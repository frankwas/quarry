import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, errText, uid } from '../core/api';
import { DialogService } from '../core/dialog.service';
import { MetaService } from '../core/meta.service';
import { Cell, ResultSet, TableDetails } from '../core/models';
import { buildStatements, EditTarget } from '../core/row-changes';
import { formatMs, literal, qi, qt } from '../core/sql';
import { ToastService } from '../core/toast.service';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { DataGrid, GridColumn, SortDir } from '../ui/data-grid';
import { Icon } from '../ui/icon';
import { ValueInspector } from '../ui/value-inspector';
import { SettingsService } from '../core/settings.service';

@Component({
  selector: 'q-data-tab',
  imports: [DataGrid, Icon, ValueInspector],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <button class="btn ghost icon sm" (click)="load()" title="Refresh (F5)"><q-icon name="refresh" /></button>
      <div class="where" [class.err]="error()">
        <span class="kw">WHERE</span>
        <input
          class="selectable"
          spellcheck="false"
          [value]="where()"
          (keydown.enter)="applyWhere($any($event.target).value)"
          (blur)="where.set($any($event.target).value)"
          placeholder="e.g. status = 'active' AND created_at > NOW() - INTERVAL 7 DAY   (Enter to apply)"
        />
        @if (where()) {
          <button class="btn ghost icon sm" (click)="applyWhere('')" title="Clear filter"><q-icon name="x" [size]="12" /></button>
        }
      </div>
      <span class="sep"></span>
      @if (edit()) {
        <button class="btn ghost icon sm" (click)="grid()?.addRow()" title="Add row"><q-icon name="plus" /></button>
        <button class="btn ghost icon sm" (click)="grid()?.deleteSelectedRows()" title="Delete selected rows (Ctrl+Delete)"><q-icon name="trash" /></button>
        @if (dirty()) {
          <button class="btn sm" (click)="grid()?.discard()"><q-icon name="undo" />Discard</button>
          <button class="btn primary sm" (click)="apply()"><q-icon name="check" />Apply {{ grid()?.dirtyCount() }}</button>
        }
      } @else if (details() && !tab().isView && !session().readOnly) {
        <span class="badge warn" title="Rows can only be edited when the table has a primary key or a non-null unique key">no key · read-only</span>
      }
      <span class="grow"></span>
      <button class="btn ghost icon sm" [class.on]="inspector()" (click)="inspector.set(!inspector())" title="Value inspector"><q-icon name="info" /></button>
      <button class="btn ghost sm" (click)="openInQuery()" title="Open this query in an editor"><q-icon name="edit" />SQL</button>
      <button class="btn ghost sm" (click)="exportCsv()" title="Export all matching rows to CSV"><q-icon name="download" />Export</button>
      @if (!tab().isView) {
        <button class="btn ghost sm" (click)="ws.openDesign(session(), tab().schema, tab().table)"><q-icon name="sliders" />Structure</button>
      }
    </div>

    <div class="body" [class.with-inspector]="inspector()">
      @if (error()) {
        <div class="error-box err-pad">{{ error() }}</div>
      } @else if (rs(); as r) {
        <q-data-grid
          [columns]="columns()"
          [rows]="r.rows"
          [editable]="!!edit()"
          [tableName]="qi(tab().table)"
          [localSort]="false"
          [sort]="sort()"
          (sortChange)="onSort($event)"
          (dirtyChange)="dirty.set($event)"
          (filterBy)="onFilterBy($event)"
          (selectionChange)="selected.set($event)"
        />
        @if (inspector()) {
          <q-value-inspector [cell]="selected()" [editable]="!!edit()" (apply)="grid()?.setFocused($event)" />
        }
      } @else {
        <div class="empty"><span class="spin"></span></div>
      }
    </div>

    <div class="status">
      @if (loading()) {
        <span class="spin"></span>
      }
      @if (rs(); as r) {
        <span>Rows {{ (offset() + 1).toLocaleString() }}–{{ (offset() + r.rows.length).toLocaleString() }}</span>
        @if (total() !== null) {
          <span class="muted">of {{ total()!.toLocaleString() }}</span>
        } @else {
          <button class="link" (click)="count()">count rows</button>
        }
        <span class="muted">{{ fmtMs(elapsed()) }}</span>
        @if (grid()?.selectionInfo(); as si) {
          <span class="muted">{{ si }}</span>
        }
      }
      <span class="grow"></span>
      <select class="input sm page-size" [value]="pageSize()" (change)="setPageSize(+$any($event.target).value)">
        @for (n of [100, 500, 1000, 5000]; track n) {
          <option [value]="n" [selected]="n === pageSize()">{{ n }} / page</option>
        }
      </select>
      <button class="btn ghost icon sm" [disabled]="offset() === 0" (click)="page(-1)" title="Previous page"><q-icon name="chevronRight" class="flip" /></button>
      <button class="btn ghost icon sm" [disabled]="!hasMore()" (click)="page(1)" title="Next page"><q-icon name="chevronRight" /></button>
    </div>
  `,
  styles: `
    :host { display:flex; flex-direction:column; height:100%; min-height:0 }
    .btn.on { background:var(--accent-soft); color:var(--accent) }
    .where { flex:1; max-width:780px; display:flex; align-items:center; gap:8px; height:28px; padding:0 4px 0 10px;
             border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--panel) }
    .where:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft) }
    .where.err { border-color:var(--danger) }
    .where .kw { font:600 11px var(--mono); color:var(--syn-keyword) }
    .where input { flex:1; border:0; outline:none; background:none; font:12px var(--mono); min-width:0 }
    .body { flex:1; min-height:0; display:grid; grid-template-columns:1fr; position:relative }
    .body.with-inspector { grid-template-columns:1fr 320px }
    .err-pad { margin:12px }
    .status { display:flex; align-items:center; gap:12px; height:30px; padding:0 8px 0 12px; border-top:1px solid var(--border);
              background:var(--panel-2); font-size:12px; flex:none }
    .page-size { width:auto }
    .flip { transform:rotate(180deg) }
    .link { border:0; background:none; color:var(--accent); cursor:pointer; padding:0; font-size:12px }
    .grow { flex:1 }
  `,
})
export class DataTab implements OnInit {
  readonly ws = inject(WorkspaceService);
  private meta = inject(MetaService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);
  private settings = inject(SettingsService);

  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'data' }>>();
  readonly active = input(false);
  readonly grid = viewChild(DataGrid);

  readonly rs = signal<ResultSet | null>(null);
  readonly details = signal<TableDetails | null>(null);
  readonly where = signal('');
  readonly sort = signal<{ col: number; dir: SortDir } | null>(null);
  readonly offset = signal(0);
  readonly pageSize = signal(this.settings.get('data.pageSize', 500));
  readonly total = signal<number | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly elapsed = signal(0);
  readonly dirty = signal(false);
  readonly inspector = signal(false);
  readonly selected = signal<{ value: Cell; col: GridColumn | null; row: number } | null>(null);
  readonly edit = signal<EditTarget | null>(null);

  readonly hasMore = computed(() => (this.rs()?.rows.length ?? 0) >= this.pageSize());

  readonly columns = computed<GridColumn[]>(() => {
    const r = this.rs();
    const d = this.details();
    if (!r) return [];
    return r.columns.map((c) => {
      const m = d?.columns.find((x) => x.name === c.orgName);
      let hint = 'DEFAULT';
      if (m?.extra.includes('auto_increment')) hint = 'auto';
      else if (m?.default != null) hint = m.default;
      else if (m?.nullable) hint = 'NULL';
      return { name: c.name, typeName: m?.columnType.toUpperCase() ?? c.typeName, numeric: c.numeric, binary: c.binary, primaryKey: m?.key === 'PRI', hint };
    });
  });

  fmtMs = formatMs;
  qi = qi;

  async ngOnInit() {
    const t = this.tab();
    try {
      this.details.set(await this.meta.tableDetails(this.session().id, t.schema, t.table));
    } catch {
      /* browse anyway */
    }
    await this.load();
  }

  private sql(withLimit = true): string {
    const t = this.tab();
    let s = `SELECT * FROM ${qt(t.schema, t.table)}`;
    if (this.where().trim()) s += ` WHERE ${this.where().trim()}`;
    const so = this.sort();
    const cols = this.rs()?.columns ?? this.details()?.columns.map((c) => ({ name: c.name })) ?? [];
    if (so && cols[so.col]) s += ` ORDER BY ${qi(cols[so.col].name)} ${so.dir.toUpperCase()}`;
    if (withLimit) s += ` LIMIT ${this.pageSize()} OFFSET ${this.offset()}`;
    return s;
  }

  async load() {
    if (this.dirty() && !(await this.dialog.confirm({ title: 'Discard pending changes?', message: 'Reloading will throw away unsaved edits.', confirmText: 'Discard', danger: true }))) return;
    this.loading.set(true);
    this.error.set(null);
    const start = performance.now();
    try {
      const r = await api.query(this.session().id, this.sql(), [], this.pageSize());
      this.elapsed.set(performance.now() - start);
      this.rs.set(r);
      this.setupEdit(r);
    } catch (e) {
      this.error.set(errText(e));
    } finally {
      this.loading.set(false);
    }
  }

  private setupEdit(r: ResultSet) {
    const d = this.details();
    if (!d || this.tab().isView || this.session().readOnly) return this.edit.set(null);
    const key = d.indexes.find((i) => i.name === 'PRIMARY') ?? d.indexes.find((i) => i.unique && i.columns.every((c) => !d.columns.find((x) => x.name === c.name)?.nullable));
    if (!key) return this.edit.set(null);
    const names = r.columns.map((c) => c.orgName || null);
    const keyCols = key.columns.map((k) => names.indexOf(k.name));
    if (keyCols.some((k) => k < 0)) return this.edit.set(null);
    this.edit.set({ schema: this.tab().schema, table: this.tab().table, columns: names, keyCols });
  }

  async count() {
    const t = this.tab();
    let s = `SELECT COUNT(*) FROM ${qt(t.schema, t.table)}`;
    if (this.where().trim()) s += ` WHERE ${this.where().trim()}`;
    try {
      const r = await api.query(this.session().id, s);
      this.total.set(Number(r.rows[0][0]));
    } catch (e) {
      this.toast.error(errText(e));
    }
  }

  applyWhere(v: string) {
    this.where.set(v);
    this.offset.set(0);
    this.total.set(null);
    this.load();
  }

  onSort(s: { col: number; dir: SortDir } | null) {
    this.sort.set(s);
    this.offset.set(0);
    this.load();
  }

  onFilterBy(f: { col: number; value: Cell; op: '=' | '<>' }) {
    const col = this.rs()?.columns[f.col];
    if (!col) return;
    const cond = f.value === null ? `${qi(col.name)} IS ${f.op === '=' ? '' : 'NOT '}NULL` : `${qi(col.name)} ${f.op} ${literal(f.value, col.numeric)}`;
    const cur = this.where().trim();
    this.applyWhere(cur ? `(${cur}) AND ${cond}` : cond);
  }

  page(dir: number) {
    this.offset.set(Math.max(0, this.offset() + dir * this.pageSize()));
    this.load();
  }

  setPageSize(n: number) {
    this.pageSize.set(n);
    this.settings.put('data.pageSize', n);
    this.offset.set(0);
    this.load();
  }

  async apply() {
    const e = this.edit();
    const g = this.grid();
    if (!e || !g) return;
    const { stmts, preview } = buildStatements(e, g.getChanges());
    if (!stmts.length) return;
    if (!(await this.dialog.reviewSql('Apply changes', preview))) return;
    try {
      await api.execBatch(this.session().id, stmts, true);
      this.toast.success(`Applied ${stmts.length} change${stmts.length > 1 ? 's' : ''}`);
      this.dirty.set(false);
      g.discard();
      this.total.set(null);
      await this.load();
    } catch (err) {
      this.dialog.alert('Changes not applied', errText(err));
    }
  }

  openInQuery() {
    const s = this.session();
    s.schema.set(this.tab().schema);
    this.ws.openQuery(s, this.sql() + ';', this.tab().table);
  }

  async exportCsv() {
    const path = await saveDialog({ filters: [{ name: 'CSV', extensions: ['csv'] }], defaultPath: `${this.tab().table}.csv` });
    if (!path) return;
    const taskId = uid('csv');
    this.toast.show('Exporting…');
    try {
      const r = await api.exportCsv(this.session().id, taskId, this.sql(false), this.tab().schema, path);
      this.toast.success(`Exported ${r.rows.toLocaleString()} rows`);
    } catch (e) {
      this.toast.error(errText(e));
    }
  }
}
