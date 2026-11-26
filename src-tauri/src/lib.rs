mod ai;
mod ai_openai;
mod db;
mod sqlsplit;
mod ssh;
mod store;
mod transfer;

use db::{ExecResponse, ResultSet, Session, Stmt};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use store::{ConnConfig, Secrets, Store};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use transfer::Tasks;

struct AppState {
    store: Mutex<Store>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    tasks: Tasks,
    known_hosts: PathBuf,
}

type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    format!("{err:#}")
}

fn ae(err: anyhow::Error) -> String {
    format!("{err:#}")
}

async fn session(state: &AppState, id: &str) -> Res<Arc<Session>> {
    state
        .sessions
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "Session is closed — reconnect.".to_string())
}

// ------------------------------------------------------------ connections

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnSummary {
    #[serde(flatten)]
    cfg: ConnConfig,
    has_password: bool,
    has_ssh_secret: bool,
}

#[tauri::command]
async fn conn_list(state: State<'_, AppState>) -> Res<Vec<ConnSummary>> {
    let s = state.store.lock().await;
    Ok(s.conns
        .iter()
        .map(|c| ConnSummary {
            cfg: c.clone(),
            has_password: store::has_secret(&c.id, "db"),
            has_ssh_secret: store::has_secret(&c.id, "ssh"),
        })
        .collect())
}

#[tauri::command]
async fn conn_save(state: State<'_, AppState>, mut cfg: ConnConfig, secrets: Secrets) -> Res<ConnConfig> {
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
    }
    state.store.lock().await.upsert(cfg, &secrets).map_err(ae)
}

#[tauri::command]
async fn conn_delete(state: State<'_, AppState>, id: String) -> Res<()> {
    state.store.lock().await.delete(&id).map_err(ae)
}

#[tauri::command]
async fn conn_reorder(state: State<'_, AppState>, ids: Vec<String>) -> Res<()> {
    state.store.lock().await.reorder(&ids).map_err(ae)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    server_version: String,
    ssl: bool,
    elapsed_ms: f64,
}

