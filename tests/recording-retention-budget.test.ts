import { describe, expect, it } from 'vitest';
import { RecordingRetentionBudget } from '../src/recordings/retention-budget.js';

describe('budget de retenção DVR', () => {
  const budget = new RecordingRetentionBudget({ continuousDays: 30, eventDays: 90 });
  const now = new Date('2026-09-05T04:00:00.000Z');

  it('usa janela de 30 dias para contínuo e 90 para evento', () => {
    expect(budget.isEligible({ startedAt: '2026-08-01T00:00:00.000Z', retentionTier: 'continuous', backupStatus: 'verified' }, now)).toBe(true);
    expect(budget.isEligible({ startedAt: '2026-08-01T00:00:00.000Z', retentionTier: 'event', backupStatus: 'verified' }, now)).toBe(false);
  });

  it('não remove proteção manual nem upload não verificado', () => {
    expect(budget.isEligible({ startedAt: '2026-01-01T00:00:00.000Z', retentionTier: 'protected', backupStatus: 'verified' }, now)).toBe(false);
    expect(budget.isEligible({ startedAt: '2026-01-01T00:00:00.000Z', retentionTier: 'continuous', backupStatus: 'local' }, now)).toBe(false);
  });
});
