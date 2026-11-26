import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  Cell,
  ConnConfig,
  ConnSummary,
  ExecResponse,
  ResultSet,
  Secrets,
  SessionInfo,
  Stmt,
  TaskProgress,
} from './models';

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  connList: () => invoke<ConnSummary[]>('conn_list'),
  connSave: (cfg: ConnConfig, secrets: Secrets) => invoke<ConnConfig>('conn_save', { cfg, secrets }),
  connDelete: (id: string) => invoke<void>('conn_delete', { id }),
  connReorder: (ids: string[]) => invoke<void>('conn_reorder', { ids }),
  connTest: (cfg: ConnConfig, secrets: Secrets) =>
    invoke<{ serverVersion: string; ssl: boolean; elapsedMs: number }>('conn_test', { cfg, secrets }),

  sessionOpen: (connId: string) => invoke<SessionInfo>('session_open', { connId }),
  sessionClose: (sessionId: string) => invoke<void>('session_close', { sessionId }),

  editorOpen: (sessionId: string, editorId: string, database: string | null) =>
    invoke<void>('editor_open', { sessionId, editorId, database }),
  editorClose: (sessionId: string, editorId: string) => invoke<void>('editor_close', { sessionId, editorId }),
  editorExec: (sessionId: string, editorId: string, statements: string[], maxRows: number, stopOnError: boolean) =>
    invoke<ExecResponse>('editor_exec', { sessionId, editorId, statements, maxRows, stopOnError }),
  editorCancel: (sessionId: string, editorId: string) => invoke<void>('editor_cancel', { sessionId, editorId }),

  query: (sessionId: string, sql: string, params: Cell[] = [], maxRows?: number) =>
    invoke<ResultSet>('query', { sessionId, sql, params, maxRows }),
  execBatch: (sessionId: string, statements: Stmt[], transaction = true) =>
    invoke<number[]>('exec_batch', { sessionId, statements, transaction }),
  killThread: (sessionId: string, threadId: number, queryOnly: boolean) =>
    invoke<void>('kill_thread', { sessionId, threadId, queryOnly }),

  dumpSchema: (sessionId: string, taskId: string, options: DumpOptions) =>
    invoke<{ tables: number; rows: number; bytes: number }>('dump_schema', { sessionId, taskId, options }),
  runSqlFile: (sessionId: string, taskId: string, path: string, schema: string | null, continueOnError: boolean) =>
    invoke<{ statements: number; errors: string[] }>('run_sql_file', { sessionId, taskId, path, schema, continueOnError }),
  exportCsv: (sessionId: string, taskId: string, sql: string, schema: string | null, path: string) =>
    invoke<{ rows: number }>('export_csv', { sessionId, taskId, sql, schema, path }),
  previewCsv: (path: string, delimiter: string | null, hasHeader: boolean) =>
    invoke<{ headers: string[]; rows: string[][]; delimiter: string }>('preview_csv', { path, delimiter, hasHeader }),
  importCsv: (sessionId: string, taskId: string, options: CsvImportOptions) =>
    invoke<{ rows: number }>('import_csv', { sessionId, taskId, options }),
  taskCancel: (taskId: string) => invoke<void>('task_cancel', { taskId }),

  aiKeyStatus: () => invoke<Record<AiProvider, boolean>>('ai_key_status'),
  aiSetKey: (provider: AiProvider, key: string) => invoke<void>('ai_set_key', { provider, key }),
  aiTestKey: (provider: AiProvider, key: string | null) => invoke<string[]>('ai_test_key', { provider, key }),
  aiChat: (sessionId: string, chatId: string, messages: unknown[], userContent: string, options: AiOptions) =>
    invoke<AiResult>('ai_chat', { sessionId, chatId, messages, userContent, options }),
  onAi: (fn: (e: AiEvent) => void): Promise<UnlistenFn> => listen<AiEvent>('ai-event', (e) => fn(e.payload)),

  readTextFile: (path: string) => invoke<string>('read_text_file', { path }),
  writeTextFile: (path: string, content: string) => invoke<void>('write_text_file', { path, content }),

  onProgress: (fn: (p: TaskProgress) => void): Promise<UnlistenFn> =>
    listen<TaskProgress>('task-progress', (e) => fn(e.payload)),
};

export interface DumpOptions {
  schema: string;
  tables: string[];
  structure: boolean;
  data: boolean;
  routines: boolean;
  triggers: boolean;
  dropIfExists: boolean;
  path: string;
}

export type AiProvider = 'anthropic' | 'openai';

export interface AiOptions {
  provider: AiProvider;
  model: string;
  effort: string;
  allowQueries: boolean;
  schema: string | null;
}

export interface AiResult {
  messages: unknown[];
  stopReason: string;
  notice: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export type AiEvent =
  | { kind: 'text'; chatId: string; text: string }
  | { kind: 'thinking'; chatId: string; text: string }
  | { kind: 'toolStart'; chatId: string; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'toolResult'; chatId: string; id: string; summary: string; isError: boolean }
  | { kind: 'turn'; chatId: string; model: string }
  | { kind: 'fallback'; chatId: string; from: string; to: string };

export interface CsvImportOptions {
  path: string;
  schema: string;
  table: string;
  delimiter: string;
  hasHeader: boolean;
  mapping: (string | null)[];
  emptyAsNull: boolean;
  truncateFirst: boolean;
}

export function errText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

let seq = 0;
export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
}
