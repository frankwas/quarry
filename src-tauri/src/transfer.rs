//! Long-running data movement: SQL dumps, running .sql files, CSV in/out.
//! Each job reports progress through the `task-progress` event and can be
//! cancelled through its task id.

use crate::db::{fmt_err, quote_ident, Session};
use crate::sqlsplit::Splitter;
use anyhow::{anyhow, bail, Context, Result};
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Row, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct Tasks {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Tasks {
    pub fn start(&self, id: &str) -> Arc<AtomicBool> {
        let f = Arc::new(AtomicBool::new(false));
        self.flags.lock().unwrap().insert(id.to_string(), f.clone());
        f
    }
    pub fn cancel(&self, id: &str) {
        if let Some(f) = self.flags.lock().unwrap().get(id) {
            f.store(true, Ordering::Relaxed);
        }
    }
    pub fn finish(&self, id: &str) {
        self.flags.lock().unwrap().remove(id);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    task_id: &'a str,
    done: u64,
    total: u64,
    message: String,
}

fn emit(app: &AppHandle, task_id: &str, done: u64, total: u64, message: impl Into<String>) {
    let _ = app.emit("task-progress", Progress { task_id, done, total, message: message.into() });
}

fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        bail!("Cancelled");
    }
    Ok(())
}

// ---------------------------------------------------------------- dump

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpOptions {
    pub schema: String,
    /// Empty = every table and view in the schema.
    #[serde(default)]
    pub tables: Vec<String>,
    pub structure: bool,
    pub data: bool,
    pub routines: bool,
    pub triggers: bool,
    pub drop_if_exists: bool,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpSummary {
    pub tables: usize,
    pub rows: u64,
    pub bytes: u64,
}

fn literal(v: &Value, c: &Column) -> String {
    match v {
        Value::NULL => "NULL".into(),
        Value::Bytes(b) => {
            // Only genuinely binary string/blob columns become hex. JSON also
            // reports charset 63 but must stay a quoted string.
            let binary = c.character_set() == 63
                && matches!(
                    c.column_type(),
                    ColumnType::MYSQL_TYPE_BLOB
                        | ColumnType::MYSQL_TYPE_TINY_BLOB
                        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                        | ColumnType::MYSQL_TYPE_LONG_BLOB
                        | ColumnType::MYSQL_TYPE_STRING
                        | ColumnType::MYSQL_TYPE_VAR_STRING
                        | ColumnType::MYSQL_TYPE_VARCHAR
                        | ColumnType::MYSQL_TYPE_GEOMETRY
                );
            if binary || c.column_type() == ColumnType::MYSQL_TYPE_BIT {
                if b.is_empty() {
                    return "''".into();
                }
                let mut s = String::from("0x");
                for x in b {
                    s.push_str(&format!("{x:02X}"));
                }
                return s;
            }
            let numeric = matches!(
                c.column_type(),
                ColumnType::MYSQL_TYPE_TINY
                    | ColumnType::MYSQL_TYPE_SHORT
                    | ColumnType::MYSQL_TYPE_LONG
                    | ColumnType::MYSQL_TYPE_LONGLONG
                    | ColumnType::MYSQL_TYPE_INT24
                    | ColumnType::MYSQL_TYPE_FLOAT
                    | ColumnType::MYSQL_TYPE_DOUBLE
                    | ColumnType::MYSQL_TYPE_DECIMAL
                    | ColumnType::MYSQL_TYPE_NEWDECIMAL
                    | ColumnType::MYSQL_TYPE_YEAR
            );
            let s = String::from_utf8_lossy(b);
            if numeric {
                return s.into_owned();
            }
            quote_str(&s)
        }
        other => other.as_sql(false),
    }
}

pub fn quote_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\x1a' => out.push_str("\\Z"),
            c => out.push(c),
        }
    }
    out.push('\'');
    out
}

