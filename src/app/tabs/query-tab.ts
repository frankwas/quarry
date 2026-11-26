import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, OnInit, signal, viewChild } from '@angular/core';
import { SQLNamespace } from '@codemirror/lang-sql';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { format as formatSql } from 'sql-formatter';
import { api, errText } from '../core/api';
import { DialogService } from '../core/dialog.service';
import { MetaService } from '../core/meta.service';
import { Cell, ResultSet, StatementResult } from '../core/models';
import { buildStatements, EditTarget } from '../core/row-changes';
import { SettingsService } from '../core/settings.service';
import { formatMs, splitSql, statementAt } from '../core/sql';
import { ToastService } from '../core/toast.service';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { DataGrid, GridColumn } from '../ui/data-grid';
import { Icon } from '../ui/icon';
import { SqlEditor, EditorCommand } from '../ui/sql-editor';
import { ValueInspector } from '../ui/value-inspector';
import { ClaudePanel, EditorContext } from '../ui/claude-panel';
import { AiService } from '../core/claude.service';

interface Panel {
  id: string;
  label: string;
  rs: ResultSet;
  stmt: StatementResult;
  columns: GridColumn[];
  edit: EditTarget | null;
}

interface HistoryItem {
  sql: string;
  at: number;
  ms: number;
  ok: boolean;
  schema: string | null;
}

