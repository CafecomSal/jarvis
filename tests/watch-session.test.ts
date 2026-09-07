import { describe, expect, it } from 'vitest';
import { WatchSessionMatcher, WatchSessionSchema } from '../src/watch/watch-session.js';

describe('watch session de entrega', () => {
  const session = WatchSessionSchema.parse({
    id: 'watch-delivery-1',
    owner: 'davi',
    createdAt: '2026-09-05T04:00:00.000Z',
    expiresAt: '2026-09-05T05:00:00.000Z',
    camera: 'front',
    predicates: { requirePerson: true, vehicleClasses: ['motorcycle', 'car'], requireApproach: true },
    notificationTargets: ['alexa', 'pc'],
    status: 'active',
  });

  it('casa pessoa, veículo e aproximação na câmera correta', () => {
    const result = new WatchSessionMatcher().match(session, {
      timestamp: '2026-09-05T04:30:00.000Z',
      camera: 'front',
      classes: ['person', 'motorcycle'],
      approaching: true,
    });
    expect(result).toMatchObject({ matched: true, reason: 'watch predicates satisfied' });
  });

  it('não casa somente uma pessoa ou uma câmera errada', () => {
    const matcher = new WatchSessionMatcher();
    expect(matcher.match(session, {
      timestamp: '2026-09-05T04:30:00.000Z', camera: 'front', classes: ['person'], approaching: true,
    }).matched).toBe(false);
    expect(matcher.match(session, {
      timestamp: '2026-09-05T04:30:00.000Z', camera: 'back', classes: ['person', 'car'], approaching: true,
    }).matched).toBe(false);
  });

  it('não casa depois da expiração ou sem aproximação', () => {
    const matcher = new WatchSessionMatcher();
    expect(matcher.match(session, {
      timestamp: '2026-09-05T05:00:01.000Z', camera: 'front', classes: ['person', 'car'], approaching: true,
    }).reason).toBe('watch session expired');
    expect(matcher.match(session, {
      timestamp: '2026-09-05T04:30:00.000Z', camera: 'front', classes: ['person', 'car'], approaching: false,
    }).reason).toBe('approach predicate not satisfied');
  });
});
