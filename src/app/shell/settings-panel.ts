import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { AiProvider, errText } from '../core/api';
import { AiService, CLAUDE_MODELS, PROVIDERS } from '../core/claude.service';
import { SettingsService, Theme } from '../core/settings.service';
import { KEYSTORE } from '../core/platform';
import { Icon } from '../ui/icon';

@Component({
  selector: 'q-settings-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (mousedown.self)="closed.emit()">
      <div class="modal" (keydown.escape)="closed.emit()">
        <header>
          <h2>Settings</h2>
          <button class="btn ghost icon sm" (click)="closed.emit()"><q-icon name="x" /></button>
        </header>
        <div class="content">
          <div class="row">
            <div>
              <div class="t">Theme</div>
            </div>
            <div class="seg">
              @for (t of themes; track t.v) {
                <button [class.on]="st.s().theme === t.v" (click)="st.patch({ theme: t.v })">{{ t.label }}</button>
              }
            </div>
          </div>
          <div class="row">
            <div>
              <div class="t">Editor font size</div>
            </div>
            <input class="input num" type="number" min="10" max="22" [value]="st.s().editorFontSize" (change)="st.patch({ editorFontSize: +$any($event.target).value })" />
          </div>
          <div class="row">
            <div>
              <div class="t">Result row limit</div>
              <div class="d">Rows kept per result set in the query editor. The full count is still reported.</div>
            </div>
            <input class="input num" type="number" min="100" step="1000" [value]="st.s().maxRows" (change)="st.patch({ maxRows: +$any($event.target).value })" />
          </div>
          <div class="row">
            <div>
              <div class="t">Stop script on first error</div>
            </div>
            <input type="checkbox" class="toggle" [checked]="st.s().stopOnError" (change)="st.patch({ stopOnError: !st.s().stopOnError })" />
          </div>
          <div class="row">
            <div>
              <div class="t">Confirm UPDATE/DELETE without WHERE</div>
              <div class="d">Shows the statement and asks before running it.</div>
            </div>
            <input type="checkbox" class="toggle" [checked]="st.s().confirmUnsafeWrites" (change)="st.patch({ confirmUnsafeWrites: !st.s().confirmUnsafeWrites })" />
          </div>
          <div class="section-title keys-title">AI assistant</div>
          <div class="row">
            <div>
              <div class="t">Provider</div>
              <div class="d">Used by the assistant panel in query tabs. Keys are stored in {{ keystore }}.</div>
            </div>
            <div class="seg">
              @for (p of providers; track p.id) {
                <button [class.on]="st.s().aiProvider === p.id" (click)="st.patch({ aiProvider: p.id })">{{ p.label }}</button>
              }
            </div>
          </div>
          @for (p of providers; track p.id) {
            <div class="row">
              <div>
                <div class="t">{{ p.label }} API key</div>
                <div class="d">
                  @if (ai.keys()?.[p.id]) {
                    Saved.
                  } @else {
                    Not set. Create one at {{ p.keysUrl.replace('https://', '') }}.
                  }
                </div>
              </div>
              @if (ai.keys()?.[p.id]) {
                <button class="btn sm" (click)="ai.remove(p.id)">Remove key</button>
              }
            </div>
            <div class="row key-row">
              <input
                class="input mono"
                type="password"
                [placeholder]="(ai.keys()?.[p.id] ? 'Replace with a new key ' : '') + (p.id === 'openai' ? 'sk-…' : 'sk-ant-…')"
                [value]="keyDrafts()[p.id]"
                (input)="setDraft(p.id, $any($event.target).value)"
                spellcheck="false"
              />
              <button class="btn primary sm" [disabled]="!keyDrafts()[p.id].trim() || savingKey() === p.id" (click)="saveKey(p.id)">Verify & save</button>
            </div>
            @if (keyMsg()?.provider === p.id) {
              <div class="key-msg" [class.danger-text]="keyMsg()!.bad" [class.ok-text]="!keyMsg()!.bad">{{ keyMsg()!.text }}</div>
            }
          }
          <div class="row">
            <div><div class="t">Claude model</div></div>
            <select class="input sel" [value]="st.s().claudeModel" (change)="st.patch({ claudeModel: $any($event.target).value })">
              @for (m of models; track m.id) {
                <option [value]="m.id" [selected]="m.id === st.s().claudeModel">{{ m.label }} — {{ m.hint }}</option>
              }
            </select>
          </div>
          <div class="row">
            <div>
              <div class="t">OpenAI model</div>
              <div class="d">Listed from your OpenAI account.</div>
            </div>
            @if (ai.openaiModels().length) {
              <select class="input sel" [value]="st.s().openaiModel" (change)="st.patch({ openaiModel: $any($event.target).value })">
                @for (m of ai.openaiModels(); track m) {
                  <option [value]="m" [selected]="m === st.s().openaiModel">{{ m }}</option>
                }
              </select>
            } @else {
              <input class="input sel mono" placeholder="model id" [value]="st.s().openaiModel" (change)="st.patch({ openaiModel: $any($event.target).value })" />
            }
            @if (ai.keys()?.openai) {
              <button class="btn ghost icon sm" (click)="reloadModels()" title="Reload model list"><q-icon name="refresh" /></button>
            }
          </div>
          <div class="row">
            <div>
              <div class="t">Effort</div>
              <div class="d">Higher effort thinks longer and costs more; high suits schema work.</div>
            </div>
            <div class="seg">
              @for (e of efforts; track e) {
                <button [class.on]="st.s().claudeEffort === e" (click)="st.patch({ claudeEffort: e })">{{ e }}</button>
              }
            </div>
          </div>
          <div class="row">
            <div>
              <div class="t">Let the assistant run read-only queries</div>
              <div class="d">SELECT/SHOW/EXPLAIN only, 50 rows max, inside a READ ONLY transaction. Results are sent to the selected provider.</div>
            </div>
            <input type="checkbox" class="toggle" [checked]="st.s().claudeAllowQueries" (change)="st.patch({ claudeAllowQueries: !st.s().claudeAllowQueries })" />
          </div>

          <div class="section-title keys-title">Keyboard</div>
          <div class="keys">
            <span>Run statement at cursor</span><span><kbd>Ctrl</kbd> <kbd>Enter</kbd></span>
            <span>Run all / selection</span><span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd></span>
            <span>Explain</span><span><kbd>Ctrl</kbd> <kbd>E</kbd></span>
            <span>Format SQL</span><span><kbd>Shift</kbd> <kbd>Alt</kbd> <kbd>F</kbd></span>
            <span>Autocomplete</span><span data-raw-ctrl><kbd>Ctrl</kbd> <kbd>Space</kbd></span>
            <span>Toggle comment</span><span><kbd>Ctrl</kbd> <kbd>/</kbd></span>
            <span>Command palette</span><span><kbd>Ctrl</kbd> <kbd>K</kbd></span>
            <span>AI assistant (in a query tab)</span><span><kbd>Ctrl</kbd> <kbd>I</kbd></span>
            <span>New / close tab</span><span><kbd>Ctrl</kbd> <kbd>T</kbd> / <kbd>Ctrl</kbd> <kbd>W</kbd></span>
            <span>Grid: edit / set NULL</span><span><kbd>Enter</kbd> / <kbd>Ctrl</kbd> <kbd>0</kbd></span>
            <span>Grid: copy with headers</span><span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>C</kbd></span>
          </div>
        </div>
      </div>
    </div>
  `,
  styleUrl: './modal.css',
  styles: `
    .row { display:flex; align-items:center; gap:16px; padding:12px 0; border-bottom:1px solid var(--border) }
    .row > div:first-child { flex:1 }
    .t { font-weight:600 } .d { color:var(--muted); font-size:12px; margin-top:2px }
    .num { width:110px }
    .toggle { width:16px; height:16px; accent-color:var(--accent) }
    .keys-title { margin-top:18px }
    .key-row { border-bottom:0; padding-top:0 } .key-row .input { flex:1 }
    .key-msg { font-size:12px; margin:-4px 0 6px }
    .sel { width:auto; max-width:360px }
    .keys { display:grid; grid-template-columns:1fr auto; gap:8px 16px; font-size:12.5px; color:var(--text-2) }
  `,
})
export class SettingsPanel {
  readonly keystore = KEYSTORE;
  readonly st = inject(SettingsService);
  readonly ai = inject(AiService);
  readonly models = CLAUDE_MODELS;
  readonly providers = PROVIDERS;
  readonly efforts = ['low', 'medium', 'high', 'xhigh'] as const;
  readonly keyDrafts = signal<Record<AiProvider, string>>({ anthropic: '', openai: '' });
  readonly savingKey = signal<AiProvider | null>(null);
  readonly keyMsg = signal<{ provider: AiProvider; text: string; bad: boolean } | null>(null);

  setDraft(p: AiProvider, v: string) {
    this.keyDrafts.update((d) => ({ ...d, [p]: v }));
  }

  async saveKey(p: AiProvider) {
    this.savingKey.set(p);
    this.keyMsg.set(null);
    try {
      await this.ai.save(p, this.keyDrafts()[p].trim());
      this.setDraft(p, '');
      this.keyMsg.set({ provider: p, text: 'Key verified and saved.', bad: false });
    } catch (e) {
      this.keyMsg.set({ provider: p, text: errText(e), bad: true });
    } finally {
      this.savingKey.set(null);
    }
  }

  async reloadModels() {
    try {
      await this.ai.reloadOpenAiModels();
      this.keyMsg.set({ provider: 'openai', text: `${this.ai.openaiModels().length} models found.`, bad: false });
    } catch (e) {
      this.keyMsg.set({ provider: 'openai', text: errText(e), bad: true });
    }
  }
  readonly closed = output<void>();
  readonly themes: { v: Theme; label: string }[] = [
    { v: 'system', label: 'System' },
    { v: 'light', label: 'Light' },
    { v: 'dark', label: 'Dark' },
  ];
}
