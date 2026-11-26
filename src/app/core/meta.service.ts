import { Injectable } from '@angular/core';
import { api } from './api';
import {
  Cell,
  ColumnMeta,
  ForeignKeyMeta,
  IndexMeta,
  ResultSet,
  RoutineMeta,
  TableDetails,
  TableMeta,
  TriggerMeta,
} from './models';
import { qt } from './sql';

/** Reads rows of a result set as objects keyed by column name. */
export function rowsOf(rs: ResultSet): Record<string, Cell>[] {
  const names = rs.columns.map((c) => c.name);
  return rs.rows.map((r) => {
    const o: Record<string, Cell> = {};
    names.forEach((n, i) => (o[n] = r[i]));
    return o;
  });
}

const num = (v: Cell) => (v === null ? null : Number(v));

export interface SchemaObjects {
  tables: TableMeta[];
  views: TableMeta[];
  routines: RoutineMeta[];
  triggers: TriggerMeta[];
}

/** information_schema access with a per-session cache. */
@Injectable({ providedIn: 'root' })
export class MetaService {
  private cache = new Map<string, Promise<unknown>>();

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  invalidate(sessionId: string, schema?: string) {
    for (const k of [...this.cache.keys()]) {
      if (!k.startsWith(sessionId + '|')) continue;
      if (!schema || k.includes(`|${schema}|`) || k.endsWith(`|${schema}`) || k === `${sessionId}|schemas`) {
        this.cache.delete(k);
      }
    }
  }

