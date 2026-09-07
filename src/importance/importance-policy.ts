import { z } from 'zod';

export const ImportanceProposalSchema = z.object({
  level: z.enum(['routine', 'relevant', 'critical']),
  reason: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  model: z.string().min(1).optional(),
});

export const ImportanceDecisionSchema = z.object({
  level: z.enum(['routine', 'event', 'critical']),
  retentionTier: z.enum(['continuous', 'event', 'protected']),
  notify: z.boolean(),
  reason: z.string().min(1),
});

export type ImportanceProposal = z.infer<typeof ImportanceProposalSchema>;
export type ImportanceDecision = z.infer<typeof ImportanceDecisionSchema>;

export interface ImportanceDecisionInput {
  proposal?: ImportanceProposal;
  watchMatch?: boolean;
  humanConfirmed?: boolean;
  protectedByUser?: boolean;
}

export class ImportancePolicy {
  decide(input: ImportanceDecisionInput): ImportanceDecision {
    const proposal = input.proposal;
    if (input.protectedByUser && input.humanConfirmed) {
      return {
        level: 'critical',
        retentionTier: 'protected',
        notify: true,
        reason: 'evento protegido por confirmação humana e regra explícita',
      };
    }
    if (input.watchMatch || proposal?.level === 'critical' || proposal?.level === 'relevant') {
      return {
        level: 'event',
        retentionTier: 'event',
        notify: Boolean(input.watchMatch),
        reason: proposal?.level === 'critical'
          ? 'proposta crítica aguarda confirmação humana/política para proteção'
          : 'evento relevante aguarda confirmação para promoção',
      };
    }
    return {
      level: 'routine',
      retentionTier: 'continuous',
      notify: false,
      reason: 'sem regra de promoção para retenção de evento',
    };
  }
}
