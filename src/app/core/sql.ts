/** SQL text helpers shared by the editor, grid and designers. */

export function qi(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export function qt(schema: string, table: string): string {
  return `${qi(schema)}.${qi(table)}`;
}

export function literal(v: string | null, numeric = false): string {
  if (v === null) return 'NULL';
  if (numeric && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return v;
  if (/^0x[0-9A-F]*$/.test(v) && v.length > 2) return v;
  return (
    "'" +
    v.replace(/[\\'\0\n\r\x1a]/g, (c) =>
      c === '\\' ? '\\\\' : c === "'" ? "\\'" : c === '\0' ? '\\0' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\Z',
    ) +
    "'"
  );
}

export interface SqlSpan {
  text: string;
  from: number;
  to: number;
}

/**
 * Split a script into statements with their source offsets. Mirrors the Rust
 * splitter (quotes, backticks, comments, DELIMITER).
 */
export function splitSql(src: string): SqlSpan[] {
  const out: SqlSpan[] = [];
  let delim = ';';
  let start = 0;
  let i = 0;
  const n = src.length;
  const push = (end: number, next: number) => {
    const raw = src.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text && !onlyComments(text)) out.push({ text, from: start + lead, to: start + lead + text.length });
    start = next;
  };
  while (i < n) {
    // DELIMITER directive at line start
    if ((i === 0 || src[i - 1] === '\n') && /^[ \t]*delimiter[ \t]+/i.test(src.slice(i, i + 40))) {
      if (src.slice(start, i).trim() === '' || onlyComments(src.slice(start, i).trim())) {
        const nl = src.indexOf('\n', i);
        const line = src.slice(i, nl === -1 ? n : nl);
        const d = line.replace(/^[ \t]*delimiter[ \t]+/i, '').trim();
        if (d) delim = d;
        i = nl === -1 ? n : nl + 1;
        start = i;
        continue;
      }
    }
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '#' || (c === '-' && src[i + 1] === '-' && /[\s]/.test(src[i + 2] ?? '\n'))) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (src.startsWith(delim, i)) {
      push(i, i + delim.length);
      i += delim.length;
      continue;
    }
    i++;
  }
  push(n, n);
  return out;
}

function onlyComments(s: string): boolean {
  let rest = s.trim();
  while (rest) {
    if (rest.startsWith('--') || rest.startsWith('#')) {
      const nl = rest.indexOf('\n');
      rest = nl === -1 ? '' : rest.slice(nl + 1).trimStart();
    } else if (rest.startsWith('/*') && !rest.startsWith('/*!')) {
      const e = rest.indexOf('*/');
      rest = e === -1 ? '' : rest.slice(e + 2).trimStart();
    } else return false;
  }
  return true;
}

/** The statement containing (or just before) the cursor. */
export function statementAt(src: string, pos: number): SqlSpan | null {
  const spans = splitSql(src);
  if (!spans.length) return null;
  let best: SqlSpan | null = null;
  for (const s of spans) {
    if (pos >= s.from && pos <= s.to + 1) return s;
    if (s.to < pos) best = s;
  }
  // cursor in whitespace after a statement -> that statement; before the first -> first
  return best ?? spans[0];
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null) return '';
  return n.toLocaleString();
}

export function formatMs(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
