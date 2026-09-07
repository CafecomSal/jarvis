import { describe, expect, it } from 'vitest';
import { InMemoryAudioSessionStore } from '../src/audio/audio-session-store.js';
import type { AudioTranscript } from '../src/audio/audio-types.js';
import type { SttProvider } from '../src/audio/stt-provider.js';
import type { TtsProvider } from '../src/audio/tts-provider.js';
import { AudioPipeline } from '../src/audio/audio-pipeline.js';

describe('pipeline de áudio', () => {
  it('transcreve, consulta o Core, sintetiza e persiste somente metadata', async () => {
    let receivedContext: { sessionId?: string; audioDurationSeconds?: number } | undefined;
    const stt: SttProvider = {
      transcribe: async (_audio, _mimeType, context): Promise<AudioTranscript> => {
        receivedContext = context;
        return {
          text: 'Tem alguém no portão?',
          language: 'pt-BR',
          confidence: 0.95,
          provider: 'fixture-stt',
          model: 'fixture',
          latencyMs: 12,
        };
      },
    };
    const tts: TtsProvider = {
      synthesize: async () => ({
        audio: Buffer.from('wav'),
        mimeType: 'audio/wav' as const,
        provider: 'fixture-tts',
        model: 'fixture',
        latencyMs: 8,
      }),
    };
    const sessions = new InMemoryAudioSessionStore();
    const pipeline = new AudioPipeline({
      stt,
      tts,
      sessions,
      respond: async (text) => ({ conversationId: 'conv-1', answer: `resposta para ${text}`, toolCalls: [] }),
      now: () => new Date('2026-09-05T04:00:00.000Z'),
    });

    const result = await pipeline.process(Buffer.from('audio'), 'audio/wav', 'pc', 'pc', 1_250);
    const stored = await sessions.findById(result.session.id);

    expect(result.session).toMatchObject({ source: 'pc', status: 'completed', ttsTarget: 'pc' });
    expect(result.conversation.answer).toContain('Tem alguém no portão?');
    expect(result.audio.audio.toString()).toBe('wav');
    expect(receivedContext).toMatchObject({ sessionId: result.session.id, audioDurationSeconds: 1.25 });
    expect(stored).toMatchObject({ transcript: { provider: 'fixture-stt', latencyMs: 12 }, pipelineLatencyMs: expect.any(Number), responseText: expect.stringContaining('resposta') });
    expect('rawAudio' in (stored ?? {})).toBe(false);
  });

  it('rejeita áudio vazio antes de chamar providers', async () => {
    const pipeline = new AudioPipeline({
      stt: { transcribe: async () => { throw new Error('must not call'); } },
      tts: { synthesize: async () => { throw new Error('must not call'); } },
      sessions: new InMemoryAudioSessionStore(),
      respond: async () => ({ conversationId: 'conv', answer: 'ok', toolCalls: [] }),
    });
    await expect(pipeline.process(Buffer.alloc(0), 'audio/wav', 'pc', 'pc')).rejects.toThrow('Audio payload must not be empty');
  });
});
