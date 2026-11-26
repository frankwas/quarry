import { effect, Injectable, signal } from '@angular/core';

export type Theme = 'system' | 'light' | 'dark';

interface Settings {
  theme: Theme;
  maxRows: number;
  stopOnError: boolean;
  editorFontSize: number;
  sidebarWidth: number;
  confirmUnsafeWrites: boolean;
  claudeModel: string;
  claudeEffort: 'low' | 'medium' | 'high' | 'xhigh';
  claudeAllowQueries: boolean;
}

const DEFAULTS: Settings = {
  theme: 'system',
  maxRows: 5000,
  stopOnError: true,
  editorFontSize: 13,
  sidebarWidth: 280,
  confirmUnsafeWrites: true,
  claudeModel: 'claude-opus-5-5',
  claudeEffort: 'high',
  claudeAllowQueries: false,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('quarry.settings') || '{}') };
  } catch {
    return DEFAULTS;
  }
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly s = signal<Settings>(load());
  private media = window.matchMedia('(prefers-color-scheme: dark)');
  readonly systemDark = signal(this.media.matches);

  constructor() {
    this.media.addEventListener('change', (e) => this.systemDark.set(e.matches));
    effect(() => {
      const st = this.s();
      try {
        localStorage.setItem('quarry.settings', JSON.stringify(st));
      } catch {
        /* ignore */
      }
      const dark = st.theme === 'dark' || (st.theme === 'system' && this.systemDark());
      document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    });
  }

  isDark(): boolean {
    const t = this.s().theme;
    return t === 'dark' || (t === 'system' && this.systemDark());
  }

  patch(p: Partial<Settings>) {
    this.s.update((v) => ({ ...v, ...p }));
  }

  /** Per-key persisted state for small UI conveniences (history, last tab...). */
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem('quarry.' + key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  put(key: string, value: unknown) {
    try {
      localStorage.setItem('quarry.' + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }
}
