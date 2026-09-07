import { z } from 'zod';

export const AuditKindSchema = z.enum(['conversation', 'tool_call', 'policy_decision']);
export const AuditOutcomeSchema = z.enum(['success', 'error', 'denied']);

export const AuditEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  conversationId: z.string().min(1),
  kind: AuditKindSchema,
  action: z.string().min(1),
  actor: z.string().min(1),
  outcome: AuditOutcomeSchema.optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type AuditKind = z.infer<typeof AuditKindSchema>;
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
