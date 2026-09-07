import { describe, expect, it } from 'vitest';
import { TtsFallbackRouter } from '../src/audio/tts-router.js';
import type { TtsProvider } from '../src/audio/tts-provider.js';

const audio = { audio: Buffer.from('cloud'), mimeType: 'audio/wav' as const, provider: 'cloud', model: 'cloud-v1', latencyMs: 1 };

describe('roteador de fallback TTS', () => {
  it('não chama cloud quando o fallback está desabilitado', async () => {
    let cloudCalls = 0;
    const primary: TtsProvider = { synthesize: async () => { throw new Error('local indisponível'); } };
    const cloud: TtsProvider = { synthesize: async () => { cloudCalls += 1; return audio; } };
    await expect(new TtsFallbackRouter(primary, cloud).synthesize({ text: 'olá' })).rejects.toThrow('local indisponível');
    expect(cloudCalls).toBe(0);
  });

  it('usa cloud somente quando explicitamente habilitado', async () => {
    let cloudCalls = 0;
    const primary: TtsProvider = { synthesize: async () => { throw new Error('local indisponível'); } };
    const cloud: TtsProvider = { synthesize: async () => { cloudCalls += 1; return audio; } };
    const result = await new TtsFallbackRouter(primary, cloud, { allowFallback: true }).synthesize({ text: 'olá' });
    expect(result.provider).toBe('cloud');
    expect(cloudCalls).toBe(1);
  });
});
