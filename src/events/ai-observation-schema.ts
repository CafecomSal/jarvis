import { z } from 'zod';

export const BoundingBoxSchema = z.object({
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
}).refine((box) => box.x2 > box.x1 && box.y2 > box.y1, {
  message: 'bounding box must have positive width and height',
});

const DetectionSchema = z.object({
  confidence: z.number().min(0).max(1),
  box: BoundingBoxSchema,
});

export const ObjectObservationDataSchema = z.object({
  camera: z.string().min(1),
  className: z.string().min(1),
  classId: z.number().int().nonnegative().optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  detections: z.array(DetectionSchema).min(1),
  evidenceEventId: z.string().min(1),
  imageRef: z.string().min(1).nullable().optional(),
  recordingSegmentId: z.string().min(1).optional(),
  frameTimestampMs: z.number().int().nonnegative().optional(),
  historical: z.boolean().optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
});

const OcrRegionSchema = z.object({
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  box: BoundingBoxSchema,
});

export const OcrObservationDataSchema = z.object({
  camera: z.string().min(1),
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  language: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  regions: z.array(OcrRegionSchema).min(1),
  evidenceEventId: z.string().min(1),
  imageRef: z.string().min(1).nullable().optional(),
  recordingSegmentId: z.string().min(1).optional(),
  frameTimestampMs: z.number().int().nonnegative().optional(),
  historical: z.boolean().optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
});

export const RecordingSegmentMetadataSchema = z.object({
  camera: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().positive(),
  fileRef: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  videoCodec: z.string().min(1),
  audioCodec: z.string().min(1).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  checksum: z.string().min(1).optional(),
  backupStatus: z.enum(['local', 'queued', 'uploaded', 'verified', 'failed', 'remote_deleted']),
  retentionTier: z.enum(['continuous', 'event', 'protected']).optional(),
  protected: z.boolean().optional(),
  driveFileId: z.string().min(1).optional(),
  driveWebViewLink: z.string().url().optional(),
  backupVerifiedAt: z.string().datetime({ offset: true }).optional(),
});

export type BoundingBox = z.infer<typeof BoundingBoxSchema>;
export type ObjectObservationData = z.infer<typeof ObjectObservationDataSchema>;
export type OcrObservationData = z.infer<typeof OcrObservationDataSchema>;
export type RecordingSegmentMetadata = z.infer<typeof RecordingSegmentMetadataSchema>;
