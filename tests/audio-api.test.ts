import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryAudioSessionStore } from '../src/audio/audio-session-store.js';

describe('API de sessões de áudio', () => {
  it('lista sessões sem retornar áudio bruto', async () => {
    const audioSessions = new InMemoryAudioSessionStore();
    await audioSessions.append({
      id: 'audio-api-1',
      source: 'pc',
      status: 'completed',
      startedAt: '2026-09-05T03:30:00.000Z',
      transcript: {
        text: 'teste de voz',
        provider: 'fixture',
        model: 'fixture',
        latencyMs: 10,
      },
    });
    const app = buildApp({ audioSessions });

    const response = await app.inject({ method: 'GET', url: '/audio/sessions?source=pc' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ count: 1, sessions: [{ id: 'audio-api-1', source: 'pc' }] });
    expect(response.body).not.toContain('rawAudio');
    expect(response.body).not.toContain('base64');
  });

  it('retorna 501 quando o histórico ainda não foi configurado', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/audio/sessions' });
    await app.close();
    expect(response.statusCode).toBe(501);
  });
});
