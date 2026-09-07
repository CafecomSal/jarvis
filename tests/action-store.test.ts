import { describe, expect, it } from 'vitest';
import { InMemoryActionProposalStore } from '../src/actions/action-store.js';

describe('store de propostas de ação', () => {
  it('mantém a proposta original e lista por estado', async () => {
    const store = new InMemoryActionProposalStore();
    await store.append({
      id: 'act-1',
      toolName: 'notify_user',
      risk: 'low',
      summary: 'Avisar sobre chegada compatível',
      arguments: { target: 'pc' },
      evidenceIds: ['evt-1'],
      status: 'proposed',
      requestedAt: '2026-09-05T00:00:00.000Z',
      expiresAt: '2026-09-05T01:00:00.000Z',
    });

    expect((await store.list({ status: 'proposed', limit: 10 })).map((item) => item.id)).toEqual(['act-1']);
    expect((await store.findById('act-1'))?.summary).toContain('chegada');
  });
});
