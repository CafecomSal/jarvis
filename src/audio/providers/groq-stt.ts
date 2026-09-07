import { performance } from 'node:perf_hooks';
import type { AudioTranscript } from '../audio-types.js';
import { GroqSttModelSchema, normalizeSttLanguage, type GroqSttModel } from '../stt-config.js';
import type { SttProvider } from '../stt-provider.js';

export type GroqSttErrorKind = 'configuration' | 'invalid_input' | 'invalid_response' | 'quota' | 'timeout' | 'upstream';

export class GroqSttError extends Error {
  constructor(
    readonly kind: GroqSttErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GroqSttError';
  }
}

export interface GroqSttProviderOptions {
  apiKey: string;
  model?: GroqSttModel;
  language?: string;
  prompt?: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

type GroqSegment = {
  avg_logprob?: unknown;
  no_speech_prob?: unknown;
};

type GroqResponse = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
};

function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(';', 1)[0].toLowerCase();
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/flac') return 'flac';
  return 'wav';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function confidenceFromSegments(segments: unknown): number | undefined {
  if (!Array.isArray(segments)) return undefined;
  const values = segments
    .map((segment) => {
      if (!segment || typeof segment !== 'object') return undefined;
      const record = segment as GroqSegment;
      const avgLogprob = finiteNumber(record.avg_logprob);
      const noSpeechProb = finiteNumber(record.no_speech_prob);
      if (avgLogprob === undefined) return undefined;
      const speechConfidence = 1 - Math.max(0, Math.min(1, noSpeechProb ?? 0));
      return Math.max(0, Math.min(1, Math.exp(avgLogprob) * speechConfidence));
    })
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function responseDurationMs(duration: unknown): number | undefined {
  const seconds = finiteNumber(duration);
  if (seconds === undefined || seconds < 0) return undefined;
  return seconds * 1_000;
}

function rateLimitFromHeaders(headers: Headers): AudioTranscript['rateLimit'] {
  const numberHeader = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  };
  const stringHeader = (name: string): string | undefined => headers.get(name)?.trim() || undefined;
  const rateLimit = {
    ...(numberHeader('x-ratelimit-limit-requests') === undefined ? {} : { limitRequests: numberHeader('x-ratelimit-limit-requests') }),
    ...(numberHeader('x-ratelimit-remaining-requests') === undefined ? {} : { remainingRequests: numberHeader('x-ratelimit-remaining-requests') }),
    ...(stringHeader('x-ratelimit-reset-requests') === undefined ? {} : { resetRequests: stringHeader('x-ratelimit-reset-requests') }),
    ...(numberHeader('x-ratelimit-limit-tokens') === undefined ? {} : { limitTokens: numberHeader('x-ratelimit-limit-tokens') }),
    ...(numberHeader('x-ratelimit-remaining-tokens') === undefined ? {} : { remainingTokens: numberHeader('x-ratelimit-remaining-tokens') }),
    ...(stringHeader('x-ratelimit-reset-tokens') === undefined ? {} : { resetTokens: stringHeader('x-ratelimit-reset-tokens') }),
  };
  return Object.keys(rateLimit).length > 0 ? rateLimit : undefined;
}

async function safeJson(response: Response): Promise<GroqResponse | undefined> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? body as GroqResponse : undefined;
  } catch {
    return undefined;
  }
}

export class GroqSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly model: GroqSttModel;
  private readonly language: string;
  private readonly prompt: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GroqSttProviderOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new GroqSttError('configuration', 'Groq STT API key is not configured');
    const parsedModel = GroqSttModelSchema.safeParse(options.model ?? 'whisper-large-v3-turbo');
    if (!parsedModel.success) throw new GroqSttError('configuration', 'Groq STT model is not supported');
    this.model = parsedModel.data;
    this.language = options.language?.trim() || 'pt-BR';
    this.prompt = options.prompt?.trim() || '';
    this.timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new GroqSttError('configuration', 'Groq STT timeout is invalid');
    }
    this.baseUrl = (options.baseUrl ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<AudioTranscript> {
    if (audio.length === 0) throw new GroqSttError('invalid_input', 'Groq STT audio must not be empty');
    const started = performance.now();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `jarvis-audio.${extensionForMimeType(mimeType)}`);
    form.append('model', this.model);
    form.append('language', this.language.toLowerCase().startsWith('pt') ? 'pt' : this.language);
    form.append('temperature', '0');
    form.append('response_format', 'verbose_json');
    if (this.prompt) form.append('prompt', this.prompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GroqSttError('timeout', `Groq STT timed out after ${this.timeoutMs}ms`);
      }
      throw new GroqSttError('upstream', 'Groq STT request failed');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new GroqSttError('configuration', `Groq STT rejected credentials (${response.status})`, response.status);
      }
      if (response.status === 413 || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        throw new GroqSttError('invalid_input', `Groq STT rejected the request (${response.status})`, response.status);
      }
      if (response.status === 429) throw new GroqSttError('quota', 'Groq STT quota or rate limit reached', response.status);
      throw new GroqSttError('upstream', `Groq STT upstream failed (${response.status})`, response.status);
    }

    const body = await safeJson(response);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new GroqSttError('invalid_response', 'Groq STT returned an empty transcript', response.status);
    const language = typeof body?.language === 'string' ? normalizeSttLanguage(body.language) : normalizeSttLanguage(this.language);
    const confidence = confidenceFromSegments(body?.segments);
    const durationMs = responseDurationMs(body?.duration);
    const rateLimit = rateLimitFromHeaders(response.headers);
    return {
      text,
      ...(language ? { language } : {}),
      ...(confidence === undefined ? {} : { confidence }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(rateLimit ? { rateLimit } : {}),
      provider: 'groq',
      model: this.model,
      latencyMs: Math.max(0, performance.now() - started),
      processingLocation: 'cloud',
    };
  }
}
