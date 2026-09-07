import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUNTIME_SETTINGS,
  RuntimeSettingsSchema,
  mergeRuntimeSettings,
  runtimeSettingsFromEnvironment,
} from '../src/config/runtime-settings.js';

describe('runtime settings', () => {
  it('usa defaults seguros e preserva cloud/local explícitos', () => {
    expect(DEFAULT_RUNTIME_SETTINGS).toMatchObject({
      audioEnabled: false,
      stt: {
        route: 'local',
        localModel: 'medium',
        groqModel: 'whisper-large-v3-turbo',
        cloudEnabled: false,
        fallback: 'none',
      },
      quota: { maxRequestsPerDay: 30, maxAudioSecondsPerDay: 600, maxEstimatedMonthlyUsd: 1 },
      audioSessions: { autoDeleteEnabled: false, retentionDays: 30 },
    });
    expect(RuntimeSettingsSchema.parse(DEFAULT_RUNTIME_SETTINGS)).toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it('lê somente variáveis não secretas do ambiente', () => {
    const settings = runtimeSettingsFromEnvironment({
      JARVIS_AUDIO_ENABLED: 'true',
      JARVIS_STT_ROUTE: 'groq',
      JARVIS_STT_MODEL: 'small',
      JARVIS_GROQ_STT_MODEL: 'whisper-large-v3',
      JARVIS_STT_LANGUAGE: 'pt-BR',
      JARVIS_STT_FALLBACK: 'local',
      JARVIS_STT_TIMEOUT_MS: '15000',
      JARVIS_CLOUD_STT_ENABLED: 'true',
      JARVIS_STT_MAX_REQUESTS_PER_DAY: '12',
      JARVIS_STT_MAX_AUDIO_SECONDS_PER_DAY: '240',
      JARVIS_STT_MAX_ESTIMATED_MONTHLY_USD: '2.5',
      JARVIS_AUDIO_SESSION_AUTO_DELETE: 'true',
      JARVIS_AUDIO_SESSION_RETENTION_DAYS: '45',
      GROQ_API_KEY: 'must-not-be-read-into-settings',
    });
    expect(settings).toMatchObject({
      audioEnabled: true,
      stt: { route: 'groq', localModel: 'small', groqModel: 'whisper-large-v3', fallback: 'local', timeoutMs: 15000, cloudEnabled: true },
      quota: { maxRequestsPerDay: 12, maxAudioSecondsPerDay: 240, maxEstimatedMonthlyUsd: 2.5 },
      audioSessions: { autoDeleteEnabled: true, retentionDays: 45 },
    });
    expect(JSON.stringify(settings)).not.toContain('must-not-be-read');
  });

  it('faz merge parcial validado e rejeita campos sensíveis', () => {
    const merged = mergeRuntimeSettings(DEFAULT_RUNTIME_SETTINGS, {
      stt: { route: 'auto', cloudEnabled: true, fallback: 'local' },
      audioSessions: { retentionDays: 14 },
    });
    expect(merged).toMatchObject({
      stt: { route: 'auto', localModel: 'medium', cloudEnabled: true, fallback: 'local' },
      audioSessions: { retentionDays: 14, autoDeleteEnabled: false },
    });
    expect(() => mergeRuntimeSettings(DEFAULT_RUNTIME_SETTINGS, { apiKey: 'secret' } as never)).toThrow();
    expect(() => mergeRuntimeSettings(DEFAULT_RUNTIME_SETTINGS, { stt: { groqModel: 'unknown' } } as never)).toThrow();
  });
});
