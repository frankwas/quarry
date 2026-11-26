import {
  afterNextRender,
  ChangeDetectionStrategy,
  inject,
  Injector,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Cell } from '../core/models';
import { literal, qi } from '../core/sql';
import { Icon } from './icon';

export interface GridColumn {
  name: string;
  typeName: string;
  numeric: boolean;
  binary?: boolean;
  primaryKey?: boolean;
  /** Default value hint shown in new rows. */
  hint?: string;
}

export interface GridChanges {
  updates: { original: Cell[]; values: Map<number, Cell> }[];
  inserts: (Cell | undefined)[][];
  deletes: Cell[][];
}

export type SortDir = 'asc' | 'desc';

const ROW_H = 26;
const HEAD_H = 30;
const GUTTER_W = 52;

interface Pos {
  r: number;
  c: number;
}

@Component({
  selector: 'q-data-grid',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-grid.html',
  styleUrl: './data-grid.css',
  host: { tabindex: '0', '(keydown)': 'onKey($event)', '[class.focused]': 'hasFocus()', '(focusin)': 'hasFocus.set(true)', '(focusout)': 'onBlur($event)' },
})
export class DataGrid {
  readonly columns = input.required<GridColumn[]>();
  readonly rows = input.required<Cell[][]>();
  readonly editable = input(false);
  /** Used for "copy as INSERT". */
  readonly tableName = input<string | null>(null);
  readonly sort = input<{ col: number; dir: SortDir } | null>(null);
  /** When true the grid sorts in memory; otherwise it only emits sortChange. */
  readonly localSort = input(true);

  readonly dirtyChange = output<boolean>();
  readonly sortChange = output<{ col: number; dir: SortDir } | null>();
  readonly filterBy = output<{ col: number; value: Cell; op: '=' | '<>' }>();
  readonly selectionChange = output<{ value: Cell; col: GridColumn | null; row: number } | null>();

  private scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');
  private editorEl = viewChild<ElementRef<HTMLInputElement>>('cellEditor');

  readonly rowH = ROW_H;
  readonly headH = HEAD_H;
  readonly gutterW = GUTTER_W;

  readonly scrollTop = signal(0);
  readonly viewportH = signal(600);
  readonly widths = signal<number[]>([]);
  readonly hasFocus = signal(false);

  // edit state
  private edits = new Map<number, Map<number, Cell>>();
  private deleted = new Set<number>();
  readonly inserted = signal<(Cell | undefined)[][]>([]);
  readonly version = signal(0);

  readonly anchor = signal<Pos | null>(null);
  readonly focus = signal<Pos | null>(null);
  readonly editing = signal<{ r: number; c: number; value: string } | null>(null);
  readonly menu = signal<{ x: number; y: number } | null>(null);
  private internalSort = signal<{ col: number; dir: SortDir } | null>(null);

  readonly activeSort = computed(() => (this.localSort() ? this.internalSort() : this.sort()));

  /** View order -> source row index (sorting is a view concern). */
  readonly order = computed(() => {
    const rows = this.rows();
    const idx = rows.map((_, i) => i);
    const s = this.localSort() ? this.internalSort() : null;
    if (s) {
      const col = this.columns()[s.col];
      const mul = s.dir === 'asc' ? 1 : -1;
      idx.sort((a, b) => {
        const x = rows[a][s.col];
        const y = rows[b][s.col];
        if (x === y) return 0;
        if (x === null) return -mul;
        if (y === null) return mul;
        if (col?.numeric) return (Number(x) - Number(y)) * mul;
        return x.localeCompare(y, undefined, { numeric: true }) * mul;
      });
    }
    const ins = this.inserted();
    for (let i = 0; i < ins.length; i++) idx.push(rows.length + i);
    return idx;
  });

  readonly rowCount = computed(() => this.order().length);
  readonly totalH = computed(() => this.rowCount() * ROW_H);

