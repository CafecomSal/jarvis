import { describe, expect, it, vi } from 'vitest';
import { AudioRuntime } from '../src/audio/audio-runtime.js';
import type { SttRuntimeConfig } from '../src/audio/stt-config.js';
import type { AudioTranscript } from '../src/audio/audio-types.js';
import type { SttProvider } from '../src/audio/stt-provider.js';

const config: SttRuntimeConfig = {
  route: 'local',
  localModel: 'medium',
  groqModel: 'whisper-large-v3-turbo',
  language: 'pt-BR',
  prompt: '',
  fallback: 'none',
  timeoutMs: 12_000,
  cloudEnabled: false,
};

function fakeProvider(text: string): SttProvider & { close: ReturnType<typeof vi.fn> } {
  return {
    transcribe: vi.fn(async (): Promise<AudioTranscript> => ({
      text,
      provider: text.includes('groq') ? 'groq' : 'faster-whisper',
      model: text.includes('groq') ? 'whisper-large-v3-turbo' : 'medium',
      latencyMs: 1,
    })),
    close: vi.fn(async () => undefined),
  };
}

describe('AudioRuntime', () => {
  it('troca a rota em runtime e mantém o provider efetivo observável', async () => {
    const local = fakeProvider('local');
    const groq = fakeProvider('groq');
    const runtime = new AudioRuntime({
      config,
      createLocal: () => local,
      createGroq: () => groq,
    });

    expect((await runtime.health()).activeProvider).toBe('faster-whisper');
    await runtime.apply({ ...config, route: 'groq', cloudEnabled: true });
    const result = await runtime.transcribe(Buffer.from('audio'), 'audio/wav');

    expect(result.provider).toBe('groq');
    expect((await runtime.health())).toMatchObject({ route: 'groq', activeProvider: 'groq', processingLocation: 'cloud' });
    await runtime.close();
    expect(local.close).toHaveBeenCalled();
    expect(groq.close).toHaveBeenCalled();
  });

  it('marca Groq como não configurado quando a rota cloud não tem provider', async () => {
    const runtime = new AudioRuntime({
      config: { ...config, route: 'groq', cloudEnabled: true },
      createLocal: () => fakeProvider('local'),
    });

    await expect(runtime.health()).resolves.toMatchObject({
      activeProvider: 'unconfigured',
      processingLocation: 'unknown',
      cloudConfigured: false,
    });
    await runtime.close();
  });

  it('fecha o provider anterior antes de criar o próximo worker', async () => {
    const order: string[] = [];
    const first = fakeProvider('first');
    first.close.mockImplementation(async () => { order.push('close-first'); });
    const second = fakeProvider('second');
    let creations = 0;
    const runtime = new AudioRuntime({
      config,
      createLocal: () => {
        creations += 1;
        order.push(`create-${creations}`);
        return creations === 1 ? first : second;
      },
    });

    await runtime.apply({ ...config, localModel: 'small' });

    expect(order).toEqual(['create-1', 'close-first', 'create-2']);
    await runtime.close();
  });

  it('mantém o runtime anterior se a criação do novo provider falhar', async () => {
    const local = fakeProvider('local');
    const runtime = new AudioRuntime({
      config,
      createLocal: (next) => {
        if (next.localModel === 'small') throw new Error('cannot create');
        return local;
      },
    });

    await expect(runtime.apply({ ...config, localModel: 'small' })).rejects.toThrow('cannot create');
    expect((await runtime.transcribe(Buffer.from('audio'), 'audio/wav')).text).toBe('local');
    expect((await runtime.health()).localModel).toBe('medium');
  });
});
