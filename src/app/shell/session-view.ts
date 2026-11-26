import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { SettingsService } from '../core/settings.service';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { AdminTab } from '../tabs/admin-tab';
import { DataTab } from '../tabs/data-tab';
import { DesignTab } from '../tabs/design-tab';
import { DumpTab } from '../tabs/dump-tab';
import { ErTab } from '../tabs/er-tab';
import { ImportCsvTab } from '../tabs/import-csv-tab';
import { ImportSqlTab } from '../tabs/import-sql-tab';
import { InfoTab } from '../tabs/info-tab';
import { QueryTab } from '../tabs/query-tab';
import { DialogService } from '../core/dialog.service';
import { Icon } from '../ui/icon';
import { SchemaTree } from './schema-tree';

@Component({
  selector: 'q-session-view',
  imports: [SchemaTree, Icon, QueryTab, DataTab, DesignTab, InfoTab, ErTab, AdminTab, DumpTab, ImportSqlTab, ImportCsvTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="side" [style.width.px]="settings.s().sidebarWidth">
      <div class="conn-head" [style.--c]="session().conn.color || 'var(--accent)'">
        <span class="dot"></span>
        <div class="ch-main">
          <div class="ch-name">{{ session().conn.name }}</div>
          <div class="ch-ver mono">{{ session().serverVersion }}{{ session().readOnly ? ' · read-only' : '' }}</div>
        </div>
        <button class="btn ghost icon sm" (click)="ws.openQuery(session())" title="New query tab (Ctrl+T)"><q-icon name="plus" /></button>
      </div>
      <q-schema-tree [session]="session()" />
      <nav class="admin">
        <div class="section-title">Server</div>
        <button (click)="ws.openAdmin(session(), 'status')"><q-icon name="activity" [size]="14" />Status</button>
        <button (click)="ws.openAdmin(session(), 'processes')"><q-icon name="server" [size]="14" />Processes</button>
        <button (click)="ws.openAdmin(session(), 'users')"><q-icon name="users" [size]="14" />Users & privileges</button>
        <button (click)="ws.openAdmin(session(), 'variables')"><q-icon name="sliders" [size]="14" />Variables</button>
        <div class="section-title data">Data</div>
        <button (click)="openDump()"><q-icon name="download" [size]="14" />Export / dump</button>
        <button (click)="ws.open(session(), { kind: 'import-sql', id: 'isql-' + now(), title: 'Run SQL file' })"><q-icon name="upload" [size]="14" />Run SQL file</button>
        <button (click)="ws.open(session(), { kind: 'import-csv', id: 'csv-' + now(), title: 'Import CSV', schema: session().schema(), table: null })">
          <q-icon name="file" [size]="14" />Import CSV
        </button>
      </nav>
    </aside>
    <div class="side-resizer" (mousedown)="resizeSide($event)"></div>

    <section class="main">
      <div class="tabs" (dblclick.self)="ws.openQuery(session())">
        @for (t of session().tabs(); track t.id) {
          <div
            class="tab"
            [class.on]="session().activeTab() === t.id"
            (mousedown)="tabDown($event, t)"
            [title]="t.title"
            draggable="true"
            (dragstart)="drag.set(t.id)"
            (dragover)="$event.preventDefault()"
            (drop)="drop(t.id)"
          >
            <q-icon [name]="icon(t)" [size]="13" class="t-ico" [class]="'k-' + t.kind" />
            <span class="t-title">{{ t.title }}</span>
            @if (session().dirty().has(t.id)) {
              <span class="t-dirty" title="Unsaved changes"></span>
            }
            <button class="t-close" (mousedown)="$event.stopPropagation()" (click)="closeTab(t)" title="Close (Ctrl+W)"><q-icon name="x" [size]="12" /></button>
          </div>
        }
        <button class="btn ghost icon sm new-tab" (click)="ws.openQuery(session())" title="New query (Ctrl+T)"><q-icon name="plus" /></button>
      </div>

      <div class="outlet">
        @for (t of session().tabs(); track t.id) {
          <div class="pane" [class.on]="session().activeTab() === t.id">
            @switch (t.kind) {
              @case ('query') {
                <q-query-tab [session]="session()" [tab]="$any(t)" [active]="session().activeTab() === t.id" />
              }
              @case ('data') {
                <q-data-tab [session]="session()" [tab]="$any(t)" [active]="session().activeTab() === t.id" />
              }
              @case ('design') {
                <q-design-tab [session]="session()" [tab]="$any(t)" />
              }
              @case ('info') {
                <q-info-tab [session]="session()" [tab]="$any(t)" />
              }
              @case ('er') {
                <q-er-tab [session]="session()" [tab]="$any(t)" />
              }
              @case ('admin') {
                <q-admin-tab [session]="session()" [tab]="$any(t)" [active]="session().activeTab() === t.id" />
              }
              @case ('dump') {
                <q-dump-tab [session]="session()" [tab]="$any(t)" />
              }
              @case ('import-sql') {
                <q-import-sql-tab [session]="session()" />
              }
              @case ('import-csv') {
                <q-import-csv-tab [session]="session()" [tab]="$any(t)" />
              }
            }
          </div>
        } @empty {
          <div class="empty">
            <q-icon name="db" [size]="30" />
            <div>No tabs open</div>
            <button class="btn" (click)="ws.openQuery(session())"><q-icon name="plus" />New query</button>
            <div class="keys"><kbd>Ctrl</kbd>+<kbd>T</kbd> new query · <kbd>Ctrl</kbd>+<kbd>K</kbd> command palette</div>
          </div>
        }
      </div>
    </section>
  `,
  styles: `
    :host { display:flex; height:100%; min-height:0 }
    .side { flex:none; display:flex; flex-direction:column; min-height:0; background:var(--panel); border-right:1px solid var(--border) }
    .side-resizer { width:4px; margin-left:-2px; cursor:col-resize; z-index:5; flex:none }
    .side-resizer:hover { background:var(--accent) }
    .conn-head { display:flex; align-items:center; gap:10px; padding:10px 8px 6px 14px; flex:none }
    .dot { width:10px; height:10px; border-radius:50%; background:var(--c); box-shadow:0 0 0 3px color-mix(in srgb, var(--c) 25%, transparent) }
    .ch-main { flex:1; min-width:0 }
    .ch-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    .ch-ver { color:var(--muted); font-size:11px }
    q-schema-tree { flex:1; min-height:0 }
    .admin { flex:none; padding:8px 6px 10px; border-top:1px solid var(--border) }
    .admin .section-title { margin:2px 8px 4px }
    .admin .section-title.data { margin-top:8px }
    .admin button { display:flex; align-items:center; gap:8px; width:100%; height:26px; padding:0 8px; border:0; background:none; border-radius:5px; cursor:pointer; color:var(--text-2); text-align:left }
    .admin button:hover { background:var(--hover); color:var(--text) }
    .main { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0 }
    .tabs { display:flex; align-items:flex-end; gap:2px; padding:6px 8px 0; background:var(--bg); border-bottom:1px solid var(--border); overflow-x:auto; flex:none; min-height:38px }
    .tabs::-webkit-scrollbar { height:0 }
    .tab { display:flex; align-items:center; gap:7px; height:31px; padding:0 6px 0 12px; max-width:220px; min-width:90px;
           border:1px solid transparent; border-bottom:0; border-radius:7px 7px 0 0; cursor:pointer; color:var(--text-2); position:relative; flex:none }
    .tab:hover { background:var(--hover) }
    .tab.on { background:var(--panel); border-color:var(--border); color:var(--text); margin-bottom:-1px; height:32px }
    .tab.on::before { content:''; position:absolute; left:10px; right:10px; top:0; height:2px; background:var(--accent); border-radius:0 0 2px 2px }
    .t-title { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    .t-ico.k-query { color:var(--syn-keyword) } .t-ico.k-data { color:var(--syn-number) } .t-ico.k-design { color:var(--warn) }
    .t-ico.k-er { color:var(--accent) } .t-ico.k-admin { color:var(--syn-type) }
    .t-dirty { width:7px; height:7px; border-radius:50%; background:var(--warn) }
    .t-close { display:flex; align-items:center; justify-content:center; width:20px; height:20px; border:0; background:none; border-radius:4px; color:var(--muted); cursor:pointer; opacity:0 }
    .tab:hover .t-close, .tab.on .t-close { opacity:1 }
    .t-close:hover { background:var(--active); color:var(--text) }
    .new-tab { margin:0 0 4px 4px }
    .outlet { flex:1; min-height:0; position:relative; background:var(--panel) }
    .pane { position:absolute; inset:0; display:none }
    .pane.on { display:block }
    .keys { font-size:12px; margin-top:6px }
  `,
})
export class SessionView {
  readonly ws = inject(WorkspaceService);
  readonly settings = inject(SettingsService);
  private dialog = inject(DialogService);
  readonly session = input.required<OpenSession>();
  readonly drag = signal<string | null>(null);

  now = () => Date.now();

  icon(t: Tab): string {
    return { query: 'edit', data: 'table', design: 'sliders', info: 'info', er: 'diagram', admin: 'server', dump: 'download', 'import-sql': 'upload', 'import-csv': 'file' }[t.kind];
  }

  tabDown(e: MouseEvent, t: Tab) {
    if (e.button === 1) {
      e.preventDefault();
      this.closeTab(t);
    } else if (e.button === 0) this.session().activeTab.set(t.id);
  }

  async closeTab(t: Tab) {
    const s = this.session();
    if (s.dirty().has(t.id)) {
      const ok = await this.dialog.confirm({ title: `Close “${t.title}”?`, message: 'It has unsaved changes.', confirmText: 'Close without saving', danger: true });
      if (!ok) return;
    }
    this.ws.close(s, t.id);
  }

  drop(targetId: string) {
    const src = this.drag();
    this.drag.set(null);
    if (!src || src === targetId) return;
    this.session().tabs.update((tabs) => {
      const from = tabs.findIndex((t) => t.id === src);
      const to = tabs.findIndex((t) => t.id === targetId);
      const copy = [...tabs];
      const [m] = copy.splice(from, 1);
      copy.splice(to, 0, m);
      return copy;
    });
  }

  openDump() {
    const s = this.session();
    this.ws.open(s, { kind: 'dump', id: `dump-${Date.now()}`, title: 'Export', schema: s.schema() });
  }

  resizeSide(e: MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.settings.s().sidebarWidth;
    const move = (ev: MouseEvent) => this.settings.patch({ sidebarWidth: Math.min(560, Math.max(200, startW + ev.clientX - startX)) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
}
