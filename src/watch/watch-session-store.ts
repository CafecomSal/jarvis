import { WatchSessionSchema, type WatchSession } from './watch-session.js';

export interface WatchSessionQuery {
  camera?: string;
  status?: WatchSession['status'];
  limit?: number;
}

export interface WatchSessionStore {
  append(session: WatchSession): Promise<WatchSession>;
  list(query?: WatchSessionQuery): Promise<WatchSession[]>;
  findById(id: string): Promise<WatchSession | undefined>;
  expire(now?: Date): Promise<string[]>;
}

function clone(session: WatchSession): WatchSession {
  return structuredClone(session);
}

export class InMemoryWatchSessionStore implements WatchSessionStore {
  private readonly sessions: WatchSession[] = [];

  async append(session: WatchSession): Promise<WatchSession> {
    const validated = WatchSessionSchema.parse(session);
    const existing = this.sessions.find((item) => item.id === validated.id);
    if (existing) return clone(existing);
    this.sessions.push(clone(validated));
    return clone(validated);
  }

  async list(query: WatchSessionQuery = {}): Promise<WatchSession[]> {
    return this.sessions
      .filter((session) => query.camera === undefined || session.camera === query.camera)
      .filter((session) => query.status === undefined || session.status === query.status)
      .slice(-(query.limit ?? 100))
      .map(clone);
  }

  async findById(id: string): Promise<WatchSession | undefined> {
    const session = this.sessions.find((item) => item.id === id);
    return session ? clone(session) : undefined;
  }

  async expire(now = new Date()): Promise<string[]> {
    const expired: string[] = [];
    for (let index = 0; index < this.sessions.length; index += 1) {
      const session = this.sessions[index];
      if (session.status === 'active' && Date.parse(session.expiresAt) <= now.getTime()) {
        this.sessions[index] = { ...session, status: 'expired' };
        expired.push(session.id);
      }
    }
    return expired;
  }
}
