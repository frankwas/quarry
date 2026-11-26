//! Claude integration: an agent loop over the Messages API (raw HTTP + SSE;
//! there is no official Rust SDK) with read-only schema tools that run
//! against the open session. The API key lives in the OS credential store
//! and never reaches the webview.
//!
//! Claude cannot change data: it can read metadata, optionally run read-only
//! SELECTs inside a READ ONLY transaction, and hand back scripts that the
//! user inserts into an editor and runs through the normal path.

use crate::db::{quote_ident, run_query, Session};
use crate::store;
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use mysql_async::prelude::*;
use mysql_async::{Conn, Params};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const KEY_ID: &str = "anthropic";
const MAX_TURNS: usize = 16;
const SCHEMA_BUDGET_CHARS: usize = 120_000;

pub fn set_key(key: &str) -> Result<()> {
    store::set_secret(KEY_ID, "api_key", key.trim())
}

pub fn has_key() -> bool {
    store::has_secret(KEY_ID, "api_key")
}

fn key() -> Result<String> {
    store::get_secret(KEY_ID, "api_key").ok_or_else(|| anyhow!("No Claude API key saved. Add one in Settings → Claude."))
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()?)
}

/// Cheap key check: list models (no tokens spent).
pub async fn test_key(candidate: Option<String>) -> Result<Vec<String>> {
    let k = match candidate.filter(|s| !s.trim().is_empty()) {
        Some(s) => s.trim().to_string(),
        None => key()?,
    };
    let resp = client()?
        .get("https://api.anthropic.com/v1/models?limit=100")
        .header("x-api-key", k)
        .header("anthropic-version", API_VERSION)
        .send()
        .await?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        bail!("{}", api_error_text(status.as_u16(), &body));
    }
    Ok(body["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default())
}

fn api_error_text(status: u16, body: &Value) -> String {
    let msg = body["error"]["message"].as_str().unwrap_or("request failed");
    match status {
        401 => format!("Invalid API key (401): {msg}"),
        403 => format!("Permission denied (403): {msg}"),
        429 => format!("Rate limited (429): {msg}"),
        529 => format!("Claude is overloaded right now (529). Try again shortly."),
        s if s >= 500 => format!("Anthropic server error ({s}): {msg}"),
        s => format!("API error ({s}): {msg}"),
    }
}

// --------------------------------------------------------------- requests

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOptions {
    pub model: String,
    pub effort: String,
    pub allow_queries: bool,
    pub schema: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum AiEvent<'a> {
    Text { chat_id: &'a str, text: &'a str },
    Thinking { chat_id: &'a str, text: &'a str },
    ToolStart { chat_id: &'a str, id: &'a str, name: &'a str, input: &'a Value },
    ToolResult { chat_id: &'a str, id: &'a str, summary: &'a str, is_error: bool },
    Turn { chat_id: &'a str, model: &'a str },
    Fallback { chat_id: &'a str, from: &'a str, to: &'a str },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    /// Full API message history, to send back with the next user turn.
    pub messages: Vec<Value>,
    pub stop_reason: String,
    pub notice: Option<String>,
    pub usage: Usage,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

fn tools() -> Value {
    json!([
        {
            "name": "list_tables",
            "description": "List the tables and views in a schema with engine, approximate row count and comment. Call this when you need to discover what exists in a schema other than the one already described, or to refresh after the user says the schema changed.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": { "schema": { "type": "string", "description": "Schema name; defaults to the current schema" } },
                "additionalProperties": false
            }
        },
        {
            "name": "describe_table",
            "description": "Return the exact CREATE TABLE (or CREATE VIEW) statement for one table, including indexes, foreign keys, defaults and comments. Call this before writing ALTER statements, migrations, or anything that depends on exact column types, and whenever the schema overview is truncated.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "table": { "type": "string", "description": "Table or view name" },
                    "schema": { "type": "string", "description": "Schema name; defaults to the current schema" }
                },
                "required": ["table"],
                "additionalProperties": false
            }
        },
        {
            "name": "run_read_query",
            "description": "Run one read-only statement (SELECT, WITH … SELECT, SHOW, DESCRIBE or EXPLAIN) and get up to 50 rows back. Executes inside a READ ONLY transaction with a 15 s time limit. Use it to check real values, distributions, duplicates or row counts before writing a script that depends on them. Never use it to modify data — it will fail.",
            "eager_input_streaming": true,
            "input_schema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "A single read-only SQL statement" }
                },
                "required": ["sql"],
                "additionalProperties": false
            }
        }
    ])
}

