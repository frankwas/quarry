//! Live sessions. A session is one open connection profile: a small pool for
//! metadata/browsing/admin work, plus one dedicated connection per editor tab
//! so `USE`, session variables and transactions behave like a terminal.

use crate::ssh::{self, Tunnel};
use crate::store::{self, ConnConfig, SslMode};
use anyhow::{anyhow, bail, Result};
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Opts, OptsBuilder, Params, Pool, PoolConstraints, PoolOpts, SslOpts, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct Editor {
    pub conn: Arc<Mutex<Conn>>,
    pub thread_id: u32,
}

pub struct Session {
    pub cfg: ConnConfig,
    pub opts: Opts,
    pub pool: Pool,
    pub editors: Mutex<HashMap<String, Arc<Editor>>>,
    pub tunnel: Mutex<Option<Tunnel>>,
    pub server_version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub org_name: String,
    pub table: String,
    pub org_table: String,
    pub schema: String,
    pub type_name: String,
    pub numeric: bool,
    pub binary: bool,
    pub primary_key: bool,
    pub unique_key: bool,
    pub not_null: bool,
    pub auto_increment: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows the server returned in total (may exceed rows.len() when capped).
    pub total_rows: u64,
    pub truncated: bool,
    pub affected_rows: u64,
    pub last_insert_id: Option<u64>,
    pub info: String,
    pub warnings: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub sql: String,
    pub elapsed_ms: f64,
    pub error: Option<String>,
    pub result_sets: Vec<ResultSet>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResponse {
    pub statements: Vec<StatementResult>,
    pub current_database: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct Stmt {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Option<String>>,
}

fn base_opts(cfg: &ConnConfig, password: Option<String>, host: &str, port: u16, ssl: Option<SslOpts>) -> OptsBuilder {
    OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(cfg.user.clone()))
        .pass(password)
        .db_name(cfg.database.clone().filter(|d| !d.is_empty()))
        .prefer_socket(false)
        .ssl_opts(ssl)
        .init(vec!["SET NAMES utf8mb4"])
        .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, 4).unwrap()))
}

fn ssl_lenient() -> SslOpts {
    SslOpts::default()
        .with_danger_accept_invalid_certs(true)
        .with_danger_skip_domain_validation(true)
}

/// Establish a working first connection, trying TLS first when the mode is
/// "preferred". Returns the opts that worked plus that connection.
async fn connect_opts(cfg: &ConnConfig, password: Option<String>, host: &str, port: u16) -> Result<(Opts, Conn)> {
    let attempts: Vec<Option<SslOpts>> = match cfg.ssl {
        SslMode::Disabled => vec![None],
        SslMode::Preferred => vec![Some(ssl_lenient()), None],
        SslMode::Required => vec![Some(ssl_lenient())],
        SslMode::Verify => vec![Some(SslOpts::default())],
    };
    let mut last_err = None;
    for ssl in attempts {
        let opts: Opts = base_opts(cfg, password.clone(), host, port, ssl).into();
        match tokio::time::timeout(Duration::from_secs(15), Conn::new(opts.clone())).await {
            Ok(Ok(conn)) => return Ok((opts, conn)),
            Ok(Err(e)) => {
                // Credential errors won't improve without TLS; stop early.
                let fatal = matches!(&e, mysql_async::Error::Server(se) if se.code == 1045 || se.code == 1049);
                last_err = Some(anyhow!(e));
                if fatal {
                    break;
                }
            }
            Err(_) => last_err = Some(anyhow!("connection to {host}:{port} timed out")),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("could not connect")))
}

pub struct Opened {
    pub opts: Opts,
    pub first: Conn,
    pub tunnel: Option<Tunnel>,
}

