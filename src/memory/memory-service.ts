import type { EventStore } from '../events/in-memory-event-store.js';
import type { EventQuery } from '../events/event-query.js';
import type { HomeEvent } from '../events/schema.js';

export class WorkingMemory {
  constructor(private readonly events: EventStore) {}

  async recent(limit = 20): Promise<HomeEvent[]> {
    return this.events.list(limit);
  }
}

export class EpisodicMemory {
  constructor(private readonly events: EventStore) {}

  async search(query: EventQuery = {}): Promise<HomeEvent[]> {
    return this.events.query(query);
  }
}
