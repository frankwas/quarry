import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errText } from '../core/api';
import { MetaService } from '../core/meta.service';
import { ColumnMeta } from '../core/models';
import { ToastService } from '../core/toast.service';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';
import { useTask } from './task-progress';

@Component({
  selector: 'q-import-csv-tab',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <h1>Import CSV</h1>
      <p class="muted lead">Map the file's columns onto a table and insert in batches of 500 rows.</p>

      <div class="card box">
        <div class="row3">
          <div class="field grow2">
            <label>File</label>
            <div class="row">
              <input class="input mono" [value]="path() ?? ''" readonly placeholder="Choose a .csv / .tsv file" />
              <button class="btn" (click)="pick()"><q-icon name="folder" />Browse…</button>
            </div>
          </div>
          <div class="field">
            <label>Delimiter</label>
            <select class="input" [value]="delimiter()" (change)="setDelimiter($any($event.target).value)">
              <option value=",">Comma ,</option>
              <option value=";">Semicolon ;</option>
              <option value="\\t">Tab</option>
              <option value="|">Pipe |</option>
            </select>
          </div>
          <div class="field">
            <label>&nbsp;</label>
            <label class="check"><input type="checkbox" [checked]="hasHeader()" (change)="toggleHeader()" />First row is a header</label>
          </div>
        </div>

        <div class="row3">
          <div class="field">
            <label>Schema</label>
            <select class="input" [value]="schema() ?? ''" (change)="pickSchema($any($event.target).value)">
              <option value="" disabled>Choose…</option>
              @for (s of schemas(); track s) {
                <option [value]="s" [selected]="s === schema()">{{ s }}</option>
              }
            </select>
          </div>
          <div class="field">
            <label>Table</label>
            <select class="input" [value]="table() ?? ''" (change)="pickTable($any($event.target).value)">
              <option value="" disabled>Choose…</option>
              @for (t of tables(); track t) {
                <option [value]="t" [selected]="t === table()">{{ t }}</option>
              }
            </select>
          </div>
          <div class="field opts">
            <label class="check"><input type="checkbox" [checked]="emptyNull()" (change)="emptyNull.set(!emptyNull())" />Empty values as NULL</label>
            <label class="check"><input type="checkbox" [checked]="truncate()" (change)="truncate.set(!truncate())" />Delete existing rows first</label>
          </div>
        </div>
      </div>

      @if (preview(); as p) {
        <div class="section-title">Column mapping & preview</div>
        <div class="card map">
          <table class="tbl">
            <thead>
              <tr>
                @for (h of p.headers; track $index; let i = $index) {
                  <th>
                    <div class="h-src mono">{{ h }}</div>
                    <select class="input sm" [value]="mapping()[i] ?? ''" (change)="setMap(i, $any($event.target).value)">
                      <option value="">— skip —</option>
                      @for (c of cols(); track c.name) {
                        <option [value]="c.name" [selected]="c.name === mapping()[i]">{{ c.name }} · {{ c.columnType }}</option>
                      }
                    </select>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of p.rows.slice(0, 12); track $index) {
                <tr>
                  @for (v of r; track $index; let i = $index) {
                    <td class="mono" [class.skip]="!mapping()[i]">{{ v }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="actions">
          @if (task.running()) {
            <div class="progress grow" [class.indeterminate]="task.pct() === null"><div [style.width.%]="task.pct() ?? 30"></div></div>
            <span class="muted small">{{ task.progress()?.message }}</span>
            <button class="btn sm" (click)="task.cancel()"><q-icon name="stop" />Cancel</button>
          } @else {
            <span class="muted">{{ mappedCount() }} of {{ p.headers.length }} columns mapped</span>
            <span class="grow"></span>
            <button class="btn primary" [disabled]="!table() || !mappedCount() || session().readOnly" (click)="run()"><q-icon name="upload" />Import</button>
          }
        </div>
      }
      @if (result()) {
        <div class="ok-text done">{{ result() }}</div>
      }
      @if (error()) {
        <div class="error-box">{{ error() }}</div>
      }
    </div>
  `,
  styles: `
    :host { display:block; height:100% }
    h1 { font-size:19px; margin:0 0 4px } .lead { margin:0 0 18px }
    .box { padding:16px; display:flex; flex-direction:column; gap:14px; max-width:1000px }
    .row3 { display:flex; gap:12px } .row3 > .field { flex:1 } .row3 > .grow2 { flex:2 }
    .row { display:flex; gap:8px } .opts { justify-content:flex-end; gap:6px }
    .section-title { margin-top:22px }
    .map { overflow:auto; max-height:calc(100vh - 470px); max-width:100% }
    .map th { vertical-align:top; padding:6px 8px; height:auto }
    .h-src { font-weight:600; margin-bottom:4px }
    .map select { min-width:150px }
    td.skip { color:var(--null) }
    .actions { display:flex; align-items:center; gap:10px; margin-top:12px; max-width:1000px }
    .grow { flex:1 } .small { font-size:12px } .done { margin-top:12px; font-weight:600 }
  `,
})
export class ImportCsvTab implements OnInit {
  private meta = inject(MetaService);
  private ws = inject(WorkspaceService);
  private toast = inject(ToastService);
  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'import-csv' }>>();
  readonly task = useTask();

  readonly path = signal<string | null>(null);
  readonly delimiter = signal(',');
  readonly hasHeader = signal(true);
  readonly preview = signal<{ headers: string[]; rows: string[][] } | null>(null);
  readonly schemas = signal<string[]>([]);
  readonly schema = signal<string | null>(null);
  readonly tables = signal<string[]>([]);
  readonly table = signal<string | null>(null);
  readonly cols = signal<ColumnMeta[]>([]);
  readonly mapping = signal<(string | null)[]>([]);
  readonly emptyNull = signal(true);
  readonly truncate = signal(false);
  readonly result = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  readonly mappedCount = computed(() => this.mapping().filter(Boolean).length);

  async ngOnInit() {
    this.schemas.set(await this.meta.schemas(this.session().id));
    const s = this.tab().schema ?? this.session().schema();
    if (s) await this.pickSchema(s);
    if (this.tab().table) await this.pickTable(this.tab().table!);
  }

  async pick() {
    const p = await openDialog({ filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }], multiple: false });
    if (!p || Array.isArray(p)) return;
    this.path.set(p);
    await this.loadPreview(null);
  }

  private async loadPreview(delim: string | null) {
    const path = this.path();
    if (!path) return;
    try {
      const p = await api.previewCsv(path, delim, this.hasHeader());
      this.delimiter.set(p.delimiter);
      this.preview.set(p);
      this.autoMap();
      this.error.set(null);
    } catch (e) {
      this.error.set(errText(e));
    }
  }

  setDelimiter(d: string) {
    this.delimiter.set(d);
    this.loadPreview(d);
  }

  toggleHeader() {
    this.hasHeader.update((v) => !v);
    this.loadPreview(this.delimiter());
  }

  async pickSchema(s: string) {
    this.schema.set(s);
    const o = await this.meta.objects(this.session().id, s);
    this.tables.set(o.tables.map((t) => t.name));
    this.table.set(null);
    this.cols.set([]);
  }

  async pickTable(t: string) {
    this.table.set(t);
    this.cols.set(await this.meta.columns(this.session().id, this.schema()!, t));
    this.autoMap();
  }

  private autoMap() {
    const p = this.preview();
    const cols = this.cols();
    if (!p) return;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    this.mapping.set(p.headers.map((h, i) => cols.find((c) => norm(c.name) === norm(h))?.name ?? (this.hasHeader() ? null : (cols[i]?.name ?? null))));
  }

  setMap(i: number, v: string) {
    this.mapping.update((m) => m.map((x, j) => (j === i ? v || null : x)));
  }

  async run() {
    this.result.set(null);
    this.error.set(null);
    const id = this.task.start('csv');
    try {
      const r = await api.importCsv(this.session().id, id, {
        path: this.path()!,
        schema: this.schema()!,
        table: this.table()!,
        delimiter: this.delimiter(),
        hasHeader: this.hasHeader(),
        mapping: this.mapping(),
        emptyAsNull: this.emptyNull(),
        truncateFirst: this.truncate(),
      });
      this.result.set(`Imported ${r.rows.toLocaleString()} rows into ${this.table()}`);
      this.toast.success('Import finished');
      this.ws.reload(this.session(), this.schema()!);
    } catch (e) {
      this.error.set(errText(e));
    } finally {
      this.task.done();
    }
  }
}
