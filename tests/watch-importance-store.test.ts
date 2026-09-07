import { describe, expect, it } from 'vitest';
import { InMemoryWatchSessionStore } from '../src/watch/watch-session-store.js';
import { InMemoryImportanceStore } from '../src/importance/importance-store.js';

describe('stores de watch session e importância', () => {
  it('mantém watch session idempotente e expira sessões vencidas', async () => {
    const store = new InMemoryWatchSessionStore();
    await store.append({
      id: 'watch-1', owner: 'davi', createdAt: '2026-09-05T04:00:00.000Z', expiresAt: '2026-09-05T04:05:00.000Z',
      camera: 'front', predicates: { requirePerson: true, vehicleClasses: ['motorcycle'], requireApproach: true, requirePackage: false },
      notificationTargets: ['pc'], status: 'active',
    });
    await store.append({
      id: 'watch-1', owner: 'other', createdAt: '2026-09-05T04:00:00.000Z', expiresAt: '2026-09-05T04:05:00.000Z',
      camera: 'back', predicates: { requirePerson: true, vehicleClasses: [], requireApproach: true, requirePackage: false },
      notificationTargets: ['alexa'], status: 'active',
    });

    const expired = await store.expire(new Date('2026-09-05T04:06:00.000Z'));
    expect(expired).toEqual(['watch-1']);
    expect(await store.findById('watch-1')).toMatchObject({ owner: 'davi', status: 'expired' });
  });

  it('persiste uma proposta de importância com decisão separada', async () => {
    const store = new InMemoryImportanceStore();
    const record = await store.append({
      id: 'importance-1', eventId: 'evt-1', createdAt: '2026-09-05T04:00:00.000Z',
      proposal: { level: 'relevant', reason: 'pessoa e moto se aproximando', evidenceIds: ['evt-1'], model: 'gemma-hermes:latest' },
      decision: { level: 'event', retentionTier: 'event', notify: true, reason: 'watch session matched' },
    });
    expect(await store.findById(record.id)).toEqual(record);
    expect(await store.list()).toHaveLength(1);
  });
});
