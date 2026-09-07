import { z } from 'zod';

export const ActionProposalSchema = z.object({
  id: z.string().min(1),
  toolName: z.string().min(1),
  risk: z.enum(['low', 'medium', 'critical']),
  summary: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  evidenceIds: z.array(z.string().min(1)).default([]),
  requestedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(['proposed', 'confirmed_by_user', 'executing', 'succeeded', 'failed', 'expired']),
  secondaryConfirmation: z.boolean().optional(),
});

export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export interface ActionPolicyOptions {
  actionsEnabled?: boolean;
  now?: () => Date;
}

export interface ActionDecision {
  allowed: boolean;
  reason: string;
}

export class ActionPolicy {
  private readonly actionsEnabled: boolean;
  private readonly now: () => Date;

  constructor(options: ActionPolicyOptions = {}) {
    this.actionsEnabled = options.actionsEnabled ?? false;
    this.now = options.now ?? (() => new Date());
  }

  evaluate(proposal: ActionProposal): ActionDecision {
    const validated = ActionProposalSchema.parse(proposal);
    if (validated.status !== 'confirmed_by_user') {
      return { allowed: false, reason: 'explicit confirmation required' };
    }
    if (!this.actionsEnabled) {
      return { allowed: false, reason: 'actions are disabled by default policy' };
    }
    if (this.now().getTime() >= Date.parse(validated.expiresAt)) {
      return { allowed: false, reason: 'action proposal expired' };
    }
    if (validated.risk === 'critical' && validated.secondaryConfirmation !== true) {
      return { allowed: false, reason: 'critical action requires secondary confirmation' };
    }
    return { allowed: true, reason: 'confirmed action allowed by policy' };
  }
}
