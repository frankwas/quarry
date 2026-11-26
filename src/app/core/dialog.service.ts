import { Injectable, signal } from '@angular/core';

export interface DialogSpec {
  title: string;
  message?: string;
  /** SQL shown read-only (and selectable) for review before running. */
  sql?: string;
  input?: { label: string; value: string; placeholder?: string };
  confirmText?: string;
  cancelText?: string | null;
  danger?: boolean;
}

interface Pending extends DialogSpec {
  resolve: (v: string | boolean | null) => void;
}

@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly current = signal<Pending | null>(null);

  private openDialog(spec: DialogSpec): Promise<string | boolean | null> {
    return new Promise((resolve) => this.current.set({ ...spec, resolve }));
  }

  async confirm(spec: DialogSpec): Promise<boolean> {
    return (await this.openDialog(spec)) === true;
  }

  async prompt(title: string, label: string, value = '', confirmText = 'OK'): Promise<string | null> {
    const r = await this.openDialog({ title, input: { label, value }, confirmText });
    return typeof r === 'string' ? r : null;
  }

  /** Show generated SQL, resolve true if the user chooses to run it. */
  reviewSql(title: string, sql: string, confirmText = 'Apply', danger = false): Promise<boolean> {
    return this.confirm({ title, sql, confirmText, danger });
  }

  alert(title: string, message: string): Promise<boolean> {
    return this.confirm({ title, message, confirmText: 'OK', cancelText: null });
  }

  close(value: string | boolean | null) {
    const c = this.current();
    this.current.set(null);
    c?.resolve(value);
  }
}
