import type { HomeEvent } from '../events/schema.js';

export type Presence = 'home' | 'away' | 'unknown';

export interface PersonState {
  presence: Presence;
  location?: string;
  confidence?: number;
  lastSeen: string;
}

export interface ObjectState {
  location?: string;
  confidence?: number;
  lastSeen: string;
}

export interface DoorState {
  state: 'open' | 'closed';
  lastChanged: string;
}

export interface HomeState {
  security: {
    mode: 'normal' | 'defense';
  };
  people: Record<string, PersonState>;
  objects: Record<string, ObjectState>;
  doors: Record<string, DoorState>;
  observedAt: string | null;
}

function createInitialState(): HomeState {
  return {
    security: { mode: 'normal' },
    people: {},
    objects: {},
    doors: {},
    observedAt: null,
  };
}

function isAtLeastAsRecent(timestamp: string, previousTimestamp: string | undefined): boolean {
  return !previousTimestamp || Date.parse(timestamp) >= Date.parse(previousTimestamp);
}

export class WorldStateProjection {
  private state = createInitialState();

  apply(event: HomeEvent): void {
    if (!this.state.observedAt || Date.parse(event.timestamp) >= Date.parse(this.state.observedAt)) {
      this.state.observedAt = event.timestamp;
    }

    if (event.type === 'person.detected' && event.subject?.type === 'person') {
      const previous = this.state.people[event.subject.id];
      if (!isAtLeastAsRecent(event.timestamp, previous?.lastSeen)) return;
      const person: PersonState = {
        presence: 'home',
        lastSeen: event.timestamp,
      };
      if (event.location) person.location = event.location;
      if (event.confidence !== undefined) person.confidence = event.confidence;
      this.state.people[event.subject.id] = person;
    }

    if (event.type === 'person.left' && event.subject?.type === 'person') {
      const previous = this.state.people[event.subject.id];
      if (!isAtLeastAsRecent(event.timestamp, previous?.lastSeen)) return;
      this.state.people[event.subject.id] = {
        presence: 'away',
        location: previous?.location,
        confidence: event.confidence ?? previous?.confidence,
        lastSeen: event.timestamp,
      };
    }

    if (event.type === 'object.observed' && event.subject?.type === 'object') {
      const previous = this.state.objects[event.subject.id];
      if (!isAtLeastAsRecent(event.timestamp, previous?.lastSeen)) return;
      const objectState: ObjectState = { lastSeen: event.timestamp };
      if (event.location) objectState.location = event.location;
      if (event.confidence !== undefined) objectState.confidence = event.confidence;
      this.state.objects[event.subject.id] = objectState;
    }

    if ((event.type === 'door.opened' || event.type === 'door.closed') && event.subject?.type === 'door') {
      const previous = this.state.doors[event.subject.id];
      if (!isAtLeastAsRecent(event.timestamp, previous?.lastChanged)) return;
      this.state.doors[event.subject.id] = {
        state: event.type === 'door.opened' ? 'open' : 'closed',
        lastChanged: event.timestamp,
      };
    }
  }

  snapshot(): HomeState {
    return structuredClone(this.state);
  }
}
