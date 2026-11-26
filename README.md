# Quarry

A modern desktop MySQL client, built as a replacement for MySQL Workbench.
Tauri 2 (Rust) core, Angular 21 UI.

## What it does

| Area | Features |
| --- | --- |
| Connections | Saved profiles with colour and group, TLS modes (preferred / required / verify / off), SSH tunnel (key or password, trust-on-first-use host keys), **read-only** flag that blocks writes. Passwords are kept in Windows Credential Manager. |
| SQL editor | CodeMirror 6 with MySQL highlighting and schema-aware autocomplete (tables and columns of the current schema). Run the statement at the cursor (Ctrl+Enter), run all or the selection (Ctrl+Shift+Enter), cancel a running query (KILL QUERY), EXPLAIN (FORMAT=TREE on 8.0.16+), formatter, per-connection history, open/save `.sql`, confirmation before UPDATE/DELETE without WHERE. Each tab has its own connection, so `USE`, session variables and transactions behave as they would in a terminal. |
| Results grid | Virtualised (handles thousands of rows), keyboard navigation, range selection, copy as TSV / CSV / JSON / INSERT / Markdown / IN-list, value inspector with a JSON view. **Results are editable** when they come from a single table that has a key; changes are reviewed as SQL and applied in one transaction. |
| Schema browser | Schemas → tables / views / routines / triggers → columns, filter, context menus (browse, SELECT, alter, info, rename, duplicate, truncate, drop, copy DDL). |
| Table data | Server-side paging, sorting and WHERE filter, “filter by this value”, inline add / edit / delete, export to CSV. |
| Table designer | Columns (PK / NN / UN / AI / default / comment / collation / generated), indexes, foreign keys, engine options. Generates CREATE or ALTER and shows it for review before running. |
| ER diagram | Auto-laid-out diagram of a schema (dagre). Drag tables (positions are saved), pan and zoom, keys-only mode, highlights related tables on hover, SVG export. |
| Import / export | SQL dump of a whole schema or chosen tables (structure, data, routines, triggers, from one consistent snapshot). Run SQL files of any size (streamed, DELIMITER-aware). CSV import with column mapping. CSV export of any table or query. |
| Admin | Live server status (QPS, reads and writes, threads, network, buffer pool), process list with kill, users and grants (create, password, lock, grant presets, click to revoke), global and session variables (edit with SET). |
| AI assistant | An assistant panel in every query tab (Ctrl+I), backed by **Claude** or **OpenAI**, each with its own API key. It knows the current schema's structure and can look up DDL with tools. Optionally it can run read-only SELECTs (50 rows, inside a `READ ONLY` transaction). Replies stream in, and SQL blocks have Insert / Replace / New tab buttons. Failed statements get a **Fix with…** button. The assistant never runs writes: you run its scripts through the normal path, with read-only and no-WHERE protection still applying. Keys are kept in Windows Credential Manager and used only by the Rust core. Provider, model (Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5, or any chat model on your OpenAI account) and effort are set in Settings. |
| Everywhere | Light and dark themes, command palette (Ctrl+K) to jump to any table or tool, tabs you can drag to reorder. |

## Develop

Needs Node 22.12+, Rust (stable MSVC), and WebView2, which ships with Windows 11.

```bash
npm install
npm run tauri dev        # hot-reloading app
npm run tauri build      # release installer in src-tauri/target/release/bundle
```

A throwaway MySQL with a sample `shop` schema:

```bash
dev/test-db.sh up        # 127.0.0.1:3399, root / quarry-dev
dev/test-db.sh down
```

## Layout

```
src-tauri/src/
  lib.rs        Tauri commands
  store.rs      connection profiles + OS credential store
  ssh.rs        SSH tunnel (russh)
  db.rs         sessions, editor connections, query execution, batches
  transfer.rs   dump / SQL file / CSV jobs with progress + cancel
  sqlsplit.rs   statement splitter (quotes, comments, DELIMITER)
  ai.rs         assistant: Claude agent loop (Messages API over SSE), schema tools, key storage
  ai_openai.rs  assistant: OpenAI agent loop (Chat Completions, streamed function calls)
src/app/
  core/         api wrappers, metadata cache, SQL + DDL generation, workspace state
  ui/           data grid, SQL editor, value inspector, icons
  shell/        title bar, connections, sidebar tree, dialogs, palette, settings
  tabs/         query, data, design, info, ER, admin, dump, import tabs
```
