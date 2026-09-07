import type { AudioTranscript } from './audio-types.js';
import { GroqSttError } from './providers/groq-stt.js';
import { SttRuntimeConfigSchema, type SttRuntimeConfig } from './stt-config.js';
import type { SttProvider, SttRequestContext } from './stt-provider.js';

export type SttRouterErrorKind = 'configuration' | 'quota' | 'timeout' | 'upstream' | 'invalid_input';

export class SttRouterError extends Error {
  constructor(readonly kind: SttRouterErrorKind, message: string) {
    super(message);
    this.name = 'SttRouterError';
  }
}

export interface SttRouterOptions {
  local: SttProvider;
  groq?: SttProvider;
  config: SttRuntimeConfig;
  canUseCloud?: (audio?: Buffer, mimeType?: string, context?: SttRequestContext) => boolean | Promise<boolean>;
  recordCloudUsage?: (context: SttRequestContext | undefined, transcript: AudioTranscript, audio: Buffer, mimeType: string) => Promise<void>;
}

function localResult(result: AudioTranscript, fallbackFrom?: string): AudioTranscript {
  return {
    ...result,
    processingLocation: 'local',
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

function cloudResult(result: AudioTranscript): AudioTranscript {
  return { ...result, processingLocation: 'cloud' };
}

function isFallbackEligible(error: unknown): boolean {
  if (error instanceof SttRouterError) return error.kind === 'quota';
  return error instanceof GroqSttError && ['quota', 'timeout', 'upstream'].includes(error.kind);
}

function errorKind(error: unknown): SttRouterErrorKind {
  if (error instanceof SttRouterError) return error.kind;
  if (error instanceof GroqSttError) {
    if (error.kind === 'quota') return 'quota';
    if (error.kind === 'timeout') return 'timeout';
    if (error.kind === 'upstream') return 'upstream';
    if (error.kind === 'invalid_input' || error.kind === 'invalid_response') return 'invalid_input';
    return 'configuration';
  }
  return 'upstream';
}

export class SttRouter implements SttProvider {
  private config: SttRuntimeConfig;

  constructor(private readonly options: SttRouterOptions) {
    this.config = SttRuntimeConfigSchema.parse(options.config);
  }

  getConfig(): SttRuntimeConfig {
    return { ...this.config };
  }

  updateConfig(config: SttRuntimeConfig): void {
    this.config = SttRuntimeConfigSchema.parse(config);
  }

  private async useLocal(audio: Buffer, mimeType: string, fallbackFrom?: string, context?: SttRequestContext): Promise<AudioTranscript> {
    return localResult(await this.options.local.transcribe(audio, mimeType, context), fallbackFrom);
  }

  private async useGroq(audio: Buffer, mimeType: string, context?: SttRequestContext): Promise<AudioTranscript> {
    if (!this.options.groq) throw new SttRouterError('configuration', 'Groq STT provider is not configured');
    if (!(await (this.options.canUseCloud?.(audio, mimeType, context) ?? true))) {
      throw new SttRouterError('quota', 'Groq STT local quota is exhausted');
    }
    const result = cloudResult(await this.options.groq.transcribe(audio, mimeType, context));
    await this.options.recordCloudUsage?.(context, result, audio, mimeType);
    return result;
  }

  private async fallbackOrThrow(error: unknown, audio: Buffer, mimeType: string, context?: SttRequestContext): Promise<AudioTranscript> {
    if (this.config.fallback !== 'local' || !isFallbackEligible(error)) throw error;
    return this.useLocal(audio, mimeType, 'groq', context);
  }

  async transcribe(audio: Buffer, mimeType: string, context?: SttRequestContext): Promise<AudioTranscript> {
    if (this.config.route === 'local') return this.useLocal(audio, mimeType, undefined, context);
    if (this.config.route === 'auto' && (!this.config.cloudEnabled || !this.options.groq)) {
      return this.useLocal(audio, mimeType, undefined, context);
    }
    if (!this.config.cloudEnabled) {
      const error = new SttRouterError('configuration', 'Groq STT is disabled by policy');
      if (this.config.fallback === 'local') return this.useLocal(audio, mimeType, 'groq', context);
      throw error;
    }
    try {
      return await this.useGroq(audio, mimeType, context);
    } catch (error) {
      return this.fallbackOrThrow(error, audio, mimeType, context);
    }
  }

  async close(): Promise<void> {
    const closable = [this.options.local, this.options.groq].filter((provider): provider is SttProvider & { close: () => Promise<void> } => (
      typeof (provider as SttProvider & { close?: unknown }).close === 'function'
    ));
    for (const provider of closable) await provider.close();
  }

  static classify(error: unknown): SttRouterErrorKind {
    return errorKind(error);
  }
}
