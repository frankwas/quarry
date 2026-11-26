export type SslMode = 'disabled' | 'preferred' | 'required' | 'verify';

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  keyPath?: string | null;
}

export interface ConnConfig {
  id: string;
  name: string;
  group?: string | null;
  color?: string | null;
  host: string;
  port: number;
  user: string;
  database?: string | null;
  ssl: SslMode;
  ssh?: SshConfig | null;
  readOnly: boolean;
}

export interface ConnSummary extends ConnConfig {
  hasPassword: boolean;
  hasSshSecret: boolean;
}

export interface Secrets {
  password?: string | null;
  sshSecret?: string | null;
}

export interface ColumnInfo {
  name: string;
  orgName: string;
  table: string;
  orgTable: string;
  schema: string;
  typeName: string;
  numeric: boolean;
  binary: boolean;
  primaryKey: boolean;
  uniqueKey: boolean;
  notNull: boolean;
  autoIncrement: boolean;
}

export type Cell = string | null;

export interface ResultSet {
  columns: ColumnInfo[];
  rows: Cell[][];
  totalRows: number;
  truncated: boolean;
  affectedRows: number;
  lastInsertId: number | null;
  info: string;
  warnings: number;
}

export interface StatementResult {
  sql: string;
  elapsedMs: number;
  error: string | null;
  resultSets: ResultSet[];
}

export interface ExecResponse {
  statements: StatementResult[];
  currentDatabase: string | null;
}

export interface Stmt {
  sql: string;
  params?: Cell[];
}

export interface SessionInfo {
  sessionId: string;
  serverVersion: string;
  readOnly: boolean;
}

// ---- schema metadata

export interface TableMeta {
  name: string;
  type: 'BASE TABLE' | 'VIEW' | 'SYSTEM VIEW';
  engine: string | null;
  rows: number | null;
  dataLength: number | null;
  comment: string;
  collation: string | null;
  autoIncrement: number | null;
}

export interface RoutineMeta {
  name: string;
  type: 'PROCEDURE' | 'FUNCTION';
}

export interface TriggerMeta {
  name: string;
  table: string;
  event: string;
  timing: string;
}

export interface ColumnMeta {
  name: string;
  position: number;
  dataType: string;
  columnType: string;
  nullable: boolean;
  default: string | null;
  extra: string;
  key: string;
  comment: string;
  charset: string | null;
  collation: string | null;
  generationExpression: string | null;
}

export interface IndexMeta {
  name: string;
  unique: boolean;
  type: string;
  columns: { name: string; subPart: number | null }[];
  comment: string;
}

export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableDetails {
  schema: string;
  name: string;
  meta: TableMeta | null;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
  ddl: string;
}

export interface TaskProgress {
  taskId: string;
  done: number;
  total: number;
  message: string;
}
