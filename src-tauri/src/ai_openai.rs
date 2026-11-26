//! OpenAI provider for the assistant panel: the same read-only schema tools
//! and safety rules as the Claude loop, over the Chat Completions API with
//! streamed function calling. The key lives in the OS credential store.

use crate::ai::{self, AiEvent, ChatOptions, ChatResult, ToolCall, Usage};
use crate::db::Session;
use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

const API_URL: &str = "https://api.openai.com/v1/chat/completions";

/// Model ids on the account that can drive a chat with tools.
pub async fn list_models(key: &str) -> Result<Vec<String>> {
    let resp = ai::client()?
        .get("https://api.openai.com/v1/models")
        .bearer_auth(key)
        .send()
        .await
        .context("could not reach api.openai.com")?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        bail!("{}", ai::api_error_text("OpenAI", status.as_u16(), &body));
    }
    const SKIP: [&str; 12] = ["audio", "realtime", "transcribe", "tts", "image", "search", "embedding", "moderation", "whisper", "dall-e", "instruct", "codex"];
    let mut ids: Vec<String> = body["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    ids.retain(|id| {
        let chat_family = id.starts_with("gpt-") || id.starts_with("chatgpt-") || (id.starts_with('o') && id[1..].starts_with(|c: char| c.is_ascii_digit()));
        chat_family && !SKIP.iter().any(|s| id.contains(s))
    });
    ids.sort();
    Ok(ids)
}

/// Reasoning models take `reasoning_effort` and reject sampling knobs.
fn is_reasoning(model: &str) -> bool {
    model.starts_with('o') || model.starts_with("gpt-5")
}

fn tools() -> Value {
    let list = ai::tools();
    Value::Array(
        list.as_array()
            .unwrap()
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": { "name": t["name"], "description": t["description"], "parameters": t["input_schema"] }
                })
            })
            .collect(),
    )
}

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    args: String,
}

struct Turn {
    text: String,
    calls: BTreeMap<u64, PendingCall>,
    finish: String,
    model: String,
    usage: Usage,
}

async fn stream_turn(app: &AppHandle, chat_id: &str, body: &Value, cancel: &AtomicBool) -> Result<Turn> {
    let resp = ai::client()?
        .post(API_URL)
        .bearer_auth(ai::key("openai")?)
        .json(body)
        .send()
        .await
        .context("could not reach api.openai.com")?;
    let status = resp.status();
    if !status.is_success() {
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        bail!("{}", ai::api_error_text("OpenAI", status.as_u16(), &body));
    }
    let mut turn = Turn { text: String::new(), calls: BTreeMap::new(), finish: String::new(), model: String::new(), usage: Usage::default() };
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    'outer: while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            bail!("Stopped");
        }
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                break 'outer;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = ev.get("error") {
                bail!("OpenAI: {}", err["message"].as_str().unwrap_or("stream error"));
            }
            if turn.model.is_empty() {
                if let Some(m) = ev["model"].as_str() {
                    turn.model = m.to_string();
                    let _ = app.emit("ai-event", AiEvent::Turn { chat_id, model: &turn.model });
                }
            }
            if let Some(u) = ev.get("usage").filter(|u| !u.is_null()) {
                let cached = u["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0);
                turn.usage.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(0).saturating_sub(cached);
                turn.usage.cache_read_tokens = cached;
                turn.usage.output_tokens = u["completion_tokens"].as_u64().unwrap_or(0);
            }
            let Some(choice) = ev["choices"].get(0) else { continue };
            let delta = &choice["delta"];
            if let Some(t) = delta["content"].as_str() {
                if !t.is_empty() {
                    turn.text.push_str(t);
                    let _ = app.emit("ai-event", AiEvent::Text { chat_id, text: t });
                }
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for c in calls {
                    let idx = c["index"].as_u64().unwrap_or(0);
                    let p = turn.calls.entry(idx).or_default();
                    if let Some(id) = c["id"].as_str() {
                        p.id = id.to_string();
                    }
                    if let Some(n) = c["function"]["name"].as_str() {
                        p.name.push_str(n);
                    }
                    if let Some(a) = c["function"]["arguments"].as_str() {
                        p.args.push_str(a);
                    }
                }
            }
            if let Some(f) = choice["finish_reason"].as_str() {
                turn.finish = f.to_string();
            }
        }
    }
    Ok(turn)
}

