import { describe, expect, it, vi } from 'vitest';
import { GroqSttError } from '../src/audio/providers/groq-stt.js';
import { SttRouter } from '../src/audio/stt-router.js';
import type { SttRuntimeConfig } from '../src/audio/stt-config.js';
import type { AudioTranscript } from '../src/audio/audio-types.js';
import type { SttProvider } from '../src/audio/stt-provider.js';

const baseConfig: SttRuntimeConfig = {
  route: 'local',
  localModel: 'medium',
  groqModel: 'whisper-large-v3-turbo',
  language: 'pt-BR',
  prompt: '',
  fallback: 'none',
  timeoutMs: 12_000,
  cloudEnabled: false,
};

function transcript(provider: string, processingLocation: 'local' | 'cloud'): AudioTranscript {
  return {
    text: provider === 'groq' ? 'transcrito na nuvem' : 'transcrito localmente',
    language: 'pt-BR',
    provider,
    model: provider === 'groq' ? 'whisper-large-v3-turbo' : 'medium',
    latencyMs: 10,
    processingLocation,
  };
}

function provider(result: AudioTranscript | Error): SttProvider {
  return { transcribe: vi.fn(async () => { if (result instanceof Error) throw result; return result; }) };
}

describe('SttRouter', () => {
  it('usa somente o provider local na rota local', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(transcript('groq', 'cloud'));
    const router = new SttRouter({ local, groq, config: baseConfig });

    const result = await router.transcribe(Buffer.from('audio'), 'audio/wav');

    expect(result).toMatchObject({ provider: 'faster-whisper', processingLocation: 'local' });
    expect(local.transcribe).toHaveBeenCalledTimes(1);
    expect(groq.transcribe).not.toHaveBeenCalled();
  });

  it('não envia áudio quando Groq está desligado', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(transcript('groq', 'cloud'));
    const router = new SttRouter({ local, groq, config: { ...baseConfig, route: 'groq', fallback: 'none' } });

    await expect(router.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'configuration' });
    expect(groq.transcribe).not.toHaveBeenCalled();
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it('usa local automaticamente quando auto não tem cloud habilitado', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(transcript('groq', 'cloud'));
    const router = new SttRouter({ local, groq, config: { ...baseConfig, route: 'auto' } });

    const result = await router.transcribe(Buffer.from('audio'), 'audio/wav');

    expect(result.provider).toBe('faster-whisper');
    expect(groq.transcribe).not.toHaveBeenCalled();
  });

  it('usa Groq quando a rota está habilitada e configurada', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(transcript('groq', 'cloud'));
    const router = new SttRouter({ local, groq, config: { ...baseConfig, route: 'groq', cloudEnabled: true } });

    const result = await router.transcribe(Buffer.from('audio'), 'audio/wav');

    expect(result).toMatchObject({ provider: 'groq', processingLocation: 'cloud' });
    expect(groq.transcribe).toHaveBeenCalledTimes(1);
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it('faz fallback local uma vez para timeout/quota/upstream e registra a origem', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(new GroqSttError('timeout', 'Groq timed out'));
    const router = new SttRouter({ local, groq, config: { ...baseConfig, route: 'groq', cloudEnabled: true, fallback: 'local' } });

    const result = await router.transcribe(Buffer.from('audio'), 'audio/wav');

    expect(result).toMatchObject({ provider: 'faster-whisper', processingLocation: 'local', fallbackFrom: 'groq' });
    expect(groq.transcribe).toHaveBeenCalledTimes(1);
    expect(local.transcribe).toHaveBeenCalledTimes(1);
  });

  it('não faz fallback silencioso para credencial inválida ou input inválido', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(new GroqSttError('configuration', 'Groq credentials rejected', 401));
    const router = new SttRouter({ local, groq, config: { ...baseConfig, route: 'groq', cloudEnabled: true, fallback: 'local' } });

    await expect(router.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'configuration' });
    expect(local.transcribe).not.toHaveBeenCalled();
  });

  it('pode bloquear cloud por quota sem chamar o provider', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(transcript('groq', 'cloud'));
    const router = new SttRouter({
      local,
      groq,
      config: { ...baseConfig, route: 'groq', cloudEnabled: true },
      canUseCloud: () => false,
    });

    await expect(router.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'quota' });
    expect(groq.transcribe).not.toHaveBeenCalled();
  });

  it('faz fallback local quando a quota bloqueia antes da chamada cloud', async () => {
    const local = provider(transcript('faster-whisper', 'local'));
    const groq = provider(transcript('groq', 'cloud'));
    const router = new SttRouter({
      local,
      groq,
      config: { ...baseConfig, route: 'groq', cloudEnabled: true, fallback: 'local' },
      canUseCloud: () => false,
    });

    const result = await router.transcribe(Buffer.from('audio'), 'audio/wav');

    expect(result).toMatchObject({ provider: 'faster-whisper', processingLocation: 'local', fallbackFrom: 'groq' });
    expect(groq.transcribe).not.toHaveBeenCalled();
    expect(local.transcribe).toHaveBeenCalledTimes(1);
  });
});
