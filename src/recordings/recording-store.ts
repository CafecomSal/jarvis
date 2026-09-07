import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';
import { RecordingSegmentMetadataSchema, type RecordingSegmentMetadata } from '../events/ai-observation-schema.js';

export type RecordingSegment = RecordingSegmentMetadata & { id: string };
export type RecordingBackupStatus = RecordingSegmentMetadata['backupStatus'];

export interface RecordingBackupUpdate {
  backupStatus: RecordingBackupStatus;
  driveFileId?: string;
  driveWebViewLink?: string;
  backupVerifiedAt?: string;
}

export interface RecordingQuery {
  camera?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface RecordingStore {
  append(segment: RecordingSegment): Promise<RecordingSegment>;
  list(query?: RecordingQuery): Promise<RecordingSegment[]>;
  findById(id: string): Promise<RecordingSegment | undefined>;
  updateBackup(id: string, update: RecordingBackupUpdate): Promise<RecordingSegment>;
}

function clone(segment: RecordingSegment): RecordingSegment {
  return structuredClone(segment);
}

function validateSegment(segment: RecordingSegment): RecordingSegment {
  if (!segment.id.trim()) throw new Error('Recording segment id must not be empty');
  return {
    id: segment.id,
    ...RecordingSegmentMetadataSchema.parse(segment),
  };
}

export class InMemoryRecordingStore implements RecordingStore {
  private readonly segments: RecordingSegment[] = [];

  async append(segment: RecordingSegment): Promise<RecordingSegment> {
    const validated = validateSegment(segment);
    const existing = this.segments.find((item) => item.id === validated.id);
    if (existing) return clone(existing);
    this.segments.push(clone(validated));
    return clone(validated);
  }

  async list(query: RecordingQuery = {}): Promise<RecordingSegment[]> {
    const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
    const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
    const limit = query.limit ?? 100;
    return this.segments
      .filter((segment) => (!query.camera || segment.camera === query.camera))
      .filter((segment) => Date.parse(segment.startedAt) >= from && Date.parse(segment.startedAt) <= to)
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
      .slice(-limit)
      .map(clone);
  }

  async findById(id: string): Promise<RecordingSegment | undefined> {
    const segment = this.segments.find((item) => item.id === id);
    return segment ? clone(segment) : undefined;
  }

  async updateBackup(id: string, update: RecordingBackupUpdate): Promise<RecordingSegment> {
    const index = this.segments.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`Recording segment not found: ${id}`);
    const current = this.segments[index];
    const updated = validateSegment({
      ...current,
      backupStatus: update.backupStatus,
      ...(update.driveFileId === undefined ? {} : { driveFileId: update.driveFileId }),
      ...(update.driveWebViewLink === undefined ? {} : { driveWebViewLink: update.driveWebViewLink }),
      ...(update.backupVerifiedAt === undefined ? {} : { backupVerifiedAt: update.backupVerifiedAt }),
    });
    this.segments[index] = updated;
    return clone(updated);
  }
}

interface RecordingRow extends QueryResultRow {
  id: string;
  camera: string;
  started_at: Date | string;
  ended_at: Date | string;
  duration_ms: number | string;
  file_ref: string;
  bytes: number | string;
  mime_type: string;
  video_codec: string;
  audio_codec: string | null;
  width: number;
  height: number;
  checksum: string | null;
  backup_status: string;
  drive_file_id: string | null;
  drive_web_view_link: string | null;
  backup_verified_at: Date | string | null;
  retention_tier: string | null;
  protected: boolean | null;
}

const RECORDING_COLUMNS = `
  id, camera, started_at, ended_at, duration_ms, file_ref, bytes,
  mime_type, video_codec, audio_codec, width, height, checksum, backup_status,
  drive_file_id, drive_web_view_link, backup_verified_at, retention_tier, protected
`;