/// Connect using a profile plus (optionally) secrets that override the stored
/// ones; used by both "Test connection" and opening a session.
pub async fn open_raw(cfg: &ConnConfig, password: Option<String>, ssh_secret: Option<String>, known_hosts: PathBuf) -> Result<Opened> {
    let password = password.or_else(|| store::get_secret(&cfg.id, "db"));
    let (host, port, tunnel) = match &cfg.ssh {
        Some(s) if !s.host.is_empty() => {
            let secret = ssh_secret.or_else(|| store::get_secret(&cfg.id, "ssh"));
            let t = ssh::open(s, secret, &cfg.host, cfg.port, known_hosts).await?;
            ("127.0.0.1".to_string(), t.local_port, Some(t))
        }
        _ => (cfg.host.clone(), cfg.port, None),
    };
    match connect_opts(cfg, password, &host, port).await {
        Ok((opts, first)) => Ok(Opened { opts, first, tunnel }),
        Err(e) => {
            if let Some(t) = tunnel {
                t.close().await;
            }
            Err(e)
        }
    }
}

impl Session {
    pub async fn open(cfg: ConnConfig, known_hosts: PathBuf) -> Result<Self> {
        let Opened { opts, mut first, tunnel } = open_raw(&cfg, None, None, known_hosts).await?;
        let server_version: String = first.query_first("SELECT VERSION()").await?.unwrap_or_default();
        first.disconnect().await.ok();
        let pool = Pool::new(opts.clone());
        Ok(Self {
            cfg,
            opts,
            pool,
            editors: Mutex::new(HashMap::new()),
            tunnel: Mutex::new(tunnel),
            server_version,
        })
    }

    pub async fn close(&self) {
        // Dropping an editor's Conn closes its socket.
        self.editors.lock().await.clear();
        let _ = self.pool.clone().disconnect().await;
        if let Some(t) = self.tunnel.lock().await.take() {
            t.close().await;
        }
    }

    pub async fn editor_open(&self, editor_id: String, database: Option<String>) -> Result<()> {
        let mut conn = Conn::new(self.opts.clone()).await?;
        if let Some(db) = database.filter(|d| !d.is_empty()) {
            conn.query_drop(format!("USE {}", quote_ident(&db))).await?;
        }
        let thread_id = conn.id();
        self.editors
            .lock()
            .await
            .insert(editor_id, Arc::new(Editor { conn: Arc::new(Mutex::new(conn)), thread_id }));
        Ok(())
    }

    pub async fn editor_close(&self, editor_id: &str) {
        if let Some(e) = self.editors.lock().await.remove(editor_id) {
            // Cancel anything still running so the lock frees, then drop.
            let _ = self.kill(e.thread_id, true).await;
            let conn = e.conn.clone();
            tokio::spawn(async move {
                let c = conn.lock().await;
                drop(c);
            });
        }
    }

    async fn editor(&self, editor_id: &str) -> Result<Arc<Editor>> {
        self.editors
            .lock()
            .await
            .get(editor_id)
            .cloned()
            .ok_or_else(|| anyhow!("editor connection not found (reconnect the tab)"))
    }

    pub async fn editor_exec(&self, editor_id: &str, statements: Vec<String>, max_rows: usize, stop_on_error: bool) -> Result<ExecResponse> {
        let editor = self.editor(editor_id).await?;
        let mut conn = editor.conn.lock().await;
        let mut out = Vec::new();
        for sql in statements {
            if self.cfg.read_only && is_write(&sql) {
                out.push(StatementResult {
                    sql,
                    elapsed_ms: 0.0,
                    error: Some("Blocked: this connection is marked read-only.".into()),
                    result_sets: vec![],
                });
                if stop_on_error {
                    break;
                }
                continue;
            }
            let start = Instant::now();
            let res = run_query(&mut conn, &sql, Params::Empty, max_rows).await;
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            match res {
                Ok(result_sets) => out.push(StatementResult { sql, elapsed_ms, error: None, result_sets }),
                Err(e) => {
                    let lost = is_conn_lost(&e);
                    out.push(StatementResult { sql, elapsed_ms, error: Some(fmt_err(&e)), result_sets: vec![] });
                    if lost {
                        // Reconnect transparently so the tab stays usable.
                        if let Ok(fresh) = Conn::new(self.opts.clone()).await {
                            *conn = fresh;
                        }
                        break;
                    }
                    if stop_on_error {
                        break;
                    }
                }
            }
        }
        let current_database: Option<String> = conn.query_first("SELECT DATABASE()").await.ok().flatten();
        Ok(ExecResponse { statements: out, current_database })
    }

