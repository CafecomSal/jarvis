import { describe, expect, it } from 'vitest';
import { ImportancePolicy } from '../src/importance/importance-policy.js';

describe('ImportancePolicy', () => {
  it('não deixa a proposta do Gemma sozinha proteger um evento', () => {
    const result = new ImportancePolicy().decide({
      proposal: { level: 'critical', reason: 'possível entrega', evidenceIds: ['evt-1'] },
    });

    expect(result).toMatchObject({ level: 'event', retentionTier: 'event', notify: false });
    expect(result.reason).toContain('confirmação');
  });

  it('protege somente quando uma regra determinística ou confirmação humana autoriza', () => {
    const result = new ImportancePolicy().decide({
      proposal: { level: 'critical', reason: 'evento validado', evidenceIds: ['evt-2'] },
      protectedByUser: true,
      humanConfirmed: true,
    });

    expect(result).toMatchObject({ level: 'critical', retentionTier: 'protected', notify: true });
  });

  it('classifica ocorrência rotineira como contínua', () => {
    expect(new ImportancePolicy().decide({
      proposal: { level: 'routine', reason: 'sem mudança', evidenceIds: [] },
    })).toMatchObject({ level: 'routine', retentionTier: 'continuous', notify: false });
  });
});
