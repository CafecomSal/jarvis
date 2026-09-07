import { z } from 'zod';

export const HouseSemanticModelSchema = z.object({
  rooms: z.array(z.string().min(1)).default([]),
  connections: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    via: z.string().min(1).optional(),
  })).default([]),
  cameras: z.array(z.object({
    id: z.string().min(1),
    location: z.string().min(1),
  })).default([]),
  zones: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  })).default([]),
});

export type HouseSemanticModel = z.infer<typeof HouseSemanticModelSchema>;

export class SemanticMemory {
  private readonly model: HouseSemanticModel;

  constructor(model: Partial<HouseSemanticModel> = {}) {
    this.model = HouseSemanticModelSchema.parse(model);
  }

  snapshot(): HouseSemanticModel {
    return structuredClone(this.model);
  }
}