fn system_prompt(server_version: &str, schema: Option<&str>, allow_queries: bool) -> String {
    format!(
        "You are the SQL assistant built into Quarry, a desktop MySQL client. The user is working on a MySQL server, version {server_version}{schema_line}.\n\n\
How you work:\n\
- Write MySQL-dialect SQL that runs on this server version. Put every script in a ```sql fenced block; the user gets buttons to insert it into their editor and run it.\n\
- You cannot change data yourself. The user reviews and runs your scripts. Say plainly when a script is destructive (DROP, TRUNCATE, DELETE/UPDATE without a narrow WHERE, ALTERs that rewrite or lock large tables) and, where it fits, offer a safer path such as a backup table, a transaction, or a dry-run SELECT first.\n\
- Use the tools to check real structure instead of guessing. Call describe_table before writing ALTERs or anything that depends on exact types, keys or constraints.\n\
- {query_line}\n\
- Prefer explicit column lists, qualified names when a script spans schemas, and backtick-quoted identifiers when names are reserved words or unusual.\n\
- Keep explanations short and concrete. Lead with the script when the user asked for one.",
        schema_line = schema.map(|s| format!(", and the current schema is `{s}`")).unwrap_or_default(),
        query_line = if allow_queries {
            "run_read_query is enabled: use it sparingly to look at real data when the answer depends on it. Results are capped at 50 rows."
        } else {
            "The user has not allowed you to read table data. run_read_query will return an error; work from structure alone and ask the user if you truly need to see values."
        }
    )
}