@Component({
  selector: 'q-query-tab',
  imports: [SqlEditor, DataGrid, Icon, ValueInspector, ClaudePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './query-tab.html',
  styleUrl: './query-tab.css',
})
export class QueryTab implements OnInit, OnDestroy {
  private ws = inject(WorkspaceService);
  private meta = inject(MetaService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  readonly settings = inject(SettingsService);
  readonly ai = inject(AiService);

  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'query' }>>();
  readonly active = input(false);

  readonly editor = viewChild.required(SqlEditor);
  readonly grid = viewChild(DataGrid);
  readonly claudePanel = viewChild(ClaudePanel);
  readonly showClaude = signal(this.settings.get('query.claude', false));

  readonly ready = signal(false);
  readonly connError = signal<string | null>(null);
  readonly running = signal(false);
  readonly runStart = signal(0);
  readonly elapsed = signal(0);
  readonly panels = signal<Panel[]>([]);
  readonly messages = signal<StatementResult[]>([]);
  readonly activePanel = signal<string>('messages');
  readonly currentDb = signal<string | null>(null);
  readonly schemas = signal<string[]>([]);
  readonly completion = signal<SQLNamespace>({});
  readonly split = signal(this.settings.get('query.split', 0.45));
  readonly showInspector = signal(this.settings.get('query.inspector', false));
  readonly showHistory = signal(false);
  readonly historyFilter = signal('');
  readonly history = signal<HistoryItem[]>([]);
  readonly gridDirty = signal(false);
  readonly selected = signal<{ value: Cell; col: GridColumn | null; row: number } | null>(null);
  readonly filePath = signal<string | null>(null);
  private savedText = '';
  text = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly current = computed(() => this.panels().find((p) => p.id === this.activePanel()) ?? null);
  readonly lastStmt = computed(() => this.messages().at(-1) ?? null);
  readonly errorCount = computed(() => this.messages().filter((m) => m.error).length);
  readonly filteredHistory = computed(() => {
    const f = this.historyFilter().toLowerCase();
    return this.history().filter((h) => !f || h.sql.toLowerCase().includes(f));
  });

  readonly commands: EditorCommand[] = [
    { key: 'Mod-Enter', run: () => this.run('current') },
    { key: 'Shift-Mod-Enter', run: () => this.run('all') },
    { key: 'F5', run: () => this.run('all') },
    { key: 'Mod-s', run: () => this.save() },
    { key: 'Shift-Alt-f', run: () => this.format() },
    { key: 'Mod-e', run: () => this.explain() },
    { key: 'Mod-i', run: () => this.toggleClaude() },
  ];

  /** What the Claude panel may include with a question. */
  readonly editorContext = (): EditorContext => {
    const ed = this.editor();
    const err = [...this.messages()].reverse().find((m) => m.error);
    return { sql: ed.text(), selection: ed.selection().text, lastError: err ? `${err.error}\n\nStatement:\n${err.sql}` : null };
  };

  toggleClaude() {
    this.showClaude.update((v) => !v);
    this.settings.put('query.claude', this.showClaude());
  }

  fixWithClaude(sql: string, error: string) {
    if (!this.showClaude()) this.toggleClaude();
    setTimeout(() => this.claudePanel()?.fix(sql, error));
  }

  claudeInsert(code: string) {
    const ed = this.editor();
    const text = ed.text();
    const sel = ed.selection();
    const sql = code.trim().endsWith(';') ? code.trim() : code.trim() + ';';
    // Insert on its own lines so it never merges with the statement under the cursor.
    const before = sel.from > 0 && text[sel.from - 1] !== '\n' ? '\n\n' : '';
    ed.insertAtCursor(`${before}${sql}\n`);
  }

  claudeReplace(code: string) {
    this.editor().setText(code.trim() + '\n');
    this.editor().focus();
  }

  claudeNewTab(code: string) {
    this.ws.openQuery(this.session(), code.trim() + '\n', 'Claude script');
  }

  constructor() {
    effect(() => {
      // keep completion in sync with current db and sidebar refreshes
      const db = this.currentDb();
      this.session().refresh();
      if (this.ready()) this.loadCompletion(db);
    });
  }

  async ngOnInit() {
    const s = this.session();
    const t = this.tab();
    this.text = t.initialSql;
    this.savedText = t.initialSql;
    this.filePath.set(t.filePath ?? null);
    this.history.set(this.settings.get(`history.${s.conn.id}`, [] as HistoryItem[]));
    try {
      await api.editorOpen(s.id, t.id, t.schema ?? null);
      this.currentDb.set(t.schema ?? null);
      this.ready.set(true);
    } catch (e) {
      this.connError.set(errText(e));
    }
    this.meta.schemas(s.id).then((l) => this.schemas.set(l)).catch(() => {});
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
    api.editorClose(this.session().id, this.tab().id);
  }

  private async loadCompletion(db: string | null) {
    const s = this.session();
    try {
      const schemas = await this.meta.schemas(s.id);
      const ns: Record<string, SQLNamespace> = {};
      for (const sc of schemas) ns[sc] = {};
      if (db) ns[db] = await this.meta.completion(s.id, db);
      this.completion.set(ns);
      this.schemas.set(schemas);
    } catch {
      /* completion is best-effort */
    }
  }

  onText(v: string) {
    this.text = v;
    this.ws.setDirty(this.session(), this.tab().id, !!this.filePath() && v !== this.savedText);
  }

  async useSchema(db: string) {
    if (!db) return;
    await this.exec([`USE \`${db.replace(/`/g, '``')}\``], false);
  }

  // ------------------------------------------------------------ running

  async run(mode: 'current' | 'all') {
    if (this.running() || !this.ready()) return;
    const ed = this.editor();
    const sel = ed.selection();
    let stmts: string[];
    if (sel.text.trim()) {
      stmts = splitSql(sel.text).map((s) => s.text);
      ed.flash(sel.from, sel.to);
    } else if (mode === 'current') {
      const s = statementAt(ed.text(), ed.cursor());
      if (!s) return;
      stmts = [s.text];
      ed.flash(s.from, s.to);
    } else {
      const all = splitSql(ed.text());
      stmts = all.map((s) => s.text);
      if (all.length) ed.flash(all[0].from, all[all.length - 1].to);
    }
    if (!stmts.length) return;
    if (this.settings.s().confirmUnsafeWrites) {
      const unsafe = stmts.filter((s) => /^\s*(update|delete)\b/i.test(s) && !/\bwhere\b/i.test(s));
      if (unsafe.length) {
        const ok = await this.dialog.confirm({
          title: 'Run without a WHERE clause?',
          message: `${unsafe.length === 1 ? 'This statement affects' : 'These statements affect'} every row in the table.`,
          sql: unsafe.join(';\n\n') + ';',
          confirmText: 'Run anyway',
          danger: true,
        });
        if (!ok) return;
      }
    }
    await this.exec(stmts, true);
  }

  async explain() {
    const ed = this.editor();
    const sel = ed.selection();
    const s = sel.text.trim() || statementAt(ed.text(), ed.cursor())?.text;
    if (!s) return;
    const [maj, min, patch] = this.session().serverVersion.split(/[.-]/).map(Number);
    const tree = !/mariadb/i.test(this.session().serverVersion) && (maj > 8 || (maj === 8 && (min > 0 || patch >= 16)));
    await this.exec([`EXPLAIN ${tree ? 'FORMAT=TREE ' : ''}${s.replace(/^\s*explain\s+/i, '')}`], true);
  }

  private async exec(stmts: string[], record: boolean) {
    const s = this.session();
    this.running.set(true);
    this.runStart.set(performance.now());
    this.elapsed.set(0);
    this.timer = setInterval(() => this.elapsed.set(performance.now() - this.runStart()), 100);
    try {
      const res = await api.editorExec(s.id, this.tab().id, stmts, this.settings.s().maxRows, this.settings.s().stopOnError);
      this.currentDb.set(res.currentDatabase);
      this.showResults(res.statements);
      if (record) this.record(res.statements);
      if (res.statements.some((r) => !r.error && /^\s*(create|alter|drop|rename|truncate)\b/i.test(r.sql))) {
        this.ws.reload(s, res.currentDatabase ?? undefined);
      }
    } catch (e) {
      this.messages.set([{ sql: stmts.join(';\n'), elapsedMs: 0, error: errText(e), resultSets: [] }]);
      this.panels.set([]);
      this.activePanel.set('messages');
    } finally {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.running.set(false);
    }
  }

  async cancel() {
    await api.editorCancel(this.session().id, this.tab().id).catch((e) => this.toast.error(errText(e)));
  }

  private showResults(stmts: StatementResult[]) {
    const panels: Panel[] = [];
    stmts.forEach((st, si) => {
      st.resultSets.forEach((rs, ri) => {
        if (!rs.columns.length) return;
        panels.push({
          id: `${si}.${ri}`,
          label: `Result ${panels.length + 1}`,
          rs,
          stmt: st,
          columns: rs.columns.map((c) => ({ name: c.name, typeName: c.typeName, numeric: c.numeric, binary: c.binary, primaryKey: c.primaryKey })),
          edit: null,
        });
      });
    });
    this.panels.set(panels);
    this.messages.set(stmts);
    const firstErr = stmts.some((s) => s.error);
    this.activePanel.set(!firstErr && panels.length ? panels[panels.length - 1].id : 'messages');
    for (const p of panels) this.detectEditable(p);
  }

  /** A result is editable when it maps 1:1 onto one table whose full PK is present. */
  private async detectEditable(p: Panel) {
    const s = this.session();
    if (s.readOnly) return;
    const cols = p.rs.columns;
    const schema = cols[0]?.schema;
    const table = cols[0]?.orgTable;
    if (!schema || !table || cols.some((c) => c.orgTable !== table || c.schema !== schema)) return;
    try {
      const d = await this.meta.tableDetails(s.id, schema, table);
      const pk = d.indexes.find((i) => i.name === 'PRIMARY') ?? d.indexes.find((i) => i.unique && i.columns.every((c) => !d.columns.find((x) => x.name === c.name)?.nullable));
      if (!pk) return;
      const names = cols.map((c) => c.orgName || null);
      const keyCols = pk.columns.map((k) => names.indexOf(k.name));
      if (keyCols.some((k) => k < 0)) return;
      const edit: EditTarget = { schema, table, columns: names, keyCols };
      this.panels.update((ps) => ps.map((x) => (x.id === p.id ? { ...x, edit } : x)));
    } catch {
      /* not editable */
    }
  }

  private record(stmts: StatementResult[]) {
    const now = Date.now();
    const items: HistoryItem[] = stmts.map((s) => ({ sql: s.sql, at: now, ms: s.elapsedMs, ok: !s.error, schema: this.currentDb() }));
    const prev = this.history().filter((h) => !items.some((i) => i.sql === h.sql));
    const next = [...items.reverse(), ...prev].slice(0, 300);
    this.history.set(next);
    this.settings.put(`history.${this.session().conn.id}`, next);
  }

  // ------------------------------------------------------------ grid edits

  async applyEdits() {
    const p = this.current();
    const g = this.grid();
    if (!p?.edit || !g) return;
    const { stmts, preview } = buildStatements(p.edit, g.getChanges());
    if (!stmts.length) return;
    if (!(await this.dialog.reviewSql('Apply changes', preview))) return;
    try {
      await api.execBatch(this.session().id, stmts, true);
      this.toast.success(`Applied ${stmts.length} change${stmts.length > 1 ? 's' : ''}`);
      // re-run the source statement to show fresh data
      await this.exec([p.stmt.sql], false);
    } catch (e) {
      this.dialog.alert('Changes not applied', errText(e));
    }
  }

  discardEdits() {
    this.grid()?.discard();
  }

  // ------------------------------------------------------------ editor helpers

  format() {
    const ed = this.editor();
    const sel = ed.selection();
    const src = sel.text || ed.text();
    try {
      const out = formatSql(src, { language: 'mysql', keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 });
      if (sel.text) ed.replaceRange(sel.from, sel.to, out);
      else ed.setText(out);
    } catch (e) {
      this.toast.error(`Could not format: ${errText(e)}`);
    }
  }

  async openFile() {
    const path = await openDialog({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }], multiple: false });
    if (!path || Array.isArray(path)) return;
    const content = await api.readTextFile(path);
    const s = this.session();
    if (!this.text.trim()) {
      this.editor().setText(content);
      this.savedText = content;
      this.filePath.set(path);
      this.ws.rename(s, this.tab().id, path.split(/[\\/]/).pop()!);
    } else {
      this.ws.openQuery(s, content, path.split(/[\\/]/).pop(), path);
    }
  }

  async save(as = false) {
    let path = this.filePath();
    if (!path || as) {
      path = await saveDialog({ filters: [{ name: 'SQL', extensions: ['sql'] }], defaultPath: `${this.tab().title}.sql` });
      if (!path) return;
    }
    const content = this.editor().text();
    await api.writeTextFile(path, content);
    this.savedText = content;
    this.filePath.set(path);
    const s = this.session();
    this.ws.rename(s, this.tab().id, path.split(/[\\/]/).pop()!);
    this.ws.setDirty(s, this.tab().id, false);
    this.toast.success('Saved');
  }

  useHistory(h: HistoryItem, run = false) {
    const ed = this.editor();
    const t = ed.text();
    ed.setText(t.trim() ? `${t.replace(/\s+$/, '')}\n\n${h.sql};` : `${h.sql};`);
    this.showHistory.set(false);
    ed.focus();
    if (run) this.exec([h.sql], true);
  }

  clearHistory() {
    this.history.set([]);
    this.settings.put(`history.${this.session().conn.id}`, []);
  }

  toggleInspector() {
    this.showInspector.update((v) => !v);
    this.settings.put('query.inspector', this.showInspector());
  }

  async exportResult(kind: 'csv' | 'json' | 'sql') {
    const p = this.current();
    if (!p) return;
    const path = await saveDialog({ filters: [{ name: kind.toUpperCase(), extensions: [kind] }], defaultPath: `result.${kind}` });
    if (!path) return;
    const names = p.rs.columns.map((c) => c.name);
    let content = '';
    if (kind === 'csv') {
      const q = (v: Cell) => (v === null ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      content = [names.map(q).join(','), ...p.rs.rows.map((r) => r.map(q).join(','))].join('\r\n');
    } else if (kind === 'json') {
      content = JSON.stringify(p.rs.rows.map((r) => Object.fromEntries(r.map((v, i) => [names[i], p.rs.columns[i].numeric && v !== null ? Number(v) : v]))), null, 2);
    } else {
      const { literal, qi } = await import('../core/sql');
      const t = p.edit ? `${qi(p.edit.table)}` : '`result`';
      content = p.rs.rows.map((r) => `INSERT INTO ${t} (${names.map(qi).join(', ')}) VALUES (${r.map((v, i) => literal(v, p.rs.columns[i].numeric)).join(', ')});`).join('\n');
    }
    await api.writeTextFile(path, content);
    this.toast.success(`Exported ${p.rs.rows.length.toLocaleString()} rows`);
  }

  startSplit(e: MouseEvent) {
    e.preventDefault();
    const box = (e.target as HTMLElement).parentElement!.getBoundingClientRect();
    const move = (ev: MouseEvent) => this.split.set(Math.min(0.85, Math.max(0.12, (ev.clientY - box.top) / box.height)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.settings.put('query.split', this.split());
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  fmtMs = formatMs;

  relTime(t: number): string {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(t).toLocaleDateString();
  }

  stmtSummary(m: StatementResult): string {
    if (m.error) return m.error;
    const rs = m.resultSets;
    const withCols = rs.find((r) => r.columns.length);
    if (withCols) return `${withCols.totalRows.toLocaleString()} row${withCols.totalRows === 1 ? '' : 's'} returned${withCols.truncated ? ` (showing first ${withCols.rows.length.toLocaleString()})` : ''}`;
    const r = rs[0];
    if (!r) return 'OK';
    let out = `${r.affectedRows.toLocaleString()} row${r.affectedRows === 1 ? '' : 's'} affected`;
    if (r.lastInsertId) out += ` · insert id ${r.lastInsertId}`;
    if (r.warnings) out += ` · ${r.warnings} warning${r.warnings > 1 ? 's' : ''}`;
    if (r.info) out += ` · ${r.info}`;
    return out;
  }
}
