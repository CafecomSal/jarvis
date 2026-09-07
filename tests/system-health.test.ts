import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { SystemHealthSnapshot } from '../src/health/system-health.js';

describe('API de saúde do sistema', () => {
  it('retorna uma visão segura dos componentes sem expor segredos', async () => {
    const snapshot: SystemHealthSnapshot = {
      status: 'ok',
      checkedAt: '2026-09-05T03:30:00.000Z',
      core: { status: 'ok' },
      model: { status: 'configured', name: 'gemma-hermes:latest', runtime: 'ollama-local' },
      database: { status: 'configured' },
      recordings: { status: 'configured', staging: 'temporary' },
      audio: { status: 'not_configured' },
      network: { exposure: 'tailscale-only', bind: 'loopback' },
    };
    const app = buildApp({ systemHealth: async () => snapshot });

    const response = await app.inject({ method: 'GET', url: '/system/health' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('token');
    expect(response.body).not.toContain('rtsp://');
  });
});
