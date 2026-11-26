import { Injectable, signal } from '@angular/core';
import { api } from './api';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', hint: 'best quality · $4 / $20 per M tokens' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', hint: 'faster · $2 / $10 per M tokens' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', hint: 'quickest, cheapest · $0.10 / $0.50' },
];

/** Whether a Claude API key is stored (the key itself stays in Rust). */
@Injectable({ providedIn: 'root' })
export class ClaudeService {
  readonly hasKey = signal<boolean | null>(null);

  constructor() {
    this.refresh();
  }

  async refresh() {
    try {
      this.hasKey.set(await api.aiHasKey());
    } catch {
      this.hasKey.set(false);
    }
  }

  /** Validates the key against the API before saving it. */
  async save(key: string) {
    await api.aiTestKey(key);
    await api.aiSetKey(key);
    await this.refresh();
  }

  async remove() {
    await api.aiSetKey('');
    await this.refresh();
  }
}