pub async fn chat(
    app: AppHandle,
    session: Arc<Session>,
    chat_id: String,
    cancel: Arc<AtomicBool>,
    mut history: Vec<Value>,
    user_content: Value,
    opts: ChatOptions,
) -> Result<ChatResult> {
    let mut conn = session.pool.get_conn().await?;
    let schema = opts.schema.clone().filter(|s| !s.is_empty());
    let overview = match &schema {
        Some(s) => ai::schema_overview(&mut conn, s).await.unwrap_or_else(|e| format!("(could not read schema overview: {e})")),
        None => "No default schema is selected. Use list_tables with an explicit schema when needed.".into(),
    };
    // The system message is rebuilt per request (schema / settings may change)
    // and kept out of the returned history.
    let system = format!("{}\n\n{}", ai::system_prompt(&session.server_version, schema.as_deref(), opts.allow_queries), overview);
    history.push(json!({ "role": "user", "content": user_content }));

    let mut usage = Usage::default();
    let mut notice = None;
    let mut finish = String::new();

    for _ in 0..ai::MAX_TURNS {
        if cancel.load(Ordering::Relaxed) {
            bail!("Stopped");
        }
        let mut messages = vec![json!({ "role": "system", "content": system })];
        messages.extend(history.iter().cloned());
        let mut body = json!({
            "model": opts.model,
            "messages": messages,
            "tools": tools(),
            "stream": true,
            "stream_options": { "include_usage": true },
            "max_completion_tokens": 32000,
        });
        if is_reasoning(&opts.model) {
            let effort = match opts.effort.as_str() {
                "low" => "low",
                "medium" => "medium",
                _ => "high",
            };
            body["reasoning_effort"] = json!(effort);
        }

        let turn = stream_turn(&app, &chat_id, &body, &cancel).await?;
        usage.input_tokens += turn.usage.input_tokens;
        usage.output_tokens += turn.usage.output_tokens;
        usage.cache_read_tokens += turn.usage.cache_read_tokens;
        finish = turn.finish.clone();

        let mut assistant = json!({ "role": "assistant", "content": if turn.text.is_empty() { Value::Null } else { Value::String(turn.text.clone()) } });
        if !turn.calls.is_empty() {
            assistant["tool_calls"] = Value::Array(
                turn.calls
                    .values()
                    .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.args } }))
                    .collect(),
            );
        }
        history.push(assistant);

        match turn.finish.as_str() {
            "tool_calls" if !turn.calls.is_empty() => {
                for c in turn.calls.values() {
                    let parsed = if c.args.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str::<Value>(&c.args).map_err(|_| c.args.clone()) };
                    let call = ToolCall { id: c.id.clone(), name: c.name.clone(), input: parsed };
                    let input = call.input.clone().unwrap_or(Value::Null);
                    let _ = app.emit("ai-event", AiEvent::ToolStart { chat_id: &chat_id, id: &call.id, name: &call.name, input: &input });
                    let (content, is_error, summary) = ai::run_tool(&session, &mut conn, schema.as_deref(), opts.allow_queries, &call).await;
                    let _ = app.emit("ai-event", AiEvent::ToolResult { chat_id: &chat_id, id: &call.id, summary: &summary, is_error });
                    let content = if is_error { format!("Error: {content}") } else { content };
                    history.push(json!({ "role": "tool", "tool_call_id": call.id, "content": content }));
                }
            }
            "length" => {
                notice = Some("The reply hit the output limit and was cut off.".to_string());
                break;
            }
            "content_filter" => {
                notice = Some("OpenAI's content filter stopped this reply.".to_string());
                break;
            }
            _ => break,
        }
    }
    if finish == "tool_calls" {
        notice = Some("Stopped after many tool calls in one reply. Ask it to continue if needed.".into());
    }
    Ok(ChatResult { messages: history, stop_reason: finish, notice, usage })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_schema_conversion() {
        let t = tools();
        let arr = t.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["type"], "function");
        assert!(arr[1]["function"]["parameters"]["required"].is_array());
        assert!(arr[0]["function"].get("eager_input_streaming").is_none());
    }

    #[test]
    fn reasoning_detection() {
        assert!(is_reasoning("o3"));
        assert!(is_reasoning("gpt-5"));
        assert!(!is_reasoning("gpt-4.1"));
    }
}
