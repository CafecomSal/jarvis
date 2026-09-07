import { z } from 'zod';

export const SttRouteSchema = z.enum(['local', 'groq', 'auto']);
export const SttFallbackSchema = z.enum(['none', 'local']);
export const LocalSttModelSchema = z.enum(['medium', 'small', 'base']);
export const GroqSttModelSchema = z.enum(['whisper-large-v3', 'whisper-large-v3-turbo']);

export const SttRuntimeConfigSchema = z.object({
  route: SttRouteSchema,
  localModel: LocalSttModelSchema,
  groqModel: GroqSttModelSchema,
  language: z.string().trim().min(2).max(16),
  prompt: z.string().max(1_000),
  fallback: SttFallbackSchema,
  timeoutMs: z.number().int().min(100).max(120_000),
  cloudEnabled: z.boolean(),
}).strict();

export type SttRoute = z.infer<typeof SttRouteSchema>;
export type SttFallback = z.infer<typeof SttFallbackSchema>;
export type GroqSttModel = z.infer<typeof GroqSttModelSchema>;
export type SttRuntimeConfig = z.infer<typeof SttRuntimeConfigSchema>;

export const DEFAULT_STT_RUNTIME_CONFIG: SttRuntimeConfig = {
  route: 'local',
  localModel: 'medium',
  groqModel: 'whisper-large-v3-turbo',
  language: 'pt-BR',
  prompt: '',
  fallback: 'none',
  timeoutMs: 12_000,
  cloudEnabled: false,
};

export function normalizeSttLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  return language.toLowerCase() === 'pt' ? 'pt-BR' : language;
}