pub async fn dump(app: AppHandle, session: Arc<Session>, task_id: String, cancel: Arc<AtomicBool>, o: DumpOptions) -> Result<DumpSummary> {
    let mut conn = Conn::new(session.opts.clone()).await?;
    conn.query_drop(format!("USE {}", quote_ident(&o.schema))).await?;
    conn.query_drop("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ").await?;
    conn.query_drop("START TRANSACTION /*!40100 WITH CONSISTENT SNAPSHOT */").await?;

    let all: Vec<(String, String)> = conn
        .exec(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            (o.schema.clone(),),
        )
        .await?;
    let selected: Vec<(String, bool)> = all
        .into_iter()
        .filter(|(n, _)| o.tables.is_empty() || o.tables.contains(n))
        .map(|(n, t)| (n, t == "VIEW"))
        .collect();

    let file = std::fs::File::create(&o.path).with_context(|| format!("creating {}", o.path))?;
    let mut w = BufWriter::with_capacity(1 << 20, file);
    let total = selected.len() as u64;
    let mut rows_total = 0u64;

    writeln!(w, "-- Quarry SQL dump")?;
    writeln!(w, "-- Server: {}  Schema: {}", session.server_version, o.schema)?;
    writeln!(w, "-- Created: {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))?;
    writeln!(w, "SET NAMES utf8mb4;")?;
    writeln!(w, "SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;")?;
    writeln!(w, "SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;")?;
    writeln!(w, "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n")?;

    // Tables first, views after (views may reference any table).
    for (idx, (name, _)) in selected.iter().filter(|(_, v)| !v).enumerate() {
        check(&cancel)?;
        emit(&app, &task_id, idx as u64, total, format!("Dumping {name}"));
        let q = quote_ident(name);
        if o.structure {
            let row: Option<(String, String)> = conn.query_first(format!("SHOW CREATE TABLE {q}")).await?;
            let (_, ddl) = row.ok_or_else(|| anyhow!("no DDL for {name}"))?;
            writeln!(w, "--\n-- Table {q}\n--\n")?;
            if o.drop_if_exists {
                writeln!(w, "DROP TABLE IF EXISTS {q};")?;
            }
            writeln!(w, "{ddl};\n")?;
        }
        if o.data {
            let mut result = conn.query_iter(format!("SELECT * FROM {q}")).await?;
            let cols: Vec<Column> = result.columns().map(|c| c.to_vec()).unwrap_or_default();
            let col_list = cols.iter().map(|c| quote_ident(&c.name_str())).collect::<Vec<_>>().join(", ");
            let mut batch = String::new();
            let mut n = 0u64;
            while let Some(row) = result.next().await? {
                let vals: Vec<Value> = row.unwrap();
                let tuple = format!(
                    "({})",
                    vals.iter().zip(cols.iter()).map(|(v, c)| literal(v, c)).collect::<Vec<_>>().join(",")
                );
                if batch.is_empty() {
                    batch = format!("INSERT INTO {q} ({col_list}) VALUES\n{tuple}");
                } else {
                    batch.push_str(",\n");
                    batch.push_str(&tuple);
                }
                n += 1;
                if batch.len() > 1 << 20 {
                    writeln!(w, "{batch};")?;
                    batch.clear();
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    emit(&app, &task_id, idx as u64, total, format!("Dumping {name} ({n} rows)"));
                }
            }
            drop(result);
            check(&cancel)?;
            if !batch.is_empty() {
                writeln!(w, "{batch};")?;
            }
            if n > 0 {
                writeln!(w)?;
            }
            rows_total += n;
        }
        if o.triggers {
            let trig: Vec<Row> = conn.query(format!("SHOW TRIGGERS WHERE `Table` = {}", crate::transfer::quote_str(name))).await?;
            for t in trig {
                let tname: String = t.get(0).unwrap_or_default();
                let row: Option<Row> = conn.query_first(format!("SHOW CREATE TRIGGER {}", quote_ident(&tname))).await?;
                if let Some(r) = row {
                    let ddl: String = r.get(2).unwrap_or_default();
                    writeln!(w, "DROP TRIGGER IF EXISTS {};\nDELIMITER ;;\n{ddl};;\nDELIMITER ;\n", quote_ident(&tname))?;
                }
            }
        }
    }

    if o.structure {
        for (name, _) in selected.iter().filter(|(_, v)| *v) {
            check(&cancel)?;
            let q = quote_ident(name);
            let row: Option<Row> = conn.query_first(format!("SHOW CREATE VIEW {q}")).await?;
            if let Some(r) = row {
                let ddl: String = r.get(1).unwrap_or_default();
                writeln!(w, "--\n-- View {q}\n--\n")?;
                writeln!(w, "DROP VIEW IF EXISTS {q};")?;
                writeln!(w, "{ddl};\n")?;
            }
        }
    }

    if o.routines {
        let routines: Vec<(String, String)> = conn
            .exec(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
                (o.schema.clone(),),
            )
            .await?;
        for (name, kind) in routines {
            check(&cancel)?;
            let q = quote_ident(&name);
            let row: Option<Row> = conn.query_first(format!("SHOW CREATE {kind} {q}")).await?;
            if let Some(r) = row {
                let ddl: Option<String> = r.get(2);
                if let Some(ddl) = ddl {
                    writeln!(w, "DROP {kind} IF EXISTS {q};\nDELIMITER ;;\n{ddl};;\nDELIMITER ;\n")?;
                }
            }
        }
    }

    writeln!(w, "SET SQL_MODE=@OLD_SQL_MODE;")?;
    writeln!(w, "SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;")?;
    writeln!(w, "SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;")?;
    w.flush()?;
    conn.query_drop("COMMIT").await.ok();
    conn.disconnect().await.ok();
    let bytes = std::fs::metadata(&o.path).map(|m| m.len()).unwrap_or(0);
    emit(&app, &task_id, total, total, "Done");
    Ok(DumpSummary { tables: selected.len(), rows: rows_total, bytes })
}

// ---------------------------------------------------------------- run .sql file

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub statements: u64,
    pub errors: Vec<String>,
}

