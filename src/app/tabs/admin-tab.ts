import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal } from '@angular/core';
import { api, errText } from '../core/api';
import { DialogService } from '../core/dialog.service';
import { rowsOf } from '../core/meta.service';
import { Cell, ResultSet } from '../core/models';
import { formatBytes, literal, qi } from '../core/sql';
import { ToastService } from '../core/toast.service';
import { AdminSection, OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';

interface Sample {
  t: number;
  v: Record<string, number>;
}

const STATUS_VARS = [
  'Uptime',
  'Questions',
  'Com_select',
  'Com_insert',
  'Com_update',
  'Com_delete',
  'Threads_connected',
  'Threads_running',
  'Max_used_connections',
  'Connections',
  'Aborted_connects',
  'Bytes_received',
  'Bytes_sent',
  'Slow_queries',
  'Innodb_buffer_pool_pages_total',
  'Innodb_buffer_pool_pages_free',
  'Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_reads',
  'Innodb_row_lock_waits',
  'Created_tmp_disk_tables',
  'Created_tmp_tables',
  'Open_tables',
  'Table_locks_waited',
];

const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER', 'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'LOCK TABLES', 'CREATE TEMPORARY TABLES'];

@Component({
  selector: 'q-admin-tab',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-tab.html',
  styleUrl: './admin-tab.css',
})
export class AdminTab implements OnDestroy {
  readonly ws = inject(WorkspaceService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'admin' }>>();
  readonly active = input(false);

  readonly error = signal<string | null>(null);
  readonly autoRefresh = signal(true);
  private timer: ReturnType<typeof setInterval> | null = null;

  // status
  readonly samples = signal<Sample[]>([]);
  readonly vars = signal<Record<string, string>>({});

  // processes
  readonly procs = signal<Record<string, Cell>[]>([]);
  readonly hideSleep = signal(true);
  readonly procFilter = signal('');

  // users
  readonly users = signal<{ user: string; host: string; plugin: string; locked: boolean; expired: boolean }[]>([]);
  readonly selUser = signal<{ user: string; host: string } | null>(null);
  readonly grants = signal<string[]>([]);
  readonly privs = PRIVS;
  readonly grantPrivs = signal<Set<string>>(new Set(['SELECT']));
  readonly grantTarget = signal('*.*');
  readonly schemas = signal<string[]>([]);

  // variables
  readonly varRows = signal<{ name: string; value: string }[]>([]);
  readonly varScope = signal<'GLOBAL' | 'SESSION'>('GLOBAL');
  readonly varFilter = signal('');

  readonly section = computed<AdminSection>(() => this.tab().section);

  constructor() {
    effect(() => {
      const active = this.active();
      const auto = this.autoRefresh();
      const sec = this.section();
      this.stop();
      if (!active) return;
      this.refresh();
      if (auto && (sec === 'status' || sec === 'processes')) this.timer = setInterval(() => this.refresh(), sec === 'status' ? 2000 : 3000);
    });
  }

  ngOnDestroy() {
    this.stop();
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    try {
      switch (this.section()) {
        case 'status':
          return await this.loadStatus();
        case 'processes':
          return await this.loadProcs();
        case 'users':
          return await this.loadUsers();
        case 'variables':
          return await this.loadVars();
      }
    } catch (e) {
      this.error.set(errText(e));
      this.stop();
    }
  }

  private q(sql: string, params: Cell[] = []): Promise<ResultSet> {
    return api.query(this.session().id, sql, params);
  }

  // ------------------------------------------------------------ status

  private async loadStatus() {
    const s = this.session().id;
    const list = STATUS_VARS.map((v) => `'${v}'`).join(',');
    const [st, va] = await Promise.all([
      this.q(`SHOW GLOBAL STATUS WHERE Variable_name IN (${list})`),
      Object.keys(this.vars()).length
        ? Promise.resolve(null)
        : this.q(`SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','innodb_buffer_pool_size','version_comment','version','hostname','port','datadir','character_set_server','collation_server','time_zone','system_time_zone','sql_mode','long_query_time','slow_query_log','max_allowed_packet','wait_timeout','innodb_flush_log_at_trx_commit','binlog_format','log_bin','read_only')`),
    ]);
    const v: Record<string, number> = {};
    for (const [k, val] of st.rows) v[k!] = Number(val);
    const now = performance.now();
    // Samples closer than 1s apart make noisy rates; keep the older one.
    const prev = this.samples().at(-1);
    if (!prev || now - prev.t >= 1000) this.samples.update((ss) => [...ss.slice(-59), { t: now, v }]);
    if (va) {
      const m: Record<string, string> = {};
      for (const [k, val] of va.rows) m[k!] = val ?? '';
      this.vars.set(m);
    }
    this.error.set(null);
    void s;
  }

  readonly cur = computed(() => this.samples().at(-1)?.v ?? null);

