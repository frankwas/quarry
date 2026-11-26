import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private n = 0;

  show(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 8000 : 3500) {
    const id = ++this.n;
    this.toasts.update((t) => [...t, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
  success(text: string) {
    this.show(text, 'success');
  }
  error(text: string) {
    this.show(text, 'error');
  }
  dismiss(id: number) {
    this.toasts.update((t) => t.filter((x) => x.id !== id));
  }
}