  readonly visible = computed(() => {
    this.version();
    const top = this.scrollTop();
    const h = this.viewportH();
    const start = Math.max(0, Math.floor(top / ROW_H) - 6);
    const end = Math.min(this.rowCount(), Math.ceil((top + h) / ROW_H) + 6);
    const order = this.order();
    const out: { view: number; src: number; cells: Cell[]; state: 'normal' | 'new' | 'deleted'; editedCols: Set<number> }[] = [];
    for (let v = start; v < end; v++) {
      const src = order[v];
      out.push({ view: v, src, cells: this.rowValues(src), state: this.rowState(src), editedCols: new Set(this.edits.get(src)?.keys() ?? []) });
    }
    return out;
  });

  readonly offsetY = computed(() => (this.visible()[0]?.view ?? 0) * ROW_H);

  readonly selRange = computed(() => {
    const a = this.anchor();
    const f = this.focus();
    if (!a || !f) return null;
    return { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) };
  });

  readonly dirtyCount = computed(() => {
    this.version();
    let n = this.deleted.size + this.inserted().length;
    for (const m of this.edits.values()) if (m.size) n++;
    return n;
  });

  readonly selectionInfo = computed(() => {
    const r = this.selRange();
    if (!r) return '';
    const rows = r.r1 - r.r0 + 1;
    const cols = r.c1 - r.c0 + 1;
    if (rows === 1 && cols === 1) return '';
    return `${rows} × ${cols} selected`;
  });

  private resizeObs?: ResizeObserver;
  private injector = inject(Injector);

  constructor() {
    // Reset everything when a new result arrives.
    effect(() => {
      const cols = this.columns();
      const rows = this.rows();
      untracked(() => {
        this.edits.clear();
        this.deleted.clear();
        this.inserted.set([]);
        this.editing.set(null);
        this.anchor.set(rows.length ? { r: 0, c: 0 } : null);
        this.focus.set(rows.length ? { r: 0, c: 0 } : null);
        this.internalSort.set(null);
        this.widths.set(this.measure(cols, rows));
        this.version.update((v) => v + 1);
        const el = this.scroller()?.nativeElement;
        if (el) {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
        this.scrollTop.set(0);
        this.dirtyChange.emit(false);
      });
    });
    effect(() => {
      const f = this.focus();
      this.version();
      untracked(() => {
        if (!f) return this.selectionChange.emit(null);
        const src = this.order()[f.r];
        if (src === undefined) return this.selectionChange.emit(null);
        this.selectionChange.emit({ value: this.rowValues(src)[f.c] ?? null, col: this.columns()[f.c] ?? null, row: src });
      });
    });
  }

  ngAfterViewInit() {
    const el = this.scroller().nativeElement;
    this.viewportH.set(el.clientHeight);
    this.resizeObs = new ResizeObserver(() => this.viewportH.set(el.clientHeight));
    this.resizeObs.observe(el);
  }

  ngOnDestroy() {
    this.resizeObs?.disconnect();
  }

  private measure(cols: GridColumn[], rows: Cell[][]): number[] {
    const ctx = document.createElement('canvas').getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const mono = css.getPropertyValue('--mono');
    const sans = css.getPropertyValue('--font');
    const sample = rows.slice(0, 200);
    return cols.map((c, i) => {
      // header = [key icon] name type [sort icon] + padding
      ctx.font = `600 12px ${sans}`;
      let head = ctx.measureText(c.name).width;
      ctx.font = `10.5px ${mono}`;
      head += ctx.measureText(c.typeName.toLowerCase()).width;
      let w = head + 5 + 16 + 14 + (c.primaryKey ? 17 : 0) + 6;
      ctx.font = `12px ${mono}`;
      for (const r of sample) {
        const v = r[i];
        if (v === null) continue;
        const len = Math.min(v.length, 60);
        w = Math.max(w, ctx.measureText(v.slice(0, len)).width + 20);
      }
      return Math.round(Math.min(Math.max(w, 64), 380));
    });
  }

  // ---------------------------------------------------------------- data

  rowValues(src: number): Cell[] {
    const base = this.rows();
    if (src >= base.length) {
      return (this.inserted()[src - base.length] ?? []).map((v) => (v === undefined ? null : v));
    }
    const e = this.edits.get(src);
    if (!e || !e.size) return base[src];
    return base[src].map((v, i) => (e.has(i) ? e.get(i)! : v));
  }

  isDefault(src: number, c: number): boolean {
    const base = this.rows();
    return src >= base.length && this.inserted()[src - base.length]?.[c] === undefined;
  }

  rowState(src: number): 'normal' | 'new' | 'deleted' {
    if (src >= this.rows().length) return 'new';
    return this.deleted.has(src) ? 'deleted' : 'normal';
  }

  private setCell(src: number, c: number, v: Cell) {
    const base = this.rows();
    if (src >= base.length) {
      this.inserted.update((ins) => {
        const copy = ins.map((r) => [...r]);
        copy[src - base.length][c] = v;
        return copy;
      });
    } else {
      const orig = base[src][c];
      let e = this.edits.get(src);
      if (!e) this.edits.set(src, (e = new Map()));
      if (orig === v) e.delete(c);
      else e.set(c, v);
    }
    this.bump();
  }

  private bump() {
    this.version.update((v) => v + 1);
    this.dirtyChange.emit(this.dirtyCount() > 0);
  }

  getChanges(): GridChanges {
    const base = this.rows();
    const updates: GridChanges['updates'] = [];
    for (const [src, m] of this.edits) {
      if (m.size && !this.deleted.has(src)) updates.push({ original: base[src], values: new Map(m) });
    }
    return {
      updates,
      inserts: this.inserted().map((r) => [...r]),
      deletes: [...this.deleted].map((i) => base[i]),
    };
  }

  discard() {
    this.edits.clear();
    this.deleted.clear();
    this.inserted.set([]);
    this.editing.set(null);
    this.bump();
  }

  addRow() {
    if (!this.editable()) return;
    this.inserted.update((ins) => [...ins, this.columns().map(() => undefined)]);
    this.bump();
    const r = this.rowCount() - 1;
    this.select({ r, c: 0 });
    afterNextRender(() => this.startEdit(), { injector: this.injector });
  }

  deleteSelectedRows() {
    if (!this.editable()) return;
    const range = this.selRange();
    if (!range) return;
    const base = this.rows();
    const order = this.order();
    const removeNew: number[] = [];
    for (let v = range.r0; v <= range.r1; v++) {
      const src = order[v];
      if (src >= base.length) removeNew.push(src - base.length);
      else if (this.deleted.has(src)) this.deleted.delete(src);
      else this.deleted.add(src);
    }
    if (removeNew.length) this.inserted.update((ins) => ins.filter((_, i) => !removeNew.includes(i)));
    this.bump();
  }

  // ---------------------------------------------------------------- selection

  select(p: Pos, extend = false) {
    const max = this.rowCount() - 1;
    const maxC = this.columns().length - 1;
    const q = { r: Math.max(0, Math.min(max, p.r)), c: Math.max(0, Math.min(maxC, p.c)) };
    if (!extend || !this.anchor()) this.anchor.set(q);
    this.focus.set(q);
    this.ensureVisible(q);
  }

  isSelected(view: number, c: number): boolean {
    const r = this.selRange();
    return !!r && view >= r.r0 && view <= r.r1 && c >= r.c0 && c <= r.c1;
  }

  isFocus(view: number, c: number): boolean {
    const f = this.focus();
    return !!f && f.r === view && f.c === c;
  }

  rowSelected(view: number): boolean {
    const r = this.selRange();
    return !!r && view >= r.r0 && view <= r.r1 && r.c0 === 0 && r.c1 === this.columns().length - 1;
  }

  private ensureVisible(p: Pos) {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const top = p.r * ROW_H;
    const viewH = el.clientHeight - HEAD_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + viewH) el.scrollTop = top + ROW_H - viewH;
    const widths = this.widths();
    let left = GUTTER_W;
    for (let i = 0; i < p.c; i++) left += widths[i];
    const right = left + widths[p.c];
    if (left - GUTTER_W < el.scrollLeft) el.scrollLeft = left - GUTTER_W;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }

  onScroll(e: Event) {
    const el = e.target as HTMLDivElement;
    this.scrollTop.set(el.scrollTop);
    if (this.menu()) this.menu.set(null);
  }

  cellDown(e: MouseEvent, view: number, c: number) {
    if (e.button === 2 && this.isSelected(view, c)) return;
    if (this.editing()) this.commitEdit();
    this.select({ r: view, c }, e.shiftKey);
    if (!e.shiftKey) {
      const move = (ev: MouseEvent) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const cell = el?.closest('[data-cell]') as HTMLElement | null;
        if (cell) {
          const [r, cc] = cell.dataset['cell']!.split(':').map(Number);
          this.focus.set({ r, c: cc });
        }
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  }

  gutterDown(e: MouseEvent, view: number) {
    const last = this.columns().length - 1;
    if (e.shiftKey && this.anchor()) {
      this.anchor.update((a) => ({ r: a!.r, c: 0 }));
      this.focus.set({ r: view, c: last });
    } else {
      this.anchor.set({ r: view, c: 0 });
      this.focus.set({ r: view, c: last });
    }
  }

  selectColumn(c: number) {
    if (!this.rowCount()) return;
    this.anchor.set({ r: 0, c });
    this.focus.set({ r: this.rowCount() - 1, c });
  }

  selectAll() {
    if (!this.rowCount()) return;
    this.anchor.set({ r: 0, c: 0 });
    this.focus.set({ r: this.rowCount() - 1, c: this.columns().length - 1 });
  }

  onBlur(e: FocusEvent) {
    const host = (e.currentTarget as HTMLElement) ?? null;
    if (!host || !host.contains(e.relatedTarget as Node)) this.hasFocus.set(false);
  }

  // ---------------------------------------------------------------- sorting

  headerClick(e: MouseEvent, c: number) {
    if ((e.target as HTMLElement).classList.contains('resizer')) return;
    if (e.shiftKey || e.ctrlKey) return this.selectColumn(c);
    const cur = this.activeSort();
    let next: { col: number; dir: SortDir } | null;
    if (!cur || cur.col !== c) next = { col: c, dir: 'asc' };
    else if (cur.dir === 'asc') next = { col: c, dir: 'desc' };
    else next = null;
    if (this.localSort()) this.internalSort.set(next);
    this.sortChange.emit(next);
  }

  startResize(e: MouseEvent, c: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = this.widths()[c];
    const move = (ev: MouseEvent) => {
      const w = Math.max(40, startW + ev.clientX - startX);
      this.widths.update((ws) => ws.map((x, i) => (i === c ? w : x)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  autoFit(c: number) {
    const w = this.measure([this.columns()[c]], this.rows().map((r) => [r[c]]))[0];
    this.widths.update((ws) => ws.map((x, i) => (i === c ? Math.max(w, 64) : x)));
  }

  // ---------------------------------------------------------------- editing

  startEdit(initial?: string) {
    const f = this.focus();
    if (!f || !this.editable()) return;
    const src = this.order()[f.r];
    if (this.rowState(src) === 'deleted') return;
    const cur = this.rowValues(src)[f.c];
    this.editing.set({ r: f.r, c: f.c, value: initial ?? (this.isDefault(src, f.c) ? '' : (cur ?? '')) });
    // The input only exists after the next render; focus it then.
    afterNextRender(
      () => {
        const el = this.editorEl()?.nativeElement;
        if (el) {
          el.focus();
          if (initial === undefined) el.select();
          else el.setSelectionRange(el.value.length, el.value.length);
        }
      },
      { injector: this.injector },
    );
  }

  commitEdit(value?: string) {
    const ed = this.editing();
    if (!ed) return;
    const v = value ?? this.editorEl()?.nativeElement.value ?? ed.value;
    const src = this.order()[ed.r];
    const cur = this.rowValues(src)[ed.c];
    const wasNull = cur === null && !this.isDefault(src, ed.c);
    // Leaving a NULL cell's empty editor untouched keeps it NULL.
    if (!(wasNull && v === '')) this.setCell(src, ed.c, v);
    this.editing.set(null);
    this.hostFocus();
  }

  cancelEdit() {
    this.editing.set(null);
    this.hostFocus();
  }

  editorKey(e: KeyboardEvent) {
    e.stopPropagation();
    const ed = this.editing();
    if (!ed) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.commitEdit();
      this.select({ r: ed.r + 1, c: ed.c });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelEdit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.commitEdit();
      this.select({ r: ed.r, c: ed.c + (e.shiftKey ? -1 : 1) });
    }
  }

  setSelected(v: Cell | undefined) {
    const range = this.selRange();
    if (!range || !this.editable()) return;
    const order = this.order();
    const base = this.rows();
    for (let r = range.r0; r <= range.r1; r++) {
      const src = order[r];
      if (this.rowState(src) === 'deleted') continue;
      for (let c = range.c0; c <= range.c1; c++) {
        if (v === undefined) {
          if (src >= base.length) {
            this.inserted.update((ins) => {
              const copy = ins.map((x) => [...x]);
              copy[src - base.length][c] = undefined;
              return copy;
            });
          }
        } else this.setCell(src, c, v);
      }
    }
    this.bump();
  }

  /** Values from `setValue` in the inspector. */
  setFocused(v: Cell) {
    const f = this.focus();
    if (!f || !this.editable()) return;
    const src = this.order()[f.r];
    if (this.rowState(src) === 'deleted') return;
    this.setCell(src, f.c, v);
  }

  private hostFocus() {
    (this.scroller()?.nativeElement.parentElement as HTMLElement | null)?.focus();
  }

  // ---------------------------------------------------------------- keyboard

  onKey(e: KeyboardEvent) {
    if (this.editing()) return;
    const f = this.focus();
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor((this.viewportH() - HEAD_H) / ROW_H) - 1);
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      if (!f) return this.select({ r: 0, c: 0 });
      this.select({ r: f.r + dr, c: f.c + dc }, e.shiftKey);
    };
    switch (e.key) {
      case 'ArrowDown':
        return mod ? move(this.rowCount(), 0) : move(1, 0);
      case 'ArrowUp':
        return mod ? move(-this.rowCount(), 0) : move(-1, 0);
      case 'ArrowRight':
        return mod ? move(0, this.columns().length) : move(0, 1);
      case 'ArrowLeft':
        return mod ? move(0, -this.columns().length) : move(0, -1);
      case 'PageDown':
        return move(page, 0);
      case 'PageUp':
        return move(-page, 0);
      case 'Home':
        return mod ? move(-this.rowCount(), -this.columns().length) : move(0, -this.columns().length);
      case 'End':
        return mod ? move(this.rowCount(), this.columns().length) : move(0, this.columns().length);
      case 'Tab':
        return move(0, e.shiftKey ? -1 : 1);
      case 'Enter':
      case 'F2':
        e.preventDefault();
        return this.startEdit();
      case 'Escape':
        this.menu.set(null);
        return;
      case 'Delete':
        if (this.rowSelected(this.focus()?.r ?? -1) || e.ctrlKey) {
          e.preventDefault();
          return this.deleteSelectedRows();
        }
        return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      return this.copy(e.shiftKey ? 'tsv-header' : 'tsv');
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      return this.selectAll();
    }
    if (mod && e.key.toLowerCase() === 'v' && this.editable()) {
      e.preventDefault();
      navigator.clipboard.readText().then((t) => this.paste(t));
      return;
    }
    if (mod && e.key === '0' && this.editable()) {
      e.preventDefault();
      return this.setSelected(null);
    }
    if (!mod && !e.altKey && e.key.length === 1 && this.editable()) {
      e.preventDefault();
      this.startEdit(e.key);
    }
  }

  private paste(text: string) {
    const f = this.focus();
    if (!f) return;
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const order = this.order();
    lines.forEach((cells, dr) => {
      const src = order[f.r + dr];
      if (src === undefined || this.rowState(src) === 'deleted') return;
      cells.forEach((v, dc) => {
        if (f.c + dc < this.columns().length) this.setCell(src, f.c + dc, v === 'NULL' ? null : v);
      });
    });
  }

  // ---------------------------------------------------------------- copy

  private selectedMatrix(): { cols: number[]; rows: Cell[][] } {
    const r = this.selRange();
    if (!r) return { cols: [], rows: [] };
    const cols: number[] = [];
    for (let c = r.c0; c <= r.c1; c++) cols.push(c);
    const order = this.order();
    const rows: Cell[][] = [];
    for (let v = r.r0; v <= r.r1; v++) {
      const vals = this.rowValues(order[v]);
      rows.push(cols.map((c) => vals[c]));
    }
    return { cols, rows };
  }

  copy(kind: 'tsv' | 'tsv-header' | 'insert' | 'json' | 'csv' | 'in-list' | 'markdown') {
    const { cols, rows } = this.selectedMatrix();
    if (!cols.length) return;
    const names = cols.map((c) => this.columns()[c].name);
    const numeric = cols.map((c) => this.columns()[c].numeric);
    let text = '';
    const csvq = (v: Cell) => (v === null ? '' : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    switch (kind) {
      case 'tsv':
      case 'tsv-header':
        text = (kind === 'tsv-header' ? names.join('\t') + '\n' : '') + rows.map((r) => r.map((v) => v ?? 'NULL').join('\t')).join('\n');
        break;
      case 'csv':
        text = [names.map(csvq).join(','), ...rows.map((r) => r.map(csvq).join(','))].join('\n');
        break;
      case 'json':
        text = JSON.stringify(
          rows.map((r) => Object.fromEntries(r.map((v, i) => [names[i], numeric[i] && v !== null && v !== '' && !isNaN(Number(v)) ? Number(v) : v]))),
          null,
          2,
        );
        break;
      case 'insert': {
        const t = this.tableName() ?? 'table_name';
        text = rows.map((r) => `INSERT INTO ${t} (${names.map(qi).join(', ')}) VALUES (${r.map((v, i) => literal(v, numeric[i])).join(', ')});`).join('\n');
        break;
      }
      case 'in-list':
        text = '(' + rows.map((r) => literal(r[0], numeric[0])).join(', ') + ')';
        break;
      case 'markdown':
        text = [
          '| ' + names.join(' | ') + ' |',
          '| ' + names.map(() => '---').join(' | ') + ' |',
          ...rows.map((r) => '| ' + r.map((v) => (v ?? 'NULL').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'),
        ].join('\n');
        break;
    }
    navigator.clipboard.writeText(text);
    this.menu.set(null);
  }

  // ---------------------------------------------------------------- context menu

  openMenu(e: MouseEvent, view?: number, c?: number) {
    e.preventDefault();
    if (view !== undefined && c !== undefined && !this.isSelected(view, c)) this.select({ r: view, c });
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 380);
    this.menu.set({ x, y });
  }

  @HostListener('document:mousedown', ['$event'])
  docDown(e: MouseEvent) {
    if (this.menu() && !(e.target as HTMLElement).closest('.ctx-menu')) this.menu.set(null);
  }

  filterFocused(op: '=' | '<>') {
    const f = this.focus();
    if (!f) return;
    const src = this.order()[f.r];
    this.filterBy.emit({ col: f.c, value: this.rowValues(src)[f.c], op });
    this.menu.set(null);
  }

  menuAction(fn: () => void) {
    fn();
    this.menu.set(null);
  }

  // ---------------------------------------------------------------- display helpers

  display(v: Cell): string {
    if (v === null) return 'NULL';
    if (v.length > 300) v = v.slice(0, 300) + '…';
    return v.replace(/\r?\n/g, ' ↵ ');
  }

  editorLeft(c: number): number {
    const w = this.widths();
    let x = GUTTER_W;
    for (let i = 0; i < c; i++) x += w[i];
    return x;
  }

  totalW = computed(() => GUTTER_W + this.widths().reduce((a, b) => a + b, 0));

  trackRow = (_: number, r: { src: number }) => r.src;
}
