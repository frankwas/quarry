import { TableDetails } from './models';
import { literal, qi, qt } from './sql';

export interface ColDef {
  /** Original name (null for new columns). */
  orig: string | null;
  name: string;
  type: string;
  nullable: boolean;
  /** Raw default: null = no default; 'NULL'; CURRENT_TIMESTAMP etc are expressions. */
  default: string | null;
  autoIncrement: boolean;
  unsigned: boolean;
  onUpdateNow: boolean;
  comment: string;
  collation: string | null;
  generated: string | null;
  pk: boolean;
}

export interface IdxDef {
  orig: string | null;
  name: string;
  kind: 'INDEX' | 'UNIQUE' | 'FULLTEXT' | 'SPATIAL';
  columns: string[];
  comment: string;
}

export interface FkDef {
  orig: string | null;
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableDef {
  name: string;
  engine: string;
  collation: string;
  comment: string;
  columns: ColDef[];
  indexes: IdxDef[];
  fks: FkDef[];
}

const EXPR_DEFAULT = /^(CURRENT_TIMESTAMP(\(\d*\))?|NOW\(\d*\)|NULL|\(.*\))$/i;

export function fromDetails(d: TableDetails): TableDef {
  const pk = d.indexes.find((i) => i.name === 'PRIMARY');
  const pkCols = new Set(pk?.columns.map((c) => c.name) ?? []);
  return {
    name: d.name,
    engine: d.meta?.engine ?? 'InnoDB',
    collation: d.meta?.collation ?? '',
    comment: d.meta?.comment ?? '',
    columns: d.columns.map((c) => {
      const unsigned = /\bunsigned\b/i.test(c.columnType);
      return {
        orig: c.name,
        name: c.name,
        type: c.columnType.replace(/\s*unsigned\b/i, '').replace(/\s*zerofill\b/i, ''),
        nullable: c.nullable,
        default: normDefault(c.default, c.extra, c.dataType),
        autoIncrement: /auto_increment/i.test(c.extra),
        unsigned,
        onUpdateNow: /on update current_timestamp/i.test(c.extra),
        comment: c.comment,
        collation: c.collation,
        generated: c.generationExpression,
        pk: pkCols.has(c.name),
      };
    }),
    indexes: d.indexes
      .filter((i) => i.name !== 'PRIMARY')
      .map((i) => ({
        orig: i.name,
        name: i.name,
        kind: i.type === 'FULLTEXT' ? 'FULLTEXT' : i.type === 'SPATIAL' ? 'SPATIAL' : i.unique ? 'UNIQUE' : 'INDEX',
        columns: i.columns.map((c) => (c.subPart ? `${c.name}(${c.subPart})` : c.name)),
        comment: i.comment,
      })),
    fks: d.foreignKeys.map((f) => ({ orig: f.name, ...f })),
  };
}

/** information_schema reports defaults unquoted; turn them back into SQL. */
function normDefault(def: string | null, extra: string, dataType: string): string | null {
  if (def === null) return null;
  if (/DEFAULT_GENERATED/i.test(extra) || EXPR_DEFAULT.test(def)) return def;
  if (/^(tinyint|smallint|mediumint|int|bigint|decimal|float|double|bit|year)$/i.test(dataType) && /^-?[\d.]+$/.test(def)) return def;
  if (/^b'[01]*'$/.test(def)) return def;
  // MariaDB already reports string defaults quoted
  if (/^'.*'$/s.test(def)) return def;
  return literal(def);
}

export function colSql(c: ColDef): string {
  let s = `${qi(c.name)} ${c.type}`;
  if (c.unsigned && /int|decimal|float|double/i.test(c.type)) s += ' UNSIGNED';
  if (c.collation && /char|text|enum|set/i.test(c.type)) s += ` COLLATE ${c.collation}`;
  if (c.generated) {
    s += ` GENERATED ALWAYS AS (${c.generated}) STORED`;
    s += c.nullable ? ' NULL' : ' NOT NULL';
  } else {
    s += c.nullable ? ' NULL' : ' NOT NULL';
    if (c.default !== null && c.default !== '' && !c.autoIncrement) s += ` DEFAULT ${c.default}`;
    if (c.onUpdateNow) s += ' ON UPDATE CURRENT_TIMESTAMP';
    if (c.autoIncrement) s += ' AUTO_INCREMENT';
  }
  if (c.comment) s += ` COMMENT ${literal(c.comment)}`;
  return s;
}

function idxCols(cols: string[]): string {
  return cols
    .map((c) => {
      const m = /^(.*)\((\d+)\)$/.exec(c);
      return m ? `${qi(m[1])}(${m[2]})` : qi(c);
    })
    .join(', ');
}

function idxSql(i: IdxDef): string {
  const kw = i.kind === 'INDEX' ? 'INDEX' : `${i.kind} INDEX`;
  return `${kw} ${qi(i.name)} (${idxCols(i.columns)})${i.comment ? ` COMMENT ${literal(i.comment)}` : ''}`;
}

function fkSql(schema: string, f: FkDef): string {
  const ref = f.refSchema && f.refSchema !== schema ? qt(f.refSchema, f.refTable) : qi(f.refTable);
  return `CONSTRAINT ${qi(f.name)} FOREIGN KEY (${f.columns.map(qi).join(', ')}) REFERENCES ${ref} (${f.refColumns.map(qi).join(', ')}) ON UPDATE ${f.onUpdate} ON DELETE ${f.onDelete}`;
}

export function createSql(schema: string, t: TableDef): string {
  const lines = t.columns.map((c) => '  ' + colSql(c));
  const pk = t.columns.filter((c) => c.pk);
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => qi(c.name)).join(', ')})`);
  for (const i of t.indexes) lines.push('  ' + idxSql(i));
  for (const f of t.fks) lines.push('  ' + fkSql(schema, f));
  let s = `CREATE TABLE ${qt(schema, t.name)} (\n${lines.join(',\n')}\n) ENGINE=${t.engine}`;
  if (t.collation) s += ` DEFAULT COLLATE=${t.collation}`;
  if (t.comment) s += ` COMMENT=${literal(t.comment)}`;
  return s;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** ALTER TABLE statements turning `before` into `after`; empty when unchanged. */
export function alterSql(schema: string, before: TableDef, after: TableDef): string[] {
  const out: string[] = [];
  const parts: string[] = [];
  const tbl = qt(schema, before.name);

  // FKs first (dropping), since column/index changes may depend on them
  const fkDrops = before.fks.filter((f) => {
    const n = after.fks.find((x) => x.orig === f.orig);
    return !n || !same({ ...n, orig: null }, { ...f, orig: null });
  });
  if (fkDrops.length) out.push(`ALTER TABLE ${tbl}\n  ${fkDrops.map((f) => `DROP FOREIGN KEY ${qi(f.orig!)}`).join(',\n  ')}`);

  for (const i of before.indexes) {
    const n = after.indexes.find((x) => x.orig === i.orig);
    if (!n || !same({ ...n, orig: null }, { ...i, orig: null })) parts.push(`DROP INDEX ${qi(i.orig!)}`);
  }

  const beforePk = before.columns.filter((c) => c.pk).map((c) => c.orig);
  const afterPk = after.columns.filter((c) => c.pk).map((c) => c.orig ?? c.name);
  const pkChanged = !same(beforePk, afterPk) || after.columns.some((c) => c.pk && c.orig && c.name !== c.orig);
  if (pkChanged && beforePk.length) parts.push('DROP PRIMARY KEY');

  for (const c of before.columns) if (!after.columns.some((x) => x.orig === c.orig)) parts.push(`DROP COLUMN ${qi(c.orig!)}`);

  after.columns.forEach((c, idx) => {
    const pos = idx === 0 ? ' FIRST' : ` AFTER ${qi(after.columns[idx - 1].name)}`;
    if (!c.orig) {
      parts.push(`ADD COLUMN ${colSql(c)}${pos}`);
      return;
    }
    const b = before.columns.find((x) => x.orig === c.orig)!;
    const bIdx = before.columns.filter((x) => after.columns.some((y) => y.orig === x.orig)).indexOf(b);
    const aIdx = after.columns.filter((x) => x.orig).indexOf(c);
    const moved = bIdx !== aIdx;
    const changed = !same({ ...b, pk: false, orig: null }, { ...c, pk: false, orig: null });
    if (changed || moved) {
      parts.push(c.name !== c.orig ? `CHANGE COLUMN ${qi(c.orig)} ${colSql(c)}${moved ? pos : ''}` : `MODIFY COLUMN ${colSql(c)}${moved ? pos : ''}`);
    }
  });

  if (pkChanged && afterPk.length) parts.push(`ADD PRIMARY KEY (${after.columns.filter((c) => c.pk).map((c) => qi(c.name)).join(', ')})`);

  for (const i of after.indexes) {
    const b = before.indexes.find((x) => x.orig === i.orig);
    if (!i.orig || !b || !same({ ...b, orig: null }, { ...i, orig: null })) parts.push(`ADD ${idxSql(i)}`);
  }

  const opts: string[] = [];
  if (after.engine !== before.engine) opts.push(`ENGINE=${after.engine}`);
  if (after.collation !== before.collation && after.collation) opts.push(`DEFAULT COLLATE=${after.collation}`);
  if (after.comment !== before.comment) opts.push(`COMMENT=${literal(after.comment)}`);
  parts.push(...opts);

  if (parts.length) out.push(`ALTER TABLE ${tbl}\n  ${parts.join(',\n  ')}`);

  const fkAdds = after.fks.filter((f) => {
    const b = before.fks.find((x) => x.orig === f.orig);
    return !f.orig || !b || !same({ ...b, orig: null }, { ...f, orig: null });
  });
  if (fkAdds.length) out.push(`ALTER TABLE ${tbl}\n  ${fkAdds.map((f) => `ADD ${fkSql(schema, f)}`).join(',\n  ')}`);

  if (after.name !== before.name) out.push(`RENAME TABLE ${tbl} TO ${qt(schema, after.name)}`);
  return out;
}

export const COMMON_TYPES = [
  'INT',
  'BIGINT',
  'TINYINT(1)',
  'SMALLINT',
  'DECIMAL(10,2)',
  'DOUBLE',
  'VARCHAR(255)',
  'CHAR(36)',
  'TEXT',
  'MEDIUMTEXT',
  'LONGTEXT',
  'JSON',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIME',
  'YEAR',
  "ENUM('a','b')",
  'BLOB',
  'VARBINARY(255)',
  'BINARY(16)',
  'BIT(1)',
];
