import type { EventQuery } from './event-query.js';
import { HomeEventSchema, type HomeEvent } from './schema.js';

export interface EventAppender {
  append(event: HomeEvent): Promise<HomeEvent>;
}

export interface EventStore extends EventAppender {
  list(limit?: number): Promise<HomeEvent[]>;
  search(query: string, limit?: number): Promise<HomeEvent[]>;
  query(filter?: EventQuery): Promise<HomeEvent[]>;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: HomeEvent[] = [];

  async append(event: HomeEvent): Promise<HomeEvent> {
    const validated = HomeEventSchema.parse(event);
    const existing = this.events.find((stored) => stored.id === validated.id);
    if (existing) return structuredClone(existing);
    const stored = structuredClone(validated);
    this.events.push(stored);
    return structuredClone(stored);
  }

  async list(limit = 100): Promise<HomeEvent[]> {
    return structuredClone(this.events.slice(-limit));
  }

  async search(query: string, limit = 20): Promise<HomeEvent[]> {
    const normalize = (value: string): string => value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const stopWords = new Set(['com', 'dos', 'das', 'para', 'por', 'que', 'uma', 'uns', 'umas']);
    const terms = normalize(query)
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && !stopWords.has(term));
    const matches = terms.length === 0
      ? this.events
      : this.events.filter((event) => {
        const haystack = normalize(JSON.stringify(event));
        return terms.some((term) => haystack.includes(term));
      });

    return structuredClone(matches.slice(-limit));
  }

  async query(filter: EventQuery = {}): Promise<HomeEvent[]> {
    const from = filter.from ? Date.parse(filter.from) : Number.NEGATIVE_INFINITY;
    const to = filter.to ? Date.parse(filter.to) : Number.POSITIVE_INFINITY;
    const matches = this.events
      .filter((event) => {
        const occurredAt = Date.parse(event.timestamp);
        return occurredAt >= from
          && occurredAt <= to
          && (!filter.type || event.type === filter.type)
          && (!filter.location || event.location === filter.location)
          && (!filter.subjectId || event.subject?.id === filter.subjectId);
      })
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

    return structuredClone(matches.slice(-(filter.limit ?? 100)));
  }
}
