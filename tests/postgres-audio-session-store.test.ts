import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresAudioSessionStore } from '../src/audio/audio-session-store.js';

const connectionString = process.env.DATABASE_URL ?? 'postgres://jarvis:***@127.0.0.1:5434/jarvis';
const sessionId = 'test-pg-audio-session-001';

describe.skipIf(!process.env.DATABASE_URL)('PostgresAudioSessionStore', () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresAudioSessionStore({ pool });

  beforeAll(async () => {
    await store.initialize();
    await pool.query('DELETE FROM audio_sessions WHERE id = $1', [sessionId]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM audio_sessions WHERE id = $1', [sessionId]);
    await pool.end();
  });

  it('persiste, lista e busca uma sessão sem áudio bruto', async () => {
    const session = await store.append({
      id: sessionId,
      source: 'pc',
      status: 'completed',
      startedAt: '2026-09-05T03:30:00.000Z',
      endedAt: '2026-09-05T03:30:02.000Z',
      transcript: {
        text: 'consulta local',
        language: 'pt-BR',
        confidence: 0.9,
        provider: 'fixture',
        model: 'fixture',
        latencyMs: 40,
      },
      responseText: 'resposta',
      ttsTarget: 'pc',
    });

    const listed = await store.list({ source: 'pc' });
    const found = await store.findById(sessionId);

    expect(session.id).toBe(sessionId);
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: sessionId, source: 'pc' })]));
    expect(found).toMatchObject({ id: sessionId, responseText: 'resposta' });
  });
});
