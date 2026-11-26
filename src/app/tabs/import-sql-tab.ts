import { ChangeDetectionStrategy, Component, inject, input, OnInit, signal } from '@angular/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errText } from '../core/api';
import { DialogService } from '../core/dialog.service';
import { MetaService } from '../core/meta.service';
import { ToastService } from '../core/toast.service';
import { OpenSession, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';
import { useTask } from './task-progress';

@Component({
  selector: 'q-import-sql-tab',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <h1>Run SQL file</h1>
      <p class="muted lead">Streams a .sql script (a dump, a migration) statement by statement. Handles <code>DELIMITER</code> blocks and files of any size.</p>
      <div class="card box">
        <div class="field">
          <label>File</label>
          <div class="row">
            <input class="input mono" [value]="path() ?? ''" readonly placeholder="Choose a .sql file" />
            <button class="btn" (click)="pick()"><q-icon name="folder" />Browse…</button>
          </div>
        </div>
        <div class="field">
          <label>Run in schema</label>
          <select class="input" [value]="schema() ?? ''" (change)="schema.set($any($event.target).value || null)">
            <option value="">(none — the script picks with USE)</option>
            @for (s of schemas(); track s) {
              <option [value]="s" [selected]="s === schema()">{{ s }}</option>
            }
          </select>
        </div>
        <label class="check"><input type="checkbox" [checked]="cont()" (change)="cont.set(!cont())" />Continue after errors (collects up to 100)</label>

        @if (session().readOnly) {
          <div class="error-box">This connection is read-only.</div>
        } @else if (task.running()) {
          <div class="progress" [class.indeterminate]="task.pct() === null"><div [style.width.%]="task.pct() ?? 30"></div></div>
          <div class="row">
            <span class="muted small">{{ task.progress()?.message ?? 'Starting…' }} {{ task.pct() !== null ? '· ' + task.pct()!.toFixed(0) + '%' : '' }}</span>
            <span class="grow"></span>
            <button class="btn sm" (click)="task.cancel()"><q-icon name="stop" />Cancel</button>
          </div>
        } @else {
          <div><button class="btn primary" [disabled]="!path()" (click)="run()"><q-icon name="play" />Run file</button></div>
        }

        @if (summary(); as s) {
          <div [class.ok-text]="!s.errors.length" [class.warn-text]="s.errors.length" class="sum">
            {{ s.statements.toLocaleString() }} statements executed{{ s.errors.length ? ', ' + s.errors.length + ' failed' : '' }}
          </div>
          @for (e of s.errors; track $index) {
            <div class="error-box">{{ e }}</div>
          }
        }
        @if (error()) {
          <div class="error-box">{{ error() }}</div>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display:block; height:100% }
    h1 { font-size:19px; margin:0 0 4px } .lead { margin:0 0 18px; max-width:640px }
    .box { padding:16px; display:flex; flex-direction:column; gap:14px; max-width:720px }
    .row { display:flex; gap:8px; align-items:center } .grow { flex:1 } .small { font-size:12px }
    .sum { font-weight:600 }
  `,
})
export class ImportSqlTab implements OnInit {
  private meta = inject(MetaService);
  private ws = inject(WorkspaceService);
  private toast = inject(ToastService);
  private dialog = inject(DialogService);
  readonly session = input.required<OpenSession>();
  readonly task = useTask();
  readonly path = signal<string | null>(null);
  readonly schema = signal<string | null>(null);
  readonly schemas = signal<string[]>([]);
  readonly cont = signal(false);
  readonly summary = signal<{ statements: number; errors: string[] } | null>(null);
  readonly error = signal<string | null>(null);

  async ngOnInit() {
    this.schemas.set(await this.meta.schemas(this.session().id));
    this.schema.set(this.session().schema());
  }

  async pick() {
    const p = await openDialog({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }], multiple: false });
    if (p && !Array.isArray(p)) this.path.set(p);
  }

  async run() {
    const path = this.path()!;
    const ok = await this.dialog.confirm({
      title: 'Run this file?',
      message: `${path}\n\non ${this.session().conn.name}${this.schema() ? ` in schema ${this.schema()}` : ''}. Statements run immediately and are not wrapped in a transaction.`,
      confirmText: 'Run',
    });
    if (!ok) return;
    this.summary.set(null);
    this.error.set(null);
    const id = this.task.start('isql');
    try {
      const r = await api.runSqlFile(this.session().id, id, path, this.schema(), this.cont());
      this.summary.set(r);
      if (!r.errors.length) this.toast.success('File executed');
      this.ws.reload(this.session());
    } catch (e) {
      this.error.set(errText(e));
    } finally {
      this.task.done();
    }
  }
}
