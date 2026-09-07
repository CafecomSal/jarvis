import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { SemanticMemory } from '../src/memory/semantic-memory.js';
import { createDefaultToolRegistry } from '../src/tools/tool-registry.js';
import { WorldStateProjection } from '../src/state/world-state.js';

describe('memória semântica da casa', () => {
  it('preserva cômodos, conexões, câmeras e zonas configurados', async () => {
    const semanticMemory = new SemanticMemory({
      rooms: ['sala', 'cozinha'],
      connections: [{ from: 'sala', to: 'cozinha', via: 'corredor' }],
      cameras: [{ id: 'front', location: 'frente' }],
      zones: [{ id: 'backyard', name: 'quintal' }],
    });
    const registry = createDefaultToolRegistry({
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
      semanticMemory,
    });

    const result = await registry.execute({
      id: 'call-house-knowledge',
      name: 'get_house_knowledge',
      arguments: {},
    });

    expect(result).toEqual({
      rooms: ['sala', 'cozinha'],
      connections: [{ from: 'sala', to: 'cozinha', via: 'corredor' }],
      cameras: [{ id: 'front', location: 'frente' }],
      zones: [{ id: 'backyard', name: 'quintal' }],
    });
  });

  it('começa vazio e não inventa topologia quando nada foi configurado', () => {
    const semanticMemory = new SemanticMemory();

    expect(semanticMemory.snapshot()).toEqual({
      rooms: [],
      connections: [],
      cameras: [],
      zones: [],
    });
  });
});
