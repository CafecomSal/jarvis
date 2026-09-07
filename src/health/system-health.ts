export type HealthStatus = 'ok' | 'degraded' | 'configured' | 'not_configured' | 'unknown';

export interface SystemHealthResources {
  ollama: { status: HealthStatus; loadedModels: string[] };
  gpu: {
    status: HealthStatus;
    memoryUsedMiB?: number;
    memoryTotalMiB?: number;
    utilizationPercent?: number;
  };
  processes: { status: HealthStatus; [name: string]: string | number };
}

export interface SystemHealthAudioDetails {
  stt?: {
    route: string;
    activeProvider: string;
    model: string;
    processingLocation: string;
    fallback: string;
    cloudEnabled: boolean;
    cloudConfigured: boolean;
  };
  tts?: { provider: string; model: string };
  quota?: Record<string, number | string>;
}

export interface SystemHealthSnapshot {
  status: 'ok' | 'degraded' | 'unknown';
  checkedAt: string;
  core: { status: HealthStatus };
  model: { status: HealthStatus; name: string; runtime: string };
  database: { status: HealthStatus };
  recordings: { status: HealthStatus; staging: 'temporary' | 'disabled' };
  audio: { status: HealthStatus; source?: string } & SystemHealthAudioDetails;
  network: { exposure: 'tailscale-only' | 'local-only' | 'unknown'; bind: 'loopback' | 'private' | 'public' | 'unknown' };
  resources?: SystemHealthResources;
}

export interface DefaultSystemHealthOptions {
  model: string;
  databaseConfigured: boolean;
  recordingsConfigured: boolean;
  audioConfigured?: boolean;
  exposure?: SystemHealthSnapshot['network']['exposure'];
  bind?: SystemHealthSnapshot['network']['bind'];
  now?: () => Date;
}

export function createDefaultSystemHealth(options: DefaultSystemHealthOptions): SystemHealthSnapshot {
  const audioConfigured = options.audioConfigured ?? false;
  const now = options.now ?? (() => new Date());
  return {
    status: 'ok',
    checkedAt: now().toISOString(),
    core: { status: 'ok' },
    model: { status: options.model.trim() ? 'configured' : 'unknown', name: options.model, runtime: 'ollama-local' },
    database: { status: options.databaseConfigured ? 'configured' : 'unknown' },
    recordings: { status: options.recordingsConfigured ? 'configured' : 'not_configured', staging: options.recordingsConfigured ? 'temporary' : 'disabled' },
    audio: {
      status: audioConfigured ? 'configured' : 'not_configured',
      ...(audioConfigured ? { source: 'Faster-Whisper CPU + Piper CPU' } : {}),
    },
    network: {
      exposure: options.exposure ?? 'local-only',
      bind: options.bind ?? 'loopback',
    },
  };
}
