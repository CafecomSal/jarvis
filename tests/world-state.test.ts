import { describe, expect, it } from 'vitest';
import { WorldStateProjection } from '../src/state/world-state.js';

function event(overrides: Record<string, unknown>) {
  return {
    id: 'evt-world-state',
    type: 'door.opened' as const,
    timestamp: '2026-08-29T19:00:00-03:00',
    source: { type: 'test', id: 'fixture' },
    data: {},
    ...overrides,
  };
}

describe('WorldStateProjection', () => {
  it('projeta abertura e fechamento de uma porta', () => {
    const projection = new WorldStateProjection();

    projection.apply(event({
      id: 'evt-door-open',
      type: 'door.opened',
      timestamp: '2026-08-29T19:00:00-03:00',
      subject: { type: 'door', id: 'back-door' },
    }));
    projection.apply(event({
      id: 'evt-door-closed',
      type: 'door.closed',
      timestamp: '2026-08-29T19:05:00-03:00',
      subject: { type: 'door', id: 'back-door' },
    }));

    expect(projection.snapshot().doors['back-door']).toMatchObject({
      state: 'closed',
      lastChanged: '2026-08-29T19:05:00-03:00',
    });
  });

  it('ignora detecção de pessoa mais antiga que o estado já projetado', () => {
    const projection = new WorldStateProjection();

    projection.apply(event({
      id: 'evt-person-new',
      type: 'person.detected',
      timestamp: '2026-08-29T19:10:00-03:00',
      location: 'quarto',
      subject: { type: 'person', id: 'davi' },
      confidence: 0.95,
    }));
    projection.apply(event({
      id: 'evt-person-old',
      type: 'person.detected',
      timestamp: '2026-08-29T19:01:00-03:00',
      location: 'sala',
      subject: { type: 'person', id: 'davi' },
      confidence: 0.5,
    }));

    expect(projection.snapshot().people.davi).toMatchObject({
      location: 'quarto',
      confidence: 0.95,
      lastSeen: '2026-08-29T19:10:00-03:00',
    });
  });

  it('ignora observação de objeto mais antiga que a localização atual', () => {
    const projection = new WorldStateProjection();

    projection.apply(event({
      id: 'evt-object-new',
      type: 'object.observed',
      timestamp: '2026-08-29T19:20:00-03:00',
      location: 'bancada',
      subject: { type: 'object', id: 'tv_remote' },
    }));
    projection.apply(event({
      id: 'evt-object-old',
      type: 'object.observed',
      timestamp: '2026-08-29T19:02:00-03:00',
      location: 'sala',
      subject: { type: 'object', id: 'tv_remote' },
    }));

    expect(projection.snapshot().objects.tv_remote).toMatchObject({
      location: 'bancada',
      lastSeen: '2026-08-29T19:20:00-03:00',
    });
  });
});
