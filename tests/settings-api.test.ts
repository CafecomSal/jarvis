import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryAuditStore } from '../src/audit/in-memory-audit-store.js';
import { InMemoryRuntimeSettingsStore, RuntimeSettingsService } from '../src/config/runtime-settings-store.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/config/runtime-settings.js';
import type { AudioRuntime } from '../src/audio/audio-runtime.js';

describe('API de runtime settings', () => {
  it('retorna configuração segura, origem e status da chave sem expor segredo', async () => {
    const service = new RuntimeSettingsService(new InMemoryRuntimeSettingsStore(), DEFAULT_RUNTIME_SETTINGS);
    const app = buildApp({ runtimeSettings: service, groqApiKeyConfigured: false });

    const response = await app.inject({ method: 'GET', url: '/settings' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'default',
      settings: {
        stt: {
          route: 'local',
          localModel: 'medium',
          groqModel: 'whisper-large-v3-turbo',
          cloudEnabled: false,
        },
        tts: { provider: 'piper', model: 'pt_BR-jeff-medium', editable: false },
      },
      cloud: { groq: { configured: false } },
    });
    expect(response.body).not.toContain('GROQ_API_KEY');
    expect(response.body).not.toContain('secret');
  });

  it('exige confirmação e chave configurada para habilitar cloud', async () => {
    const service = new RuntimeSettingsService(new InMemoryRuntimeSettingsStore(), DEFAULT_RUNTIME_SETTINGS);
    const app = buildApp({ runtimeSettings: service, groqApiKeyConfigured: false });

    const noConfirmation = await app.inject({
      method: 'PUT',
      url: '/settings',
      payload: { stt: { route: 'groq', cloudEnabled: true } },
    });
    const noKey = await app.inject({
      method: 'PUT',
      url: '/settings',
      payload: { stt: { route: 'groq', cloudEnabled: true }, confirmCloudBoundary: true },
    });
    const current = await service.effective();
    await app.close();

    expect(noConfirmation.statusCode).toBe(400);
    expect(noKey.statusCode).toBe(409);
    expect(current.settings.stt.route).toBe('local');
  });

  it('aplica settings permitidos, audita alteração e rejeita campo sensível', async () => {
    const service = new RuntimeSettingsService(new InMemoryRuntimeSettingsStore(), DEFAULT_RUNTIME_SETTINGS);
    const audit = new InMemoryAuditStore();
    const audioRuntime = {
      apply: vi.fn(async () => undefined),
      health: vi.fn(async () => ({
        route: 'groq' as const,
        localModel: 'medium',
        groqModel: 'whisper-large-v3-turbo',
        activeProvider: 'groq' as const,
        processingLocation: 'cloud' as const,
        fallback: 'local' as const,
        cloudEnabled: true,
        cloudConfigured: true,
      })),
    } as unknown as Pick<AudioRuntime, 'apply' | 'health'>;
    const app = buildApp({ runtimeSettings: service, audioRuntime, groqApiKeyConfigured: true, audit });

    const response = await app.inject({
      method: 'PUT',
      url: '/settings',
      payload: {
        stt: { route: 'groq', cloudEnabled: true, fallback: 'local' },
        quota: { maxRequestsPerDay: 42 },
        confirmCloudBoundary: true,
      },
    });
    const sensitive = await app.inject({
      method: 'PUT',
      url: '/settings',
      payload: { GROQ_API_KEY: 'secret' },
    });
    const entries = await audit.list();
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      applied: true,
      settings: { stt: { route: 'groq', cloudEnabled: true, fallback: 'local' }, quota: { maxRequestsPerDay: 42 } },
    });
    expect(audioRuntime.apply).toHaveBeenCalledTimes(1);
    expect(sensitive.statusCode).toBe(400);
    expect(entries.some((entry) => entry.action === 'runtime_settings.update')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });
});
