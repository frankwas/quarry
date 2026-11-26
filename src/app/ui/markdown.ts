/** Tiny, escape-first markdown for chat replies: fenced code blocks become
 *  separate segments (so the UI can attach SQL actions); prose gets inline
 *  code, bold, italics, headings, lists and paragraphs. */

export type Segment = { kind: 'md'; html: string } | { kind: 'code'; lang: string; code: string; open: boolean };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

function prose(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
    } else if (h) {
      flushPara();
      closeList();
      out.push(`<h4>${inline(h[2])}</h4>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join('');
}

export function renderMarkdown(text: string): Segment[] {
  const segs: Segment[] = [];
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ kind: 'md', html: prose(text.slice(last, m.index)) });
    segs.push({ kind: 'code', lang: (m[1] || '').toLowerCase(), code: m[2].replace(/\n$/, ''), open: m[3] !== '```' });
    last = re.lastIndex;
    if (m[3] !== '```') break;
  }
  if (last < text.length) segs.push({ kind: 'md', html: prose(text.slice(last)) });
  return segs.filter((s) => s.kind === 'code' || s.html);
}
