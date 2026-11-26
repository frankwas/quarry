import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AiEvent, AiProvider, api, errText, uid } from '../core/api';
import { AiService, CLAUDE_MODELS, PROVIDERS } from '../core/claude.service';
import { SettingsService } from '../core/settings.service';
import { OpenSession } from '../core/workspace.service';
import { Icon } from './icon';
import { renderMarkdown, Segment } from './markdown';

type Part =
  | { type: 'text'; text: string; segs: Segment[] }
  | { type: 'thinking'; text: string; open: boolean }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown>; summary: string | null; isError: boolean }
  | { type: 'notice'; text: string; tone: 'info' | 'warn' | 'error' };

interface ChatTurn {
  role: 'user' | 'assistant';
  text?: string;
  context?: string;
  parts: Part[];
  usage?: string;
}

export interface EditorContext {
  sql: string;
  selection: string;
  lastError: string | null;
}

@Component({
  selector: 'q-claude-panel',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-panel.html',
  styleUrl: './claude-panel.css',
})
export class ClaudePanel {
  readonly ai = inject(AiService);
  readonly settings = inject(SettingsService);

  readonly session = input.required<OpenSession>();
  readonly schema = input<string | null>(null);
  readonly context = input.required<() => EditorContext>();

  readonly insert = output<string>();
  readonly replace = output<string>();
  readonly newTab = output<string>();
  readonly closed = output<void>();

  private list = viewChild<ElementRef<HTMLDivElement>>('list');
  private box = viewChild<ElementRef<HTMLTextAreaElement>>('box');

  readonly models = CLAUDE_MODELS;
  readonly providers = PROVIDERS;
  readonly turns = signal<ChatTurn[]>([]);
  readonly draft = signal('');
  readonly running = signal(false);
  readonly includeEditor = signal(true);
  readonly keyDraft = signal('');
  readonly keyError = signal<string | null>(null);
  readonly savingKey = signal(false);
  readonly copied = signal<string | null>(null);

  private history: unknown[] = [];
  private chatId = uid('chat');
  private unlisten: UnlistenFn | null = null;

  readonly modelLabel = computed(() => this.models.find((m) => m.id === this.ai.model())?.label ?? this.ai.model());

  readonly suggestions = [
    'Write a query that…',
    'Explain what the script in my editor does',
    'Create a migration to add an index for the slowest query',
    'Generate realistic seed data for these tables',
  ];

  constructor() {
    api.onAi((e) => this.onEvent(e)).then((u) => (this.unlisten = u));
    inject(DestroyRef).onDestroy(() => {
      this.unlisten?.();
      if (this.running()) api.taskCancel(this.chatId);
    });
  }

  // ------------------------------------------------------------ key setup

  async saveKey() {
    const k = this.keyDraft().trim();
    if (!k) return;
    this.savingKey.set(true);
    this.keyError.set(null);
    try {
      await this.ai.save(this.ai.provider(), k);
      this.keyDraft.set('');
    } catch (e) {
      this.keyError.set(errText(e));
    } finally {
      this.savingKey.set(false);
    }
  }

  openConsole() {
    openUrl(this.ai.info().keysUrl);
  }

  setProvider(p: AiProvider) {
    if (this.running() || p === this.ai.provider()) return;
    this.settings.patch({ aiProvider: p });
    this.keyDraft.set('');
    this.keyError.set(null);
    // Histories are provider-specific, so switching starts a fresh chat.
    this.newChat();
  }

  setModel(id: string) {
    if (this.ai.provider() === 'openai') this.settings.patch({ openaiModel: id });
    else this.settings.patch({ claudeModel: id });
  }

  // ------------------------------------------------------------ chat

  newChat() {
    if (this.running()) return;
    this.turns.set([]);
    this.history = [];
    this.chatId = uid('chat');
  }

  ask(text: string) {
    this.draft.set(text);
    this.send();
  }