pub async fn run_sql_file(
    app: AppHandle,
    session: Arc<Session>,
    task_id: String,
    cancel: Arc<AtomicBool>,
    path: String,
    schema: Option<String>,
    continue_on_error: bool,
) -> Result<ImportSummary> {
    if session.cfg.read_only {
        bail!("Blocked: this connection is marked read-only.");
    }
    let file = std::fs::File::open(&path).with_context(|| format!("opening {path}"))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut conn = Conn::new(session.opts.clone()).await?;
    if let Some(s) = schema.filter(|s| !s.is_empty()) {
        conn.query_drop(format!("USE {}", quote_ident(&s))).await?;
    }
    let mut splitter = Splitter::new();
    let mut done_bytes = 0u64;
    let mut count = 0u64;
    let mut errors = Vec::new();
    let mut buf = vec![0u8; 1 << 18];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        check(&cancel)?;
        let n = reader.read(&mut buf)?;
        let mut stmts = if n == 0 {
            if !carry.is_empty() {
                let s = String::from_utf8_lossy(&carry).into_owned();
                carry.clear();
                let mut v = splitter.push(&s);
                v.extend(splitter.finish());
                v
            } else {
                splitter.finish().into_iter().collect()
            }
        } else {
            done_bytes += n as u64;
            carry.extend_from_slice(&buf[..n]);
            // Only hand over complete UTF-8 sequences.
            let valid = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) => e.valid_up_to(),
            };
            let s = String::from_utf8_lossy(&carry[..valid]).into_owned();
            carry.drain(..valid);
            splitter.push(&s)
        };
        for sql in stmts.drain(..) {
            check(&cancel)?;
            count += 1;
            if let Err(e) = conn.query_drop(&sql).await {
                let preview: String = sql.chars().take(200).collect();
                errors.push(format!("#{count}: {}\n{preview}", fmt_err(&e)));
                if !continue_on_error || errors.len() >= 100 {
                    conn.disconnect().await.ok();
                    emit(&app, &task_id, done_bytes, total, "Stopped on error");
                    return Ok(ImportSummary { statements: count, errors });
                }
            }
            if count % 50 == 0 {
                emit(&app, &task_id, done_bytes, total, format!("{count} statements"));
            }
        }
        if n == 0 {
            break;
        }
    }
    conn.disconnect().await.ok();
    emit(&app, &task_id, total, total, "Done");
    Ok(ImportSummary { statements: count, errors })
}

// ---------------------------------------------------------------- CSV

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvExportSummary {
    pub rows: u64,
}

pub async fn export_csv(app: AppHandle, session: Arc<Session>, task_id: String, cancel: Arc<AtomicBool>, sql: String, schema: Option<String>, path: String) -> Result<CsvExportSummary> {
    let mut conn = Conn::new(session.opts.clone()).await?;
    if let Some(s) = schema.filter(|s| !s.is_empty()) {
        conn.query_drop(format!("USE {}", quote_ident(&s))).await?;
    }
    let file = std::fs::File::create(&path).with_context(|| format!("creating {path}"))?;
    let mut w = csv::Writer::from_writer(BufWriter::with_capacity(1 << 20, file));
    let mut result = conn.query_iter(sql).await.map_err(|e| anyhow!(fmt_err(&e)))?;
    let cols: Vec<Column> = result.columns().map(|c| c.to_vec()).unwrap_or_default();
    w.write_record(cols.iter().map(|c| c.name_str().into_owned()))?;
    let mut n = 0u64;
    while let Some(row) = result.next().await? {
        let vals: Vec<Value> = row.unwrap();
        w.write_record(vals.iter().map(|v| match v {
            Value::NULL => String::new(),
            Value::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
            other => other.as_sql(true).trim_matches('\'').to_string(),
        }))?;
        n += 1;
        if n % 5000 == 0 {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            emit(&app, &task_id, n, 0, format!("{n} rows"));
        }
    }
    drop(result);
    w.flush()?;
    conn.disconnect().await.ok();
    check(&cancel)?;
    emit(&app, &task_id, n, n, "Done");
    Ok(CsvExportSummary { rows: n })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub delimiter: String,
}

