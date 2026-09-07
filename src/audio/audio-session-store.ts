import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';
import {
  AudioSessionSchema,
  type AudioSession,
  type AudioSessionQuery,
  type AudioSessionStore,
} from './audio-types.js';

function clone(session: AudioSession): AudioSession {
  return structuredClone(session);
}

export class InMemoryAudioSessionStore implements AudioSessionStore {
  private readonly sessions: AudioSession[] = [];

  async append(session: AudioSession): Promise<AudioSession> {
    const validated = AudioSessionSchema.parse(session);
    const existing = this.sessions.find((item) => item.id === validated.id);
    if (existing) return clone(existing);
    this.sessions.push(clone(validated));
    return clone(validated);
  }

  async list(query: AudioSessionQuery = {}): Promise<AudioSession[]> {
    const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
    const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
    const sessions = this.sessions
      .filter((session) => query.source === undefined || session.source === query.source)
      .filter((session) => query.status === undefined || session.status === query.status)
      .filter((session) => Date.parse(session.startedAt) >= from && Date.parse(session.startedAt) <= to)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    return sessions.slice(-(query.limit ?? 100)).map(clone);
  }

  async findById(id: string): Promise<AudioSession | undefined> {
    const session = this.sessions.find((item) => item.id === id);
    return session ? clone(session) : undefined;
  }

  async deleteByIds(ids: readonly string[]): Promise<AudioSession[]> {
    const wanted = new Set(ids);
    const deleted = this.sessions.filter((session) => wanted.has(session.id)).map(clone);
    if (deleted.length > 0) {
      const remaining = this.sessions.filter((session) => !wanted.has(session.id));
      this.sessions.splice(0, this.sessions.length, ...remaining);
    }
    return deleted;
  }
}

interface AudioSessionRow extends QueryResultRow {
  id: string;
  source: string;
  status: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  pipeline_latency_ms: number | string | null;
  transcript: Record<string, unknown> | string | null;
  response_text: string | null;
  tts_target: string | null;
  tts_provider: string | null;
  error: string | null;
  conversation_id: string | null;
}

function rowToSession(row: AudioSessionRow): AudioSession {
  const transcript = typeof row.transcript === 'string'
    ? JSON.parse(row.transcript) as unknown
    : row.transcript ?? undefined;
  return AudioSessionSchema.parse({
    id: row.id,
    source: row.source,
    status: row.status,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : new Date(row.started_at).toISOString(),
    ...(row.ended_at ? { endedAt: row.ended_at instanceof Date ? row.ended_at.toISOString() : new Date(row.ended_at).toISOString() } : {}),
    ...(row.pipeline_latency_ms === null ? {} : { pipelineLatencyMs: Number(row.pipeline_latency_ms) }),
    ...(transcript ? { transcript } : {}),
    ...(row.response_text ? { responseText: row.response_text } : {}),
    ...(row.tts_target ? { ttsTarget: row.tts_target } : {}),
    ...(row.tts_provider ? { ttsProvider: row.tts_provider } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
  });
}

export interface PostgresAudioSessionStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresAudioSessionStore implements AudioSessionStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresAudioSessionStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
    });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    await this.pool.query(await readPostgresMigration(currentFile, '003_audio_sessions.sql'));
  }

  async append(session: AudioSession): Promise<AudioSession> {
    const validated = AudioSessionSchema.parse(session);
    const result = await this.pool.query<AudioSessionRow>(
      `INSERT INTO audio_sessions (
        id, source, status, started_at, ended_at, pipeline_latency_ms, transcript, response_text,
        tts_target, tts_provider, error, conversation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO NOTHING
      RETURNING id, source, status, started_at, ended_at, pipeline_latency_ms, transcript, response_text,
        tts_target, tts_provider, error, conversation_id`,
      [
        validated.id,
        validated.source,
        validated.status,
        validated.startedAt,
        validated.endedAt ?? null,
        validated.pipelineLatencyMs ?? null,
        validated.transcript ? JSON.stringify(validated.transcript) : null,
        validated.responseText ?? null,
        validated.ttsTarget ?? null,
        validated.ttsProvider ?? null,
        validated.error ?? null,
        validated.conversationId ?? null,
      ],
    );
    if (result.rows[0]) return rowToSession(result.rows[0]);
    const existing = await this.findById(validated.id);
    if (!existing) throw new Error(`Audio session was not returned after append: ${validated.id}`);
    return existing;
  }

  async list(query: AudioSessionQuery = {}): Promise<AudioSession[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      parameters.push(value);
      clauses.push(clause.replace('?', `$${parameters.length}`));
    };
    if (query.source) add('source = ?', query.source);
    if (query.status) add('status = ?', query.status);
    if (query.from) add('started_at >= ?', query.from);
    if (query.to) add('started_at <= ?', query.to);
    const limit = query.limit ?? 100;
    parameters.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<AudioSessionRow>(
      `SELECT id, source, status, started_at, ended_at, pipeline_latency_ms, transcript, response_text,
        tts_target, tts_provider, error, conversation_id
       FROM (
         SELECT id, source, status, started_at, ended_at, pipeline_latency_ms, transcript, response_text,
           tts_target, tts_provider, error, conversation_id
         FROM audio_sessions ${where}
         ORDER BY started_at DESC
         LIMIT $${parameters.length}
       ) recent
       ORDER BY started_at ASC`,
      parameters,
    );
    return result.rows.map(rowToSession);
  }

  async findById(id: string): Promise<AudioSession | undefined> {
    const result = await this.pool.query<AudioSessionRow>(
      `SELECT id, source, status, started_at, ended_at, pipeline_latency_ms, transcript, response_text,
        tts_target, tts_provider, error, conversation_id
       FROM audio_sessions WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToSession(result.rows[0]) : undefined;
  }

  async deleteByIds(ids: readonly string[]): Promise<AudioSession[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query<AudioSessionRow>(
      `DELETE FROM audio_sessions
       WHERE id = ANY($1::text[])
       RETURNING id, source, status, started_at, ended_at, pipeline_latency_ms, transcript, response_text,
         tts_target, tts_provider, error, conversation_id`,
      [ids],
    );
    return result.rows.map(rowToSession);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}