    pub async fn editor_cancel(&self, editor_id: &str) -> Result<()> {
        let e = self.editor(editor_id).await?;
        self.kill(e.thread_id, true).await
    }

    pub async fn kill(&self, thread_id: u32, query_only: bool) -> Result<()> {
        let mut c = self.pool.get_conn().await?;
        let kw = if query_only { "KILL QUERY" } else { "KILL" };
        c.query_drop(format!("{kw} {thread_id}")).await?;
        Ok(())
    }

    /// One-off query on the pool (metadata, admin screens, grid paging).
    pub async fn query(&self, sql: &str, params: Vec<Option<String>>, max_rows: usize) -> Result<ResultSet> {
        let mut c = self.pool.get_conn().await?;
        let mut sets = run_query(&mut c, sql, to_params(params), max_rows).await?;
        Ok(if sets.is_empty() { ResultSet::default() } else { sets.remove(0) })
    }

    /// Several parameterised statements, optionally in one transaction.
    /// Returns affected rows per statement; on failure, rolls back and
    /// reports the failing index.
    pub async fn exec_batch(&self, stmts: Vec<Stmt>, transaction: bool) -> Result<Vec<u64>> {
        if self.cfg.read_only && stmts.iter().any(|s| is_write(&s.sql)) {
            bail!("Blocked: this connection is marked read-only.");
        }
        let mut c = self.pool.get_conn().await?;
        if transaction {
            c.query_drop("START TRANSACTION").await?;
        }
        let mut affected = Vec::new();
        for (i, s) in stmts.into_iter().enumerate() {
            let r = if s.params.is_empty() {
                c.query_drop(&s.sql).await
            } else {
                c.exec_drop(&s.sql, to_params(s.params)).await
            };
            if let Err(e) = r {
                if transaction {
                    let _ = c.query_drop("ROLLBACK").await;
                }
                bail!("Statement {} failed: {}\n\n{}", i + 1, fmt_err(&e), s.sql);
            }
            affected.push(c.affected_rows());
        }
        if transaction {
            c.query_drop("COMMIT").await?;
        }
        Ok(affected)
    }
}

pub fn to_params(params: Vec<Option<String>>) -> Params {
    if params.is_empty() {
        Params::Empty
    } else {
        Params::Positional(params.into_iter().map(|p| p.map(Value::from).unwrap_or(Value::NULL)).collect())
    }
}

pub async fn run_query(conn: &mut Conn, sql: &str, params: Params, max_rows: usize) -> Result<Vec<ResultSet>, mysql_async::Error> {
    match params {
        Params::Empty => collect_sets(conn.query_iter(sql).await?, max_rows).await,
        p => collect_sets(conn.exec_iter(sql, p).await?, max_rows).await,
    }
}

async fn collect_sets<P: mysql_async::prelude::Protocol>(
    mut result: mysql_async::QueryResult<'_, '_, P>,
    max_rows: usize,
) -> Result<Vec<ResultSet>, mysql_async::Error> {
    let mut sets = Vec::new();
    loop {
        let columns: Vec<Column> = result.columns().map(|c| c.to_vec()).unwrap_or_default();
        let infos: Vec<ColumnInfo> = columns.iter().map(column_info).collect();
        let mut rs = ResultSet { columns: infos, ..Default::default() };
        while let Some(row) = result.next().await? {
            rs.total_rows += 1;
            if rs.rows.len() < max_rows {
                let vals = row.unwrap();
                rs.rows.push(vals.into_iter().zip(columns.iter()).map(|(v, c)| value_to_string(v, c)).collect());
            } else {
                rs.truncated = true;
            }
        }
        rs.affected_rows = result.affected_rows();
        rs.last_insert_id = result.last_insert_id();
        rs.info = result.info().to_string();
        rs.warnings = result.warnings();
        sets.push(rs);
        if result.is_empty() {
            break;
        }
    }
    drop(result);
    Ok(sets)
}

fn is_binary_col(c: &Column) -> bool {
    c.character_set() == 63
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
        )
}

