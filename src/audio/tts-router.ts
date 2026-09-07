import type { TtsProvider, TtsRequest, TtsResult } from './tts-provider.js';

export interface TtsFallbackOptions {
  allowFallback?: boolean;
}

export class TtsFallbackRouter implements TtsProvider {
  private readonly allowFallback: boolean;

  constructor(
    private readonly primary: TtsProvider,
    private readonly fallback?: TtsProvider,
    options: TtsFallbackOptions = {},
  ) {
    this.allowFallback = options.allowFallback ?? false;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    try {
      return await this.primary.synthesize(request);
    } catch (primaryError) {
      if (!this.allowFallback || !this.fallback) throw primaryError;
      return this.fallback.synthesize(request);
    }
  }
}
