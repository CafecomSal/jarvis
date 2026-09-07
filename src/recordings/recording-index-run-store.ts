import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';

export type RecordingIndexRunStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface RecordingIndexRun {
  id: string;
  segmentId: string;
  status: RecordingIndexRunStatus;
  attempts: number;
  framesProcessed: number;
  evidenceCount: number;
  objectCount: number;
  ocrCount: number;
  model: string;
  ocrModel: string;
  policyVersion: string;
  error?: string;
  nextAttemptAt?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface RecordingIndexRunInput {
  id: string;
  segmentId: string;
  model: string;
  ocrModel: string;
  policyVersion: string;
}

export interface RecordingIndexRunStore {
  initialize?(): Promise<void>;
  enqueue(input: RecordingIndexRunInput, options?: { force?: boolean }): Promise<RecordingIndexRun>;
  findById(id: string): Promise<RecordingIndexRun | undefined>;
  findLatestBySegment(segmentId: string): Promise<RecordingIndexRun | undefined>;
  listRecoverable(now?: Date, limit?: number): Promise<RecordingIndexRun[]>;
  markProcessing(id: string): Promise<RecordingIndexRun>;
  markCompleted(id: string, result: Pick<RecordingIndexRun, 'framesProcessed' | 'evidenceCount' | 'objectCount' | 'ocrCount'>): Promise<RecordingIndexRun>;
  markFailure(id: string, error: string, nextAttemptAt?: string): Promise<RecordingIndexRun>;
  close?(): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateInput(input: RecordingIndexRunInput): RecordingIndexRunInput {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Recording index run ${name} must not be empty`);
  }
  return input;
}

export class InMemoryRecordingIndexRunStore implements RecordingIndexRunStore {
  private readonly runs = new Map<string, RecordingIndexRun>();
  private readonly keys = new Map<string, string>();

  async enqueue(raw: RecordingIndexRunInput, options: { force?: boolean } = {}): Promise<RecordingIndexRun> {
    const input = validateInput(raw);
    const key = `${input.segmentId}\u0000${input.policyVersion}\u0000${input.model}\u0000${input.ocrModel}`;
    const existingId = this.keys.get(key);
    const existing = existingId ? this.runs.get(existingId) : undefined;
    if (existing && !options.force) return clone(existing);
    if (existing && options.force) {
      const reset: RecordingIndexRun = {
        ...existing,
        status: 'queued',
        attempts: 0,
        framesProcessed: 0,
        evidenceCount: 0,
        objectCount: 0,
        ocrCount: 0,
        error: undefined,
        nextAttemptAt: undefined,
        startedAt: undefined,
        completedAt: undefined,
        queuedAt: nowIso(),
        updatedAt: nowIso(),
      };
      this.runs.set(existing.id, reset);
      return clone(reset);
    }
    const timestamp = nowIso();
    const run: RecordingIndexRun = {
      ...input,
      status: 'queued',
      attempts: 0,
      framesProcessed: 0,
      evidenceCount: 0,
      objectCount: 0,
      ocrCount: 0,
      queuedAt: timestamp,
      updatedAt: timestamp,
    };
    this.runs.set(run.id, run);
    this.keys.set(key, run.id);
    return clone(run);
  }

  async findById(id: string): Promise<RecordingIndexRun | undefined> {
    const result = this.runs.get(id);
    return result ? clone(result) : undefined;
  }

  async findLatestBySegment(segmentId: string): Promise<RecordingIndexRun | undefined> {
    const result = [...this.runs.values()]
      .filter((run) => run.segmentId === segmentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return result ? clone(result) : undefined;
  }

  async listRecoverable(now = new Date(), limit = 100): Promise<RecordingIndexRun[]> {
    const nowMs = now.getTime();
    return [...this.runs.values()]
      .filter((run) => (run.status === 'queued' || run.status === 'processing')
        && run.attempts < 3
        && (!run.nextAttemptAt || Date.parse(run.nextAttemptAt) <= nowMs))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }

  async markProcessing(id: string): Promise<RecordingIndexRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Recording index run not found: ${id}`);
    const updated: RecordingIndexRun = {
      ...current,
      status: 'processing',
      attempts: current.attempts + 1,
      startedAt: nowIso(),
      nextAttemptAt: undefined,
      updatedAt: nowIso(),
    };
    this.runs.set(id, updated);
    return clone(updated);
  }

  async markCompleted(id: string, result: Pick<RecordingIndexRun, 'framesProcessed' | 'evidenceCount' | 'objectCount' | 'ocrCount'>): Promise<RecordingIndexRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Recording index run not found: ${id}`);
    const updated: RecordingIndexRun = {
      ...current,
      status: 'completed',
      framesProcessed: result.framesProcessed,
      evidenceCount: result.evidenceCount,
      objectCount: result.objectCount,
      ocrCount: result.ocrCount,
      error: undefined,
      nextAttemptAt: undefined,
      completedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.runs.set(id, updated);
    return clone(updated);
  }

  async markFailure(id: string, error: string, nextAttemptAt?: string): Promise<RecordingIndexRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Recording index run not found: ${id}`);
    const terminal = current.attempts >= 3 || nextAttemptAt === undefined;
    const updated: RecordingIndexRun = {
      ...current,
      status: terminal ? 'failed' : 'queued',
      error: error.slice(0, 500),
      ...(terminal ? { completedAt: undefined, nextAttemptAt: undefined } : { nextAttemptAt }),
      updatedAt: nowIso(),
    };
    this.runs.set(id, updated);
    return clone(updated);
  }
}

