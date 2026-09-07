import { z } from 'zod';

export const WatchPredicatesSchema = z.object({
  requirePerson: z.boolean().default(true),
  vehicleClasses: z.array(z.string().min(1)).default([]),
  requireApproach: z.boolean().default(true),
  requirePackage: z.boolean().default(false),
});

export const WatchSessionSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  camera: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  predicates: WatchPredicatesSchema,
  notificationTargets: z.array(z.enum(['pc', 'alexa'])).min(1),
  status: z.enum(['active', 'matched', 'expired', 'cancelled']),
});

export const WatchObservationSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  camera: z.string().min(1),
  region: z.string().min(1).optional(),
  classes: z.array(z.string().min(1)),
  approaching: z.boolean(),
  packagePresent: z.boolean().optional(),
});

export type WatchSession = z.infer<typeof WatchSessionSchema>;
export type WatchObservation = z.infer<typeof WatchObservationSchema>;

export interface WatchMatchResult {
  matched: boolean;
  reason: string;
}

export class WatchSessionMatcher {
  match(session: WatchSession, observation: WatchObservation): WatchMatchResult {
    const validatedSession = WatchSessionSchema.parse(session);
    const validatedObservation = WatchObservationSchema.parse(observation);
    const observationTime = Date.parse(validatedObservation.timestamp);
    if (validatedSession.status !== 'active') return { matched: false, reason: 'watch session not active' };
    if (observationTime >= Date.parse(validatedSession.expiresAt)) return { matched: false, reason: 'watch session expired' };
    if (validatedSession.camera && validatedSession.camera !== validatedObservation.camera) {
      return { matched: false, reason: 'camera predicate not satisfied' };
    }
    if (validatedSession.region && validatedSession.region !== validatedObservation.region) {
      return { matched: false, reason: 'region predicate not satisfied' };
    }
    if (validatedSession.predicates.requirePerson && !validatedObservation.classes.includes('person')) {
      return { matched: false, reason: 'person predicate not satisfied' };
    }
    if (validatedSession.predicates.vehicleClasses.length > 0
      && !validatedSession.predicates.vehicleClasses.some((vehicle) => validatedObservation.classes.includes(vehicle))) {
      return { matched: false, reason: 'vehicle predicate not satisfied' };
    }
    if (validatedSession.predicates.requireApproach && !validatedObservation.approaching) {
      return { matched: false, reason: 'approach predicate not satisfied' };
    }
    if (validatedSession.predicates.requirePackage && !validatedObservation.packagePresent) {
      return { matched: false, reason: 'package predicate not satisfied' };
    }
    return { matched: true, reason: 'watch predicates satisfied' };
  }
}
