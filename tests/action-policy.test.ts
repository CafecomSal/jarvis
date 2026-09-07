import { describe, expect, it } from 'vitest';
import { ActionPolicy, ActionProposalSchema } from '../src/actions/action-policy.js';

describe('política de propostas de ação', () => {
  const proposal = ActionProposalSchema.parse({
    id: 'action-1',
    toolName: 'open_gate',
    risk: 'critical',
    summary: 'Abrir o portão',
    arguments: { reason: 'entregador compatível' },
    evidenceIds: ['evt-1'],
    requestedAt: '2026-09-05T04:00:00.000Z',
    expiresAt: '2026-09-05T04:05:00.000Z',
    status: 'proposed',
  });

  it('nega proposta sem confirmação explícita', () => {
    expect(new ActionPolicy().evaluate(proposal)).toMatchObject({ allowed: false, reason: 'explicit confirmation required' });
  });

  it('continua negando execução física quando a policy global está desligada', () => {
    const confirmed = { ...proposal, status: 'confirmed_by_user' as const, secondaryConfirmation: true };
    expect(new ActionPolicy({ actionsEnabled: false }).evaluate(confirmed)).toMatchObject({
      allowed: false,
      reason: 'actions are disabled by default policy',
    });
  });

  it('permite apenas proposta confirmada e não expirada quando habilitada', () => {
    const confirmed = { ...proposal, status: 'confirmed_by_user' as const, secondaryConfirmation: true };
    expect(new ActionPolicy({ actionsEnabled: true, now: () => new Date('2026-09-05T04:01:00.000Z') }).evaluate(confirmed)).toMatchObject({ allowed: true });
  });
});