  /** Per-second rate series for a counter (or sum of counters). */
  rate(keys: string[]): number[] {
    const ss = this.samples();
    const out: number[] = [];
    for (let i = 1; i < ss.length; i++) {
      const dt = (ss[i].t - ss[i - 1].t) / 1000;
      const d = keys.reduce((a, k) => a + (ss[i].v[k] ?? 0) - (ss[i - 1].v[k] ?? 0), 0);
      out.push(dt > 0 ? Math.max(0, d / dt) : 0);
    }
    return out;
  }

  gauge(key: string): number[] {
    return this.samples().map((s) => s.v[key] ?? 0);
  }

  readonly qps = computed(() => this.rate(['Questions']));
  readonly reads = computed(() => this.rate(['Com_select']));
  readonly writes = computed(() => this.rate(['Com_insert', 'Com_update', 'Com_delete']));
  readonly netIn = computed(() => this.rate(['Bytes_received']));
  readonly netOut = computed(() => this.rate(['Bytes_sent']));
  readonly running = computed(() => this.gauge('Threads_running'));
  readonly connected = computed(() => this.gauge('Threads_connected'));

  readonly bufferUse = computed(() => {
    const c = this.cur();
    if (!c || !c['Innodb_buffer_pool_pages_total']) return null;
    return 1 - c['Innodb_buffer_pool_pages_free'] / c['Innodb_buffer_pool_pages_total'];
  });
  readonly hitRatio = computed(() => {
    const c = this.cur();
    if (!c || !c['Innodb_buffer_pool_read_requests']) return null;
    return 1 - c['Innodb_buffer_pool_reads'] / c['Innodb_buffer_pool_read_requests'];
  });

  last(series: number[]): number {
    return series.at(-1) ?? 0;
  }

  spark(series: number[], w = 220, h = 44): string {
    if (series.length < 2) return '';
    const max = Math.max(...series, 1e-9);
    const step = w / (60 - 1);
    const off = w - (series.length - 1) * step;
    return series.map((v, i) => `${(off + i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 8)).toFixed(1)}`).join(' ');
  }

  uptime(sec: number | undefined): string {
    if (!sec) return '—';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  fmtRate(n: number): string {
    return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1);
  }

  fb = formatBytes;

  // ------------------------------------------------------------ processes

  private async loadProcs() {
    const rs = await this.q('SHOW FULL PROCESSLIST');
    this.procs.set(rowsOf(rs));
    this.error.set(null);
  }

  readonly shownProcs = computed(() => {
    const f = this.procFilter().toLowerCase();
    return this.procs().filter((p) => {
      if (this.hideSleep() && p['Command'] === 'Sleep') return false;
      if (p['Command'] === 'Daemon' && this.hideSleep()) return false;
      if (!f) return true;
      return Object.values(p).some((v) => v?.toLowerCase().includes(f));
    });
  });