fn sniff_delimiter(path: &str) -> u8 {
    let Ok(f) = std::fs::File::open(path) else { return b',' };
    let mut line = String::new();
    let _ = BufReader::new(f).read_line(&mut line);
    [b',', b';', b'\t', b'|']
        .into_iter()
        .max_by_key(|d| line.bytes().filter(|b| b == d).count())
        .unwrap_or(b',')
}

pub fn preview_csv(path: &str, delimiter: Option<String>, has_header: bool) -> Result<CsvPreview> {
    let d = delimiter
        .and_then(|d| if d == "\\t" { Some(b'\t') } else { d.bytes().next() })
        .unwrap_or_else(|| sniff_delimiter(path));
    let mut r = csv::ReaderBuilder::new().delimiter(d).has_headers(false).flexible(true).from_path(path)?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    for rec in r.records().take(51) {
        rows.push(rec?.iter().map(|s| s.to_string()).collect());
    }
    let headers = if has_header && !rows.is_empty() {
        rows.remove(0)
    } else {
        (1..=rows.first().map(|r| r.len()).unwrap_or(0)).map(|i| format!("column{i}")).collect()
    };
    Ok(CsvPreview { headers, rows, delimiter: if d == b'\t' { "\\t".into() } else { (d as char).to_string() } })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportOptions {
    pub path: String,
    pub schema: String,
    pub table: String,
    pub delimiter: String,
    pub has_header: bool,
    /// Target column per CSV column; `None` skips that CSV column.
    pub mapping: Vec<Option<String>>,
    pub empty_as_null: bool,
    pub truncate_first: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportSummary {
    pub rows: u64,
}

pub async fn import_csv(app: AppHandle, session: Arc<Session>, task_id: String, cancel: Arc<AtomicBool>, o: CsvImportOptions) -> Result<CsvImportSummary> {
    if session.cfg.read_only {
        bail!("Blocked: this connection is marked read-only.");
    }
    let d = if o.delimiter == "\\t" { b'\t' } else { o.delimiter.bytes().next().unwrap_or(b',') };
    let total = std::fs::metadata(&o.path).map(|m| m.len()).unwrap_or(0);
    let mut r = csv::ReaderBuilder::new().delimiter(d).has_headers(o.has_header).flexible(true).from_path(&o.path)?;
    let targets: Vec<(usize, String)> = o.mapping.iter().enumerate().filter_map(|(i, m)| m.clone().filter(|s| !s.is_empty()).map(|m| (i, m))).collect();
    if targets.is_empty() {
        bail!("Map at least one CSV column to a table column.");
    }
    let table = format!("{}.{}", quote_ident(&o.schema), quote_ident(&o.table));
    let col_list = targets.iter().map(|(_, c)| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let placeholder = format!("({})", vec!["?"; targets.len()].join(","));

    let mut conn = Conn::new(session.opts.clone()).await?;
    if o.truncate_first {
        conn.query_drop(format!("DELETE FROM {table}")).await?;
    }
    const BATCH: usize = 500;
    let mut params: Vec<Value> = Vec::with_capacity(BATCH * targets.len());
    let mut in_batch = 0usize;
    let mut n = 0u64;

    async fn flush(conn: &mut Conn, table: &str, cols: &str, ph: &str, rows: usize, params: &mut Vec<Value>) -> Result<()> {
        if rows == 0 {
            return Ok(());
        }
        let sql = format!("INSERT INTO {table} ({cols}) VALUES {}", vec![ph; rows].join(","));
        conn.exec_drop(sql, std::mem::take(params)).await.map_err(|e| anyhow!(fmt_err(&e)))?;
        Ok(())
    }

    for rec in r.records() {
        let rec = rec?;
        for (i, _) in &targets {
            let v = rec.get(*i).unwrap_or("");
            params.push(if v.is_empty() && o.empty_as_null { Value::NULL } else { Value::from(v) });
        }
        in_batch += 1;
        n += 1;
        if in_batch == BATCH {
            check(&cancel)?;
            flush(&mut conn, &table, &col_list, &placeholder, in_batch, &mut params)
                .await
                .with_context(|| format!("rows {}–{}", n - in_batch as u64 + 1, n))?;
            in_batch = 0;
            let pos = rec.position().map(|p| p.byte()).unwrap_or(0);
            emit(&app, &task_id, pos, total, format!("{n} rows"));
        }
    }
    flush(&mut conn, &table, &col_list, &placeholder, in_batch, &mut params)
        .await
        .with_context(|| format!("rows {}–{}", n - in_batch as u64 + 1, n))?;
    conn.disconnect().await.ok();
    emit(&app, &task_id, total, total, "Done");
    Ok(CsvImportSummary { rows: n })
}
