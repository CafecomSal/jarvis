import { describe, expect, it } from 'vitest';
import { createDefaultSystemHealth } from '../src/health/system-health.js';

describe('health default', () => {
  it('identifica os providers locais quando o pipeline está configurado', () => {
    const health = createDefaultSystemHealth({
      model: 'gemma-hermes:latest',
      databaseConfigured: true,
      recordingsConfigured: true,
      audioConfigured: true,
    });

    expect(health.audio).toEqual({ status: 'configured', source: 'Faster-Whisper CPU + Piper CPU' });
  });
});
