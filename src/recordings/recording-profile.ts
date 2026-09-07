import { z } from 'zod';

export const RecordingProfileNameSchema = z.enum(['continuous-economic', 'event-high-quality', 'manual-export']);

export const RecordingProfileSchema = z.object({
  name: RecordingProfileNameSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoFps: z.number().positive(),
  videoBitrateKbps: z.number().int().positive(),
  videoPreset: z.string().min(1),
  audioCodec: z.string().min(1),
  audioBitrateKbps: z.number().int().positive(),
  segmentDurationMs: z.number().int().positive(),
});

export type RecordingProfileName = z.infer<typeof RecordingProfileNameSchema>;
export type RecordingProfile = z.infer<typeof RecordingProfileSchema>;

const DEFAULT_PROFILES: Record<RecordingProfileName, RecordingProfile> = {
  'continuous-economic': {
    name: 'continuous-economic',
    width: 1280,
    height: 1440,
    videoFps: 5,
    videoBitrateKbps: 1400,
    videoPreset: 'veryfast',
    audioCodec: 'aac',
    audioBitrateKbps: 32,
    segmentDurationMs: 60_000,
  },
  'event-high-quality': {
    name: 'event-high-quality',
    width: 1920,
    height: 2160,
    videoFps: 5,
    videoBitrateKbps: 5000,
    videoPreset: 'fast',
    audioCodec: 'aac',
    audioBitrateKbps: 64,
    segmentDurationMs: 30_000,
  },
  'manual-export': {
    name: 'manual-export',
    width: 1920,
    height: 2160,
    videoFps: 10,
    videoBitrateKbps: 8000,
    videoPreset: 'fast',
    audioCodec: 'aac',
    audioBitrateKbps: 96,
    segmentDurationMs: 60_000,
  },
};

export function getRecordingProfile(name: RecordingProfileName): RecordingProfile {
  return structuredClone(DEFAULT_PROFILES[name]);
}
