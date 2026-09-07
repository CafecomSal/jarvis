import type { AudioTranscript } from './audio-types.js';
import { SttRouter } from './stt-router.js';
import { SttRuntimeConfigSchema, type SttRuntimeConfig } from './stt-config.js';
import type { SttProvider, SttRequestContext } from './stt-provider.js';

export interface AudioRuntimeHealth {
  route: SttRuntimeConfig['route'];
  localModel: string;
  groqModel: string;
  activeProvider: 'faster-whisper' | 'groq' | 'unconfigured';
  processingLocation: 'local' | 'cloud' | 'unknown';
  fallback: SttRuntimeConfig['fallback'];
  cloudEnabled: boolean;
  cloudConfigured: boolean;
}

export interface AudioRuntimeOptions {
  config: SttRuntimeConfig;
  createLocal: (config: SttRuntimeConfig) => SttProvider;
  createGroq?: (config: SttRuntimeConfig) => SttProvider;
  canUseCloud?: (audio?: Buffer, mimeType?: string, context?: SttRequestContext) => boolean | Promise<boolean>;
  recordCloudUsage?: (context: SttRequestContext | undefined, transcript: AudioTranscript, audio: Buffer, mimeType: string) => Promise<void>;
}

type ClosableProvider = SttProvider & { close?: () => Promise<void> };

async function closeProvider(provider: SttProvider | undefined, excluded: Set<SttProvider>): Promise<void> {
  if (!provider || excluded.has(provider)) return;
  excluded.add(provider);
  const closable = provider as ClosableProvider;
  await closable.close?.();
}

export class AudioRuntime implements SttProvider {
  private config: SttRuntimeConfig;
  private local?: SttProvider;
  private groq?: SttProvider;
  private router?: SttRouter;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AudioRuntimeOptions) {
    this.config = SttRuntimeConfigSchema.parse(options.config);
    this.local = options.createLocal(this.config);
    this.groq = options.createGroq?.(this.config);
    this.router = this.createRouter(this.config, this.local, this.groq);
  }

  private createRouter(config: SttRuntimeConfig, local: SttProvider | undefined, groq?: SttProvider): SttRouter {
    if (!local) throw new Error('Local STT provider is not configured');
    return new SttRouter({
      local,
      groq,
      config,
      canUseCloud: this.options.canUseCloud,
      recordCloudUsage: this.options.recordCloudUsage,
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  getConfig(): SttRuntimeConfig {
    return { ...this.config };
  }

  private async applyUnsafe(config: SttRuntimeConfig): Promise<void> {
    const nextConfig = SttRuntimeConfigSchema.parse(config);
    const previousConfig = this.config;
    const previousLocal = this.local;
    const previousGroq = this.groq;
    const closed = new Set<SttProvider>();
    let nextLocal: SttProvider | undefined;
    let nextGroq: SttProvider | undefined;

    try {
      await closeProvider(previousLocal, closed);
      await closeProvider(previousGroq, closed);
      this.local = undefined;
      this.groq = undefined;
      this.router = undefined;

      nextLocal = this.options.createLocal(nextConfig);
      nextGroq = this.options.createGroq?.(nextConfig);
      this.config = nextConfig;
      this.local = nextLocal;
      this.groq = nextGroq;
      this.router = this.createRouter(nextConfig, nextLocal, nextGroq);
    } catch (error) {
      const created = new Set<SttProvider>();
      await closeProvider(nextLocal, created);
      await closeProvider(nextGroq, created);
      try {
        const restoredLocal = this.options.createLocal(previousConfig);
        const restoredGroq = this.options.createGroq?.(previousConfig);
        this.config = previousConfig;
        this.local = restoredLocal;
        this.groq = restoredGroq;
        this.router = this.createRouter(previousConfig, restoredLocal, restoredGroq);
      } catch (restoreError) {
        this.local = undefined;
        this.groq = undefined;
        this.router = undefined;
        throw new Error(
          `Audio runtime apply failed and rollback failed: ${error instanceof Error ? error.message : 'apply failed'}; `
          + `${restoreError instanceof Error ? restoreError.message : 'rollback failed'}`,
        );
      }
      throw error;
    }
  }

  async apply(config: SttRuntimeConfig): Promise<void> {
    await this.exclusive(() => this.applyUnsafe(config));
  }

  async transcribe(audio: Buffer, mimeType: string, context?: SttRequestContext): Promise<AudioTranscript> {
    return this.exclusive(async () => {
      if (!this.router) throw new Error('Audio runtime is not available');
      return this.router.transcribe(audio, mimeType, context);
    });
  }

  async health(): Promise<AudioRuntimeHealth> {
    const cloudConfigured = Boolean(this.groq);
    const cloudRequested = this.config.cloudEnabled && this.config.route !== 'local';
    const useCloud = cloudRequested && cloudConfigured;
    const missingRequestedCloud = this.config.route === 'groq' && cloudRequested && !cloudConfigured;
    const localActive = Boolean(this.local);
    return {
      route: this.config.route,
      localModel: this.config.localModel,
      groqModel: this.config.groqModel,
      activeProvider: useCloud ? 'groq' : missingRequestedCloud ? 'unconfigured' : localActive ? 'faster-whisper' : 'unconfigured',
      processingLocation: useCloud ? 'cloud' : missingRequestedCloud ? 'unknown' : localActive ? 'local' : 'unknown',
      fallback: this.config.fallback,
      cloudEnabled: this.config.cloudEnabled,
      cloudConfigured,
    };
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      const closed = new Set<SttProvider>();
      await closeProvider(this.local, closed);
      await closeProvider(this.groq, closed);
      this.local = undefined;
      this.groq = undefined;
      this.router = undefined;
    });
  }
}