  async schemas(s: string): Promise<string[]> {
    return this.cached(`${s}|schemas`, async () => {
      const rs = await api.query(s, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
      return rs.rows.map((r) => r[0]!);
    });
  }

  async objects(s: string, schema: string): Promise<SchemaObjects> {
    return this.cached(`${s}|objects|${schema}`, async () => {
      const [t, r, tr] = await Promise.all([
        api.query(
          s,
          `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH AS SIZE, TABLE_COMMENT,
                  TABLE_COLLATION, AUTO_INCREMENT
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
          [schema],
        ),
        api.query(
          s,
          `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES
            WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
          [schema],
        ),
        api.query(
          s,
          `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
          [schema],
        ),
      ]);
      const all: TableMeta[] = t.rows.map((x) => ({
        name: x[0]!,
        type: x[1] as TableMeta['type'],
        engine: x[2],
        rows: num(x[3]),
        dataLength: num(x[4]),
        comment: x[5] ?? '',
        collation: x[6],
        autoIncrement: num(x[7]),
      }));
      return {
        tables: all.filter((x) => x.type !== 'VIEW'),
        views: all.filter((x) => x.type === 'VIEW'),
        routines: r.rows.map((x) => ({ name: x[0]!, type: x[1] as RoutineMeta['type'] })),
        triggers: tr.rows.map((x) => ({ name: x[0]!, table: x[1]!, event: x[2]!, timing: x[3]! })),
      };
    });
  }

  /** table -> column names for one schema, used by editor autocomplete. */
  async completion(s: string, schema: string): Promise<Record<string, string[]>> {
    return this.cached(`${s}|completion|${schema}`, async () => {
      const rs = await api.query(
        s,
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [schema],
      );
      const out: Record<string, string[]> = {};
      for (const [t, c] of rs.rows) (out[t!] ??= []).push(c!);
      return out;
    });
  }

  async columns(s: string, schema: string, table: string): Promise<ColumnMeta[]> {
    return (await this.tableDetails(s, schema, table)).columns;
  }

  async tableDetails(s: string, schema: string, table: string): Promise<TableDetails> {
    return this.cached(`${s}|details|${schema}|${table}`, async () => {
      const [cols, idx, fks, tbl] = await Promise.all([
        api.query(
          s,
          `SELECT COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
                  COLUMN_KEY, COLUMN_COMMENT, CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION`,
          [schema, table],
        ),
        api.query(
          s,
          `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, COLUMN_NAME, SUB_PART, INDEX_COMMENT
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
          [schema, table],
        ),
        api.query(
          s,
          `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
                  k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
             FROM information_schema.KEY_COLUMN_USAGE k
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
              AND r.TABLE_NAME = k.TABLE_NAME
            WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
          [schema, table],
        ),
        this.objects(s, schema),
      ]);
      const columns: ColumnMeta[] = cols.rows.map((r) => ({
        name: r[0]!,
        position: Number(r[1]),
        dataType: r[2]!,
        columnType: r[3]!,
        nullable: r[4] === 'YES',
        default: r[5],
        extra: r[6] ?? '',
        key: r[7] ?? '',
        comment: r[8] ?? '',
        charset: r[9],
        collation: r[10],
        generationExpression: r[11] || null,
      }));
      const indexes: IndexMeta[] = [];
      for (const r of idx.rows) {
        let ix = indexes.find((i) => i.name === r[0]);
        if (!ix) {
          ix = { name: r[0]!, unique: r[1] === '0', type: r[2]!, columns: [], comment: r[5] ?? '' };
          indexes.push(ix);
        }
        ix.columns.push({ name: r[3] ?? '', subPart: num(r[4]) });
      }
      const foreignKeys: ForeignKeyMeta[] = [];
      for (const r of fks.rows) {
        let fk = foreignKeys.find((f) => f.name === r[0]);
        if (!fk) {
          fk = {
            name: r[0]!,
            columns: [],
            refSchema: r[2]!,
            refTable: r[3]!,
            refColumns: [],
            onUpdate: r[5]!,
            onDelete: r[6]!,
          };
          foreignKeys.push(fk);
        }
        fk.columns.push(r[1]!);
        fk.refColumns.push(r[4]!);
      }
      const meta = [...tbl.tables, ...tbl.views].find((t) => t.name === table) ?? null;
      let ddl = '';
      try {
        const kw = meta?.type === 'VIEW' ? 'VIEW' : 'TABLE';
        const rs = await api.query(s, `SHOW CREATE ${kw} ${qt(schema, table)}`);
        ddl = rs.rows[0]?.[1] ?? '';
      } catch {
        /* no privilege */
      }
      return { schema, name: table, meta, columns, indexes, foreignKeys, ddl };
    });
  }

  /** All FKs of a schema in one query (for the ER diagram). */
  async schemaForeignKeys(s: string, schema: string): Promise<(ForeignKeyMeta & { table: string })[]> {
    const rs = await api.query(
      s,
      `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
              k.REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [schema],
    );
    const out: (ForeignKeyMeta & { table: string })[] = [];
    for (const r of rs.rows) {
      let fk = out.find((f) => f.table === r[0] && f.name === r[1]);
      if (!fk) {
        fk = { table: r[0]!, name: r[1]!, columns: [], refSchema: r[3]!, refTable: r[4]!, refColumns: [], onUpdate: '', onDelete: '' };
        out.push(fk);
      }
      fk.columns.push(r[2]!);
      fk.refColumns.push(r[5]!);
    }
    return out;
  }

  async schemaColumns(s: string, schema: string): Promise<Record<string, { name: string; type: string; key: string; nullable: boolean }[]>> {
    const rs = await api.query(
      s,
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [schema],
    );
    const out: Record<string, { name: string; type: string; key: string; nullable: boolean }[]> = {};
    for (const r of rs.rows) (out[r[0]!] ??= []).push({ name: r[1]!, type: r[2]!, key: r[3] ?? '', nullable: r[4] === 'YES' });
    return out;
  }

  async charsets(s: string): Promise<{ charset: string; defaultCollation: string }[]> {
    return this.cached(`${s}|charsets`, async () => {
      const rs = await api.query(s, 'SELECT CHARACTER_SET_NAME, DEFAULT_COLLATE_NAME FROM information_schema.CHARACTER_SETS ORDER BY 1');
      return rs.rows.map((r) => ({ charset: r[0]!, defaultCollation: r[1]! }));
    });
  }

  async collations(s: string): Promise<{ collation: string; charset: string }[]> {
    return this.cached(`${s}|collations`, async () => {
      const rs = await api.query(s, 'SELECT COLLATION_NAME, CHARACTER_SET_NAME FROM information_schema.COLLATIONS ORDER BY 1');
      return rs.rows.map((r) => ({ collation: r[0]!, charset: r[1]! }));
    });
  }
}
