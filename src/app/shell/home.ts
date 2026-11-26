import { ChangeDetectionStrategy, Component, computed, HostListener, inject, OnInit, signal } from '@angular/core';
import { api, errText } from '../core/api';
import { DialogService } from '../core/dialog.service';
import { ConnSummary } from '../core/models';
import { SettingsService } from '../core/settings.service';
import { KEYSTORE } from '../core/platform';
import { ToastService } from '../core/toast.service';
import { WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';
import { ConnForm } from './conn-form';

@Component({
  selector: 'q-home',
  imports: [Icon, ConnForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="wrap">
        <div class="top">
          <div>
            <h1>Connections</h1>
            <p class="muted">{{ conns().length }} saved · double-click or Enter to connect</p>
          </div>
          <span class="grow"></span>
          <div class="search">
            <q-icon name="search" [size]="14" />
            <input #q placeholder="Search connections" [value]="filter()" (input)="filter.set($any($event.target).value)" (keydown.enter)="connectFirst()" />
          </div>
          <button class="btn primary" (click)="edit.set(blank())"><q-icon name="plus" />New connection</button>
        </div>

        @for (g of groups(); track g.name) {
          @if (g.name) {
            <div class="section-title group">{{ g.name }}</div>
          }
          <div class="grid">
            @for (c of g.items; track c.id) {
              <div
                class="conn card"
                tabindex="0"
                [style.--c]="c.color || 'var(--accent)'"
                (dblclick)="connect(c)"
                (keydown.enter)="connect(c)"
                (contextmenu)="openMenu($event, c)"
              >
                <div class="stripe"></div>
                <div class="c-main">
                  <div class="c-name">
                    {{ c.name }}
                    @if (c.readOnly) {
                      <span class="badge warn" title="Writes are blocked"><q-icon name="lock" [size]="10" />&nbsp;read-only</span>
                    }
                  </div>
                  <div class="c-addr mono">{{ c.user }}&#64;{{ c.host }}:{{ c.port }}{{ c.database ? ' / ' + c.database : '' }}</div>
                  <div class="c-tags">
                    @if (c.ssh) {
                      <span class="badge">SSH {{ c.ssh.host }}</span>
                    }
                    @if (c.ssl !== 'disabled') {
                      <span class="badge">TLS {{ c.ssl }}</span>
                    }
                    @if (isOpen(c.id)) {
                      <span class="badge accent">connected</span>
                    }
                  </div>
                </div>
                <div class="c-actions">
                  <button class="btn ghost icon sm" (click)="edit.set(c)" title="Edit"><q-icon name="edit" /></button>
                  <button class="btn ghost icon sm" (click)="openMenu($event, c)" title="More"><q-icon name="more" /></button>
                  <button class="btn primary sm" (click)="connect(c)" [disabled]="ws.connecting() === c.id">
                    @if (ws.connecting() === c.id) {
                      <span class="spin"></span>
                    } @else {
                      Connect
                    }
                  </button>
                </div>
              </div>
            }
          </div>
        } @empty {
          @if (!filter()) {
            <div class="first card">
              <q-icon name="db" [size]="34" />
              <h2>Add your first MySQL connection</h2>
              <p class="muted">Local, remote over TLS, or through an SSH bastion. Passwords go into {{ keystore }}.</p>
              <button class="btn primary" (click)="edit.set(blank())"><q-icon name="plus" />New connection</button>
            </div>
          } @else {
            <div class="empty">No connections match “{{ filter() }}”</div>
          }
        }
      </div>
    </div>

    @if (menu(); as m) {
      <div class="ctx-menu" [style.left.px]="m.x" [style.top.px]="m.y">
        <button (click)="menu.set(null); connect(m.c)"><q-icon name="plug" [size]="14" />Connect</button>
        <button (click)="menu.set(null); edit.set(m.c)"><q-icon name="edit" [size]="14" />Edit…</button>
        <button (click)="menu.set(null); duplicate(m.c)"><q-icon name="copy" [size]="14" />Duplicate</button>
        <hr />
        <button class="danger" (click)="menu.set(null); remove(m.c)"><q-icon name="trash" [size]="14" />Delete…</button>
      </div>
    }

    @if (edit(); as e) {
      <q-conn-form [initial]="e" (cancel)="edit.set(null)" (saved)="onSaved($event)" />
    }
  `,
  styles: `
    :host { display:block; height:100% }
    .wrap { max-width:1080px; margin:0 auto; padding:12px 8px 40px }
    .top { display:flex; align-items:center; gap:12px; margin-bottom:20px }
    h1 { font-size:22px; margin:0 0 2px; letter-spacing:-.01em }
    .top p { margin:0 }
    .grow { flex:1 }
    .search { display:flex; align-items:center; gap:8px; height:30px; padding:0 10px; border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--panel); color:var(--muted); width:240px }
    .search:focus-within { border-color:var(--accent) }
    .search input { border:0; outline:none; background:none; flex:1; color:var(--text); min-width:0 }
    .group { margin:22px 0 8px }
    .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); gap:10px }
    .conn { position:relative; display:flex; align-items:center; gap:12px; padding:14px 14px 14px 18px; overflow:hidden; outline:none; transition:border-color .12s, box-shadow .12s }
    .conn:hover { border-color:var(--border-strong) }
    .conn:focus-visible { border-color:var(--c); box-shadow:0 0 0 3px color-mix(in srgb, var(--c) 22%, transparent) }
    .stripe { position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--c) }
    .c-main { flex:1; min-width:0 }
    .c-name { font-weight:600; font-size:14px; display:flex; align-items:center; gap:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    .c-addr { color:var(--muted); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    .c-tags { display:flex; gap:5px; margin-top:8px; flex-wrap:wrap }
    .c-tags:empty { display:none }
    .c-actions { display:flex; align-items:center; gap:2px }
    .c-actions .btn.ghost { opacity:0; transition:opacity .1s }
    .conn:hover .c-actions .btn.ghost, .conn:focus-within .c-actions .btn.ghost { opacity:1 }
    .first { display:flex; flex-direction:column; align-items:center; text-align:center; padding:48px 24px; gap:6px; color:var(--accent) }
    .first h2 { color:var(--text); font-size:17px; margin:10px 0 0 }
    .first p { max-width:420px; margin:2px 0 14px }
  `,
})
export class Home implements OnInit {
  readonly keystore = KEYSTORE;
  readonly ws = inject(WorkspaceService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  private settings = inject(SettingsService);

  readonly conns = signal<ConnSummary[]>([]);
  readonly filter = signal('');
  readonly edit = signal<ConnSummary | null>(null);
  readonly menu = signal<{ x: number; y: number; c: ConnSummary } | null>(null);

  readonly filtered = computed(() => {
    const f = this.filter().toLowerCase();
    return this.conns().filter((c) => !f || [c.name, c.host, c.user, c.database ?? '', c.group ?? ''].some((x) => x.toLowerCase().includes(f)));
  });

  readonly groups = computed(() => {
    const map = new Map<string, ConnSummary[]>();
    for (const c of this.filtered()) {
      const g = c.group ?? '';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return [...map.entries()].sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0]))).map(([name, items]) => ({ name, items }));
  });

  async ngOnInit() {
    await this.reload();
  }

  async reload() {
    try {
      this.conns.set(await api.connList());
    } catch (e) {
      this.toast.error(errText(e));
    }
  }

  blank(): ConnSummary {
    return { id: '', name: '', host: '127.0.0.1', port: 3306, user: 'root', ssl: 'preferred', readOnly: false, color: null, hasPassword: false, hasSshSecret: false } as ConnSummary;
  }

  isOpen(id: string) {
    return this.ws.sessions().some((s) => s.conn.id === id);
  }

  async connect(c: ConnSummary) {
    const existing = this.ws.sessions().find((s) => s.conn.id === c.id);
    if (existing) return this.ws.activeId.set(existing.id);
    await this.ws.connect(c);
  }

  connectFirst() {
    const c = this.filtered()[0];
    if (c) this.connect(c);
  }

  async onSaved(e: { conn: ConnSummary; connect: boolean }) {
    this.edit.set(null);
    await this.reload();
    if (e.connect) await this.connect(e.conn);
  }

  async duplicate(c: ConnSummary) {
    const { hasPassword, hasSshSecret, ...cfg } = c;
    await api.connSave({ ...cfg, id: '', name: `${c.name} (copy)` }, {});
    await this.reload();
    this.toast.show('Duplicated — re-enter the password in the copy');
  }

  async remove(c: ConnSummary) {
    if (!(await this.dialog.confirm({ title: `Delete “${c.name}”?`, message: 'The saved connection and its stored passwords are removed. Your databases are not touched.', confirmText: 'Delete', danger: true }))) return;
    await api.connDelete(c.id);
    await this.reload();
  }

  openMenu(e: MouseEvent, c: ConnSummary) {
    e.preventDefault();
    e.stopPropagation();
    this.menu.set({ x: Math.min(e.clientX, window.innerWidth - 210), y: Math.min(e.clientY, window.innerHeight - 160), c });
  }

  act(fn: () => unknown) {
    this.menu.set(null);
    fn();
  }

  @HostListener('document:mousedown', ['$event'])
  docDown(e: MouseEvent) {
    if (this.menu() && !(e.target as HTMLElement).closest('.ctx-menu')) this.menu.set(null);
  }
}