/// Compact overview of a schema's tables for the system prompt. Says so
/// explicitly when it had to stop listing columns.
async fn schema_overview(conn: &mut Conn, schema: &str) -> Result<String> {
    let cols: Vec<(String, String, String, String, String)> = conn
        .exec(
            "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
            (schema,),
        )
        .await?;
    let fks: Vec<(String, String, String, String)> = conn
        .exec(
            "SELECT TABLE_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION), REFERENCED_TABLE_NAME, \
                    GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) \
               FROM information_schema.KEY_COLUMN_USAGE \
              WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL \
              GROUP BY TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME ORDER BY TABLE_NAME",
            (schema,),
        )
        .await?;
    let views: Vec<String> = conn
        .exec("SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?", (schema,))
        .await?;

    let mut out = format!("Schema `{schema}` overview (columns as name type, PK = primary key, ? = nullable):\n");
    let mut current = String::new();
    let mut truncated_from: Option<usize> = None;
    let table_names: Vec<String> = {
        let mut v: Vec<String> = cols.iter().map(|c| c.0.clone()).collect();
        v.dedup();
        v
    };
    for (i, (t, c, ty, key, nullable)) in cols.iter().enumerate() {
        if truncated_from.is_none() && out.len() > SCHEMA_BUDGET_CHARS {
            truncated_from = Some(i);
            break;
        }
        if *t != current {
            current = t.clone();
            let kind = if views.contains(t) { "view" } else { "table" };
            out.push_str(&format!("\n{kind} {t}:"));
        }
        let mut flags = String::new();
        if key == "PRI" {
            flags.push_str(" PK");
        }
        if nullable == "YES" {
            flags.push('?');
        }
        out.push_str(&format!(" {c} {ty}{flags},"));
    }
    if let Some(i) = truncated_from {
        let shown: std::collections::BTreeSet<&String> = cols[..i].iter().map(|c| &c.0).collect();
        let rest: Vec<&String> = table_names.iter().filter(|t| !shown.contains(t)).collect();
        out.push_str(&format!(
            "\n\n[Overview truncated for size. {} more tables, listed by name only — call describe_table for their columns:]\n{}",
            rest.len(),
            rest.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    if !fks.is_empty() {
        out.push_str("\n\nForeign keys:\n");
        for (t, c, rt, rc) in &fks {
            out.push_str(&format!("{t}({c}) -> {rt}({rc})\n"));
        }
    }
    if cols.is_empty() {
        out.push_str("\n(no tables yet)");
    }
    Ok(out)
}

// --------------------------------------------------------------- SSE stream

struct Turn {
    content: Vec<Value>,
    /// Raw partial JSON per tool_use block index.
    tool_json: std::collections::HashMap<usize, String>,
    stop_reason: String,
    model: String,
    usage: Usage,
    refusal: Option<String>,
}

async fn stream_turn(app: &AppHandle, chat_id: &str, body: &Value, uses_fallbacks: bool, cancel: &AtomicBool) -> Result<Turn> {
    let mut req = client()?
        .post(API_URL)
        .header("x-api-key", key()?)
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    if uses_fallbacks {
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let resp = req.json(body).send().await.context("could not reach api.anthropic.com")?;
    let status = resp.status();
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        bail!("{}", api_error_text(status.as_u16(), &body));
    }

    let mut turn = Turn {
        content: Vec::new(),
        tool_json: Default::default(),
        stop_reason: String::new(),
        model: String::new(),
        usage: Usage::default(),
        refusal: None,
    };
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            bail!("Stopped");
        }
        buf.extend_from_slice(&chunk?);
        // SSE events are separated by a blank line.
        while let Some(pos) = find_event_end(&buf) {
            let raw: Vec<u8> = buf.drain(..pos).collect();
            let text = String::from_utf8_lossy(&raw);
            let data: String = text
                .lines()
                .filter_map(|l| l.strip_prefix("data:").map(|d| d.trim_start()))
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() {
                continue;
            }
            let ev: Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            handle_event(app, chat_id, &ev, &mut turn)?;
        }
    }
    Ok(turn)
}

fn find_event_end(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len() {
        if buf[i..].starts_with(b"\n\n") {
            return Some(i + 2);
        }
        if buf[i..].starts_with(b"\r\n\r\n") {
            return Some(i + 4);
        }
    }
    None
}

fn handle_event(app: &AppHandle, chat_id: &str, ev: &Value, turn: &mut Turn) -> Result<()> {
    match ev["type"].as_str().unwrap_or("") {
        "message_start" => {
            turn.model = ev["message"]["model"].as_str().unwrap_or("").to_string();
            let u = &ev["message"]["usage"];
            turn.usage.input_tokens += u["input_tokens"].as_u64().unwrap_or(0);
            turn.usage.cache_read_tokens += u["cache_read_input_tokens"].as_u64().unwrap_or(0);
            turn.usage.cache_write_tokens += u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            let _ = app.emit("ai-event", AiEvent::Turn { chat_id, model: &turn.model });
        }
        "content_block_start" => {
            let idx = ev["index"].as_u64().unwrap_or(0) as usize;
            let block = ev["content_block"].clone();
            if block["type"] == "fallback" {
                let from = block["from"]["model"].as_str().unwrap_or("").to_string();
                let to = block["to"]["model"].as_str().unwrap_or("").to_string();
                let _ = app.emit("ai-event", AiEvent::Fallback { chat_id, from: &from, to: &to });
            }
            if turn.content.len() <= idx {
                turn.content.resize(idx + 1, Value::Null);
            }
            turn.content[idx] = block;
        }
        "content_block_delta" => {
            let idx = ev["index"].as_u64().unwrap_or(0) as usize;
            let d = &ev["delta"];
            let Some(block) = turn.content.get_mut(idx) else { return Ok(()) };
            match d["type"].as_str().unwrap_or("") {
                "text_delta" => {
                    let t = d["text"].as_str().unwrap_or("");
                    append_str(block, "text", t);
                    let _ = app.emit("ai-event", AiEvent::Text { chat_id, text: t });
                }
                "thinking_delta" => {
                    let t = d["thinking"].as_str().unwrap_or("");
                    append_str(block, "thinking", t);
                    let _ = app.emit("ai-event", AiEvent::Thinking { chat_id, text: t });
                }
                "signature_delta" => {
                    block["signature"] = d["signature"].clone();
                }
                "input_json_delta" => {
                    turn.tool_json.entry(idx).or_default().push_str(d["partial_json"].as_str().unwrap_or(""));
                }
                _ => {}
            }
        }
        "content_block_stop" => {}
        "message_delta" => {
            if let Some(r) = ev["delta"]["stop_reason"].as_str() {
                turn.stop_reason = r.to_string();
            }
            if turn.stop_reason == "refusal" {
                turn.refusal = ev["delta"]["stop_details"]["explanation"].as_str().map(String::from);
            }
            turn.usage.output_tokens += ev["usage"]["output_tokens"].as_u64().unwrap_or(0);
        }
        "error" => {
            let e = &ev["error"];
            bail!("{}: {}", e["type"].as_str().unwrap_or("error"), e["message"].as_str().unwrap_or("stream error"));
        }
        _ => {}
    }
    Ok(())
}

fn append_str(block: &mut Value, field: &str, s: &str) {
    let cur = block[field].as_str().unwrap_or("").to_string();
    block[field] = Value::String(cur + s);
}

/// Content as it must be echoed back. After a mid-output fallback, blocks
/// from the declined attempt that precede the last `fallback` boundary are
/// dropped (thinking, redacted_thinking, tool_use, unknown types); text and
/// the fallback block itself stay in place.
fn echo_content(content: &[Value]) -> Vec<Value> {
    let last_fb = content.iter().rposition(|b| b["type"] == "fallback");
    content
        .iter()
        .enumerate()
        .filter(|(i, b)| match last_fb {
            Some(fb) if *i < fb => matches!(b["type"].as_str(), Some("text") | Some("fallback")),
            _ => true,
        })
        .map(|(_, b)| b.clone())
        .filter(|b| !b.is_null())
        .collect()
}

// --------------------------------------------------------------- tools

struct ToolCall {
    id: String,
    name: String,
    input: Result<Value, String>,
}

fn validate(name: &str, input: &Value) -> Result<(), String> {
    let obj = input.as_object().ok_or("input must be an object")?;
    let str_field = |k: &str, required: bool| -> Result<(), String> {
        match obj.get(k) {
            None if required => Err(format!("missing required field `{k}`")),
            None => Ok(()),
            Some(v) if v.is_string() => Ok(()),
            Some(_) => Err(format!("`{k}` must be a string")),
        }
    };
    match name {
        "list_tables" => str_field("schema", false),
        "describe_table" => {
            str_field("table", true)?;
            str_field("schema", false)
        }
        "run_read_query" => str_field("sql", true),
        _ => Err(format!("unknown tool `{name}`")),
    }
}

async fn run_tool(session: &Session, conn: &mut Conn, default_schema: Option<&str>, allow_queries: bool, call: &ToolCall) -> (String, bool, String) {
    let input = match &call.input {
        Ok(v) => v,
        Err(raw) => {
            let content = json!({ "INVALID_JSON": raw }).to_string();
            return (content, true, "invalid tool input".into());
        }
    };
    if let Err(e) = validate(&call.name, input) {
        return (format!("Invalid input: {e}"), true, format!("invalid input: {e}"));
    }
    let schema = input["schema"].as_str().or(default_schema).map(String::from);
    let res: Result<(String, String)> = async {
        match call.name.as_str() {
            "list_tables" => {
                let schema = schema.ok_or_else(|| anyhow!("no schema selected; pass `schema`"))?;
                let rows: Vec<(String, String, Option<String>, Option<u64>, String)> = conn
                    .exec(
                        "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES \
                         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                        (schema.clone(),),
                    )
                    .await?;
                if rows.is_empty() {
                    return Ok((format!("Schema `{schema}` has no tables (or does not exist)."), format!("{schema}: no tables")));
                }
                let mut s = format!("{} objects in `{schema}`:\n", rows.len());
                for (n, t, e, r, c) in &rows {
                    s.push_str(&format!(
                        "{n}\t{}\t{}\t~{} rows{}\n",
                        if t == "VIEW" { "view" } else { "table" },
                        e.clone().unwrap_or_default(),
                        r.unwrap_or(0),
                        if c.is_empty() { String::new() } else { format!("\t{c}") }
                    ));
                }
                Ok((s, format!("{} tables in {schema}", rows.len())))
            }
            "describe_table" => {
                let schema = schema.ok_or_else(|| anyhow!("no schema selected; pass `schema`"))?;
                let table = input["table"].as_str().unwrap_or_default();
                let q = format!("{}.{}", quote_ident(&schema), quote_ident(table));
                let row: Option<mysql_async::Row> = conn.query_first(format!("SHOW CREATE TABLE {q}")).await.map_err(|e| anyhow!(crate::db::fmt_err(&e)))?;
                let ddl: String = row.and_then(|r| r.get(1)).unwrap_or_default();
                Ok((format!("{ddl};"), format!("read structure of {table}")))
            }
            "run_read_query" => {
                if !allow_queries {
                    bail!("The user has not allowed Claude to read table data. Work from the structure, or ask the user to enable \"Let Claude run read-only queries\".");
                }
                let sql = input["sql"].as_str().unwrap_or_default().trim().trim_end_matches(';').to_string();
                if crate::db::is_write(&sql) {
                    bail!("Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are allowed.");
                }
                // Real enforcement: a READ ONLY transaction plus a time limit.
                let _ = conn.query_drop("SET SESSION MAX_EXECUTION_TIME = 15000").await;
                conn.query_drop("START TRANSACTION READ ONLY").await?;
                let r = run_query(conn, &sql, Params::Empty, 50).await;
                let _ = conn.query_drop("ROLLBACK").await;
                // This is a pooled connection; don't leave the limit on it.
                let _ = conn.query_drop("SET SESSION MAX_EXECUTION_TIME = 0").await;
                let sets = r.map_err(|e| anyhow!(crate::db::fmt_err(&e)))?;
                let Some(rs) = sets.into_iter().find(|s| !s.columns.is_empty()) else {
                    return Ok(("Statement returned no result set.".into(), "no result set".into()));
                };
                let mut s = rs.columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>().join("\t");
                s.push('\n');
                for row in &rs.rows {
                    let line = row
                        .iter()
                        .map(|v| match v {
                            None => "NULL".to_string(),
                            Some(x) if x.chars().count() > 300 => format!("{}…", x.chars().take(300).collect::<String>()),
                            Some(x) => x.replace(['\t', '\n'], " "),
                        })
                        .collect::<Vec<_>>()
                        .join("\t");
                    s.push_str(&line);
                    s.push('\n');
                }
                if rs.truncated {
                    s.push_str(&format!("[{} rows total; first 50 shown]\n", rs.total_rows));
                }
                let n = rs.total_rows;
                Ok((s, format!("{n} row{}", if n == 1 { "" } else { "s" })))
            }
            other => bail!("unknown tool {other}"),
        }
    }
    .await;
    let _ = session; // pool connection is passed in; kept for future tools
    match res {
        Ok((content, summary)) => (content, false, summary),
        Err(e) => {
            let msg = format!("{e:#}");
            (msg.clone(), true, msg)
        }
    }
}

// --------------------------------------------------------------- agent loop

pub async fn chat(
    app: AppHandle,
    session: Arc<Session>,
    chat_id: String,
    cancel: Arc<AtomicBool>,
    mut messages: Vec<Value>,
    user_content: Value,
    opts: ChatOptions,
) -> Result<ChatResult> {
    let mut conn = session.pool.get_conn().await?;
    let schema = opts.schema.clone().filter(|s| !s.is_empty());
    let overview = match &schema {
        Some(s) => schema_overview(&mut conn, s).await.unwrap_or_else(|e| format!("(could not read schema overview: {e})")),
        None => "No default schema is selected. Use list_tables with an explicit schema when needed.".into(),
    };
    let system = json!([
        { "type": "text", "text": system_prompt(&session.server_version, schema.as_deref(), opts.allow_queries) },
        { "type": "text", "text": overview, "cache_control": { "type": "ephemeral" } }
    ]);

    // Server-side refusal fallbacks are available for Opus 5.5 / Sonnet 5.5 but not Haiku.
    let uses_fallbacks = !opts.model.contains("haiku");
    messages.push(json!({ "role": "user", "content": user_content }));

    let mut usage = Usage::default();
    let mut notice = None;
    let mut stop_reason = String::new();

    for _ in 0..MAX_TURNS {
        if cancel.load(Ordering::Relaxed) {
            bail!("Stopped");
        }
        let mut body = json!({
            "model": opts.model,
            "max_tokens": 64000,
            "stream": true,
            "system": system,
            "tools": tools(),
            "thinking": { "type": "adaptive", "display": "summarized" },
            "output_config": { "effort": opts.effort },
            "cache_control": { "type": "ephemeral" },
            "messages": messages,
        });
        if uses_fallbacks {
            body["fallbacks"] = json!("default");
        }

        let mut turn = stream_turn(&app, &chat_id, &body, uses_fallbacks, &cancel).await?;
        usage.input_tokens += turn.usage.input_tokens;
        usage.output_tokens += turn.usage.output_tokens;
        usage.cache_read_tokens += turn.usage.cache_read_tokens;
        usage.cache_write_tokens += turn.usage.cache_write_tokens;
        stop_reason = turn.stop_reason.clone();

        // Materialise tool inputs from the streamed JSON (strict parse).
        let mut calls = Vec::new();
        let last_fb = turn.content.iter().rposition(|b| b["type"] == "fallback");
        for (idx, block) in turn.content.iter_mut().enumerate() {
            if block["type"] != "tool_use" {
                continue;
            }
            let raw = turn.tool_json.get(&idx).cloned().unwrap_or_default();
            let parsed = if raw.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str::<Value>(&raw).map_err(|_| raw.clone()) };
            block["input"] = parsed.clone().unwrap_or_else(|_| json!({}));
            // Tool calls from a declined attempt (before the fallback boundary) never run.
            if last_fb.map_or(true, |fb| idx > fb) {
                calls.push(ToolCall {
                    id: block["id"].as_str().unwrap_or_default().to_string(),
                    name: block["name"].as_str().unwrap_or_default().to_string(),
                    input: parsed,
                });
            }
        }
        messages.push(json!({ "role": "assistant", "content": echo_content(&turn.content) }));

        match turn.stop_reason.as_str() {
            "tool_use" if !calls.is_empty() => {
                let mut results = Vec::new();
                for call in &calls {
                    let input = call.input.clone().unwrap_or(Value::Null);
                    let _ = app.emit("ai-event", AiEvent::ToolStart { chat_id: &chat_id, id: &call.id, name: &call.name, input: &input });
                    let (content, is_error, summary) = run_tool(&session, &mut conn, schema.as_deref(), opts.allow_queries, call).await;
                    let _ = app.emit("ai-event", AiEvent::ToolResult { chat_id: &chat_id, id: &call.id, summary: &summary, is_error });
                    let mut r = json!({ "type": "tool_result", "tool_use_id": call.id, "content": content });
                    if is_error {
                        r["is_error"] = json!(true);
                    }
                    results.push(r);
                }
                // All results for one assistant turn go back in a single user message.
                messages.push(json!({ "role": "user", "content": results }));
            }
            "pause_turn" => continue,
            "max_tokens" => {
                notice = Some(if calls.is_empty() {
                    "The reply hit the output limit and was cut off.".into()
                } else {
                    "The reply hit the output limit in the middle of a tool call, so the call was not run.".into()
                });
                break;
            }
            "refusal" => {
                notice = Some(format!(
                    "Claude declined this request{}.",
                    turn.refusal.take().map(|e| format!(": {e}")).unwrap_or_default()
                ));
                break;
            }
            _ => break,
        }
    }
    if stop_reason == "tool_use" {
        notice = Some("Stopped after many tool calls in one reply. Ask Claude to continue if needed.".into());
    }
    Ok(ChatResult { messages, stop_reason, notice, usage })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_framing() {
        assert_eq!(find_event_end(b"event: x\ndata: {}\n\nrest"), Some(19));
        assert_eq!(find_event_end(b"data: {}\r\n\r\n"), Some(12));
        assert_eq!(find_event_end(b"data: partial"), None);
    }

    #[test]
    fn echo_drops_declined_attempt_blocks() {
        let content = vec![
            json!({"type": "thinking", "thinking": "a", "signature": "s1"}),
            json!({"type": "text", "text": "partial"}),
            json!({"type": "tool_use", "id": "t1", "name": "list_tables", "input": {}}),
            json!({"type": "fallback", "from": {"model": "a"}, "to": {"model": "b"}}),
            json!({"type": "thinking", "thinking": "b", "signature": "s2"}),
            json!({"type": "text", "text": "final"}),
        ];
        let out = echo_content(&content);
        let types: Vec<&str> = out.iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(types, vec!["text", "fallback", "thinking", "text"]);
    }

    #[test]
    fn echo_keeps_everything_without_fallback() {
        let content = vec![json!({"type": "thinking", "thinking": "a", "signature": "s"}), json!({"type": "tool_use", "id": "t", "name": "x", "input": {}})];
        assert_eq!(echo_content(&content).len(), 2);
    }

    #[test]
    fn tool_input_validation() {
        assert!(validate("describe_table", &json!({"table": "orders"})).is_ok());
        assert!(validate("describe_table", &json!({})).is_err());
        assert!(validate("describe_table", &json!({"table": 5})).is_err());
        assert!(validate("run_read_query", &json!({"sql": "select 1"})).is_ok());
        assert!(validate("list_tables", &json!({})).is_ok());
        assert!(validate("nope", &json!({})).is_err());
    }
}
