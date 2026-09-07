import { describe, expect, it } from 'vitest';
import { AudioSessionSchema } from '../src/audio/audio-types.js';
import { InMemoryAudioSessionStore } from '../src/audio/audio-session-store.js';

describe('sessões de áudio', () => {
  it('valida uma sessão sem persistir áudio bruto', () => {
    const session = AudioSessionSchema.parse({
      id: 'audio-1',
      source: 'pc',
      status: 'completed',
      startedAt: '2026-09-05T03:30:00.000Z',
      endedAt: '2026-09-05T03:30:02.000Z',
      transcript: {
        text: 'Tem alguém no portão?',
        language: 'pt-BR',
        confidence: 0.94,
        provider: 'local-test',
        model: 'fixture',
        latencyMs: 50,
      },
      responseText: 'Não é possível confirmar sem uma nova evidência.',
      ttsTarget: 'pc',
    });

    expect(session.source).toBe('pc');
    expect('rawAudio' in session).toBe(false);
  });

  it('lista sessões em ordem e mantém append idempotente', async () => {
    const store = new InMemoryAudioSessionStore();
    const session = {
      id: 'audio-idempotent',
      source: 'alexa' as const,
      status: 'completed' as const,
      startedAt: '2026-09-05T03:30:00.000Z',
    };

    await store.append(session);
    await store.append(session);

    expect(await store.list()).toEqual([session]);
  });
});
