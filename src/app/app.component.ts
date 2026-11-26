import { ChangeDetectionStrategy, Component, HostListener, inject, signal } from '@angular/core';
import { SettingsService } from './core/settings.service';
import { ToastService } from './core/toast.service';
import { WorkspaceService } from './core/workspace.service';
import { DialogHost } from './shell/dialog-host';
import { Home } from './shell/home';
import { Palette } from './shell/palette';
import { SessionView } from './shell/session-view';
import { SettingsPanel } from './shell/settings-panel';
import { Icon } from './ui/icon';

@Component({
  selector: 'app-root',
  imports: [Home, SessionView, DialogHost, Palette, Icon, SettingsPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  readonly ws = inject(WorkspaceService);
  readonly toast = inject(ToastService);
  readonly settings = inject(SettingsService);
  readonly palette = signal(false);
  readonly showSettings = signal(false);

  constructor() {
    // Block the webview's own context menu outside inputs.
    document.addEventListener('contextmenu', (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('input, textarea, .cm-editor')) e.preventDefault();
    });
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const s = this.ws.active();
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.palette.set(!this.palette());
    } else if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
      e.preventDefault();
      this.palette.set(true);
    } else if (mod && e.key.toLowerCase() === 't' && s) {
      e.preventDefault();
      this.ws.openQuery(s);
    } else if (mod && e.key.toLowerCase() === 'w' && s?.activeTab()) {
      e.preventDefault();
      this.ws.close(s, s.activeTab()!);
    } else if (mod && e.key === 'Tab' && s) {
      e.preventDefault();
      const tabs = s.tabs();
      const i = tabs.findIndex((t) => t.id === s.activeTab());
      const n = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (n) s.activeTab.set(n.id);
    } else if (mod && e.key === ',') {
      e.preventDefault();
      this.showSettings.set(true);
    } else if (e.key === 'F5' && !(e.target as HTMLElement).closest('.cm-editor')) {
      e.preventDefault(); // no webview reload
    }
  }

  toggleTheme() {
    this.settings.patch({ theme: this.settings.isDark() ? 'light' : 'dark' });
  }
}
