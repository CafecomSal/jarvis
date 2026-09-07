import { z } from 'zod';
import {
  DEFAULT_STT_RUNTIME_CONFIG,
  LocalSttModelSchema,
  SttFallbackSchema,
  SttRuntimeConfigSchema,
  SttRouteSchema,
  type SttRuntimeConfig,
} from '../audio/stt-config.js';

export const RuntimeQuotaSchema = z.object({
  maxRequestsPerDay: z.number().int().min(1).max(1_000_000),
  maxAudioSecondsPerDay: z.number().int().min(1).max(86_400),
  maxEstimatedMonthlyUsd: z.number().finite().min(0).max(100_000),
}).strict();

export const AudioSessionRetentionSettingsSchema = z.object({
  autoDeleteEnabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(3_650),
  deletableStatuses: z.array(z.enum(['completed', 'failed'])).min(1).max(2),
}).strict();

export const RuntimeSettingsSchema = z.object({
  audioEnabled: z.boolean(),
  stt: SttRuntimeConfigSchema,
  quota: RuntimeQuotaSchema,
  audioSessions: AudioSessionRetentionSettingsSchema,
}).strict();

const RuntimeSettingsPatchSchema = z.object({
  audioEnabled: z.boolean().optional(),
  stt: SttRuntimeConfigSchema.partial().strict().optional(),
  quota: RuntimeQuotaSchema.partial().strict().optional(),
  audioSessions: AudioSessionRetentionSettingsSchema.partial().strict().optional(),
}).strict();

export type RuntimeQuota = z.infer<typeof RuntimeQuotaSchema>;
export type AudioSessionRetentionSettings = z.infer<typeof AudioSessionRetentionSettingsSchema>;
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
export type RuntimeSettingsPatch = z.infer<typeof RuntimeSettingsPatchSchema>;

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  audioEnabled: false,
  stt: DEFAULT_STT_RUNTIME_CONFIG,
  quota: {
    maxRequestsPerDay: 30,
    maxAudioSecondsPerDay: 600,
    maxEstimatedMonthlyUsd: 1,
  },
  audioSessions: {
    autoDeleteEnabled: false,
    retentionDays: 30,
    deletableStatuses: ['completed', 'failed'],
  },
};

function boolValue(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function intValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function floatValue(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function runtimeSettingsFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): RuntimeSettings {
  const localModel = LocalSttModelSchema.safeParse(env.JARVIS_STT_MODEL?.trim() || DEFAULT_STT_RUNTIME_CONFIG.localModel);
  const route = SttRouteSchema.safeParse(env.JARVIS_STT_ROUTE?.trim() || DEFAULT_STT_RUNTIME_CONFIG.route);
  const fallback = SttFallbackSchema.safeParse(env.JARVIS_STT_FALLBACK?.trim() || DEFAULT_STT_RUNTIME_CONFIG.fallback);
  const candidate: RuntimeSettings = {
    audioEnabled: boolValue(env, 'JARVIS_AUDIO_ENABLED', DEFAULT_RUNTIME_SETTINGS.audioEnabled),
    stt: {
      route: route.success ? route.data : DEFAULT_STT_RUNTIME_CONFIG.route,
      localModel: localModel.success ? localModel.data : DEFAULT_STT_RUNTIME_CONFIG.localModel,
      groqModel: env.JARVIS_GROQ_STT_MODEL?.trim() === 'whisper-large-v3'
        ? 'whisper-large-v3'
        : DEFAULT_STT_RUNTIME_CONFIG.groqModel,
      language: env.JARVIS_STT_LANGUAGE?.trim() || DEFAULT_STT_RUNTIME_CONFIG.language,
      prompt: env.JARVIS_STT_PROMPT?.trim() || DEFAULT_STT_RUNTIME_CONFIG.prompt,
      fallback: fallback.success ? fallback.data : DEFAULT_STT_RUNTIME_CONFIG.fallback,
      timeoutMs: Math.min(120_000, Math.max(100, intValue(env, 'JARVIS_STT_TIMEOUT_MS', DEFAULT_STT_RUNTIME_CONFIG.timeoutMs))),
      cloudEnabled: boolValue(env, 'JARVIS_CLOUD_STT_ENABLED', DEFAULT_STT_RUNTIME_CONFIG.cloudEnabled),
    },
    quota: {
      maxRequestsPerDay: Math.min(1_000_000, intValue(env, 'JARVIS_STT_MAX_REQUESTS_PER_DAY', DEFAULT_RUNTIME_SETTINGS.quota.maxRequestsPerDay)),
      maxAudioSecondsPerDay: Math.min(86_400, intValue(env, 'JARVIS_STT_MAX_AUDIO_SECONDS_PER_DAY', DEFAULT_RUNTIME_SETTINGS.quota.maxAudioSecondsPerDay)),
      maxEstimatedMonthlyUsd: Math.min(100_000, floatValue(env, 'JARVIS_STT_MAX_ESTIMATED_MONTHLY_USD', DEFAULT_RUNTIME_SETTINGS.quota.maxEstimatedMonthlyUsd)),
    },
    audioSessions: {
      autoDeleteEnabled: boolValue(env, 'JARVIS_AUDIO_SESSION_AUTO_DELETE', DEFAULT_RUNTIME_SETTINGS.audioSessions.autoDeleteEnabled),
      retentionDays: Math.min(3_650, intValue(env, 'JARVIS_AUDIO_SESSION_RETENTION_DAYS', DEFAULT_RUNTIME_SETTINGS.audioSessions.retentionDays)),
      deletableStatuses: DEFAULT_RUNTIME_SETTINGS.audioSessions.deletableStatuses,
    },
  };
  return RuntimeSettingsSchema.parse(candidate);
}

export function mergeRuntimeSettings(current: RuntimeSettings, patch: unknown): RuntimeSettings {
  const validatedCurrent = RuntimeSettingsSchema.parse(current);
  const validatedPatch = RuntimeSettingsPatchSchema.parse(patch);
  return RuntimeSettingsSchema.parse({
    ...validatedCurrent,
    ...validatedPatch,
    stt: { ...validatedCurrent.stt, ...(validatedPatch.stt ?? {}) },
    quota: { ...validatedCurrent.quota, ...(validatedPatch.quota ?? {}) },
    audioSessions: { ...validatedCurrent.audioSessions, ...(validatedPatch.audioSessions ?? {}) },
  });
}
