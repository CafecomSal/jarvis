import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryActionProposalStore } from '../src/actions/action-store.js';

describe('API de propostas de ação', () => {
  it('lista proposta sem oferecer execução automática', async () => {
    const actions = new InMemoryActionProposalStore();
    await actions.append({
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
    const app = buildApp({ actions });

    const list = await app.inject({ method: 'GET', url: '/actions/proposals?status=proposed' });
    const execute = await app.inject({ method: 'POST', url: '/actions/proposals/act-1/execute', payload: {} });

    expect(list.statusCode).toBe(200);
    expect(list.json().proposals[0].id).toBe('act-1');
    expect(execute.statusCode).toBe(404);
    await app.close();
  });
});
