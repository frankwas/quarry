import { DestroyRef, inject, signal } from '@angular/core';
import { UnlistenFn } from '@tauri-apps/api/event';
import { api, uid } from '../core/api';
import { TaskProgress } from '../core/models';

/** Tracks one long-running backend job (progress events + cancel). */
export function useTask() {
  const destroy = inject(DestroyRef);
  const id = signal<string | null>(null);
  const progress = signal<TaskProgress | null>(null);
  let unlisten: UnlistenFn | null = null;

  api.onProgress((p) => {
    if (p.taskId === id()) progress.set(p);
  }).then((u) => (unlisten = u));
  destroy.onDestroy(() => unlisten?.());

  return {
    id,
    progress,
    running: () => id() !== null,
    start(prefix: string): string {
      const t = uid(prefix);
      progress.set(null);
      id.set(t);
      return t;
    },
    done() {
      id.set(null);
    },
    cancel() {
      const t = id();
      if (t) api.taskCancel(t);
    },
    pct(): number | null {
      const p = progress();
      if (!p || !p.total) return null;
      return Math.min(100, (p.done / p.total) * 100);
    },
  };
}