interface IndexRunRow extends QueryResultRow {
  id: string;
  segment_id: string;
  status: RecordingIndexRunStatus;
  attempts: number;
  frames_processed: number;
  evidence_count: number;
  object_count: number;
  ocr_count: number;
  model: string;
  ocr_model: string;
  policy_version: string;
  error: string | null;
  next_attempt_at: Date | string | null;
  queued_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  updated_at: Date | string;
}

const RUN_COLUMNS = `id, segment_id, status, attempts, frames_processed, evidence_count,
  object_count, ocr_count, model, ocr_model, policy_version, error, next_attempt_at,
  queued_at, started_at, completed_at, updated_at`;

function rowToRun(row: IndexRunRow): RecordingIndexRun {
  const isoOrUndefined = (value: Date | string | null): string | undefined => value === null ? undefined : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return {
    id: row.id,
    segmentId: row.segment_id,
    status: row.status,
    attempts: Number(row.attempts),
    framesProcessed: Number(row.frames_processed),
    evidenceCount: Number(row.evidence_count),
    objectCount: Number(row.object_count),
    ocrCount: Number(row.ocr_count),
    model: row.model,
    ocrModel: row.ocr_model,
    policyVersion: row.policy_version,
    ...(row.error ? { error: row.error } : {}),
    ...(isoOrUndefined(row.next_attempt_at) ? { nextAttemptAt: isoOrUndefined(row.next_attempt_at) } : {}),
    queuedAt: row.queued_at instanceof Date ? row.queued_at.toISOString() : new Date(row.queued_at).toISOString(),
    ...(isoOrUndefined(row.started_at) ? { startedAt: isoOrUndefined(row.started_at) } : {}),
    ...(isoOrUndefined(row.completed_at) ? { completedAt: isoOrUndefined(row.completed_at) } : {}),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  };
}

export interface PostgresRecordingIndexRunStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresRecordingIndexRunStore implements RecordingIndexRunStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresRecordingIndexRunStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    await this.pool.query(await readPostgresMigration(fileURLToPath(import.meta.url), '005_evidence_index.sql'));
  }

  async enqueue(input: RecordingIndexRunInput, options: { force?: boolean } = {}): Promise<RecordingIndexRun> {
    validateInput(input);
    if (options.force) {
      await this.pool.query(
        `UPDATE recording_index_runs SET status = 'queued', attempts = 0, frames_processed = 0,
         evidence_count = 0, object_count = 0, ocr_count = 0, error = NULL, next_attempt_at = NULL,
         started_at = NULL, completed_at = NULL, queued_at = NOW(), updated_at = NOW()
         WHERE segment_id = $1 AND policy_version = $2 AND model = $3 AND ocr_model = $4`,
        [input.segmentId, input.policyVersion, input.model, input.ocrModel],
      );
    }
    const result = await this.pool.query<IndexRunRow>(
      `INSERT INTO recording_index_runs (id, segment_id, status, model, ocr_model, policy_version)
       VALUES ($1, $2, 'queued', $3, $4, $5)
       ON CONFLICT (segment_id, policy_version, model, ocr_model) DO UPDATE SET updated_at = recording_index_runs.updated_at
       RETURNING ${RUN_COLUMNS}`,
      [input.id, input.segmentId, input.model, input.ocrModel, input.policyVersion],
    );
    if (result.rows[0]) return rowToRun(result.rows[0]);
    const existing = await this.pool.query<IndexRunRow>(
      `SELECT ${RUN_COLUMNS} FROM recording_index_runs
       WHERE segment_id = $1 AND policy_version = $2 AND model = $3 AND ocr_model = $4`,
      [input.segmentId, input.policyVersion, input.model, input.ocrModel],
    );
    if (!existing.rows[0]) throw new Error(`Recording index run was not returned: ${input.id}`);
    return rowToRun(existing.rows[0]);
  }

  async findById(id: string): Promise<RecordingIndexRun | undefined> {
    const result = await this.pool.query<IndexRunRow>(`SELECT ${RUN_COLUMNS} FROM recording_index_runs WHERE id = $1`, [id]);
    return result.rows[0] ? rowToRun(result.rows[0]) : undefined;
  }

  async findLatestBySegment(segmentId: string): Promise<RecordingIndexRun | undefined> {
    const result = await this.pool.query<IndexRunRow>(`SELECT ${RUN_COLUMNS} FROM recording_index_runs WHERE segment_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 1`, [segmentId]);
    return result.rows[0] ? rowToRun(result.rows[0]) : undefined;
  }

  async listRecoverable(now = new Date(), limit = 100): Promise<RecordingIndexRun[]> {
    const result = await this.pool.query<IndexRunRow>(
      `SELECT ${RUN_COLUMNS} FROM recording_index_runs
       WHERE status IN ('queued', 'processing') AND attempts < 3
         AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
       ORDER BY queued_at ASC, id ASC LIMIT $2`,
      [now.toISOString(), limit],
    );
    return result.rows.map(rowToRun);
  }

  async markProcessing(id: string): Promise<RecordingIndexRun> {
    const result = await this.pool.query<IndexRunRow>(
      `UPDATE recording_index_runs SET status = 'processing', attempts = attempts + 1,
       started_at = NOW(), next_attempt_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [id],
    );
    if (!result.rows[0]) throw new Error(`Recording index run not found: ${id}`);
    return rowToRun(result.rows[0]);
  }

  async markCompleted(id: string, resultData: Pick<RecordingIndexRun, 'framesProcessed' | 'evidenceCount' | 'objectCount' | 'ocrCount'>): Promise<RecordingIndexRun> {
    const result = await this.pool.query<IndexRunRow>(
      `UPDATE recording_index_runs SET status = 'completed', frames_processed = $2,
       evidence_count = $3, object_count = $4, ocr_count = $5, error = NULL,
       next_attempt_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [id, resultData.framesProcessed, resultData.evidenceCount, resultData.objectCount, resultData.ocrCount],
    );
    if (!result.rows[0]) throw new Error(`Recording index run not found: ${id}`);
    return rowToRun(result.rows[0]);
  }

  async markFailure(id: string, error: string, nextAttemptAt?: string): Promise<RecordingIndexRun> {
    const result = await this.pool.query<IndexRunRow>(
      `UPDATE recording_index_runs SET status = CASE WHEN attempts >= 3 OR $2::timestamptz IS NULL THEN 'failed' ELSE 'queued' END,
       error = LEFT($3, 500), next_attempt_at = CASE WHEN attempts >= 3 OR $2::timestamptz IS NULL THEN NULL ELSE $2 END,
       updated_at = NOW() WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [id, nextAttemptAt ?? null, error],
    );
    if (!result.rows[0]) throw new Error(`Recording index run not found: ${id}`);
    return rowToRun(result.rows[0]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
