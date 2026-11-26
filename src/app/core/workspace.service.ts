import { computed, inject, Injectable, signal, WritableSignal } from '@angular/core';
import { api, errText, uid } from './api';
import { MetaService } from './meta.service';
import { ConnSummary } from './models';
import { ToastService } from './toast.service';

export type AdminSection = 'status' | 'processes' | 'users' | 'variables';

export type Tab =
  | { kind: 'query'; id: string; title: string; initialSql: string; filePath?: string; schema?: string | null }
  | { kind: 'data'; id: string; title: string; schema: string; table: string; isView: boolean }
  | { kind: 'design'; id: string; title: string; schema: string; table: string | null }
  | { kind: 'info'; id: string; title: string; schema: string; table: string }
  | { kind: 'er'; id: string; title: string; schema: string }
  | { kind: 'admin'; id: string; title: string; section: AdminSection }
  | { kind: 'dump'; id: string; title: string; schema: string | null }
  | { kind: 'import-sql'; id: string; title: string }
  | { kind: 'import-csv'; id: string; title: string; schema: string | null; table: string | null };

export interface OpenSession {
  id: string;
  conn: ConnSummary;
  serverVersion: string;
  readOnly: boolean;
  tabs: WritableSignal<Tab[]>;
  activeTab: WritableSignal<string | null>;
  /** Schema selected in the sidebar; new query tabs start in it. */
  schema: WritableSignal<string | null>;
  /** Bumped to make the sidebar reload. */
  refresh: WritableSignal<number>;
  dirty: WritableSignal<Set<string>>;
}

@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private meta = inject(MetaService);
  private toast = inject(ToastService);

  readonly sessions = signal<OpenSession[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly connecting = signal<string | null>(null);
  readonly active = computed(() => this.sessions().find((s) => s.id === this.activeId()) ?? null);

  async connect(conn: ConnSummary): Promise<OpenSession | null> {
    this.connecting.set(conn.id);
    try {
      const info = await api.sessionOpen(conn.id);
      const s: OpenSession = {
        id: info.sessionId,
        conn,
        serverVersion: info.serverVersion,
        readOnly: info.readOnly,
        tabs: signal([]),
        activeTab: signal(null),
        schema: signal(conn.database || null),
        refresh: signal(0),
        dirty: signal(new Set()),
      };
      this.sessions.update((l) => [...l, s]);
      this.activeId.set(s.id);
      this.openQuery(s);
      return s;
    } catch (e) {
      this.toast.error(`Could not connect to ${conn.name}: ${errText(e)}`);
      return null;
    } finally {
      this.connecting.set(null);
    }
  }

  async disconnect(s: OpenSession) {
    this.sessions.update((l) => l.filter((x) => x.id !== s.id));
    if (this.activeId() === s.id) this.activeId.set(this.sessions()[0]?.id ?? null);
    this.meta.invalidate(s.id);
    await api.sessionClose(s.id).catch(() => {});
  }

  open(s: OpenSession, tab: Tab) {
    s.tabs.update((t) => [...t, tab]);
    s.activeTab.set(tab.id);
  }

  /** Focus an existing tab matching `key`, or open the one `make` builds. */
  openOrFocus(s: OpenSession, match: (t: Tab) => boolean, make: () => Tab) {
    const existing = s.tabs().find(match);
    if (existing) s.activeTab.set(existing.id);
    else this.open(s, make());
  }

  openQuery(s: OpenSession, sql = '', title?: string, filePath?: string) {
    const n = s.tabs().filter((t) => t.kind === 'query').length + 1;
    this.open(s, { kind: 'query', id: uid('q'), title: title ?? `Query ${n}`, initialSql: sql, filePath, schema: s.schema() });
  }

  openData(s: OpenSession, schema: string, table: string, isView = false) {
    this.openOrFocus(
      s,
      (t) => t.kind === 'data' && t.schema === schema && t.table === table,
      () => ({ kind: 'data', id: uid('d'), title: table, schema, table, isView }),
    );
  }

  openDesign(s: OpenSession, schema: string, table: string | null) {
    this.openOrFocus(
      s,
      (t) => t.kind === 'design' && t.schema === schema && t.table === table && table !== null,
      () => ({ kind: 'design', id: uid('ds'), title: table ? `Design ${table}` : 'New table', schema, table }),
    );
  }

  openInfo(s: OpenSession, schema: string, table: string) {
    this.openOrFocus(
      s,
      (t) => t.kind === 'info' && t.schema === schema && t.table === table,
      () => ({ kind: 'info', id: uid('i'), title: `${table} · info`, schema, table }),
    );
  }

  openEr(s: OpenSession, schema: string) {
    this.openOrFocus(
      s,
      (t) => t.kind === 'er' && t.schema === schema,
      () => ({ kind: 'er', id: uid('er'), title: `${schema} · diagram`, schema }),
    );
  }

  openAdmin(s: OpenSession, section: AdminSection) {
    const titles: Record<AdminSection, string> = {
      status: 'Server status',
      processes: 'Processes',
      users: 'Users & privileges',
      variables: 'Variables',
    };
    this.openOrFocus(
      s,
      (t) => t.kind === 'admin' && t.section === section,
      () => ({ kind: 'admin', id: uid('a'), title: titles[section], section }),
    );
  }

  close(s: OpenSession, id: string) {
    const tabs = s.tabs();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    s.tabs.set(next);
    s.dirty.update((d) => {
      const c = new Set(d);
      c.delete(id);
      return c;
    });
    if (s.activeTab() === id) s.activeTab.set(next[Math.min(idx, next.length - 1)]?.id ?? null);
  }

  rename(s: OpenSession, id: string, title: string) {
    s.tabs.update((tabs) => tabs.map((t) => (t.id === id ? { ...t, title } : t)));
  }

  setDirty(s: OpenSession, id: string, dirty: boolean) {
    const has = s.dirty().has(id);
    if (has === dirty) return;
    s.dirty.update((d) => {
      const c = new Set(d);
      if (dirty) c.add(id);
      else c.delete(id);
      return c;
    });
  }

  reload(s: OpenSession, schema?: string) {
    this.meta.invalidate(s.id, schema);
    s.refresh.update((n) => n + 1);
  }
}
