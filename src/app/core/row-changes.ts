import { GridChanges } from '../ui/data-grid';
import { Cell, Stmt } from './models';
import { literal, qi, qt } from './sql';

export interface EditTarget {
  schema: string;
  table: string;
  /** Real column name for each grid column (null = computed / not from table). */
  columns: (string | null)[];
  /** Grid column indexes that identify a row. */
  keyCols: number[];
}

/**
 * Turn grid changes into parameterised statements plus a readable preview.
 * Rows are matched on their key columns (primary key when the table has one).
 */
export function buildStatements(t: EditTarget, ch: GridChanges): { stmts: Stmt[]; preview: string } {
  const stmts: Stmt[] = [];
  const preview: string[] = [];
  const tbl = qt(t.schema, t.table);

  const where = (row: Cell[]) => {
    const parts: string[] = [];
    const params: Cell[] = [];
    const show: string[] = [];
    for (const k of t.keyCols) {
      const col = qi(t.columns[k]!);
      if (row[k] === null) {
        parts.push(`${col} IS NULL`);
        show.push(`${col} IS NULL`);
      } else {
        parts.push(`${col} = ?`);
        params.push(row[k]);
        show.push(`${col} = ${literal(row[k])}`);
      }
    }
    return { sql: parts.join(' AND '), params, show: show.join(' AND ') };
  };

  for (const row of ch.deletes) {
    const w = where(row);
    stmts.push({ sql: `DELETE FROM ${tbl} WHERE ${w.sql} LIMIT 1`, params: w.params });
    preview.push(`DELETE FROM ${tbl} WHERE ${w.show} LIMIT 1;`);
  }

  for (const u of ch.updates) {
    const sets: string[] = [];
    const show: string[] = [];
    const params: Cell[] = [];
    for (const [c, v] of u.values) {
      const name = t.columns[c];
      if (!name) continue;
      sets.push(`${qi(name)} = ?`);
      params.push(v);
      show.push(`${qi(name)} = ${literal(v)}`);
    }
    if (!sets.length) continue;
    const w = where(u.original);
    stmts.push({ sql: `UPDATE ${tbl} SET ${sets.join(', ')} WHERE ${w.sql} LIMIT 1`, params: [...params, ...w.params] });
    preview.push(`UPDATE ${tbl} SET ${show.join(', ')} WHERE ${w.show} LIMIT 1;`);
  }

  for (const row of ch.inserts) {
    const cols: string[] = [];
    const params: Cell[] = [];
    row.forEach((v, c) => {
      const name = t.columns[c];
      if (v === undefined || !name) return;
      cols.push(qi(name));
      params.push(v);
    });
    if (!cols.length) {
      stmts.push({ sql: `INSERT INTO ${tbl} () VALUES ()` });
      preview.push(`INSERT INTO ${tbl} () VALUES ();`);
      continue;
    }
    stmts.push({ sql: `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params });
    preview.push(`INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${params.map((p) => literal(p)).join(', ')});`);
  }

  return { stmts, preview: preview.join('\n') };
}
