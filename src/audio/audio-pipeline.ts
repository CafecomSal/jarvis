import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AudioSession, AudioSource } from './audio-types.js';
import type { AudioSessionStore } from './audio-types.js';
import type { SttProvider } from './stt-provider.js';
import type { TtsProvider, TtsResult } from './tts-provider.js';

export interface AudioConversationResult {
  conversationId: string;
  answer: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; result: unknown }>;
}

export interface AudioPipelineOptions {
  stt: SttProvider;
  tts: TtsProvider;
  sessions: AudioSessionStore;
  respond: (text: string) => Promise<AudioConversationResult>;
  maxBytes?: number;
  now?: () => Date;
}

export interface AudioPipelineResult {
  session: AudioSession;
  conversation: AudioConversationResult;
  audio: TtsResult;
}

export class AudioPipeline {
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(private readonly options: AudioPipelineOptions) {
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error('Audio maxBytes must be a positive integer');
    }
  }

  async process(
    audio: Buffer,
    mimeType: string,
    source: AudioSource,
    ttsTarget: 'pc' | 'alexa' = source === 'alexa' ? 'alexa' : 'pc',
  ): Promise<AudioPipelineResult> {
    if (audio.length === 0) throw new Error('Audio payload must not be empty');
    if (audio.length > this.maxBytes) throw new Error(`Audio payload exceeds ${this.maxBytes} bytes`);
    if (!mimeType.trim()) throw new Error('Audio mimeType must not be empty');

    const id = `audio-${randomUUID()}`;
    const startedAt = this.now();
    const startedAtMs = performance.now();
    try {
      const transcript = await this.options.stt.transcribe(audio, mimeType, { sessionId: id });
      const conversation = await this.options.respond(transcript.text);
      const audioResult = await this.options.tts.synthesize({ text: conversation.answer, language: 'pt-BR' });
      const endedAt = this.now();
      const pipelineLatencyMs = Math.max(0, performance.now() - startedAtMs);
      const session = await this.options.sessions.append({
        id,
        source,
        status: 'completed',
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        pipelineLatencyMs,
        transcript,
        responseText: conversation.answer,
        ttsTarget,
        ttsProvider: audioResult.provider,
        conversationId: conversation.conversationId,
      });
      return { session, conversation, audio: audioResult };
    } catch (error) {
      await this.options.sessions.append({
        id,
        source,
        status: 'failed',
        startedAt: startedAt.toISOString(),
        endedAt: this.now().toISOString(),
        error: error instanceof Error ? error.message.slice(0, 500) : 'audio pipeline failed',
      });
      throw error;
    }
  }
}