  /** Called by the query tab's "Fix with Claude". */
  fix(sql: string, error: string) {
    this.draft.set(`This statement failed. Explain why and give me a corrected version.\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nError: ${error}`);
    this.send(false);
  }

  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  async send(withEditor = this.includeEditor()) {
    const question = this.draft().trim();
    if (!question || this.running() || !this.ai.hasKey()) return;


    const ctx = this.context()();
    const blocks: string[] = [];
    if (withEditor && ctx.sql.trim()) blocks.push(`<editor_contents>\n${ctx.sql}\n</editor_contents>`);
    if (withEditor && ctx.selection.trim() && ctx.selection !== ctx.sql) blocks.push(`<selected_text>\n${ctx.selection}\n</selected_text>`);
    if (withEditor && ctx.lastError) blocks.push(`<last_error>\n${ctx.lastError}\n</last_error>`);
    const content = blocks.length ? `${blocks.join('\n\n')}\n\n${question}` : question;
    const contextNote = blocks.length ? `with ${withEditor && ctx.selection.trim() ? 'selection' : 'editor contents'}${ctx.lastError && withEditor ? ' + last error' : ''}` : undefined;

    this.turns.update((t) => [...t, { role: 'user', text: question, context: contextNote, parts: [] }, { role: 'assistant', parts: [] }]);
    this.draft.set('');
    this.running.set(true);
    this.scroll();

    const s = this.settings.s();
    try {
      const r = await api.aiChat(this.session().id, this.chatId, this.history, content, {
        provider: s.aiProvider,
        model: this.ai.model(),
        effort: s.claudeEffort,
        allowQueries: s.claudeAllowQueries,
        schema: this.schema(),
      });
      this.history = r.messages;
      const u = r.usage;
      this.patchLast((turn) => {
        if (r.notice) turn.parts.push({ type: 'notice', text: r.notice, tone: 'warn' });
        turn.usage = `${this.k(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} in${u.cacheReadTokens ? ` (${this.k(u.cacheReadTokens)} cached)` : ''} · ${this.k(u.outputTokens)} out`;
      });
    } catch (e) {
      const msg = errText(e);
      this.patchLast((turn) => turn.parts.push({ type: 'notice', text: msg === 'Stopped' ? 'Stopped.' : msg, tone: msg === 'Stopped' ? 'info' : 'error' }));
      if (msg !== 'Stopped' && /api key/i.test(msg)) this.ai.refresh();
    } finally {
      this.running.set(false);
      this.scroll();
      setTimeout(() => this.box()?.nativeElement.focus());
    }
  }

  stop() {
    api.taskCancel(this.chatId);
  }

  private k(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
  }

  private patchLast(fn: (t: ChatTurn) => void) {
    this.turns.update((ts) => {
      const copy = [...ts];
      const last = { ...copy[copy.length - 1], parts: [...copy[copy.length - 1].parts] };
      fn(last);
      copy[copy.length - 1] = last;
      return copy;
    });
  }

  private onEvent(e: AiEvent) {
    if (e.chatId !== this.chatId) return;
    switch (e.kind) {
      case 'text':
        this.patchLast((t) => {
          const p = t.parts.at(-1);
          if (p?.type === 'text') {
            const text = p.text + e.text;
            t.parts[t.parts.length - 1] = { type: 'text', text, segs: renderMarkdown(text) };
          } else t.parts.push({ type: 'text', text: e.text, segs: renderMarkdown(e.text) });
        });
        break;
      case 'thinking':
        this.patchLast((t) => {
          const p = t.parts.at(-1);
          if (p?.type === 'thinking') t.parts[t.parts.length - 1] = { ...p, text: p.text + e.text };
          else t.parts.push({ type: 'thinking', text: e.text, open: false });
        });
        break;
      case 'toolStart':
        this.patchLast((t) => t.parts.push({ type: 'tool', id: e.id, name: e.name, input: e.input ?? {}, summary: null, isError: false }));
        break;
      case 'toolResult':
        this.patchLast((t) => {
          const i = t.parts.findIndex((p) => p.type === 'tool' && p.id === e.id);
          if (i >= 0) t.parts[i] = { ...(t.parts[i] as Extract<Part, { type: 'tool' }>), summary: e.summary, isError: e.isError };
        });
        break;
      case 'fallback':
        this.patchLast((t) => t.parts.push({ type: 'notice', text: `${e.from} declined; continued on ${e.to}.`, tone: 'info' }));
        break;
    }
    this.scroll();
  }

  toggleThinking(turn: number, part: number) {
    this.turns.update((ts) =>
      ts.map((t, i) => (i !== turn ? t : { ...t, parts: t.parts.map((p, j) => (j === part && p.type === 'thinking' ? { ...p, open: !p.open } : p)) })),
    );
  }

  toolLabel(p: Extract<Part, { type: 'tool' }>): string {
    switch (p.name) {
      case 'list_tables':
        return `Listed tables${p.input['schema'] ? ` in ${p.input['schema']}` : ''}`;
      case 'describe_table':
        return `Read structure of ${p.input['table'] ?? '…'}`;
      case 'run_read_query':
        return 'Ran a read-only query';
      default:
        return p.name;
    }
  }

  toolSql(p: Extract<Part, { type: 'tool' }>): string | null {
    return p.name === 'run_read_query' && typeof p.input['sql'] === 'string' ? (p.input['sql'] as string) : null;
  }

  copy(code: string) {
    navigator.clipboard.writeText(code);
    this.copied.set(code);
    setTimeout(() => this.copied.set(null), 1200);
  }

  isSql(lang: string): boolean {
    return !lang || ['sql', 'mysql', 'mariadb'].includes(lang);
  }

  private scroll() {
    setTimeout(() => {
      const el = this.list()?.nativeElement;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
    });
  }

  autosize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }
}
