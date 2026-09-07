import { performance } from 'node:perf_hooks';
import type { TtsProvider, TtsRequest, TtsResult } from '../tts-provider.js';

export interface AzureTtsOptions {
  key: string;
  region: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export class AzureTtsProvider implements TtsProvider {
  private readonly key: string;
  private readonly region: string;
  private readonly voice: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AzureTtsOptions) {
    this.key = options.key.trim();
    this.region = options.region.trim();
    this.voice = options.voice?.trim() || 'pt-BR-FranciscaNeural';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!this.key) throw new Error('Azure key must not be empty');
    if (!this.region) throw new Error('Azure region must not be empty');
    if (!this.voice) throw new Error('Azure voice must not be empty');
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const text = request.text.trim();
    if (!text) throw new Error('TTS text must not be empty');
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const language = request.language?.trim() || 'pt-BR';
    const ssml = `<speak version="1.0" xml:lang="${escapeXml(language)}"><voice name="${escapeXml(request.voice?.trim() || this.voice)}">${escapeXml(text)}</voice></speak>`;
    try {
      const response = await this.fetchImpl(`https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/ssml+xml',
          'Ocp-Apim-Subscription-Key': this.key,
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'jarvis-core-local-audio',
        },
        body: ssml,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Azure TTS failed with HTTP ${response.status}`);
      return {
        audio: Buffer.from(await response.arrayBuffer()),
        mimeType: 'audio/mpeg',
        provider: 'azure-speech',
        model: request.voice?.trim() || this.voice,
        latencyMs: Math.max(0, performance.now() - started),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Azure TTS timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
