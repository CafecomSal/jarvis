import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';
import { HomeEventSchema, type HomeEvent } from './schema.js';
import type { EventQuery } from './event-query.js';
import type { EventStore } from './in-memory-event-store.js';

export interface PostgresEventStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

interface EventRow extends QueryResultRow {
  id: string;
  type: string;
  occurred_at: Date | string;
  source_type: string;
  source_id: string;
  location: string | null;
  subject_type: string | null;
  subject_id: string | null;
  confidence: number | null;
  data: Record<string, unknown> | string | null;
}

const EVENT_COLUMNS = `
  id, type, occurred_at, source_type, source_id, location,
  subject_type, subject_id, confidence, data
`;

function rowToEvent(row: EventRow): HomeEvent {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) as Record<string, unknown> : row.data ?? {};
  return HomeEventSchema.parse({
    id: row.id,
    type: row.type,
    timestamp: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString(),
    source: { type: row.source_type, id: row.source_id },
    location: row.location ?? undefined,
    subject: row.subject_type && row.subject_id
      ? { type: row.subject_type, id: row.subject_id }
      : undefined,
    confidence: row.confidence ?? undefined,
    data,
  });
}

function normalizeTerms(query: string): string[] {
  const normalized = query
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const stopWords = new Set(['com', 'dos', 'das', 'para', 'por', 'que', 'uma', 'uns', 'umas']);
  return normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

export class PostgresEventStore implements EventStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresEventStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
    });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    const migration = await readPostgresMigration(currentFile, '001_init.sql');
    await this.pool.query(migration);
  }

  async append(event: HomeEvent): Promise<HomeEvent> {
    const validated = HomeEventSchema.parse(event);
    const result = await this.pool.query<EventRow>(
      `INSERT INTO events (
        id, type, occurred_at, source_type, source_id, location,
        subject_type, subject_id, confidence, data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING ${EVENT_COLUMNS}`,
      [
        validated.id,
        validated.type,
        validated.timestamp,
        validated.source.type,
        validated.source.id,
        validated.location ?? null,
        validated.subject?.type ?? null,
        validated.subject?.id ?? null,
        validated.confidence ?? null,
        JSON.stringify(validated.data),
      ],
    );

    if (result.rows[0]) return rowToEvent(result.rows[0]);

    const existing = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`,
      [validated.id],
    );
    if (!existing.rows[0]) {
      throw new Error(`Event was not returned after append: ${validated.id}`);
    }
    return rowToEvent(existing.rows[0]);
  }

  async list(limit = 100): Promise<HomeEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM (
         SELECT ${EVENT_COLUMNS}, created_at
         FROM events
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $1
       ) recent
       ORDER BY occurred_at ASC, created_at ASC`,
      [limit],
    );
    return result.rows.map(rowToEvent);
  }

  async search(query: string, limit = 20): Promise<HomeEvent[]> {
    const terms = normalizeTerms(query);
    if (terms.length === 0) return this.list(limit);

    const searchableColumns = [
      'id',
      'type',
      'source_type',
      'source_id',
      'location',
      'subject_type',
      'subject_id',
      'data::text',
    ];
    const clauses = terms.flatMap((_, termIndex) => searchableColumns.map((column) => {
      return `${column} ILIKE $${termIndex + 1}`;
    }));
    const result = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM (
         SELECT ${EVENT_COLUMNS}, created_at
         FROM events
         WHERE ${clauses.join(' OR ')}
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $${terms.length + 1}
       ) recent
       ORDER BY occurred_at ASC, created_at ASC`,
      [...terms.map((term) => `%${term}%`), limit],
    );
    return result.rows.map(rowToEvent);
  }

  async query(filter: EventQuery = {}): Promise<HomeEvent[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    const addParameter = (clause: string, value: unknown): void => {
      parameters.push(value);
      clauses.push(clause.replace('?', `$${parameters.length}`));
    };

    if (filter.from) addParameter('occurred_at >= ?', filter.from);
    if (filter.to) addParameter('occurred_at <= ?', filter.to);
    if (filter.type) addParameter('type = ?', filter.type);
    if (filter.location) addParameter('location = ?', filter.location);
    if (filter.subjectId) addParameter('subject_id = ?', filter.subjectId);

    const limit = filter.limit ?? 100;
    parameters.push(limit);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM (
         SELECT ${EVENT_COLUMNS}, created_at
         FROM events
         ${where}
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $${parameters.length}
       ) recent
       ORDER BY occurred_at ASC, created_at ASC`,
      parameters,
    );
    return result.rows.map(rowToEvent);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
