import type { TtsProvider, TtsRequest, TtsResult } from './tts-provider.js';

export interface QuotaTtsOptions {
  maxCharactersPerMonth: number;
  now?: () => Date;
}

export class QuotaTtsProvider implements TtsProvider {
  private readonly provider: TtsProvider;
  private readonly maxCharactersPerMonth: number;
  private readonly now: () => Date;
  private readonly used = new Map<string, number>();
  private readonly cache = new Map<string, TtsResult>();

  constructor(provider: TtsProvider, options: QuotaTtsOptions) {
    this.provider = provider;
    this.maxCharactersPerMonth = options.maxCharactersPerMonth;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxCharactersPerMonth) || this.maxCharactersPerMonth <= 0) {
      throw new Error('TTS monthly quota must be a positive integer');
    }
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const month = this.now().toISOString().slice(0, 7);
    const key = `${month}:${JSON.stringify(request)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const characters = Array.from(request.text).length;
    const consumed = this.used.get(month) ?? 0;
    if (consumed + characters > this.maxCharactersPerMonth) {
      throw new Error('TTS cloud quota exhausted');
    }
    const result = await this.provider.synthesize(request);
    this.used.set(month, consumed + characters);
    this.cache.set(key, result);
    return result;
  }

  usage(): { month: string; usedCharacters: number; maxCharacters: number } {
    const month = this.now().toISOString().slice(0, 7);
    return {
      month,
      usedCharacters: this.used.get(month) ?? 0,
      maxCharacters: this.maxCharactersPerMonth,
    };
  }
}
