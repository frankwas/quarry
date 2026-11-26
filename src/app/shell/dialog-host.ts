import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { DialogService } from '../core/dialog.service';
import { Icon } from '../ui/icon';
import { SqlEditor } from '../ui/sql-editor';

@Component({
  selector: 'q-dialog-host',
  imports: [Icon, SqlEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (d.current(); as c) {
      <div class="backdrop" (mousedown.self)="d.close(null)">
        <div class="modal" [class.wide]="!!c.sql" (keydown.escape)="d.close(null)" (keydown.control.enter)="ok()">
          <header>
            <h2>{{ c.title }}</h2>
            <button class="btn ghost icon sm" (click)="d.close(null)"><q-icon name="x" /></button>
          </header>
          <div class="content">
            @if (c.message) {
              <p class="msg selectable">{{ c.message }}</p>
            }
            @if (c.sql) {
              <div class="sql"><q-sql-editor [value]="c.sql" [readOnly]="true" /></div>
            }
            @if (c.input) {
              <div class="field">
                <label>{{ c.input.label }}</label>
                <input #inp class="input" [value]="value()" (input)="value.set($any($event.target).value)" (keydown.enter)="ok()" [placeholder]="c.input.placeholder ?? ''" />
              </div>
            }
          </div>
          <footer>
            @if (c.sql) {
              <button class="btn ghost" (click)="copy(c.sql)"><q-icon name="copy" />Copy SQL</button>
            }
            <span class="grow"></span>
            @if (c.cancelText !== null) {
              <button class="btn" (click)="d.close(null)">{{ c.cancelText ?? 'Cancel' }}</button>
            }
            <button #okBtn class="btn" [class.primary]="!c.danger" [class.danger]="c.danger" (click)="ok()">{{ c.confirmText ?? 'OK' }}</button>
          </footer>
        </div>
      </div>
    }
  `,
  styleUrl: './modal.css',
  styles: `
    .msg { margin:0 0 12px; white-space:pre-wrap; line-height:1.5 }
    .sql { height:min(360px, 50vh); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden }
    .grow { flex:1 }
  `,
})
export class DialogHost {
  readonly d = inject(DialogService);
  readonly value = signal('');
  private inp = viewChild<ElementRef<HTMLInputElement>>('inp');
  private okBtn = viewChild<ElementRef<HTMLButtonElement>>('okBtn');

  constructor() {
    effect(() => {
      const c = this.d.current();
      if (!c) return;
      this.value.set(c.input?.value ?? '');
      setTimeout(() => {
        const i = this.inp()?.nativeElement;
        if (i) {
          i.focus();
          i.select();
        } else this.okBtn()?.nativeElement.focus();
      });
    });
  }

  ok() {
    const c = this.d.current();
    if (!c) return;
    if (c.input) {
      const v = this.value().trim();
      if (!v) return;
      this.d.close(v);
    } else this.d.close(true);
  }

  copy(s: string) {
    navigator.clipboard.writeText(s);
  }
}
