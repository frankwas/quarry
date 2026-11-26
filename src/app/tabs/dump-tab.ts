import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { api, errText } from '../core/api';
import { MetaService } from '../core/meta.service';
import { TableMeta } from '../core/models';
import { formatBytes, formatCount } from '../core/sql';
import { ToastService } from '../core/toast.service';
import { OpenSession, Tab } from '../core/workspace.service';
import { Icon } from '../ui/icon';
import { useTask } from './task-progress';

@Component({
  selector: 'q-dump-tab',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <h1>Export schema</h1>
      <p class="muted lead">Writes a .sql file you can restore with “Run SQL file”, the mysql CLI or any other client. Runs in one consistent snapshot.</p>

      <div class="grid">
        <div class="card box">
          <div class="field">
            <label>Schema</label>
            <select class="input" [value]="schema() ?? ''" (change)="pickSchema($any($event.target).value)">
              <option value="" disabled>Choose…</option>
              @for (s of schemas(); track s) {
                <option [value]="s" [selected]="s === schema()">{{ s }}</option>
              }
            </select>
          </div>

          <div class="tbl-head">
            <span class="label">Tables & views</span>
            <span class="muted">{{ selected().size }} of {{ tables().length }}</span>
            <span class="grow"></span>
            <button class="btn ghost sm" (click)="all(true)">All</button>
            <button class="btn ghost sm" (click)="all(false)">None</button>
          </div>
          <div class="tlist">
            @for (t of tables(); track t.name) {
              <label class="trow">
                <input type="checkbox" [checked]="selected().has(t.name)" (change)="toggle(t.name)" />
                <q-icon [name]="t.type === 'VIEW' ? 'view' : 'table'" [size]="13" class="muted" />
                <span class="mono name">{{ t.name }}</span>
                <span class="muted small">{{ t.type === 'VIEW' ? 'view' : '~' + fc(t.rows) + ' rows · ' + fb(t.dataLength) }}</span>
              </label>
            } @empty {
              <div class="muted pad">{{ schema() ? 'No tables' : 'Pick a schema' }}</div>
            }
          </div>
        </div>

        <div class="card box opts">
          <div class="label">Include</div>
          <label class="check"><input type="checkbox" [checked]="structure()" (change)="structure.set(!structure())" />Structure (CREATE TABLE / VIEW)</label>
          <label class="check"><input type="checkbox" [checked]="data()" (change)="data.set(!data())" />Data (INSERT)</label>
          <label class="check"><input type="checkbox" [checked]="routines()" (change)="routines.set(!routines())" />Stored procedures & functions</label>
          <label class="check"><input type="checkbox" [checked]="triggers()" (change)="triggers.set(!triggers())" />Triggers</label>
          <label class="check"><input type="checkbox" [checked]="drop()" (change)="drop.set(!drop())" />Add DROP TABLE IF EXISTS</label>

          <div class="est muted">Estimated size before compression: {{ fb(estimate()) || '—' }}</div>

          @if (task.running()) {
            <div class="prog">
              <div class="progress" [class.indeterminate]="task.pct() === null"><div [style.width.%]="task.pct() ?? 30"></div></div>
              <div class="muted small">{{ task.progress()?.message ?? 'Starting…' }}</div>
              <button class="btn sm" (click)="task.cancel()"><q-icon name="stop" />Cancel</button>
            </div>
          } @else {
            <button class="btn primary run" [disabled]="!schema() || !selected().size || (!structure() && !data())" (click)="run()">
              <q-icon name="download" />Export to file…
            </button>
          }
          @if (result()) {
            <div class="done ok-text">{{ result() }}</div>
          }
          @if (error()) {
            <div class="error-box">{{ error() }}</div>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    :host { display:block; height:100% }
    h1 { font-size:19px; margin:0 0 4px } .lead { margin:0 0 18px; max-width:640px }
    .grid { display:grid; grid-template-columns:minmax(0, 1.4fr) minmax(280px, 1fr); gap:14px; max-width:1100px; align-items:start }
    .box { padding:14px; display:flex; flex-direction:column; gap:10px }
    .tbl-head { display:flex; align-items:center; gap:8px; margin-top:6px }
    .tlist { max-height:calc(100vh - 340px); overflow:auto; border:1px solid var(--border); border-radius:var(--radius) }
    .trow { display:flex; align-items:center; gap:8px; height:28px; padding:0 10px; border-bottom:1px solid var(--border); cursor:pointer }
    .trow:hover { background:var(--panel-2) } .trow input { accent-color:var(--accent) }
    .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
    .small { font-size:11.5px } .pad { padding:12px } .grow { flex:1 }
    .opts .check { font-size:13px }
    .est { font-size:12px; margin-top:4px }
    .run { align-self:flex-start; margin-top:6px }
    .prog { display:flex; flex-direction:column; gap:6px; margin-top:6px }
    .prog .btn { align-self:flex-start }
    .done { font-weight:600 }
  `,
})
export class DumpTab implements OnInit {
  private meta = inject(MetaService);
  private toast = inject(ToastService);
  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'dump' }>>();
  readonly task = useTask();

  readonly schemas = signal<string[]>([]);
  readonly schema = signal<string | null>(null);
  readonly tables = signal<TableMeta[]>([]);
  readonly selected = signal<Set<string>>(new Set());
  readonly structure = signal(true);
  readonly data = signal(true);
  readonly routines = signal(true);
  readonly triggers = signal(true);
  readonly drop = signal(true);
  readonly result = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  readonly estimate = computed(() => (this.data() ? this.tables().filter((t) => this.selected().has(t.name)).reduce((a, t) => a + (t.dataLength ?? 0), 0) : 0));

  fc = formatCount;
  fb = formatBytes;

  async ngOnInit() {
    this.schemas.set((await this.meta.schemas(this.session().id)).filter((s) => !['information_schema', 'performance_schema', 'sys'].includes(s)));
    const s = this.tab().schema ?? this.session().schema();
    if (s) this.pickSchema(s);
  }

  async pickSchema(s: string) {
    this.schema.set(s);
    const o = await this.meta.objects(this.session().id, s);
    const all = [...o.tables, ...o.views];
    this.tables.set(all);
    this.selected.set(new Set(all.map((t) => t.name)));
  }

  toggle(n: string) {
    this.selected.update((s) => {
      const c = new Set(s);
      if (c.has(n)) c.delete(n);
      else c.add(n);
      return c;
    });
  }

  all(on: boolean) {
    this.selected.set(on ? new Set(this.tables().map((t) => t.name)) : new Set());
  }

  async run() {
    const schema = this.schema()!;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const path = await saveDialog({ filters: [{ name: 'SQL', extensions: ['sql'] }], defaultPath: `${schema}-${stamp}.sql` });
    if (!path) return;
    this.result.set(null);
    this.error.set(null);
    const id = this.task.start('dump');
    try {
      const all = this.selected().size === this.tables().length;
      const r = await api.dumpSchema(this.session().id, id, {
        schema,
        tables: all ? [] : [...this.selected()],
        structure: this.structure(),
        data: this.data(),
        routines: this.routines(),
        triggers: this.triggers(),
        dropIfExists: this.drop(),
        path,
      });
      this.result.set(`Exported ${r.tables} objects, ${r.rows.toLocaleString()} rows, ${formatBytes(r.bytes)} → ${path}`);
      this.toast.success('Export finished');
    } catch (e) {
      this.error.set(errText(e));
    } finally {
      this.task.done();
    }
  }
}
