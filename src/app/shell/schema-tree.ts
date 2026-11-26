import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, input, signal } from '@angular/core';
import { api, errText } from '../core/api';
import { DialogService } from '../core/dialog.service';
import { MetaService, SchemaObjects } from '../core/meta.service';
import { ColumnMeta, TableMeta } from '../core/models';
import { formatBytes, formatCount, qi, qt } from '../core/sql';
import { ToastService } from '../core/toast.service';
import { OpenSession, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';

type Menu =
  | { kind: 'schema'; x: number; y: number; schema: string }
  | { kind: 'table'; x: number; y: number; schema: string; table: TableMeta }
  | { kind: 'routine'; x: number; y: number; schema: string; name: string; type: string }
  | { kind: 'trigger'; x: number; y: number; schema: string; name: string };

type MenuTarget = Menu extends infer M ? (M extends Menu ? Omit<M, 'x' | 'y'> : never) : never;

@Component({
  selector: 'q-schema-tree',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './schema-tree.html',
  styleUrl: './schema-tree.css',
})
export class SchemaTree {
  private meta = inject(MetaService);
  readonly ws = inject(WorkspaceService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly session = input.required<OpenSession>();

  readonly schemas = signal<string[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly expanded = signal<Set<string>>(new Set());
  readonly objects = signal<Record<string, SchemaObjects | 'loading' | { error: string }>>({});
  readonly columns = signal<Record<string, ColumnMeta[] | 'loading'>>({});
  readonly filter = signal('');
  readonly showSystem = signal(false);
  readonly menu = signal<Menu | null>(null);

  private static SYSTEM = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

  readonly visibleSchemas = computed(() => {
    const f = this.filter().toLowerCase();
    const objs = this.objects();
    return this.schemas().filter((s) => {
      if (!this.showSystem() && SchemaTree.SYSTEM.has(s) && this.session().schema() !== s) return false;
      if (!f) return true;
      if (s.toLowerCase().includes(f)) return true;
      const o = objs[s];
      return !!o && typeof o === 'object' && 'tables' in o && [...o.tables, ...o.views].some((t) => t.name.toLowerCase().includes(f));
    });
  });

  constructor() {
    effect(() => {
      const s = this.session();
      s.refresh();
      this.load(s);
    });
  }

  private async load(s: OpenSession) {
    this.loading.set(true);
    this.error.set(null);
    try {
      const list = await this.meta.schemas(s.id);
      this.schemas.set(list);
      // reload expanded schemas so new tables show up
      const exp = this.expanded();
      if (!exp.size && s.schema()) this.expanded.set(new Set([s.schema()!]));
      this.objects.set({});
      this.columns.set({});
      for (const sc of this.expanded()) if (list.includes(sc)) this.loadObjects(sc);
    } catch (e) {
      this.error.set(errText(e));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadObjects(schema: string) {
    this.objects.update((o) => ({ ...o, [schema]: 'loading' }));
    try {
      const objs = await this.meta.objects(this.session().id, schema);
      this.objects.update((o) => ({ ...o, [schema]: objs }));
    } catch (e) {
      this.objects.update((o) => ({ ...o, [schema]: { error: errText(e) } }));
    }
  }

  objs(schema: string): SchemaObjects | null {
    const o = this.objects()[schema];
    return o && typeof o === 'object' && 'tables' in o ? o : null;
  }

  objError(schema: string): string | null {
    const o = this.objects()[schema];
    return o && typeof o === 'object' && 'error' in o ? o.error : null;
  }

  toggle(key: string) {
    this.expanded.update((e) => {
      const c = new Set(e);
      if (c.has(key)) c.delete(key);
      else c.add(key);
      return c;
    });
  }

  isOpen(key: string): boolean {
    return this.expanded().has(key);
  }

  toggleSchema(schema: string) {
    this.toggle(schema);
    if (this.isOpen(schema) && !this.objs(schema)) this.loadObjects(schema);
  }

  selectSchema(schema: string) {
    this.session().schema.set(schema);
  }

  async toggleTable(schema: string, table: string) {
    const key = `${schema}.${table}`;
    this.toggle(`t:${key}`);
    if (this.isOpen(`t:${key}`) && !this.columns()[key]) {
      this.columns.update((c) => ({ ...c, [key]: 'loading' }));
      try {
        const cols = await this.meta.columns(this.session().id, schema, table);
        this.columns.update((c) => ({ ...c, [key]: cols }));
      } catch {
        this.columns.update((c) => {
          const n = { ...c };
          delete n[key];
          return n;
        });
      }
    }
  }

  cols(schema: string, table: string): ColumnMeta[] | null {
    const c = this.columns()[`${schema}.${table}`];
    return Array.isArray(c) ? c : null;
  }

  matches(name: string): boolean {
    const f = this.filter().toLowerCase();
    return !f || name.toLowerCase().includes(f);
  }

  tableTitle(t: TableMeta): string {
    const parts = [t.engine, t.rows != null ? `~${formatCount(t.rows)} rows` : null, formatBytes(t.dataLength), t.comment].filter(Boolean);
    return `${t.name}\n${parts.join(' · ')}`;
  }

  // ------------------------------------------------------------ menus

  openMenu(e: MouseEvent, m: MenuTarget) {
    e.preventDefault();
    e.stopPropagation();
    this.menu.set({ ...(m as Menu), x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 420) });
  }

  @HostListener('document:mousedown', ['$event'])
  docDown(e: MouseEvent) {
    if (this.menu() && !(e.target as HTMLElement).closest('.ctx-menu')) this.menu.set(null);
  }

  do(fn: () => unknown) {
    this.menu.set(null);
    fn();
  }

  openTable(schema: string, t: TableMeta) {
    this.ws.openData(this.session(), schema, t.name, t.type === 'VIEW');
  }

  selectInQuery(schema: string, table: string) {
    const s = this.session();
    s.schema.set(schema);
    this.ws.openQuery(s, `SELECT *\nFROM ${qi(table)}\nLIMIT 200;`, table);
  }

  newQueryIn(schema: string) {
    const s = this.session();
    s.schema.set(schema);
    this.ws.openQuery(s);
  }

  copy(text: string) {
    navigator.clipboard.writeText(text);
    this.toast.show('Copied');
  }

  async copyDdl(schema: string, table: string) {
    const d = await this.meta.tableDetails(this.session().id, schema, table);
    this.copy(d.ddl + ';');
  }

  async routineDdl(schema: string, name: string, type: string) {
    try {
      const rs = await api.query(this.session().id, `SHOW CREATE ${type} ${qt(schema, name)}`);
      const ddl = rs.rows[0]?.[2] ?? '';
      const s = this.session();
      s.schema.set(schema);
      this.ws.openQuery(s, `DROP ${type} IF EXISTS ${qi(name)};\n\nDELIMITER $$\n${ddl}$$\nDELIMITER ;\n`, name);
    } catch (e) {
      this.toast.error(errText(e));
    }
  }

  async triggerDdl(schema: string, name: string) {
    try {
      const rs = await api.query(this.session().id, `SHOW CREATE TRIGGER ${qt(schema, name)}`);
      const ddl = rs.rows[0]?.[2] ?? '';
      const s = this.session();
      s.schema.set(schema);
      this.ws.openQuery(s, `DROP TRIGGER IF EXISTS ${qi(name)};\n\nDELIMITER $$\n${ddl}$$\nDELIMITER ;\n`, name);
    } catch (e) {
      this.toast.error(errText(e));
    }
  }

  newRoutine(schema: string, type: 'PROCEDURE' | 'FUNCTION') {
    const s = this.session();
    s.schema.set(schema);
    const body =
      type === 'PROCEDURE'
        ? `DELIMITER $$\nCREATE PROCEDURE \`new_procedure\`(IN p_id INT)\nBEGIN\n  SELECT p_id;\nEND$$\nDELIMITER ;\n`
        : `DELIMITER $$\nCREATE FUNCTION \`new_function\`(p_value INT) RETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN p_value;\nEND$$\nDELIMITER ;\n`;
    this.ws.openQuery(s, body, `New ${type.toLowerCase()}`);
  }

  async runDdl(title: string, sql: string, schema?: string, danger = true) {
    if (!(await this.dialog.reviewSql(title, sql + ';', 'Run', danger))) return;
    try {
      await api.execBatch(this.session().id, [{ sql }], false);
      this.toast.success('Done');
      this.ws.reload(this.session(), schema);
    } catch (e) {
      this.dialog.alert('Failed', errText(e));
    }
  }

  async createSchema() {
    const name = await this.dialog.prompt('New schema', 'Schema name', '', 'Create');
    if (!name) return;
    await this.runDdl('Create schema', `CREATE SCHEMA ${qi(name)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`, undefined, false);
  }

  async renameTable(schema: string, table: string) {
    const name = await this.dialog.prompt('Rename table', 'New name', table, 'Rename');
    if (!name || name === table) return;
    await this.runDdl('Rename table', `RENAME TABLE ${qt(schema, table)} TO ${qt(schema, name)}`, schema, false);
  }

  async duplicateTable(schema: string, table: string) {
    const name = await this.dialog.prompt('Duplicate table', 'New table name', `${table}_copy`, 'Next');
    if (!name) return;
    const sql = `CREATE TABLE ${qt(schema, name)} LIKE ${qt(schema, table)};\nINSERT INTO ${qt(schema, name)} SELECT * FROM ${qt(schema, table)}`;
    if (!(await this.dialog.reviewSql('Duplicate table', sql + ';', 'Run', false))) return;
    try {
      await api.execBatch(
        this.session().id,
        [{ sql: `CREATE TABLE ${qt(schema, name)} LIKE ${qt(schema, table)}` }, { sql: `INSERT INTO ${qt(schema, name)} SELECT * FROM ${qt(schema, table)}` }],
        false,
      );
      this.toast.success(`Created ${name}`);
      this.ws.reload(this.session(), schema);
    } catch (e) {
      this.dialog.alert('Failed', errText(e));
    }
  }

  openDump(schema: string) {
    const s = this.session();
    this.ws.open(s, { kind: 'dump', id: `dump-${Date.now()}`, title: `Export ${schema}`, schema });
  }

  openImportCsv(schema: string, table: string | null) {
    const s = this.session();
    this.ws.open(s, { kind: 'import-csv', id: `csv-${Date.now()}`, title: table ? `Import into ${table}` : 'Import CSV', schema, table });
  }

  openImportSql(schema: string) {
    const s = this.session();
    s.schema.set(schema);
    this.ws.open(s, { kind: 'import-sql', id: `isql-${Date.now()}`, title: 'Run SQL file' });
  }

  refresh() {
    this.ws.reload(this.session());
  }

  qi = qi;
  qt = qt;
}