  async kill(p: Record<string, Cell>, queryOnly: boolean) {
    const id = Number(p['Id']);
    const ok = await this.dialog.confirm({
      title: queryOnly ? `Kill query on thread ${id}?` : `Kill connection ${id}?`,
      message: `${p['User']}@${p['Host']}${p['db'] ? ' · ' + p['db'] : ''}\n\n${(p['Info'] ?? '').slice(0, 500)}`,
      confirmText: queryOnly ? 'Kill query' : 'Kill connection',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.killThread(this.session().id, id, queryOnly);
      this.toast.success('Killed');
      this.loadProcs();
    } catch (e) {
      this.toast.error(errText(e));
    }
  }

  copyInfo(p: Record<string, Cell>) {
    const s = this.session();
    if (p['Info']) this.ws.openQuery(s, p['Info'] + ';', `Thread ${p['Id']}`);
  }

  // ------------------------------------------------------------ users

  private async loadUsers() {
    const rs = await this.q('SELECT * FROM mysql.user ORDER BY User, Host');
    const rows = rowsOf(rs);
    this.users.set(
      rows.map((r) => ({
        user: r['User'] ?? '',
        host: r['Host'] ?? '',
        plugin: r['plugin'] ?? '',
        locked: r['account_locked'] === 'Y',
        expired: r['password_expired'] === 'Y',
      })),
    );
    this.error.set(null);
    this.schemas.set((await this.q('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY 1')).rows.map((r) => r[0]!));
    const sel = this.selUser();
    if (sel) this.pickUser(sel);
  }

  account(u: { user: string; host: string }): string {
    return `${literal(u.user)}@${literal(u.host)}`;
  }

  async pickUser(u: { user: string; host: string }) {
    this.selUser.set(u);
    try {
      const rs = await this.q(`SHOW GRANTS FOR ${this.account(u)}`);
      this.grants.set(rs.rows.map((r) => r[0]!));
    } catch (e) {
      this.grants.set([`-- ${errText(e)}`]);
    }
  }

  private async run(title: string, sql: string, shown?: string, danger = false) {
    if (!(await this.dialog.reviewSql(title, (shown ?? sql) + ';', 'Run', danger))) return false;
    try {
      await api.execBatch(this.session().id, [{ sql }], false);
      this.toast.success('Done');
      return true;
    } catch (e) {
      this.dialog.alert('Failed', errText(e));
      return false;
    }
  }

  async createUser() {
    const name = await this.dialog.prompt('New user', "User name (add @host for a host other than '%')", '', 'Next');
    if (!name) return;
    const [user, host] = name.includes('@') ? name.split('@') : [name, '%'];
    const pw = await this.dialog.prompt('New user', `Password for ${user}@${host}`, '', 'Next');
    if (pw === null) return;
    const acc = this.account({ user, host });
    if (await this.run('Create user', `CREATE USER ${acc} IDENTIFIED BY ${literal(pw)}`, `CREATE USER ${acc} IDENTIFIED BY '••••••'`)) {
      this.selUser.set({ user, host });
      await this.loadUsers();
    }
  }

  async changePassword() {
    const u = this.selUser();
    if (!u) return;
    const pw = await this.dialog.prompt('Change password', `New password for ${u.user}@${u.host}`, '', 'Next');
    if (pw === null) return;
    const acc = this.account(u);
    await this.run('Change password', `ALTER USER ${acc} IDENTIFIED BY ${literal(pw)}`, `ALTER USER ${acc} IDENTIFIED BY '••••••'`);
  }

  async toggleLock() {
    const u = this.users().find((x) => x.user === this.selUser()?.user && x.host === this.selUser()?.host);
    if (!u) return;
    if (await this.run(u.locked ? 'Unlock account' : 'Lock account', `ALTER USER ${this.account(u)} ACCOUNT ${u.locked ? 'UNLOCK' : 'LOCK'}`)) this.loadUsers();
  }

  async dropUser() {
    const u = this.selUser();
    if (!u) return;
    if (await this.run(`Drop ${u.user}@${u.host}`, `DROP USER ${this.account(u)}`, undefined, true)) {
      this.selUser.set(null);
      this.grants.set([]);
      this.loadUsers();
    }
  }

  togglePriv(p: string) {
    this.grantPrivs.update((s) => {
      const c = new Set(s);
      if (c.has(p)) c.delete(p);
      else c.add(p);
      return c;
    });
  }

  presetPrivs(kind: 'read' | 'write' | 'all' | 'none') {
    const sets = {
      read: ['SELECT', 'SHOW VIEW'],
      write: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SHOW VIEW', 'EXECUTE'],
      all: PRIVS,
      none: [],
    };
    this.grantPrivs.set(new Set(sets[kind]));
  }

  async grant() {
    const u = this.selUser();
    if (!u || !this.grantPrivs().size) return;
    const target = this.grantTarget() === '*.*' ? '*.*' : `${qi(this.grantTarget())}.*`;
    const privs = this.grantPrivs().size === PRIVS.length ? 'ALL PRIVILEGES' : [...this.grantPrivs()].join(', ');
    if (await this.run('Grant privileges', `GRANT ${privs} ON ${target} TO ${this.account(u)}`)) this.pickUser(u);
  }

  async revoke(line: string) {
    const u = this.selUser();
    if (!u || !/^GRANT /i.test(line) || /^GRANT USAGE ON/i.test(line) || /^GRANT PROXY/i.test(line)) return;
    const m = /^GRANT (.+?) ON (.+?) TO /i.exec(line);
    if (!m) return;
    const sql = `REVOKE ${m[1]} ON ${m[2]} FROM ${this.account(u)}`;
    if (await this.run('Revoke privileges', sql, undefined, true)) this.pickUser(u);
  }

  // ------------------------------------------------------------ variables

  private async loadVars() {
    const rs = await this.q(`SHOW ${this.varScope()} VARIABLES`);
    this.varRows.set(rs.rows.map((r) => ({ name: r[0]!, value: r[1] ?? '' })));
    this.error.set(null);
  }

  setScope(s: 'GLOBAL' | 'SESSION') {
    this.varScope.set(s);
    this.loadVars();
  }

  readonly shownVars = computed(() => {
    const f = this.varFilter().toLowerCase();
    return this.varRows().filter((v) => !f || v.name.includes(f) || v.value.toLowerCase().includes(f));
  });

  async editVar(v: { name: string; value: string }) {
    const nv = await this.dialog.prompt(`SET ${this.varScope()} ${v.name}`, 'New value', v.value, 'Next');
    if (nv === null || nv === v.value) return;
    const val = /^-?\d+(\.\d+)?$/.test(nv) || /^(ON|OFF|DEFAULT|TRUE|FALSE)$/i.test(nv) ? nv : literal(nv);
    if (await this.run('Change variable', `SET ${this.varScope()} ${v.name} = ${val}`)) this.loadVars();
  }
}
