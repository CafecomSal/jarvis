import { z } from 'zod';

export const AudioSourceSchema = z.enum(['pc', 'alexa', 'text']);
export const AudioSessionStatusSchema = z.enum([
  'recording',
  'transcribing',
  'responding',
  'speaking',
  'completed',
  'failed',
]);

export const AudioTranscriptSchema = z.object({
  text: z.string(),
  language: z.string().min(2).optional(),
  confidence: z.number().min(0).max(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  latencyMs: z.number().finite().nonnegative(),
  processingLocation: z.enum(['local', 'cloud']).optional(),
  fallbackFrom: z.string().min(1).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  rateLimit: z.object({
    limitRequests: z.number().int().nonnegative().optional(),
    remainingRequests: z.number().int().nonnegative().optional(),
    resetRequests: z.string().min(1).optional(),
    limitTokens: z.number().int().nonnegative().optional(),
    remainingTokens: z.number().int().nonnegative().optional(),
    resetTokens: z.string().min(1).optional(),
  }).strict().optional(),
});

export const AudioSessionSchema = z.object({
  id: z.string().min(1),
  source: AudioSourceSchema,
  status: AudioSessionStatusSchema,
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  pipelineLatencyMs: z.number().finite().nonnegative().optional(),
  transcript: AudioTranscriptSchema.optional(),
  responseText: z.string().optional(),
  ttsTarget: z.enum(['pc', 'alexa']).optional(),
  ttsProvider: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

export type AudioSource = z.infer<typeof AudioSourceSchema>;
export type AudioSessionStatus = z.infer<typeof AudioSessionStatusSchema>;
export type AudioTranscript = z.infer<typeof AudioTranscriptSchema>;
export type AudioSession = z.infer<typeof AudioSessionSchema>;

export interface AudioSessionQuery {
  source?: AudioSource;
  status?: AudioSessionStatus;
  from?: string;
  to?: string;
  limit?: number;
}

export interface AudioSessionStore {
  append(session: AudioSession): Promise<AudioSession>;
  list(query?: AudioSessionQuery): Promise<AudioSession[]>;
  findById(id: string): Promise<AudioSession | undefined>;
  deleteByIds(ids: readonly string[]): Promise<AudioSession[]>;
}
