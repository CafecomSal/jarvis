import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STT_RUNTIME_CONFIG,
  GroqSttModelSchema,
  LocalSttModelSchema,
  SttFallbackSchema,
  SttRouteSchema,
  SttRuntimeConfigSchema,
} from '../src/audio/stt-config.js';
import { AudioTranscriptSchema } from '../src/audio/audio-types.js';

describe('configuração de STT', () => {
  it('define local como rota segura e turbo como modelo Groq padrão', () => {
    expect(DEFAULT_STT_RUNTIME_CONFIG).toMatchObject({
      route: 'local',
      localModel: 'medium',
      groqModel: 'whisper-large-v3-turbo',
      language: 'pt-BR',
      fallback: 'none',
      cloudEnabled: false,
    });
  });

  it('aceita somente rotas, fallback e modelos permitidos', () => {
    expect(SttRouteSchema.safeParse('local').success).toBe(true);
    expect(SttRouteSchema.safeParse('groq').success).toBe(true);
    expect(SttRouteSchema.safeParse('auto').success).toBe(true);
    expect(SttRouteSchema.safeParse('round-robin').success).toBe(false);
    expect(SttFallbackSchema.safeParse('local').success).toBe(true);
    expect(SttFallbackSchema.safeParse('groq').success).toBe(false);
    expect(GroqSttModelSchema.safeParse('whisper-large-v3').success).toBe(true);
    expect(GroqSttModelSchema.safeParse('distil-whisper-large-v3-en').success).toBe(false);
    expect(LocalSttModelSchema.safeParse('medium').success).toBe(true);
    expect(LocalSttModelSchema.safeParse('C:/arbitrary-model').success).toBe(false);
  });

  it('permite metadados de localização e fallback sem exigir segredo', () => {
    const transcript = AudioTranscriptSchema.parse({
      text: 'Olá Jarvis',
      language: 'pt-BR',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      latencyMs: 42,
      processingLocation: 'cloud',
      fallbackFrom: 'faster-whisper',
    });
    expect(transcript.processingLocation).toBe('cloud');
    expect('apiKey' in transcript).toBe(false);
    expect('GROQ_API_KEY' in transcript).toBe(false);
  });

  it('valida a configuração completa e rejeita valores inseguros', () => {
    expect(SttRuntimeConfigSchema.parse(DEFAULT_STT_RUNTIME_CONFIG)).toEqual(DEFAULT_STT_RUNTIME_CONFIG);
    expect(SttRuntimeConfigSchema.safeParse({ ...DEFAULT_STT_RUNTIME_CONFIG, timeoutMs: 1 }).success).toBe(false);
    expect(SttRuntimeConfigSchema.safeParse({ ...DEFAULT_STT_RUNTIME_CONFIG, groqModel: 'unknown' }).success).toBe(false);
    expect(SttRuntimeConfigSchema.safeParse({ ...DEFAULT_STT_RUNTIME_CONFIG, apiKey: 'secret' }).success).toBe(false);
  });
});