fn column_info(c: &Column) -> ColumnInfo {
    let t = c.column_type();
    let f = c.flags();
    let numeric = matches!(
        t,
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
    ColumnInfo {
        name: c.name_str().to_string(),
        org_name: c.org_name_str().to_string(),
        table: c.table_str().to_string(),
        org_table: c.org_table_str().to_string(),
        schema: c.schema_str().to_string(),
        type_name: type_name(t, c).to_string(),
        numeric,
        binary: is_binary_col(c),
        primary_key: f.contains(ColumnFlags::PRI_KEY_FLAG),
        unique_key: f.contains(ColumnFlags::UNIQUE_KEY_FLAG),
        not_null: f.contains(ColumnFlags::NOT_NULL_FLAG),
        auto_increment: f.contains(ColumnFlags::AUTO_INCREMENT_FLAG),
    }
}

fn type_name(t: ColumnType, c: &Column) -> &'static str {
    use ColumnType::*;
    match t {
        MYSQL_TYPE_TINY => "TINYINT",
        MYSQL_TYPE_SHORT => "SMALLINT",
        MYSQL_TYPE_LONG => "INT",
        MYSQL_TYPE_INT24 => "MEDIUMINT",
        MYSQL_TYPE_LONGLONG => "BIGINT",
        MYSQL_TYPE_FLOAT => "FLOAT",
        MYSQL_TYPE_DOUBLE => "DOUBLE",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "DATE",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "TIME",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "DATETIME",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "TIMESTAMP",
        MYSQL_TYPE_YEAR => "YEAR",
        MYSQL_TYPE_JSON => "JSON",
        MYSQL_TYPE_BIT => "BIT",
        MYSQL_TYPE_ENUM => "ENUM",
        MYSQL_TYPE_SET => "SET",
        MYSQL_TYPE_GEOMETRY => "GEOMETRY",
        MYSQL_TYPE_NULL => "NULL",
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            if c.character_set() == 63 { "BLOB" } else { "TEXT" }
        }
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => {
            if c.character_set() == 63 { "VARBINARY" } else { "VARCHAR" }
        }
        MYSQL_TYPE_STRING => {
            if c.flags().contains(ColumnFlags::ENUM_FLAG) {
                "ENUM"
            } else if c.flags().contains(ColumnFlags::SET_FLAG) {
                "SET"
            } else if c.character_set() == 63 {
                "BINARY"
            } else {
                "CHAR"
            }
        }
        _ => "UNKNOWN",
    }
}

fn value_to_string(v: Value, c: &Column) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => {
            if c.column_type() == ColumnType::MYSQL_TYPE_BIT {
                let mut n: u64 = 0;
                for byte in &b {
                    n = (n << 8) | *byte as u64;
                }
                return Some(format!("b'{:b}'", n));
            }
            if is_binary_col(c) {
                return Some(to_hex(&b));
            }
            match String::from_utf8(b) {
                Ok(s) => Some(s),
                Err(e) => Some(to_hex(e.as_bytes())),
            }
        }
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for byte in b {
        s.push_str(&format!("{byte:02X}"));
    }
    s
}

pub fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

fn is_conn_lost(e: &mysql_async::Error) -> bool {
    matches!(e, mysql_async::Error::Io(_) | mysql_async::Error::Driver(_))
}

pub fn fmt_err(e: &mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(se) => format!("Error {} ({}): {}", se.code, se.state, se.message),
        other => other.to_string(),
    }
}

/// Coarse check used for read-only connections: anything that is not plainly
/// a read is treated as a write.
pub fn is_write(sql: &str) -> bool {
    let s = strip_leading_comments(sql).to_ascii_lowercase();
    let first = s.split(|c: char| c.is_whitespace() || c == '(').next().unwrap_or("");
    !matches!(first, "select" | "show" | "describe" | "desc" | "explain" | "use" | "with" | "help" | "")
        || (first == "with" && (s.contains(" update ") || s.contains(" delete ") || s.contains(" insert ")))
        || (first == "select" && s.contains(" into outfile"))
}

fn strip_leading_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if s.starts_with("--") || s.starts_with('#') {
            s = s.find('\n').map(|p| s[p + 1..].trim_start()).unwrap_or("");
        } else if s.starts_with("/*") {
            s = s.find("*/").map(|p| s[p + 2..].trim_start()).unwrap_or("");
        } else {
            return s;
        }
    }
}
