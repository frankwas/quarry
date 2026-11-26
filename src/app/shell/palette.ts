import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { MetaService } from '../core/meta.service';
import { SettingsService } from '../core/settings.service';
import { WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';

interface Item {
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

/** Ctrl+K: jump to any table, open tools, switch settings. */
@Component({
  selector: 'q-palette',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (mousedown.self)="closed.emit()">
      <div class="pal" (keydown)="key($event)">
        <div class="in">
          <q-icon name="search" [size]="16" />
          <input #inp placeholder="Jump to a table or run a command…" [value]="q()" (input)="q.set($any($event.target).value); sel.set(0)" spellcheck="false" />
          <kbd>Esc</kbd>
        </div>
        <div class="list">
          @for (it of results(); track $index; let i = $index) {
            <div class="item" [class.on]="i === sel()" (mouseenter)="sel.set(i)" (click)="pick(it)">
              <q-icon [name]="it.icon" [size]="14" />
              <span class="label">{{ it.label }}</span>
              @if (it.hint) {
                <span class="hint">{{ it.hint }}</span>
              }
            </div>
          } @empty {
            <div class="none muted">Nothing matches</div>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    .backdrop { position:fixed; inset:0; z-index:600; background:rgba(10,10,8,.28); display:flex; justify-content:center; padding-top:12vh }
    .pal { width:min(620px, 92vw); max-height:60vh; display:flex; flex-direction:column; background:var(--panel); border:1px solid var(--border-strong); border-radius:12px; box-shadow:var(--shadow); overflow:hidden; align-self:flex-start }
    .in { display:flex; align-items:center; gap:10px; padding:0 14px; height:48px; border-bottom:1px solid var(--border); color:var(--muted) }
    .in input { flex:1; border:0; outline:none; background:none; font-size:15px; color:var(--text) }
    .list { overflow:auto; padding:6px }
    .item { display:flex; align-items:center; gap:10px; height:32px; padding:0 10px; border-radius:6px; cursor:pointer; color:var(--text-2) }
    .item.on { background:var(--accent-soft); color:var(--text) }
    .item.on q-icon { color:var(--accent) }
    .label { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    .hint { font-size:11.5px; color:var(--muted) }
    .none { padding:14px }
  `,
})
export class Palette {
  private ws = inject(WorkspaceService);
  private meta = inject(MetaService);
  private settings = inject(SettingsService);
  readonly closed = output<void>();
  readonly q = signal('');
  readonly sel = signal(0);
  readonly tables = signal<Item[]>([]);
  private inp = viewChild.required<ElementRef<HTMLInputElement>>('inp');

  constructor() {
    effect(() => {
      const s = this.ws.active();
      if (!s) return;
      const schema = s.schema();
      this.meta.schemas(s.id).then(async (schemas) => {
        const items: Item[] = [];
        const list = schema ? [schema, ...schemas.filter((x) => x !== schema && !['mysql', 'sys', 'performance_schema', 'information_schema'].includes(x))] : schemas;
        for (const sc of list.slice(0, 12)) {
          try {
            const o = await this.meta.objects(s.id, sc);
            for (const t of [...o.tables, ...o.views]) items.push({ label: t.name, hint: sc, icon: t.type === 'VIEW' ? 'view' : 'table', run: () => this.ws.openData(s, sc, t.name, t.type === 'VIEW') });
          } catch {
            /* skip */
          }
        }
        this.tables.set(items);
      });
    });
    setTimeout(() => this.inp().nativeElement.focus());
  }

  readonly commands = computed<Item[]>(() => {
    const s = this.ws.active();
    const items: Item[] = [];
    if (s) {
      const sc = s.schema();
      items.push(
        { label: 'New query tab', hint: 'Ctrl+T', icon: 'edit', run: () => this.ws.openQuery(s) },
        { label: 'Server status', icon: 'activity', run: () => this.ws.openAdmin(s, 'status') },
        { label: 'Process list', icon: 'server', run: () => this.ws.openAdmin(s, 'processes') },
        { label: 'Users & privileges', icon: 'users', run: () => this.ws.openAdmin(s, 'users') },
        { label: 'Server variables', icon: 'sliders', run: () => this.ws.openAdmin(s, 'variables') },
        { label: 'Export / dump', icon: 'download', run: () => this.ws.open(s, { kind: 'dump', id: `dump-${Date.now()}`, title: 'Export', schema: sc }) },
        { label: 'Run SQL file', icon: 'upload', run: () => this.ws.open(s, { kind: 'import-sql', id: `isql-${Date.now()}`, title: 'Run SQL file' }) },
        { label: 'Import CSV', icon: 'file', run: () => this.ws.open(s, { kind: 'import-csv', id: `csv-${Date.now()}`, title: 'Import CSV', schema: sc, table: null }) },
        { label: 'Refresh schema tree', icon: 'refresh', run: () => this.ws.reload(s) },
        { label: 'Disconnect', hint: s.conn.name, icon: 'unplug', run: () => this.ws.disconnect(s) },
      );
      if (sc) {
        items.push(
          { label: `ER diagram of ${sc}`, icon: 'diagram', run: () => this.ws.openEr(s, sc) },
          { label: `New table in ${sc}`, icon: 'plus', run: () => this.ws.openDesign(s, sc, null) },
        );
      }
    }
    items.push(
      { label: 'Connections', icon: 'db', run: () => this.ws.activeId.set(null) },
      { label: 'Theme: light', icon: 'sun', run: () => this.settings.patch({ theme: 'light' }) },
      { label: 'Theme: dark', icon: 'moon', run: () => this.settings.patch({ theme: 'dark' }) },
      { label: 'Theme: follow system', icon: 'settings', run: () => this.settings.patch({ theme: 'system' }) },
    );
    for (const o of this.ws.sessions()) {
      if (o !== s) items.push({ label: `Switch to ${o.conn.name}`, icon: 'plug', run: () => this.ws.activeId.set(o.id) });
    }
    return items;
  });

  readonly results = computed(() => {
    const q = this.q().trim().toLowerCase();
    const all = [...this.commands(), ...this.tables()];
    if (!q) return [...this.commands().slice(0, 8), ...this.tables().slice(0, 30)];
    const score = (it: Item) => {
      const l = it.label.toLowerCase();
      if (l === q) return 0;
      if (l.startsWith(q)) return 1;
      if (l.includes(q)) return 2;
      // subsequence match
      let i = 0;
      for (const ch of l) if (ch === q[i]) i++;
      return i === q.length ? 3 : 99;
    };
    return all
      .map((it) => ({ it, s: score(it) }))
      .filter((x) => x.s < 99)
      .sort((a, b) => a.s - b.s || a.it.label.length - b.it.label.length)
      .slice(0, 60)
      .map((x) => x.it);
  });

  key(e: KeyboardEvent) {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.sel.set((this.sel() + 1) % Math.max(n, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel.set((this.sel() - 1 + n) % Math.max(n, 1));
    } else if (e.key === 'Enter') {
      const it = this.results()[this.sel()];
      if (it) this.pick(it);
    } else if (e.key === 'Escape') this.closed.emit();
  }

  pick(it: Item) {
    this.closed.emit();
    it.run();
  }
}