#[tauri::command]
async fn conn_test(state: State<'_, AppState>, cfg: ConnConfig, secrets: Secrets) -> Res<TestResult> {
    use mysql_async::prelude::*;
    let start = std::time::Instant::now();
    let opened = db::open_raw(&cfg, secrets.password, secrets.ssh_secret, state.known_hosts.clone())
        .await
        .map_err(ae)?;
    let mut conn = opened.first;
    let version: Option<String> = conn.query_first("SELECT VERSION()").await.map_err(e)?;
    let cipher: Option<(String, String)> = conn.query_first("SHOW SESSION STATUS LIKE 'Ssl_cipher'").await.map_err(e)?;
    conn.disconnect().await.ok();
    if let Some(t) = opened.tunnel {
        t.close().await;
    }
    Ok(TestResult {
        server_version: version.unwrap_or_default(),
        ssl: cipher.map(|(_, c)| !c.is_empty()).unwrap_or(false),
        elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

// ------------------------------------------------------------ sessions

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: String,
    server_version: String,
    read_only: bool,
}

#[tauri::command]
async fn session_open(state: State<'_, AppState>, conn_id: String) -> Res<SessionInfo> {
    let cfg = state.store.lock().await.get(&conn_id).ok_or("Unknown connection")?;
    let read_only = cfg.read_only;
    let s = Session::open(cfg, state.known_hosts.clone()).await.map_err(ae)?;
    let id = uuid::Uuid::new_v4().to_string();
    let server_version = s.server_version.clone();
    state.sessions.lock().await.insert(id.clone(), Arc::new(s));
    Ok(SessionInfo { session_id: id, server_version, read_only })
}

#[tauri::command]
async fn session_close(state: State<'_, AppState>, session_id: String) -> Res<()> {
    if let Some(s) = state.sessions.lock().await.remove(&session_id) {
        s.close().await;
    }
    Ok(())
}

#[tauri::command]
async fn editor_open(state: State<'_, AppState>, session_id: String, editor_id: String, database: Option<String>) -> Res<()> {
    session(&state, &session_id).await?.editor_open(editor_id, database).await.map_err(ae)
}

#[tauri::command]
async fn editor_close(state: State<'_, AppState>, session_id: String, editor_id: String) -> Res<()> {
    if let Ok(s) = session(&state, &session_id).await {
        s.editor_close(&editor_id).await;
    }
    Ok(())
}

#[tauri::command]
async fn editor_exec(
    state: State<'_, AppState>,
    session_id: String,
    editor_id: String,
    statements: Vec<String>,
    max_rows: usize,
    stop_on_error: bool,
) -> Res<ExecResponse> {
    let s = session(&state, &session_id).await?;
    s.editor_exec(&editor_id, statements, max_rows, stop_on_error).await.map_err(ae)
}

#[tauri::command]
async fn editor_cancel(state: State<'_, AppState>, session_id: String, editor_id: String) -> Res<()> {
    session(&state, &session_id).await?.editor_cancel(&editor_id).await.map_err(ae)
}

#[tauri::command]
async fn query(state: State<'_, AppState>, session_id: String, sql: String, params: Option<Vec<Option<String>>>, max_rows: Option<usize>) -> Res<ResultSet> {
    let s = session(&state, &session_id).await?;
    s.query(&sql, params.unwrap_or_default(), max_rows.unwrap_or(100_000))
        .await
        .map_err(|err| match err.downcast_ref::<mysql_async::Error>() {
            Some(me) => db::fmt_err(me),
            None => ae(err),
        })
}

#[tauri::command]
async fn exec_batch(state: State<'_, AppState>, session_id: String, statements: Vec<Stmt>, transaction: bool) -> Res<Vec<u64>> {
    session(&state, &session_id).await?.exec_batch(statements, transaction).await.map_err(ae)
}

#[tauri::command]
async fn kill_thread(state: State<'_, AppState>, session_id: String, thread_id: u32, query_only: bool) -> Res<()> {
    session(&state, &session_id).await?.kill(thread_id, query_only).await.map_err(ae)
}

// ------------------------------------------------------------ transfer jobs

async fn run_task<T, F>(state: &AppState, task_id: &str, fut: F) -> Res<T>
where
    F: std::future::Future<Output = anyhow::Result<T>>,
{
    let r = fut.await;
    state.tasks.finish(task_id);
    r.map_err(ae)
}

#[tauri::command]
async fn dump_schema(app: AppHandle, state: State<'_, AppState>, session_id: String, task_id: String, options: transfer::DumpOptions) -> Res<transfer::DumpSummary> {
    let s = session(&state, &session_id).await?;
    let cancel = state.tasks.start(&task_id);
    run_task(&state, &task_id, transfer::dump(app, s, task_id.clone(), cancel, options)).await
}

#[tauri::command]
async fn run_sql_file(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    task_id: String,
    path: String,
    schema: Option<String>,
    continue_on_error: bool,
) -> Res<transfer::ImportSummary> {
    let s = session(&state, &session_id).await?;
    let cancel = state.tasks.start(&task_id);
    run_task(&state, &task_id, transfer::run_sql_file(app, s, task_id.clone(), cancel, path, schema, continue_on_error)).await
}

#[tauri::command]
async fn export_csv(app: AppHandle, state: State<'_, AppState>, session_id: String, task_id: String, sql: String, schema: Option<String>, path: String) -> Res<transfer::CsvExportSummary> {
    let s = session(&state, &session_id).await?;
    let cancel = state.tasks.start(&task_id);
    run_task(&state, &task_id, transfer::export_csv(app, s, task_id.clone(), cancel, sql, schema, path)).await
}

#[tauri::command]
async fn preview_csv(path: String, delimiter: Option<String>, has_header: bool) -> Res<transfer::CsvPreview> {
    tokio::task::spawn_blocking(move || transfer::preview_csv(&path, delimiter, has_header))
        .await
        .map_err(e)?
        .map_err(ae)
}

#[tauri::command]
async fn import_csv(app: AppHandle, state: State<'_, AppState>, session_id: String, task_id: String, options: transfer::CsvImportOptions) -> Res<transfer::CsvImportSummary> {
    let s = session(&state, &session_id).await?;
    let cancel = state.tasks.start(&task_id);
    run_task(&state, &task_id, transfer::import_csv(app, s, task_id.clone(), cancel, options)).await
}

#[tauri::command]
async fn task_cancel(state: State<'_, AppState>, task_id: String) -> Res<()> {
    state.tasks.cancel(&task_id);
    Ok(())
}

// ------------------------------------------------------------ Claude

#[derive(Serialize)]
struct KeyStatus {
    anthropic: bool,
    openai: bool,
}

#[tauri::command]
async fn ai_key_status() -> Res<KeyStatus> {
    tokio::task::spawn_blocking(|| KeyStatus { anthropic: ai::has_key("anthropic"), openai: ai::has_key("openai") })
        .await
        .map_err(e)
}

#[tauri::command]
async fn ai_set_key(provider: String, key: String) -> Res<()> {
    tokio::task::spawn_blocking(move || ai::set_key(&provider, &key)).await.map_err(e)?.map_err(ae)
}

#[tauri::command]
async fn ai_test_key(provider: String, key: Option<String>) -> Res<Vec<String>> {
    ai::test_key(&provider, key).await.map_err(ae)
}

#[tauri::command]
async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    chat_id: String,
    messages: Vec<serde_json::Value>,
    user_content: serde_json::Value,
    options: ai::ChatOptions,
) -> Res<ai::ChatResult> {
    let s = session(&state, &session_id).await?;
    let cancel = state.tasks.start(&chat_id);
    run_task(&state, &chat_id, ai::chat(app, s, chat_id.clone(), cancel, messages, user_content, options)).await
}

// ------------------------------------------------------------ files

#[tauri::command]
async fn read_text_file(path: String) -> Res<String> {
    tokio::fs::read_to_string(&path).await.map_err(e)
}

#[tauri::command]
async fn write_text_file(path: String, content: String) -> Res<()> {
    tokio::fs::write(&path, content).await.map_err(e)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            let store = Store::load(dir.clone())?;
            app.manage(AppState {
                store: Mutex::new(store),
                sessions: Mutex::new(HashMap::new()),
                tasks: Tasks::default(),
                known_hosts: dir.join("known_hosts.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            conn_list,
            conn_save,
            conn_delete,
            conn_reorder,
            conn_test,
            session_open,
            session_close,
            editor_open,
            editor_close,
            editor_exec,
            editor_cancel,
            query,
            exec_batch,
            kill_thread,
            dump_schema,
            run_sql_file,
            export_csv,
            preview_csv,
            import_csv,
            task_cancel,
            read_text_file,
            write_text_file,
            ai_key_status,
            ai_set_key,
            ai_test_key,
            ai_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
