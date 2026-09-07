import { z } from 'zod';

export const TagSourceSchema = z.enum(['detector', 'ocr', 'vlm', 'human']);
export const TagStatusSchema = z.enum([
  'observed',
  'confirmed',
  'human_reviewed',
  'identity_candidate',
  'identity_confirmed',
]);

export const TagValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const ObservationTagSchema = z.object({
  id: z.string().min(1),
  evidenceEventId: z.string().min(1),
  recordingId: z.string().min(1).optional(),
  frameRef: z.string().min(1).nullable().optional(),
  camera: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: TagValueSchema,
  confidence: z.number().min(0).max(1).optional(),
  source: TagSourceSchema,
  status: TagStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  reviewedAt: z.string().datetime({ offset: true }).optional(),
});

export const TagQuerySchema = z.object({
  query: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  source: TagSourceSchema.optional(),
  status: TagStatusSchema.optional(),
  camera: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type ObservationTag = z.infer<typeof ObservationTagSchema>;
export type TagQuery = z.infer<typeof TagQuerySchema>;
export type TagValue = z.infer<typeof TagValueSchema>;
export type TagSource = z.infer<typeof TagSourceSchema>;
export type TagStatus = z.infer<typeof TagStatusSchema>;

export interface TagListResult {
  count: number;
  tags: ObservationTag[];
}
