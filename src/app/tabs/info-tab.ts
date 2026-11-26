import { ChangeDetectionStrategy, Component, inject, input, OnInit, signal } from '@angular/core';
import { api, errText } from '../core/api';
import { MetaService } from '../core/meta.service';
import { TableDetails } from '../core/models';
import { formatBytes, formatCount } from '../core/sql';
import { OpenSession, Tab, WorkspaceService } from '../core/workspace.service';
import { Icon } from '../ui/icon';
import { SqlEditor } from '../ui/sql-editor';

@Component({
  selector: 'q-info-tab',
  imports: [Icon, SqlEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <div class="error-box pad">{{ error() }}</div>
    } @else if (d(); as d) {
      <div class="page">
        <div class="head">
          <q-icon [name]="d.meta?.type === 'VIEW' ? 'view' : 'table'" [size]="22" class="ico" />
          <div>
            <h1>{{ d.name }}</h1>
            <div class="muted">{{ d.schema }}{{ d.meta?.comment ? ' · ' + d.meta?.comment : '' }}</div>
          </div>
          <span class="grow"></span>
          <button class="btn sm" (click)="ws.openData(session(), d.schema, d.name, d.meta?.type === 'VIEW')"><q-icon name="table" />Browse</button>
          @if (d.meta?.type !== 'VIEW') {
            <button class="btn sm" (click)="ws.openDesign(session(), d.schema, d.name)"><q-icon name="sliders" />Alter</button>
          }
        </div>

        @if (d.meta?.type !== 'VIEW') {
          <div class="kpis">
            <div class="kpi card"><div class="k">Engine</div><div class="v">{{ d.meta?.engine ?? '—' }}</div></div>
            <div class="kpi card"><div class="k">Rows</div><div class="v">{{ exact() !== null ? fc(exact()) : '~' + fc(d.meta?.rows) }}</div>
              @if (exact() === null) { <button class="link" (click)="count()">exact count</button> }</div>
            <div class="kpi card"><div class="k">Size (data + index)</div><div class="v">{{ fb(d.meta?.dataLength) || '—' }}</div></div>
            <div class="kpi card"><div class="k">Auto increment</div><div class="v">{{ d.meta?.autoIncrement ?? '—' }}</div></div>
            <div class="kpi card"><div class="k">Collation</div><div class="v small">{{ d.meta?.collation ?? '—' }}</div></div>
          </div>
        }

        <div class="section-title">Columns</div>
        <div class="card tblwrap">
          <table class="tbl">
            <thead><tr><th></th><th>Name</th><th>Type</th><th>Null</th><th>Default</th><th>Extra</th><th>Comment</th></tr></thead>
            <tbody>
              @for (c of d.columns; track c.name) {
                <tr>
                  <td class="num muted">{{ c.position }}</td>
                  <td class="mono">@if (c.key === 'PRI') {<q-icon name="key" [size]="12" class="pk" />} {{ c.name }}</td>
                  <td class="mono type">{{ c.columnType }}</td>
                  <td>{{ c.nullable ? 'YES' : '' }}</td>
                  <td class="mono">{{ c.default ?? '' }}</td>
                  <td class="muted">{{ c.extra }}</td>
                  <td class="muted">{{ c.comment }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (d.indexes.length) {
          <div class="section-title">Indexes</div>
          <div class="card tblwrap">
            <table class="tbl">
              <thead><tr><th>Name</th><th>Kind</th><th>Columns</th><th>Type</th></tr></thead>
              <tbody>
                @for (i of d.indexes; track i.name) {
                  <tr>
                    <td class="mono">{{ i.name }}</td>
                    <td>{{ i.name === 'PRIMARY' ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX' }}</td>
                    <td class="mono">{{ idxCols(i.columns) }}</td>
                    <td class="muted">{{ i.type }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (d.foreignKeys.length || incoming().length) {
          <div class="section-title">Relationships</div>
          <div class="card tblwrap">
            <table class="tbl">
              <thead><tr><th>Constraint</th><th>From</th><th></th><th>To</th><th>Rules</th></tr></thead>
              <tbody>
                @for (f of d.foreignKeys; track f.name) {
                  <tr>
                    <td class="mono">{{ f.name }}</td>
                    <td class="mono">{{ d.name }}({{ f.columns.join(', ') }})</td>
                    <td class="muted">→</td>
                    <td class="mono"><a (click)="ws.openInfo(session(), f.refSchema, f.refTable)">{{ f.refTable }}</a>({{ f.refColumns.join(', ') }})</td>
                    <td class="muted">upd {{ f.onUpdate }} · del {{ f.onDelete }}</td>
                  </tr>
                }
                @for (f of incoming(); track f.name + f.table) {
                  <tr>
                    <td class="mono">{{ f.name }}</td>
                    <td class="mono"><a (click)="ws.openInfo(session(), f.schema, f.table)">{{ f.table }}</a>({{ f.columns }})</td>
                    <td class="muted">→</td>
                    <td class="mono">{{ d.name }}({{ f.refColumns }})</td>
                    <td class="muted">references this table</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        <div class="section-title ddl-title">
          DDL
          <button class="btn ghost sm" (click)="copy(d.ddl)"><q-icon name="copy" />Copy</button>
        </div>
        <div class="card ddl"><q-sql-editor [value]="d.ddl + ';'" [readOnly]="true" /></div>
      </div>
    } @else {
      <div class="empty"><span class="spin"></span></div>
    }
  `,
  styles: `
    :host { display:block; height:100% }
    .pad { margin:14px }
    .page { max-width:1100px }
    .head { display:flex; align-items:center; gap:12px; margin-bottom:18px }
    .head h1 { font-size:19px; margin:0 } .ico { color:var(--syn-number) } .grow { flex:1 }
    .kpis { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:10px; margin-bottom:22px }
    .kpi { padding:12px 14px } .k { font-size:11.5px; color:var(--muted) } .v { font-size:17px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums }
    .v.small { font-size:13px }
    .link { border:0; background:none; color:var(--accent); cursor:pointer; padding:0; font-size:11.5px }
    .section-title { margin-top:22px; display:flex; align-items:center; gap:8px }
    .tblwrap { overflow:auto }
    .type { color:var(--syn-type) } .pk { color:var(--warn); display:inline-flex; vertical-align:-1px }
    a { color:var(--accent); cursor:pointer }
    .ddl { height:340px; overflow:hidden }
  `,
})
export class InfoTab implements OnInit {
  readonly ws = inject(WorkspaceService);
  private meta = inject(MetaService);
  readonly session = input.required<OpenSession>();
  readonly tab = input.required<Extract<Tab, { kind: 'info' }>>();
  readonly d = signal<TableDetails | null>(null);
  readonly error = signal<string | null>(null);
  readonly exact = signal<number | null>(null);
  readonly incoming = signal<{ name: string; schema: string; table: string; columns: string; refColumns: string }[]>([]);

  fc = formatCount;
  fb = formatBytes;

  async ngOnInit() {
    const t = this.tab();
    try {
      this.d.set(await this.meta.tableDetails(this.session().id, t.schema, t.table));
      const rs = await api.query(
        this.session().id,
        `SELECT CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION),
                GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION)
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
          GROUP BY CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME`,
        [t.schema, t.table],
      );
      this.incoming.set(rs.rows.map((r) => ({ name: r[0]!, schema: r[1]!, table: r[2]!, columns: r[3]!, refColumns: r[4]! })));
    } catch (e) {
      this.error.set(errText(e));
    }
  }

  async count() {
    const t = this.tab();
    const rs = await api.query(this.session().id, `SELECT COUNT(*) FROM \`${t.schema.replace(/`/g, '``')}\`.\`${t.table.replace(/`/g, '``')}\``);
    this.exact.set(Number(rs.rows[0][0]));
  }

  idxCols(cols: { name: string; subPart: number | null }[]) {
    return cols.map((c) => (c.subPart ? `${c.name}(${c.subPart})` : c.name)).join(', ');
  }

  copy(s: string) {
    navigator.clipboard.writeText(s + ';');
  }
}
