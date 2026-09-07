import { describe, expect, it } from 'vitest';
import type { TtsResult } from '../src/audio/tts-provider.js';
import { QuotaTtsProvider } from '../src/audio/quota-tts-provider.js';

const result: TtsResult = {
  audio: Buffer.from('cloud'),
  mimeType: 'audio/mpeg',
  provider: 'azure-speech',
  model: 'pt-BR-FranciscaNeural',
  latencyMs: 1,
};

describe('quota e cache do TTS cloud', () => {
  it('cacheia repetição e bloqueia texto acima da quota mensal', async () => {
    let calls = 0;
    const provider = new QuotaTtsProvider(
      { synthesize: async () => { calls += 1; return result; } },
      { maxCharactersPerMonth: 5, now: () => new Date('2026-09-05T00:00:00.000Z') },
    );

    await provider.synthesize({ text: 'oi' });
    await provider.synthesize({ text: 'oi' });
    await expect(provider.synthesize({ text: 'mundo' })).rejects.toThrow('quota');
    expect(calls).toBe(1);
  });
});
