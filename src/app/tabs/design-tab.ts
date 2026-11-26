import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { api, errText } from '../core/api';
import { alterSql, ColDef, COMMON_TYPES, createSql, FkDef, fromDetails, IdxDef, TableDef } from '../core/ddl';
import { DialogService } from '../core/dialog.service';
import { MetaService } from '../core/meta.service';
import { ToastService } from '../core/toast.service';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';
import { SqlEditor } from '../ui/sql-editor';

type Section = 'columns' | 'indexes' | 'fks' | 'options' | 'sql';

const blankCol = (): ColDef => ({
  orig: null,
  name: '',
  type: 'VARCHAR(255)',
  nullable: true,
  default: null,
  autoIncrement: false,
  unsigned: false,
  onUpdateNow: false,
  comment: '',
  collation: null,
  generated: null,
  pk: false,
});

@Component({
  selector: 'q-design-tab',
  imports: [Icon, SqlEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './design-tab.html',
  styleUrl: './design-tab.css',
})
export class DesignTab implements OnInit {
  private ws = inject(WorkspaceService);
  private meta = inject(MetaService);
  private dialog = inject(DialogService);
  private toast = inject(ToastService);

  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'design' }>>();

  readonly before = signal<TableDef | null>(null);
  readonly def = signal<TableDef | null>(null);
  readonly section = signal<Section>('columns');
  readonly selCol = signal(0);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly tables = signal<string[]>([]);
  readonly refCols = signal<Record<string, string[] | undefined>>({});
  readonly collations = signal<string[]>([]);
  readonly types = COMMON_TYPES;
  readonly engines = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV'];
  readonly fkRules = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];

  readonly isNew = computed(() => !this.tab().table);

  readonly statements = computed(() => {
    const d = this.def();
    if (!d) return [];
    const b = this.before();
    if (!b) return d.name && d.columns.some((c) => c.name) ? [createSql(this.tab().schema, d)] : [];
    return alterSql(this.tab().schema, b, d);
  });
  readonly preview = computed(() => this.statements().map((s) => s + ';').join('\n\n'));
  readonly dirty = computed(() => this.statements().length > 0);
  readonly col = computed(() => this.def()?.columns[this.selCol()] ?? null);

  async ngOnInit() {
    const s = this.session();
    const t = this.tab();
    try {
      const [objs, colls] = await Promise.all([this.meta.objects(s.id, t.schema), this.meta.collations(s.id)]);
      this.tables.set(objs.tables.map((x) => x.name));
      this.collations.set(colls.map((c) => c.collation));
      if (t.table) {
        const d = await this.meta.tableDetails(s.id, t.schema, t.table);
        const def = fromDetails(d);
        this.before.set(structuredClone(def));
        this.def.set(def);
      } else {
        this.def.set({
          name: '',
          engine: 'InnoDB',
          collation: '',
          comment: '',
          columns: [{ ...blankCol(), name: 'id', type: 'INT', unsigned: true, nullable: false, autoIncrement: true, pk: true }],
          indexes: [],
          fks: [],
        });
      }
    } catch (e) {
      this.error.set(errText(e));
    }
  }

  private mutate(fn: (d: TableDef) => void) {
    const d = structuredClone(this.def()!);
    fn(d);
    this.def.set(d);
    this.ws.setDirty(this.session(), this.tab().id, this.dirty());
  }

  setTable<K extends keyof TableDef>(k: K, v: TableDef[K]) {
    this.mutate((d) => (d[k] = v));
  }

  setCol<K extends keyof ColDef>(i: number, k: K, v: ColDef[K]) {
    this.mutate((d) => {
      d.columns[i][k] = v;
      if (k === 'autoIncrement' && v) d.columns[i].nullable = false;
      if (k === 'pk' && v) d.columns[i].nullable = false;
    });
  }

  addCol() {
    this.mutate((d) => d.columns.splice(this.selCol() + 1, 0, blankCol()));
    this.selCol.set(Math.min(this.selCol() + 1, this.def()!.columns.length - 1));
    setTimeout(() => (document.querySelector('q-design-tab .crow.on input') as HTMLInputElement | null)?.focus());
  }

  removeCol(i: number) {
    this.mutate((d) => d.columns.splice(i, 1));
    this.selCol.set(Math.max(0, Math.min(this.selCol(), this.def()!.columns.length - 1)));
  }

  moveCol(i: number, dir: number) {
    const j = i + dir;
    if (j < 0 || j >= this.def()!.columns.length) return;
    this.mutate((d) => {
      const [c] = d.columns.splice(i, 1);
      d.columns.splice(j, 0, c);
    });
    this.selCol.set(j);
  }

  addTimestamps() {
    this.mutate((d) => {
      if (!d.columns.some((c) => c.name === 'created_at'))
        d.columns.push({ ...blankCol(), name: 'created_at', type: 'DATETIME', nullable: false, default: 'CURRENT_TIMESTAMP' });
      if (!d.columns.some((c) => c.name === 'updated_at'))
        d.columns.push({ ...blankCol(), name: 'updated_at', type: 'DATETIME', nullable: false, default: 'CURRENT_TIMESTAMP', onUpdateNow: true });
    });
  }

  // indexes
  addIdx() {
    const first = this.def()!.columns.find((c) => c.name)?.name;
    this.mutate((d) => d.indexes.push({ orig: null, name: `idx_${d.name || 'table'}_${d.indexes.length + 1}`, kind: 'INDEX', columns: first ? [first] : [], comment: '' }));
  }
  setIdx<K extends keyof IdxDef>(i: number, k: K, v: IdxDef[K]) {
    this.mutate((d) => (d.indexes[i][k] = v));
  }
  toggleIdxCol(i: number, col: string) {
    this.mutate((d) => {
      const cols = d.indexes[i].columns;
      const at = cols.findIndex((c) => c === col || c.startsWith(col + '('));
      if (at >= 0) cols.splice(at, 1);
      else cols.push(col);
    });
  }
  removeIdx(i: number) {
    this.mutate((d) => d.indexes.splice(i, 1));
  }

  // foreign keys
  async addFk() {
    this.mutate((d) =>
      d.fks.push({ orig: null, name: `fk_${d.name || 'table'}_${d.fks.length + 1}`, columns: [], refSchema: this.tab().schema, refTable: '', refColumns: [], onUpdate: 'RESTRICT', onDelete: 'RESTRICT' }),
    );
  }
  setFk<K extends keyof FkDef>(i: number, k: K, v: FkDef[K]) {
    this.mutate((d) => (d.fks[i][k] = v));
    if (k === 'refTable') this.loadRefCols(v as string);
  }
  setFkPair(i: number, pair: number, which: 'columns' | 'refColumns', v: string) {
    this.mutate((d) => {
      d.fks[i][which][pair] = v;
    });
  }
  addFkPair(i: number) {
    this.mutate((d) => {
      d.fks[i].columns.push('');
      d.fks[i].refColumns.push('');
    });
  }
  removeFkPair(i: number, pair: number) {
    this.mutate((d) => {
      d.fks[i].columns.splice(pair, 1);
      d.fks[i].refColumns.splice(pair, 1);
    });
  }
  removeFk(i: number) {
    this.mutate((d) => d.fks.splice(i, 1));
  }
  async loadRefCols(table: string) {
    if (!table || this.refCols()[table]) return;
    try {
      const cols = await this.meta.columns(this.session().id, this.tab().schema, table);
      this.refCols.update((r) => ({ ...r, [table]: cols.map((c) => c.name) }));
    } catch {
      /* ignore */
    }
  }

  colNames(): string[] {
    return this.def()?.columns.map((c) => c.name).filter(Boolean) ?? [];
  }

  isText(type: string): boolean {
    return /char|text|enum|set/i.test(type);
  }

  idxHas(i: IdxDef, col: string): boolean {
    return i.columns.some((c) => c === col || c.startsWith(col + '('));
  }

  revert() {
    const b = this.before();
    if (b) this.def.set(structuredClone(b));
    this.ws.setDirty(this.session(), this.tab().id, false);
  }

  async apply() {
    const stmts = this.statements();
    if (!stmts.length) return;
    const d = this.def()!;
    if (!d.name.trim()) return this.toast.error('Give the table a name');
    const dropsData = this.before() && stmts.some((s) => /DROP COLUMN|DROP PRIMARY KEY/.test(s));
    if (!(await this.dialog.reviewSql(this.isNew() ? 'Create table' : `Alter ${this.before()!.name}`, this.preview(), this.isNew() ? 'Create' : 'Apply', !!dropsData))) return;
    this.busy.set(true);
    try {
      await api.execBatch(this.session().id, stmts.map((sql) => ({ sql })), false);
      this.toast.success(this.isNew() ? `Created ${d.name}` : `Altered ${d.name}`);
      this.meta.invalidate(this.session().id, this.tab().schema);
      this.ws.reload(this.session(), this.tab().schema);
      const det = await this.meta.tableDetails(this.session().id, this.tab().schema, d.name);
      const fresh = fromDetails(det);
      this.before.set(structuredClone(fresh));
      this.def.set(fresh);
      this.ws.setDirty(this.session(), this.tab().id, false);
      if (this.isNew() || this.tab().table !== d.name) {
        this.session().tabs.update((tabs) => tabs.map((t) => (t.id === this.tab().id ? { ...t, table: d.name, title: `Design ${d.name}` } : t)));
      }
    } catch (e) {
      // Partially-applied ALTERs are possible when several statements run.
      this.dialog.alert('Not applied', errText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
