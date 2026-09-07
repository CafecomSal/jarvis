import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { EpisodicMemory, WorkingMemory } from '../src/memory/memory-service.js';
import { createDefaultToolRegistry } from '../src/tools/tool-registry.js';
import { WorldStateProjection } from '../src/state/world-state.js';

function event(id: string, timestamp: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'person.detected' as const,
    timestamp,
    source: { type: 'test', id: 'fixture' },
    data: {},
    ...overrides,
  };
}

describe('memória recente e episódica', () => {
  it('retorna episódios por intervalo, local e assunto', async () => {
    const events = new InMemoryEventStore();
    await events.append(event('evt-1', '2026-08-29T18:00:00-03:00', {
      location: 'sala',
      subject: { type: 'person', id: 'davi' },
    }));
    await events.append(event('evt-2', '2026-08-29T19:00:00-03:00', {
      location: 'cozinha',
      subject: { type: 'person', id: 'davi' },
    }));
    await events.append(event('evt-3', '2026-08-29T20:00:00-03:00', {
      location: 'cozinha',
      subject: { type: 'person', id: 'ana' },
    }));

    const result = await new EpisodicMemory(events).search({
      from: '2026-08-29T18:30:00-03:00',
      to: '2026-08-29T19:30:00-03:00',
      location: 'cozinha',
      subjectId: 'davi',
    });

    expect(result.map((item) => item.id)).toEqual(['evt-2']);
  });

  it('mantém apenas os eventos mais recentes na working memory', async () => {
    const events = new InMemoryEventStore();
    await events.append(event('evt-1', '2026-08-29T18:00:00-03:00'));
    await events.append(event('evt-2', '2026-08-29T19:00:00-03:00'));
    await events.append(event('evt-3', '2026-08-29T20:00:00-03:00'));

    const result = await new WorkingMemory(events).recent(2);

    expect(result.map((item) => item.id)).toEqual(['evt-2', 'evt-3']);
  });

  it('permite que search_events use filtros episódicos sem perder a busca textual', async () => {
    const events = new InMemoryEventStore();
    await events.append(event('evt-tool-1', '2026-08-29T18:00:00-03:00', {
      location: 'cozinha',
      subject: { type: 'person', id: 'davi' },
    }));
    await events.append(event('evt-tool-2', '2026-08-29T19:00:00-03:00', {
      location: 'sala',
      subject: { type: 'person', id: 'davi' },
    }));

    const registry = createDefaultToolRegistry({
      events,
      worldState: new WorldStateProjection(),
    });
    const result = await registry.execute({
      id: 'call-search-episodes',
      name: 'search_events',
      arguments: {
        location: 'cozinha',
        subjectId: 'davi',
        from: '2026-08-29T17:00:00-03:00',
        to: '2026-08-29T19:30:00-03:00',
      },
    });

    expect(result).toMatchObject([{ id: 'evt-tool-1', location: 'cozinha' }]);
  });

  it('find_object retorna a última observação com sua evidência', async () => {
    const events = new InMemoryEventStore();
    await events.append(event('evt-remote-1', '2026-08-29T18:00:00-03:00', {
      type: 'object.observed',
      location: 'sala',
      subject: { type: 'object', id: 'tv_remote' },
      confidence: 0.7,
    }));
    await events.append(event('evt-remote-2', '2026-08-29T18:15:00-03:00', {
      type: 'object.observed',
      location: 'bancada da cozinha',
      subject: { type: 'object', id: 'tv_remote' },
      confidence: 0.83,
    }));

    const registry = createDefaultToolRegistry({
      events,
      worldState: new WorldStateProjection(),
    });
    const result = await registry.execute({
      id: 'call-find-object',
      name: 'find_object',
      arguments: { object: 'tv_remote' },
    });

    expect(result).toMatchObject({
      object: 'tv_remote',
      found: true,
      lastKnown: {
        location: 'bancada da cozinha',
        timestamp: '2026-08-29T18:15:00-03:00',
        confidence: 0.83,
        evidenceEventId: 'evt-remote-2',
      },
    });
  });
});
