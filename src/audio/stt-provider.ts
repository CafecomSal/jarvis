import type { AudioTranscript } from './audio-types.js';

export interface SttRequestContext {
  sessionId?: string;
}

export interface SttProvider {
  transcribe(audio: Buffer, mimeType: string, context?: SttRequestContext): Promise<AudioTranscript>;
}
