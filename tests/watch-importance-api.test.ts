import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryImportanceStore } from '../src/importance/importance-store.js';
import { InMemoryWatchSessionStore } from '../src/watch/watch-session-store.js';

describe('API de importância e watch sessions', () => {
  it('lista sessão ativa e proposta de importância', async () => {
    const watchSessions = new InMemoryWatchSessionStore();
    await watchSessions.append({
      id: 'watch-api', owner: 'davi', createdAt: '2026-09-05T04:00:00.000Z', expiresAt: '2026-09-05T05:00:00.000Z',
      camera: 'front', predicates: { requirePerson: true, vehicleClasses: ['motorcycle'], requireApproach: true, requirePackage: false },
      notificationTargets: ['pc', 'alexa'], status: 'active',
    });
    const importance = new InMemoryImportanceStore();
    await importance.append({
      id: 'importance-api', eventId: 'evt-api', createdAt: '2026-09-05T04:00:00.000Z',
      proposal: { level: 'relevant', reason: 'pessoa e moto', evidenceIds: ['evt-api'] },
      decision: { level: 'event', retentionTier: 'event', notify: false, reason: 'aguarda confirmação' },
    });
    const app = buildApp({ watchSessions, importance });

    const watchResponse = await app.inject({ method: 'GET', url: '/watch-sessions?status=active&camera=front' });
    const importanceResponse = await app.inject({ method: 'GET', url: '/importance?limit=10' });
    await app.close();

    expect(watchResponse.statusCode).toBe(200);
    expect(watchResponse.json()).toMatchObject({ count: 1, sessions: [{ id: 'watch-api', status: 'active' }] });
    expect(importanceResponse.statusCode).toBe(200);
    expect(importanceResponse.json()).toMatchObject({ count: 1, records: [{ id: 'importance-api', decision: { retentionTier: 'event' } }] });
  });

  it('retorna 501 quando os stores não estão disponíveis', async () => {
    const app = buildApp();
    const watch = await app.inject({ method: 'GET', url: '/watch-sessions' });
    const importance = await app.inject({ method: 'GET', url: '/importance' });
    await app.close();
    expect(watch.statusCode).toBe(501);
    expect(importance.statusCode).toBe(501);
  });
});
