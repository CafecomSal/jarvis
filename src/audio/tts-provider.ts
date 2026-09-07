export interface TtsRequest {
  text: string;
  language?: string;
  voice?: string;
  rate?: number;
}

export interface TtsResult {
  audio: Buffer;
  mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/ogg';
  durationMs?: number;
  provider: string;
  model: string;
  latencyMs: number;
  cacheKey?: string;
}

export interface TtsProvider {
  synthesize(request: TtsRequest): Promise<TtsResult>;
}
