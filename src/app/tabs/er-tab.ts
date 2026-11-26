import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { Graph, layout } from '@dagrejs/dagre';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, errText } from '../core/api';
import { MetaService } from '../core/meta.service';
import { SettingsService } from '../core/settings.service';
import { ToastService } from '../core/toast.service';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';

interface ErCol {
  name: string;
  type: string;
  key: string;
  nullable: boolean;
  fk: boolean;
}
interface ErTable {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: ErCol[];
  isView: boolean;
}
interface ErEdge {
  name: string;
  from: string;
  fromCols: string[];
  to: string;
  toCols: string[];
}

const HEAD = 30;
const ROW = 20;
const CHAR = 7.1;

@Component({
  selector: 'q-er-tab',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './er-tab.html',
  styleUrl: './er-tab.css',
})
export class ErTab implements OnInit {
  private meta = inject(MetaService);
  readonly ws = inject(WorkspaceService);
  private settings = inject(SettingsService);
  private toast = inject(ToastService);

  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'er' }>>();
  private svgRef = viewChild<ElementRef<SVGSVGElement>>('svg');
  private wrapRef = viewChild<ElementRef<HTMLDivElement>>('wrap');

  readonly tables = signal<ErTable[]>([]);
  readonly edges = signal<ErEdge[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly pan = signal({ x: 40, y: 40 });
  readonly zoom = signal(1);
  readonly mode = signal<'all' | 'keys'>(this.settings.get('er.mode', 'all'));
  readonly hover = signal<string | null>(null);
  readonly filter = signal('');
  readonly includeViews = signal(false);

  readonly HEAD = HEAD;
  readonly ROW = ROW;

  readonly shown = computed(() => {
    const keys = this.mode() === 'keys';
    return this.tables()
      .filter((t) => this.includeViews() || !t.isView)
      .map((t) => {
        const cols = keys ? t.cols.filter((c) => c.key === 'PRI' || c.fk) : t.cols;
        return { ...t, cols, h: HEAD + Math.max(cols.length, 1) * ROW + 6 };
      });
  });

  readonly related = computed(() => {
    const h = this.hover();
    if (!h) return null;
    const set = new Set([h]);
    for (const e of this.edges()) {
      if (e.from === h) set.add(e.to);
      if (e.to === h) set.add(e.from);
    }
    return set;
  });

  readonly matches = computed(() => {
    const f = this.filter().toLowerCase();
    return f ? new Set(this.tables().filter((t) => t.name.toLowerCase().includes(f)).map((t) => t.name)) : null;
  });

  readonly paths = computed(() => {
    const byName = new Map(this.shown().map((t) => [t.name, t]));
    const out: { d: string; name: string; from: string; to: string; label: string; self: boolean }[] = [];
    for (const e of this.edges()) {
      const a = byName.get(e.from);
      const b = byName.get(e.to);
      if (!a || !b) continue;
      const ya = this.colY(a, e.fromCols[0]);
      const yb = this.colY(b, e.toCols[0]);
      let d: string;
      if (a === b) {
        const x = a.x + a.w;
        d = `M ${x} ${ya} C ${x + 50} ${ya}, ${x + 50} ${yb}, ${x} ${yb}`;
      } else {
        const aRight = a.x + a.w / 2 < b.x + b.w / 2;
        const x1 = aRight ? a.x + a.w : a.x;
        const x2 = aRight ? b.x : b.x + b.w;
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        d = `M ${x1} ${ya} C ${x1 + (aRight ? dx : -dx)} ${ya}, ${x2 + (aRight ? -dx : dx)} ${yb}, ${x2} ${yb}`;
      }
      out.push({ d, name: e.name, from: e.from, to: e.to, label: `${e.from}(${e.fromCols.join(', ')}) → ${e.to}(${e.toCols.join(', ')})`, self: a === b });
    }
    return out;
  });

  private colY(t: ErTable, col: string): number {
    const i = t.cols.findIndex((c) => c.name === col);
    return t.y + (i < 0 ? HEAD / 2 : HEAD + i * ROW + ROW / 2 + 3);
  }

  async ngOnInit() {
    await this.load(false);
  }

  private posKey() {
    return `er.pos.${this.session().conn.id}.${this.tab().schema}`;
  }

  async load(relayout: boolean) {
    const s = this.session();
    const schema = this.tab().schema;
    this.loading.set(true);
    this.error.set(null);
    try {
      const [cols, fks, objs] = await Promise.all([this.meta.schemaColumns(s.id, schema), this.meta.schemaForeignKeys(s.id, schema), this.meta.objects(s.id, schema)]);
      const views = new Set(objs.views.map((v) => v.name));
      const fkCols = new Set(fks.flatMap((f) => f.columns.map((c) => `${f.table}.${c}`)));
      const saved: Record<string, { x: number; y: number }> = relayout ? {} : this.settings.get(this.posKey(), {});
      const tables: ErTable[] = Object.entries(cols).map(([name, cs]) => {
        const ec = cs.map((c) => ({ name: c.name, type: c.type, key: c.key, nullable: c.nullable, fk: fkCols.has(`${name}.${c.name}`) }));
        const longest = Math.max(name.length + 4, ...ec.map((c) => c.name.length + c.type.length + 5));
        return { name, x: 0, y: 0, w: Math.min(360, Math.max(170, longest * CHAR + 28)), h: HEAD + Math.max(ec.length, 1) * ROW + 6, cols: ec, isView: views.has(name) };
      });
      const edges: ErEdge[] = fks
        .filter((f) => f.refSchema === schema)
        .map((f) => ({ name: f.name, from: f.table, fromCols: f.columns, to: f.refTable, toCols: f.refColumns }));

      const needLayout = tables.some((t) => !saved[t.name]);
      if (needLayout) {
        const g = new Graph();
        g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90, marginx: 0, marginy: 0 });
        g.setDefaultEdgeLabel(() => ({}));
        for (const t of tables) g.setNode(t.name, { width: t.w, height: t.h });
        for (const e of edges) if (e.from !== e.to) g.setEdge(e.to, e.from);
        layout(g);
        // dagre leaves unconnected tables in one long column; wrap them into a grid below.
        const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
        let maxY = 0;
        for (const t of tables) {
          if (!connected.has(t.name) && tables.length > 6) continue;
          const n = g.node(t.name);
          t.x = n.x - t.w / 2;
          t.y = n.y - t.h / 2;
          maxY = Math.max(maxY, t.y + t.h);
        }
        const loose = tables.filter((t) => !connected.has(t.name) && tables.length > 6);
        let x = 0;
        let y = maxY + (maxY ? 60 : 0);
        let rowH = 0;
        const width = Math.max(1200, ...tables.filter((t) => connected.has(t.name)).map((t) => t.x + t.w));
        for (const t of loose) {
          if (x + t.w > width) {
            x = 0;
            y += rowH + 30;
            rowH = 0;
          }
          t.x = x;
          t.y = y;
          x += t.w + 30;
          rowH = Math.max(rowH, t.h);
        }
      }
      for (const t of tables) {
        if (saved[t.name]) {
          t.x = saved[t.name].x;
          t.y = saved[t.name].y;
        }
      }
      this.tables.set(tables);
      this.edges.set(edges);
      if (relayout || needLayout) {
        this.savePositions();
        setTimeout(() => this.fit());
      }
    } catch (e) {
      this.error.set(errText(e));
    } finally {
      this.loading.set(false);
    }
  }

  private savePositions() {
    const pos: Record<string, { x: number; y: number }> = {};
    for (const t of this.tables()) pos[t.name] = { x: Math.round(t.x), y: Math.round(t.y) };
    this.settings.put(this.posKey(), pos);
  }

  setMode(m: 'all' | 'keys') {
    this.mode.set(m);
    this.settings.put('er.mode', m);
  }

  // ------------------------------------------------------------ interaction

  wheel(e: WheelEvent) {
    e.preventDefault();
    const rect = this.wrapRef()!.nativeElement.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // wheel zooms around the pointer; shift+wheel (or a sideways swipe) pans
    if (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
      const z0 = this.zoom();
      const z = Math.min(2.5, Math.max(0.15, z0 * Math.exp(-e.deltaY * 0.0015)));
      const p = this.pan();
      this.pan.set({ x: mx - ((mx - p.x) * z) / z0, y: my - ((my - p.y) * z) / z0 });
      this.zoom.set(z);
    } else {
      this.pan.update((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  }

  bgDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    const p0 = this.pan();
    const move = (ev: MouseEvent) => this.pan.set({ x: p0.x + ev.clientX - start.x, y: p0.y + ev.clientY - start.y });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  tableDown(e: MouseEvent, name: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const t0 = this.tables().find((t) => t.name === name)!;
    const o = { x: t0.x, y: t0.y };
    const z = this.zoom();
    let moved = false;
    const move = (ev: MouseEvent) => {
      moved = true;
      const nx = o.x + (ev.clientX - start.x) / z;
      const ny = o.y + (ev.clientY - start.y) / z;
      this.tables.update((ts) => ts.map((t) => (t.name === name ? { ...t, x: Math.round(nx / 10) * 10, y: Math.round(ny / 10) * 10 } : t)));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (moved) this.savePositions();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  open(name: string) {
    const t = this.tables().find((x) => x.name === name);
    this.ws.openData(this.session(), this.tab().schema, name, !!t?.isView);
  }

  zoomBy(f: number) {
    const el = this.wrapRef()!.nativeElement;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const z0 = this.zoom();
    const z = Math.min(2.5, Math.max(0.15, z0 * f));
    const p = this.pan();
    this.pan.set({ x: cx - ((cx - p.x) * z) / z0, y: cy - ((cy - p.y) * z) / z0 });
    this.zoom.set(z);
  }

  fit() {
    const ts = this.shown();
    const el = this.wrapRef()?.nativeElement;
    if (!ts.length || !el) return;
    const x0 = Math.min(...ts.map((t) => t.x));
    const y0 = Math.min(...ts.map((t) => t.y));
    const x1 = Math.max(...ts.map((t) => t.x + t.w));
    const y1 = Math.max(...ts.map((t) => t.y + t.h));
    const z = Math.min(1.2, Math.max(0.15, Math.min((el.clientWidth - 60) / (x1 - x0), (el.clientHeight - 60) / (y1 - y0))));
    this.zoom.set(z);
    this.pan.set({ x: (el.clientWidth - (x1 - x0) * z) / 2 - x0 * z, y: (el.clientHeight - (y1 - y0) * z) / 2 - y0 * z });
  }

  focusTable(name: string) {
    const t = this.shown().find((x) => x.name === name);
    const el = this.wrapRef()?.nativeElement;
    if (!t || !el) return;
    const z = Math.max(this.zoom(), 0.8);
    this.zoom.set(z);
    this.pan.set({ x: el.clientWidth / 2 - (t.x + t.w / 2) * z, y: el.clientHeight / 2 - (t.y + t.h / 2) * z });
    this.hover.set(name);
  }

  focusFirst() {
    const m = this.matches();
    if (m?.size) this.focusTable(m.values().next().value!);
  }

  dim(name: string): boolean {
    const r = this.related();
    const m = this.matches();
    if (r) return !r.has(name);
    if (m) return !m.has(name);
    return false;
  }

  edgeDim(from: string, to: string): boolean {
    const h = this.hover();
    if (h) return from !== h && to !== h;
    const m = this.matches();
    return !!m && !m.has(from) && !m.has(to);
  }

  /** Export the diagram as a standalone SVG with resolved colours. */
  async exportSvg() {
    const svg = this.svgRef()?.nativeElement;
    if (!svg) return;
    const ts = this.shown();
    const x0 = Math.min(...ts.map((t) => t.x)) - 20;
    const y0 = Math.min(...ts.map((t) => t.y)) - 20;
    const x1 = Math.max(...ts.map((t) => t.x + t.w)) + 20;
    const y1 = Math.max(...ts.map((t) => t.y + t.h)) + 20;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
    clone.setAttribute('width', String(x1 - x0));
    clone.setAttribute('height', String(y1 - y0));
    clone.querySelector('.world')?.removeAttribute('transform');
    const cs = getComputedStyle(document.documentElement);
    let text = new XMLSerializer().serializeToString(clone);
    text = text.replace(/var\((--[\w-]+)\)/g, (_, v) => cs.getPropertyValue(v).trim() || '#888');
    const style = `<style>text{font-family:${cs.getPropertyValue('--mono')};font-size:12px}.t-name{font-family:${cs.getPropertyValue('--font')};font-weight:600;font-size:12.5px}</style>`;
    text = text.replace(/(<svg[^>]*>)/, `$1${style}`).replace(/var\(--[\w-]+\)/g, '#888');
    const path = await saveDialog({ filters: [{ name: 'SVG', extensions: ['svg'] }], defaultPath: `${this.tab().schema}-er.svg` });
    if (!path) return;
    await api.writeTextFile(path, text);
    this.toast.success('Diagram exported');
  }

  worldTransform = computed(() => `translate(${this.pan().x} ${this.pan().y}) scale(${this.zoom()})`);
  zoomPct = computed(() => Math.round(this.zoom() * 100));
}
