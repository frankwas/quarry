import { computed, inject, Injectable, signal } from '@angular/core';
import { AiProvider, api } from './api';
import { SettingsService } from './settings.service';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'best quality · $4 / $20 per M tokens' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'faster · $2 / $10 per M tokens' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'quickest, cheapest · $0.10 / $0.50' },
];

export const PROVIDERS: { id: AiProvider; label: string; keysUrl: string; vendor: string }[] = [
  { id: 'anthropic', label: 'Claude', keysUrl: 'https://console.anthropic.com/settings/keys', vendor: 'Anthropic' },
  { id: 'openai', label: 'OpenAI', keysUrl: 'https://platform.openai.com/api-keys', vendor: 'OpenAI' },
];

/** Pick a sensible default from an OpenAI account's model list. */
export function defaultOpenAiModel(ids: string[]): string {
  const ver = (id: string) => Number(/^gpt-(\d+(?:\.\d+)?)$/.exec(id)?.[1] ?? 0);
  const flagship = ids.filter((id) => /^gpt-\d+(\.\d+)?$/.test(id)).sort((a, b) => ver(b) - ver(a));
  return flagship[0] ?? ids.find((id) => id.startsWith('gpt-')) ?? ids[0] ?? '';
}

/** Which assistant providers have a stored key (keys themselves stay in Rust). */
@Injectable({ providedIn: 'root' })
export class AiService {
  private settings = inject(SettingsService);
  readonly keys = signal<Record<AiProvider, boolean> | null>(null);
  readonly openaiModels = signal<string[]>(this.settings.get('openai.models', [] as string[]));

  readonly provider = computed(() => this.settings.s().aiProvider);
  readonly info = computed(() => PROVIDERS.find((p) => p.id === this.provider())!);
  readonly hasKey = computed(() => {
    const k = this.keys();
    return k === null ? null : k[this.provider()];
  });
  readonly model = computed(() => (this.provider() === 'openai' ? this.settings.s().openaiModel : this.settings.s().claudeModel));

  constructor() {
    this.refresh();
  }

  async refresh() {
    try {
      this.keys.set(await api.aiKeyStatus());
    } catch {
      this.keys.set({ anthropic: false, openai: false });
    }
  }

  /** Validates the key against the provider before saving it. */
  async save(provider: AiProvider, key: string) {
    const models = await api.aiTestKey(provider, key);
    await api.aiSetKey(provider, key);
    if (provider === 'openai') this.setOpenAiModels(models);
    await this.refresh();
  }

  async remove(provider: AiProvider) {
    await api.aiSetKey(provider, '');
    await this.refresh();
  }

  async reloadOpenAiModels() {
    this.setOpenAiModels(await api.aiTestKey('openai', null));
  }

  private setOpenAiModels(models: string[]) {
    this.openaiModels.set(models);
    this.settings.put('openai.models', models);
    const cur = this.settings.s().openaiModel;
    if (!cur || !models.includes(cur)) this.settings.patch({ openaiModel: defaultOpenAiModel(models) });
  }
}
