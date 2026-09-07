import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AudioPipelineResult } from '../src/audio/audio-pipeline.js';

const pipelineResult: AudioPipelineResult = {
  session: {
    id: 'audio-route-1',
    source: 'pc',
    status: 'completed',
    startedAt: '2026-09-05T04:10:00.000Z',
    responseText: 'ok',
  },
  conversation: { conversationId: 'conv-1', answer: 'ok', toolCalls: [] },
  audio: {
    audio: Buffer.from('wav'),
    mimeType: 'audio/wav',
    provider: 'fixture-tts',
    model: 'fixture',
    latencyMs: 1,
  },
};

describe('API de push-to-talk', () => {
  it('decodifica áudio limitado e retorna sessão/resposta sem persistir base64', async () => {
    const received: { audio: Buffer; mimeType: string; durationMs?: number }[] = [];
    const app = buildApp({
      audioPipeline: {
        process: async (audio, mimeType, _source, _ttsTarget, durationMs) => {
          received.push({ audio, mimeType, durationMs });
          return pipelineResult;
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/audio/pc',
      payload: { mimeType: 'audio/wav', audioBase64: Buffer.from('input').toString('base64'), durationMs: 1_250 },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(received).toEqual([{ audio: Buffer.from('input'), mimeType: 'audio/wav', durationMs: 1_250 }]);
    expect(response.json()).toMatchObject({ session: { id: 'audio-route-1' }, audio: { provider: 'fixture-tts', audioBase64: 'd2F2' } });
  });

  it('retorna 501 sem pipeline e 400 para base64 inválido', async () => {
    const unavailable = buildApp();
    const unavailableResponse = await unavailable.inject({ method: 'POST', url: '/audio/pc', payload: { mimeType: 'audio/wav', audioBase64: 'd2F2' } });
    await unavailable.close();
    expect(unavailableResponse.statusCode).toBe(501);

    const app = buildApp({ audioPipeline: { process: async () => pipelineResult } });
    const invalid = await app.inject({ method: 'POST', url: '/audio/pc', payload: { mimeType: 'audio/wav', audioBase64: '%%%not-base64%%%' } });
    await app.close();
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_audio_request' });
  });
});
