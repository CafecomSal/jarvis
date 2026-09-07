import { z } from 'zod';

export const EventTypeSchema = z.enum([
  'person.detected',
  'person.left',
  'door.opened',
  'door.closed',
  'sound.detected',
  'object.observed',
  'camera.snapshot',
  'vision.observation',
  'ocr.observation',
]);

const EventSourceSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

const SubjectSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

export const HomeEventSchema = z.object({
  id: z.string().min(1),
  type: EventTypeSchema,
  timestamp: z.string().datetime({ offset: true }),
  source: EventSourceSchema,
  location: z.string().min(1).optional(),
  subject: SubjectSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type EventType = z.infer<typeof EventTypeSchema>;
export type HomeEvent = z.infer<typeof HomeEventSchema>;
