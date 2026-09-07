import type { AudioTranscript } from './audio-types.js';

export interface SttRequestContext {
  sessionId?: string;
  /** Client-side elapsed duration used only when a stream container has no duration metadata. */
  audioDurationSeconds?: number;
}

export interface SttProvider {
  transcribe(audio: Buffer, mimeType: string, context?: SttRequestContext): Promise<AudioTranscript>;
}
