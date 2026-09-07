import { describe, expect, it, vi } from 'vitest';
import { GroqSttError, GroqSttProvider } from '../src/audio/providers/groq-stt.js';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('GroqSttProvider', () => {
  it('envia multipart para a API oficial e retorna transcript seguro', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return response({
        text: 'Olá Jarvis',
        language: 'pt',
        duration: 1.2,
        segments: [{ avg_logprob: -0.1, no_speech_prob: 0.02 }],
      }, 200, {
        'x-ratelimit-remaining-requests': '999',
        'x-ratelimit-reset-requests': '1m',
      });
    });
    const provider = new GroqSttProvider({ apiKey: 'test-key', fetchImpl });

    const result = await provider.transcribe(Buffer.from('wav-bytes'), 'audio/wav');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(requestInit?.method).toBe('POST');
    expect((requestInit?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(requestInit?.body).toBeInstanceOf(FormData);
    const form = requestInit?.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBe('pt');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(result).toMatchObject({
      text: 'Olá Jarvis',
      language: 'pt-BR',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      processingLocation: 'cloud',
      confidence: expect.any(Number),
      durationMs: 1200,
      rateLimit: { remainingRequests: 999, resetRequests: '1m' },
    });
  });

  it('aceita modelo, idioma e prompt configurados sem colocar segredo no resultado', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestInit = init;
      return response({ text: 'teste' });
    });
    const provider = new GroqSttProvider({
      apiKey: 'secret-key',
      model: 'whisper-large-v3',
      language: 'pt-BR',
      prompt: 'Jarvis, portão, Davi',
      fetchImpl,
    });

    const result = await provider.transcribe(Buffer.from('webm'), 'audio/webm');
    const form = requestInit?.body as FormData;

    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('pt');
    expect(form.get('prompt')).toBe('Jarvis, portão, Davi');
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it('classifica timeout, quota e erros de upstream sem retry automático', async () => {
    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    const timeoutProvider = new GroqSttProvider({ apiKey: 'secret', timeoutMs: 100, fetchImpl: timeoutFetch });
    await expect(timeoutProvider.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'timeout' });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const quotaFetch = vi.fn(async () => response({ error: { message: 'quota' } }, 429));
    const quotaProvider = new GroqSttProvider({ apiKey: 'secret', fetchImpl: quotaFetch });
    await expect(quotaProvider.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'quota', status: 429 });
    expect(quotaFetch).toHaveBeenCalledTimes(1);

    const upstreamFetch = vi.fn(async () => response({ error: { message: 'upstream' } }, 503));
    const upstreamProvider = new GroqSttProvider({ apiKey: 'secret', fetchImpl: upstreamFetch });
    await expect(upstreamProvider.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'upstream', status: 503 });
  });

  it('rejeita credencial ausente, modelo inválido e transcript vazio', async () => {
    expect(() => new GroqSttProvider({ apiKey: '' })).toThrow('Groq STT API key is not configured');
    expect(() => new GroqSttProvider({ apiKey: 'key', model: 'distil-whisper-large-v3-en' as never })).toThrow('Groq STT model is not supported');
    const fetchImpl = vi.fn(async () => response({ text: '   ' }));
    const provider = new GroqSttProvider({ apiKey: 'secret', fetchImpl });
    await expect(provider.transcribe(Buffer.from('audio'), 'audio/wav')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
