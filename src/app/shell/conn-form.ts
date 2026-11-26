import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, errText } from '../core/api';
import { ConnConfig, ConnSummary, SslMode } from '../core/models';
import { KEYSTORE } from '../core/platform';
import { Icon } from '../ui/icon';

export const CONN_COLORS = ['#0b7d6e', '#2f6feb', '#8a3ab9', '#c63d3d', '#d9822b', '#b7791f', '#2f8a3e', '#5f6b7a'];

@Component({
  selector: 'q-conn-form',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (mousedown.self)="cancel.emit()">
      <div class="modal" (keydown.escape)="cancel.emit()" (keydown.control.enter)="saveIt(false)">
        <header>
          <h2>{{ isNew() ? 'New connection' : 'Edit connection' }}</h2>
          <button class="btn ghost icon sm" (click)="cancel.emit()"><q-icon name="x" /></button>
        </header>
        <div class="content">
          <div class="row">
            <div class="field grow2">
              <label>Name</label>
              <input class="input" [value]="c().name" (input)="set('name', $any($event.target).value)" placeholder="e.g. Production — orders" autofocus />
            </div>
            <div class="field">
              <label>Group</label>
              <input class="input" [value]="c().group ?? ''" (input)="set('group', $any($event.target).value || null)" placeholder="optional" />
            </div>
          </div>
          <div class="colors">
            <span class="label">Colour</span>
            @for (col of colors; track col) {
              <button class="swatch" [style.background]="col" [class.on]="c().color === col" (click)="set('color', col)"></button>
            }
          </div>

          <div class="section-title">Server</div>
          <div class="row">
            <div class="field grow2">
              <label>Host</label>
              <input class="input mono" [value]="c().host" (input)="set('host', $any($event.target).value)" placeholder="127.0.0.1" spellcheck="false" />
            </div>
            <div class="field port">
              <label>Port</label>
              <input class="input mono" type="number" [value]="c().port" (input)="set('port', +$any($event.target).value)" />
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>User</label>
              <input class="input mono" [value]="c().user" (input)="set('user', $any($event.target).value)" spellcheck="false" />
            </div>
            <div class="field">
              <label>Password {{ hasPassword() && password() === null ? '(saved)' : '' }}</label>
              <input
                class="input"
                type="password"
                [placeholder]="hasPassword() ? '••••••••  (leave to keep)' : ''"
                [value]="password() ?? ''"
                (input)="password.set($any($event.target).value)"
              />
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>Default schema</label>
              <input class="input mono" [value]="c().database ?? ''" (input)="set('database', $any($event.target).value || null)" placeholder="optional" spellcheck="false" />
            </div>
            <div class="field">
              <label>TLS</label>
              <select class="input" [value]="c().ssl" (change)="set('ssl', $any($event.target).value)">
                @for (m of sslModes; track m.v) {
                  <option [value]="m.v" [selected]="m.v === c().ssl">{{ m.label }}</option>
                }
              </select>
            </div>
          </div>

          <div class="section-title ssh-title">
            <label class="check"><input type="checkbox" [checked]="!!c().ssh" (change)="toggleSsh()" />SSH tunnel</label>
          </div>
          @if (c().ssh; as ssh) {
            <div class="row">
              <div class="field grow2">
                <label>SSH host</label>
                <input class="input mono" [value]="ssh.host" (input)="setSsh('host', $any($event.target).value)" spellcheck="false" />
              </div>
              <div class="field port">
                <label>Port</label>
                <input class="input mono" type="number" [value]="ssh.port" (input)="setSsh('port', +$any($event.target).value)" />
              </div>
            </div>
            <div class="row">
              <div class="field">
                <label>SSH user</label>
                <input class="input mono" [value]="ssh.user" (input)="setSsh('user', $any($event.target).value)" spellcheck="false" />
              </div>
              <div class="field">
                <label>Auth</label>
                <div class="seg">
                  <button [class.on]="ssh.auth === 'key'" (click)="setSsh('auth', 'key')">Key file</button>
                  <button [class.on]="ssh.auth === 'password'" (click)="setSsh('auth', 'password')">Password</button>
                </div>
              </div>
            </div>
            @if (ssh.auth === 'key') {
              <div class="row">
                <div class="field grow2">
                  <label>Private key</label>
                  <div class="with-btn">
                    <input class="input mono" [value]="ssh.keyPath ?? ''" (input)="setSsh('keyPath', $any($event.target).value)" placeholder="~/.ssh/id_ed25519" spellcheck="false" />
                    <button class="btn" (click)="pickKey()">Browse…</button>
                  </div>
                </div>
                <div class="field">
                  <label>Passphrase {{ hasSsh() && sshSecret() === null ? '(saved)' : '' }}</label>
                  <input class="input" type="password" [value]="sshSecret() ?? ''" (input)="sshSecret.set($any($event.target).value)" placeholder="if encrypted" />
                </div>
              </div>
            } @else {
              <div class="row">
                <div class="field">
                  <label>SSH password {{ hasSsh() && sshSecret() === null ? '(saved)' : '' }}</label>
                  <input class="input" type="password" [value]="sshSecret() ?? ''" (input)="sshSecret.set($any($event.target).value)" />
                </div>
                <div class="field"></div>
              </div>
            }
            <p class="hint muted">MySQL host and port above are resolved from the SSH server (often <code>127.0.0.1:3306</code>).</p>
          }

          <div class="section-title">Safety</div>
          <label class="check"><input type="checkbox" [checked]="c().readOnly" (change)="set('readOnly', !c().readOnly)" />Read-only — block writes from the editor and grid</label>
          <p class="hint muted">Passwords are stored in {{ keystore }}, never in Quarry's settings file.</p>

          @if (testResult(); as t) {
            <div class="test" [class.bad]="!t.ok">
              <q-icon [name]="t.ok ? 'check' : 'x'" />
              <span class="selectable">{{ t.text }}</span>
            </div>
          }
        </div>
        <footer>
          <button class="btn" (click)="test()" [disabled]="testing() || !valid()">
            @if (testing()) {
              <span class="spin"></span>
            } @else {
              <q-icon name="plug" />
            }
            Test
          </button>
          <span class="grow"></span>
          <button class="btn" (click)="cancel.emit()">Cancel</button>
          <button class="btn" (click)="saveIt(false)" [disabled]="!valid() || saving()">Save</button>
          <button class="btn primary" (click)="saveIt(true)" [disabled]="!valid() || saving()">Save & connect</button>
        </footer>
      </div>
    </div>
  `,
  styleUrl: './modal.css',
  styles: `
    .row { display:flex; gap:12px; margin-bottom:12px }
    .row > .field { flex:1 } .row > .grow2 { flex:2 } .row > .port { flex:0 0 96px }
    .colors { display:flex; align-items:center; gap:7px; margin:-2px 0 16px }
    .colors .label { margin-right:6px }
    .swatch { width:20px; height:20px; border-radius:50%; border:2px solid transparent; cursor:pointer; padding:0; box-shadow:inset 0 0 0 1px rgba(0,0,0,.15) }
    .swatch.on { border-color:var(--text); box-shadow:0 0 0 2px var(--panel) inset }
    .section-title { margin-top:18px }
    .ssh-title .check { font-size:11px; letter-spacing:.06em }
    .with-btn { display:flex; gap:6px }
    .hint { font-size:12px; margin:4px 0 0 }
    .test { display:flex; gap:8px; align-items:flex-start; margin-top:16px; padding:10px 12px; border-radius:var(--radius);
            background:var(--accent-soft); color:var(--accent); font-size:12.5px; white-space:pre-wrap }
    .test.bad { background:var(--danger-soft); color:var(--danger) }
    .grow { flex:1 }
  `,
})
export class ConnForm implements OnInit {
  readonly keystore = KEYSTORE;
  readonly initial = input<ConnSummary | null>(null);
  readonly saved = output<{ conn: ConnSummary; connect: boolean }>();
  readonly cancel = output<void>();

  readonly colors = CONN_COLORS;
  readonly sslModes: { v: SslMode; label: string }[] = [
    { v: 'preferred', label: 'Preferred (try TLS, fall back)' },
    { v: 'required', label: 'Required (no cert check)' },
    { v: 'verify', label: 'Verify certificate' },
    { v: 'disabled', label: 'Disabled' },
  ];

  readonly c = signal<ConnConfig>({ id: '', name: '', host: '127.0.0.1', port: 3306, user: 'root', ssl: 'preferred', readOnly: false, color: CONN_COLORS[0] });
  readonly password = signal<string | null>(null);
  readonly sshSecret = signal<string | null>(null);
  readonly hasPassword = signal(false);
  readonly hasSsh = signal(false);
  readonly testing = signal(false);
  readonly saving = signal(false);
  readonly testResult = signal<{ ok: boolean; text: string } | null>(null);

  readonly isNew = computed(() => !this.initial() || !this.initial()!.id);
  readonly valid = computed(() => !!this.c().host.trim() && !!this.c().user.trim() && this.c().port > 0);

  ngOnInit() {
    const i = this.initial();
    if (i) {
      const { hasPassword, hasSshSecret, ...cfg } = i;
      this.c.set({ ...cfg, ssh: cfg.ssh ? { ...cfg.ssh } : null });
      this.hasPassword.set(hasPassword);
      this.hasSsh.set(hasSshSecret);
    }
  }

  set<K extends keyof ConnConfig>(k: K, v: ConnConfig[K]) {
    this.c.update((c) => ({ ...c, [k]: v }));
    this.testResult.set(null);
  }

  setSsh(k: string, v: unknown) {
    this.c.update((c) => ({ ...c, ssh: { ...c.ssh!, [k]: v } }));
    this.testResult.set(null);
  }

  toggleSsh() {
    this.c.update((c) => ({ ...c, ssh: c.ssh ? null : { host: '', port: 22, user: '', auth: 'key', keyPath: '~/.ssh/id_ed25519' } }));
  }

  async pickKey() {
    const p = await openDialog({ multiple: false });
    if (p && !Array.isArray(p)) this.setSsh('keyPath', p);
  }

  private secrets() {
    return { password: this.password(), sshSecret: this.sshSecret() };
  }

  private cfgForSave(): ConnConfig {
    const c = this.c();
    return { ...c, name: c.name.trim() || `${c.user}@${c.host}` };
  }

  async test() {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const r = await api.connTest(this.cfgForSave(), this.secrets());
      this.testResult.set({ ok: true, text: `Connected to MySQL ${r.serverVersion} in ${Math.round(r.elapsedMs)} ms${r.ssl ? ' · TLS' : ' · not encrypted'}${this.c().ssh ? ' · via SSH' : ''}` });
    } catch (e) {
      this.testResult.set({ ok: false, text: errText(e) });
    } finally {
      this.testing.set(false);
    }
  }

  async saveIt(connect: boolean) {
    if (!this.valid()) return;
    this.saving.set(true);
    try {
      const cfg = await api.connSave(this.cfgForSave(), this.secrets());
      const list = await api.connList();
      const conn = list.find((x) => x.id === cfg.id)!;
      this.saved.emit({ conn, connect });
    } catch (e) {
      this.testResult.set({ ok: false, text: errText(e) });
    } finally {
      this.saving.set(false);
    }
  }
}