function rowToSegment(row: RecordingRow): RecordingSegment {
  return validateSegment({
    id: row.id,
    camera: row.camera,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : new Date(row.started_at).toISOString(),
    endedAt: row.ended_at instanceof Date ? row.ended_at.toISOString() : new Date(row.ended_at).toISOString(),
    durationMs: Number(row.duration_ms),
    fileRef: row.file_ref,
    bytes: Number(row.bytes),
    mimeType: row.mime_type,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec ?? undefined,
    width: row.width,
    height: row.height,
    checksum: row.checksum ?? undefined,
    backupStatus: row.backup_status as RecordingSegmentMetadata['backupStatus'],
    ...(row.retention_tier ? { retentionTier: row.retention_tier as RecordingSegmentMetadata['retentionTier'] } : {}),
    ...(row.protected === null ? {} : { protected: row.protected }),
    driveFileId: row.drive_file_id ?? undefined,
    driveWebViewLink: row.drive_web_view_link ?? undefined,
    backupVerifiedAt: row.backup_verified_at instanceof Date
      ? row.backup_verified_at.toISOString()
      : row.backup_verified_at
        ? new Date(row.backup_verified_at).toISOString()
        : undefined,
  });
}

export interface PostgresRecordingStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresRecordingStore implements RecordingStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresRecordingStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
    });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    await this.pool.query(await readPostgresMigration(currentFile, '002_recordings.sql'));
  }

  async append(segment: RecordingSegment): Promise<RecordingSegment> {
    const validated = validateSegment(segment);
    const result = await this.pool.query<RecordingRow>(
      `INSERT INTO recording_segments (
        id, camera, started_at, ended_at, duration_ms, file_ref, bytes,
        mime_type, video_codec, audio_codec, width, height, checksum, backup_status,
        drive_file_id, drive_web_view_link, backup_verified_at, retention_tier, protected
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO NOTHING
      RETURNING ${RECORDING_COLUMNS}`,
      [
        validated.id,
        validated.camera,
        validated.startedAt,
        validated.endedAt,
        validated.durationMs,
        validated.fileRef,
        validated.bytes,
        validated.mimeType,
        validated.videoCodec,
        validated.audioCodec ?? null,
        validated.width,
        validated.height,
        validated.checksum ?? null,
        validated.backupStatus,
        validated.driveFileId ?? null,
        validated.driveWebViewLink ?? null,
        validated.backupVerifiedAt ?? null,
        validated.retentionTier ?? 'continuous',
        validated.protected ?? false,
      ],
    );
    if (result.rows[0]) return rowToSegment(result.rows[0]);
    const existing = await this.pool.query<RecordingRow>(
      `SELECT ${RECORDING_COLUMNS} FROM recording_segments WHERE id = $1`,
      [validated.id],
    );
    if (!existing.rows[0]) throw new Error(`Recording segment was not returned after append: ${validated.id}`);
    return rowToSegment(existing.rows[0]);
  }

  async list(query: RecordingQuery = {}): Promise<RecordingSegment[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      parameters.push(value);
      clauses.push(clause.replace('?', `$${parameters.length}`));
    };
    if (query.camera) add('camera = ?', query.camera);
    if (query.from) add('started_at >= ?', query.from);
    if (query.to) add('started_at <= ?', query.to);
    const limit = query.limit ?? 100;
    parameters.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<RecordingRow>(
      `SELECT ${RECORDING_COLUMNS}
       FROM (
         SELECT ${RECORDING_COLUMNS}, created_at
         FROM recording_segments
         ${where}
         ORDER BY started_at DESC, created_at DESC
         LIMIT $${parameters.length}
       ) recent
       ORDER BY started_at ASC, created_at ASC`,
      parameters,
    );
    return result.rows.map(rowToSegment);
  }

  async findById(id: string): Promise<RecordingSegment | undefined> {
    const result = await this.pool.query<RecordingRow>(
      `SELECT ${RECORDING_COLUMNS} FROM recording_segments WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? rowToSegment(result.rows[0]) : undefined;
  }

  async updateBackup(id: string, update: RecordingBackupUpdate): Promise<RecordingSegment> {
    const result = await this.pool.query<RecordingRow>(
      `UPDATE recording_segments
       SET backup_status = $2,
           drive_file_id = COALESCE($3, drive_file_id),
           drive_web_view_link = COALESCE($4, drive_web_view_link),
           backup_verified_at = COALESCE($5, backup_verified_at)
       WHERE id = $1
       RETURNING ${RECORDING_COLUMNS}`,
      [
        id,
        update.backupStatus,
        update.driveFileId ?? null,
        update.driveWebViewLink ?? null,
        update.backupVerifiedAt ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error(`Recording segment not found: ${id}`);
    return rowToSegment(result.rows[0]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
