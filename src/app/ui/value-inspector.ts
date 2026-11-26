import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { Cell } from '../core/models';
import { GridColumn } from './data-grid';

/** Side panel showing the full value of the focused grid cell. */
@Component({
  selector: 'q-value-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="name">{{ cell()?.col?.name ?? 'Value' }}</span>
      <span class="type">{{ cell()?.col?.typeName?.toLowerCase() }}</span>
      <span class="grow"></span>
      @if (isJson()) {
        <div class="seg">
          <button [class.on]="!raw()" (click)="raw.set(false)">JSON</button>
          <button [class.on]="raw()" (click)="raw.set(true)">Raw</button>
        </div>
      }
    </div>
    @if (cell(); as c) {
      @if (editable()) {
        <textarea class="val selectable" spellcheck="false" [value]="shown()" (input)="draft.set($any($event.target).value)"></textarea>
        <div class="foot">
          <span class="muted">{{ length() }}</span>
          <span class="grow"></span>
          <button class="btn sm" (click)="apply.emit(null)">Set NULL</button>
          <button class="btn primary sm" [disabled]="draft() === null" (click)="commit()">Apply to cell</button>
        </div>
      } @else {
        <pre class="val selectable" [class.null]="c.value === null">{{ c.value === null ? 'NULL' : shown() }}</pre>
        <div class="foot"><span class="muted">{{ length() }}</span></div>
      }
    } @else {
      <div class="empty">Select a cell</div>
    }
  `,
  styles: `
    :host { display:flex; flex-direction:column; min-height:0; border-left:1px solid var(--border); background:var(--panel); }
    .head { display:flex; align-items:center; gap:8px; padding:0 10px; height:34px; border-bottom:1px solid var(--border); flex:none }
    .name { font-weight:600 } .type { font:11px var(--mono); color:var(--muted) } .grow { flex:1 }
    .val { flex:1; margin:0; padding:10px; border:0; outline:none; resize:none; overflow:auto; background:var(--panel);
           font:12px/1.55 var(--mono); white-space:pre-wrap; word-break:break-word; }
    .val.null { color:var(--null); font-style:italic }
    .foot { display:flex; align-items:center; gap:6px; padding:6px 10px; border-top:1px solid var(--border); font-size:12px; flex:none }
    .seg button { height:22px; font-size:11px }
  `,
})
export class ValueInspector {
  readonly cell = input<{ value: Cell; col: GridColumn | null; row: number } | null>(null);
  readonly editable = input(false);
  readonly apply = output<Cell>();
  readonly raw = signal(false);
  readonly draft = signal<string | null>(null);

  readonly isJson = computed(() => {
    const v = this.cell()?.value;
    if (!v || !/^\s*[[{]/.test(v)) return false;
    try {
      JSON.parse(v);
      return true;
    } catch {
      return false;
    }
  });

  readonly shown = computed(() => {
    const v = this.cell()?.value ?? '';
    if (this.isJson() && !this.raw()) return JSON.stringify(JSON.parse(v), null, 2);
    return v;
  });

  readonly length = computed(() => {
    const v = this.cell()?.value;
    return v === null || v === undefined ? '' : `${v.length.toLocaleString()} chars`;
  });

  constructor() {
    effect(() => {
      this.cell();
      this.draft.set(null);
    });
  }

  commit() {
    let v = this.draft();
    if (v === null) return;
    if (this.isJson() && !this.raw()) {
      try {
        v = JSON.stringify(JSON.parse(v));
      } catch {
        /* keep as typed */
      }
    }
    this.apply.emit(v);
    this.draft.set(null);
  }
}
