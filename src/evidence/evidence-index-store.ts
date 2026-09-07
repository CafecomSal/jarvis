import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';

export type EvidenceObservationKind = 'object' | 'ocr' | 'vlm' | 'event';

export interface MediaEvidence {
  id: string;
  eventId: string;
  camera: string;
  timestamp: string;
  recordingSegmentId?: string;
  frameTimestampMs?: number;
  imageRef: string;
  mimeType: string;
  bytes: number;
  historical: boolean;
  createdAt?: string;
}

export interface EvidenceObservation {
  id: string;
  eventId: string;
  evidenceId: string;
  eventType: string;
  kind: EvidenceObservationKind;
  camera?: string;
  timestamp: string;
  objectClass?: string;
  text?: string;
  normalizedText?: string;
  confidence?: number;
  model?: string;
  provider?: string;
  recordingSegmentId?: string;
  frameTimestampMs?: number;
  createdAt?: string;
}

export interface EvidenceIndexQuery {
  camera?: string;
  from?: string;
  to?: string;
  recordingSegmentId?: string;
  eventType?: string;
  objectClass?: string;
  ocrQuery?: string;
  minConfidence?: number;
  limit?: number;
}

export interface EvidenceIndexMarker {
  key: string;
  version: string;
  completedAt?: string;
  cursor?: string;
  metadata: Record<string, unknown>;
  updatedAt?: string;
}

export interface EvidenceIndexStore {
  initialize?(): Promise<void>;
  upsertEvidence(evidence: MediaEvidence): Promise<MediaEvidence>;
  upsertObservation(observation: EvidenceObservation): Promise<EvidenceObservation>;
  findEvidenceById(id: string): Promise<MediaEvidence | undefined>;
  findObservationByEventId?(eventId: string): Promise<EvidenceObservation | undefined>;
  listEvidence(query?: EvidenceIndexQuery): Promise<MediaEvidence[]>;
  listObservations(evidenceId: string): Promise<EvidenceObservation[]>;
  listObservationsByRecording(recordingSegmentId: string): Promise<EvidenceObservation[]>;
  countEvidenceByRecording(recordingSegmentId: string): Promise<number>;
  getMarker(key: string): Promise<EvidenceIndexMarker | undefined>;
  setMarker(marker: EvidenceIndexMarker): Promise<EvidenceIndexMarker>;
  close?(): Promise<void>;
}

export function normalizeEvidenceText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateEvidence(value: MediaEvidence): MediaEvidence {
  if (!value.id.trim() || !value.eventId.trim()) throw new Error('Evidence ids must not be empty');
  if (!value.camera.trim()) throw new Error('Evidence camera must not be empty');
  if (!value.imageRef.trim()) throw new Error('Evidence imageRef must not be empty');
  if (!Number.isFinite(Date.parse(value.timestamp))) throw new Error('Evidence timestamp must be a valid ISO timestamp');
  if (!['image/jpeg', 'image/png'].includes(value.mimeType.toLowerCase())) throw new Error('Evidence mimeType must be image/jpeg or image/png');
  if (/^data:/i.test(value.imageRef)) throw new Error('Evidence imageRef must be a local reference');
  if (!Number.isInteger(value.bytes) || value.bytes < 0) throw new Error('Evidence bytes must be a non-negative integer');
  if (value.frameTimestampMs !== undefined && (!Number.isInteger(value.frameTimestampMs) || value.frameTimestampMs < 0)) {
    throw new Error('Evidence frameTimestampMs must be a non-negative integer');
  }
  return {
    ...value,
    createdAt: value.createdAt ?? new Date().toISOString(),
  };
}

function validateObservation(value: EvidenceObservation): EvidenceObservation {
  if (!value.id.trim() || !value.eventId.trim() || !value.evidenceId.trim()) {
    throw new Error('Evidence observation ids must not be empty');
  }
  if (!value.eventType.trim()) throw new Error('Evidence observation eventType must not be empty');
  if (!Number.isFinite(Date.parse(value.timestamp))) throw new Error('Evidence observation timestamp must be a valid ISO timestamp');
  if (value.confidence !== undefined && (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) {
    throw new Error('Evidence observation confidence must be between zero and one');
  }
  return {
    ...value,
    ...(value.normalizedText ? { normalizedText: normalizeEvidenceText(value.normalizedText) } : {}),
    createdAt: value.createdAt ?? new Date().toISOString(),
  };
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function matchesEvidence(evidence: MediaEvidence, query: EvidenceIndexQuery): boolean {
  const occurredAt = timestampMs(evidence.timestamp);
  const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
  const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
  return (!query.camera || evidence.camera === query.camera)
    && (!query.recordingSegmentId || evidence.recordingSegmentId === query.recordingSegmentId)
    && occurredAt >= from
    && occurredAt <= to;
}

export class InMemoryEvidenceIndexStore implements EvidenceIndexStore {
  private readonly evidence = new Map<string, MediaEvidence>();
  private readonly observations = new Map<string, EvidenceObservation>();
  private readonly markers = new Map<string, EvidenceIndexMarker>();

  async upsertEvidence(value: MediaEvidence): Promise<MediaEvidence> {
    const validated = validateEvidence(value);
    const existing = this.evidence.get(validated.id) ?? this.evidence.get(validated.eventId);
    if (existing) return clone(existing);
    this.evidence.set(validated.id, clone(validated));
    if (validated.eventId !== validated.id) this.evidence.set(validated.eventId, clone(validated));
    return clone(validated);
  }

  async upsertObservation(value: EvidenceObservation): Promise<EvidenceObservation> {
    const validated = validateObservation(value);
    const existing = this.observations.get(validated.id) ?? this.observations.get(validated.eventId);
    if (existing) return clone(existing);
    this.observations.set(validated.id, clone(validated));
    if (validated.eventId !== validated.id) this.observations.set(validated.eventId, clone(validated));
    return clone(validated);
  }

  async findEvidenceById(id: string): Promise<MediaEvidence | undefined> {
    const result = this.evidence.get(id);
    return result ? clone(result) : undefined;
  }

  async findObservationByEventId(eventId: string): Promise<EvidenceObservation | undefined> {
    const result = this.observations.get(eventId);
    return result ? clone(result) : undefined;
  }

  async listEvidence(query: EvidenceIndexQuery = {}): Promise<MediaEvidence[]> {
    const seen = new Set<string>();
    const rows = [...this.evidence.values()]
      .filter((value) => {
        if (seen.has(value.id)) return false;
        seen.add(value.id);
        return matchesEvidence(value, query);
      })
      .sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp) || left.id.localeCompare(right.id));
    const filtered = (query.objectClass || query.ocrQuery || query.eventType || query.minConfidence !== undefined)
      ? rows.filter((evidence) => {
        const observations = [...this.observations.values()].filter((observation) => observation.evidenceId === evidence.id);
        const wanted = query.ocrQuery ? normalizeEvidenceText(query.ocrQuery) : undefined;
        return (!query.objectClass || observations.some((observation) => observation.objectClass === query.objectClass))
          && (!query.eventType || query.eventType === 'camera.snapshot' || observations.some((observation) => observation.eventType === query.eventType))
          && (!wanted || observations.some((observation) => observation.kind === 'ocr' && normalizeEvidenceText(observation.normalizedText ?? observation.text ?? '').includes(wanted)))
          && (query.minConfidence === undefined || observations.some((observation) => (observation.confidence ?? 0) >= query.minConfidence!));
      })
      : rows;
    return filtered.slice(0, query.limit ?? 10_000).map(clone);
  }

  async listObservations(evidenceId: string): Promise<EvidenceObservation[]> {
    return [...this.observations.values()]
      .filter((value, index, all) => value.evidenceId === evidenceId && all.findIndex((item) => item.id === value.id) === index)
      .sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp) || left.id.localeCompare(right.id))
      .map(clone);
  }

  async listObservationsByRecording(recordingSegmentId: string): Promise<EvidenceObservation[]> {
    return [...this.observations.values()]
      .filter((value, index, all) => value.recordingSegmentId === recordingSegmentId && all.findIndex((item) => item.id === value.id) === index)
      .sort((left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp) || left.id.localeCompare(right.id))
      .map(clone);
  }

  async countEvidenceByRecording(recordingSegmentId: string): Promise<number> {
    return (await this.listEvidence({ recordingSegmentId })).length;
  }

  async getMarker(key: string): Promise<EvidenceIndexMarker | undefined> {
    const marker = this.markers.get(key);
    return marker ? clone(marker) : undefined;
  }

  async setMarker(value: EvidenceIndexMarker): Promise<EvidenceIndexMarker> {
    const marker = { ...value, updatedAt: value.updatedAt ?? new Date().toISOString() };
    this.markers.set(marker.key, clone(marker));
    return clone(marker);
  }
}

interface MediaEvidenceRow extends QueryResultRow {
  id: string;
  event_id: string;
  camera: string;
  occurred_at: Date | string;
  recording_segment_id: string | null;
  frame_timestamp_ms: number | string | null;
  image_ref: string;
  mime_type: string;
  bytes: number | string;
  historical: boolean;
  created_at: Date | string;
}

interface EvidenceObservationRow extends QueryResultRow {
  id: string;
  event_id: string;
  evidence_id: string;
  event_type: string;
  camera: string | null;
  occurred_at: Date | string;
  object_class: string | null;
  text: string | null;
  normalized_text: string | null;
  confidence: number | null;
  model: string | null;
  provider: string | null;
  recording_segment_id: string | null;
  frame_timestamp_ms: number | string | null;
  created_at: Date | string;
}

interface MarkerRow extends QueryResultRow {
  key: string;
  version: string;
  completed_at: Date | string | null;
  cursor: string | null;
  metadata: Record<string, unknown> | string | null;
  updated_at: Date | string;
}

const MEDIA_COLUMNS = `id, event_id, camera, occurred_at, recording_segment_id,
  frame_timestamp_ms, image_ref, mime_type, bytes, historical, created_at`;
const OBSERVATION_COLUMNS = `id, event_id, evidence_id, event_type, camera, occurred_at,
  object_class, text, normalized_text, confidence, model, provider,
  recording_segment_id, frame_timestamp_ms, created_at`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToEvidence(row: MediaEvidenceRow): MediaEvidence {
  return {
    id: row.id,
    eventId: row.event_id,
    camera: row.camera,
    timestamp: iso(row.occurred_at),
    ...(row.recording_segment_id ? { recordingSegmentId: row.recording_segment_id } : {}),
    ...(row.frame_timestamp_ms === null ? {} : { frameTimestampMs: Number(row.frame_timestamp_ms) }),
    imageRef: row.image_ref,
    mimeType: row.mime_type,
    bytes: Number(row.bytes),
    historical: row.historical,
    createdAt: iso(row.created_at),
  };
}

function rowToObservation(row: EvidenceObservationRow): EvidenceObservation {
  const kind: EvidenceObservationKind = row.event_type === 'ocr.observation'
    ? 'ocr'
    : row.event_type === 'object.observed' || row.event_type === 'person.detected' || row.event_type === 'person.left'
      ? 'object'
      : row.event_type === 'vision.observation' ? 'vlm' : 'event';
  return {
    id: row.id,
    eventId: row.event_id,
    evidenceId: row.evidence_id,
    eventType: row.event_type,
    kind,
    ...(row.camera ? { camera: row.camera } : {}),
    timestamp: iso(row.occurred_at),
    ...(row.object_class ? { objectClass: row.object_class } : {}),
    ...(row.text ? { text: row.text } : {}),
    ...(row.normalized_text ? { normalizedText: row.normalized_text } : {}),
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    ...(row.model ? { model: row.model } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.recording_segment_id ? { recordingSegmentId: row.recording_segment_id } : {}),
    ...(row.frame_timestamp_ms === null ? {} : { frameTimestampMs: Number(row.frame_timestamp_ms) }),
    createdAt: iso(row.created_at),
  };
}

function rowToMarker(row: MarkerRow): EvidenceIndexMarker {
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : row.metadata ?? {};
  return {
    key: row.key,
    version: row.version,
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.cursor ? { cursor: row.cursor } : {}),
    metadata,
    updatedAt: iso(row.updated_at),
  };
}

export interface PostgresEvidenceIndexStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresEvidenceIndexStore implements EvidenceIndexStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresEvidenceIndexStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    await this.pool.query(await readPostgresMigration(fileURLToPath(import.meta.url), '005_evidence_index.sql'));
  }

  async upsertEvidence(value: MediaEvidence): Promise<MediaEvidence> {
    const evidence = validateEvidence(value);
    const result = await this.pool.query<MediaEvidenceRow>(
      `INSERT INTO media_evidence (id, event_id, camera, occurred_at, recording_segment_id,
        frame_timestamp_ms, image_ref, mime_type, bytes, historical)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING
       RETURNING ${MEDIA_COLUMNS}`,
      [evidence.id, evidence.eventId, evidence.camera, evidence.timestamp, evidence.recordingSegmentId ?? null,
        evidence.frameTimestampMs ?? null, evidence.imageRef, evidence.mimeType, evidence.bytes, evidence.historical],
    );
    if (result.rows[0]) return rowToEvidence(result.rows[0]);
    const existing = await this.pool.query<MediaEvidenceRow>(`SELECT ${MEDIA_COLUMNS} FROM media_evidence WHERE id = $1 OR event_id = $2`, [evidence.id, evidence.eventId]);
    if (!existing.rows[0]) throw new Error(`Evidence was not returned after upsert: ${evidence.id}`);
    return rowToEvidence(existing.rows[0]);
  }

  async upsertObservation(value: EvidenceObservation): Promise<EvidenceObservation> {
    const observation = validateObservation(value);
    const result = await this.pool.query<EvidenceObservationRow>(
      `INSERT INTO evidence_observations (id, event_id, evidence_id, event_type, camera, occurred_at,
        object_class, text, normalized_text, confidence, model, provider, recording_segment_id,
        frame_timestamp_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING
       RETURNING ${OBSERVATION_COLUMNS}`,
      [observation.id, observation.eventId, observation.evidenceId, observation.eventType, observation.camera ?? null,
        observation.timestamp, observation.objectClass ?? null, observation.text ?? null, observation.normalizedText ?? null,
        observation.confidence ?? null, observation.model ?? null, observation.provider ?? null,
        observation.recordingSegmentId ?? null, observation.frameTimestampMs ?? null],
    );
    if (result.rows[0]) return rowToObservation(result.rows[0]);
    const existing = await this.pool.query<EvidenceObservationRow>(`SELECT ${OBSERVATION_COLUMNS} FROM evidence_observations WHERE id = $1 OR event_id = $2`, [observation.id, observation.eventId]);
    if (!existing.rows[0]) throw new Error(`Evidence observation was not returned after upsert: ${observation.id}`);
    return rowToObservation(existing.rows[0]);
  }

  async findEvidenceById(id: string): Promise<MediaEvidence | undefined> {
    const result = await this.pool.query<MediaEvidenceRow>(`SELECT ${MEDIA_COLUMNS} FROM media_evidence WHERE id = $1 OR event_id = $1`, [id]);
    return result.rows[0] ? rowToEvidence(result.rows[0]) : undefined;
  }

  async findObservationByEventId(eventId: string): Promise<EvidenceObservation | undefined> {
    const result = await this.pool.query<EvidenceObservationRow>(
      `SELECT ${OBSERVATION_COLUMNS} FROM evidence_observations WHERE event_id = $1`,
      [eventId],
    );
    return result.rows[0] ? rowToObservation(result.rows[0]) : undefined;
  }

  async listEvidence(query: EvidenceIndexQuery = {}): Promise<MediaEvidence[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      parameters.push(value);
      clauses.push(clause.replace('?', `$${parameters.length}`));
    };
    if (query.camera) add('camera = ?', query.camera);
    if (query.from) add('occurred_at >= ?', query.from);
    if (query.to) add('occurred_at <= ?', query.to);
    if (query.recordingSegmentId) add('recording_segment_id = ?', query.recordingSegmentId);
    if (query.objectClass) add('EXISTS (SELECT 1 FROM evidence_observations eo WHERE eo.evidence_id = media_evidence.id AND eo.object_class = ?)', query.objectClass);
    if (query.eventType && query.eventType !== 'camera.snapshot') add('EXISTS (SELECT 1 FROM evidence_observations eo WHERE eo.evidence_id = media_evidence.id AND eo.event_type = ?)', query.eventType);
    if (query.ocrQuery) add('EXISTS (SELECT 1 FROM evidence_observations eo WHERE eo.evidence_id = media_evidence.id AND eo.normalized_text ILIKE ?)', `%${normalizeEvidenceText(query.ocrQuery)}%`);
    if (query.minConfidence !== undefined) add('EXISTS (SELECT 1 FROM evidence_observations eo WHERE eo.evidence_id = media_evidence.id AND eo.confidence >= ?)', query.minConfidence);
    const limit = query.limit ?? 10_000;
    parameters.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<MediaEvidenceRow>(
      `SELECT ${MEDIA_COLUMNS} FROM media_evidence ${where} ORDER BY occurred_at ASC, id ASC LIMIT $${parameters.length}`,
      parameters,
    );
    return result.rows.map(rowToEvidence);
  }

  async listObservations(evidenceId: string): Promise<EvidenceObservation[]> {
    const result = await this.pool.query<EvidenceObservationRow>(
      `SELECT ${OBSERVATION_COLUMNS} FROM evidence_observations WHERE evidence_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [evidenceId],
    );
    return result.rows.map(rowToObservation);
  }

  async listObservationsByRecording(recordingSegmentId: string): Promise<EvidenceObservation[]> {
    const result = await this.pool.query<EvidenceObservationRow>(
      `SELECT ${OBSERVATION_COLUMNS} FROM evidence_observations WHERE recording_segment_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [recordingSegmentId],
    );
    return result.rows.map(rowToObservation);
  }

  async countEvidenceByRecording(recordingSegmentId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM media_evidence WHERE recording_segment_id = $1',
      [recordingSegmentId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getMarker(key: string): Promise<EvidenceIndexMarker | undefined> {
    const result = await this.pool.query<MarkerRow>(`SELECT key, version, completed_at, cursor, metadata, updated_at FROM evidence_index_markers WHERE key = $1`, [key]);
    return result.rows[0] ? rowToMarker(result.rows[0]) : undefined;
  }

  async setMarker(value: EvidenceIndexMarker): Promise<EvidenceIndexMarker> {
    const marker = { ...value, updatedAt: value.updatedAt ?? new Date().toISOString() };
    const result = await this.pool.query<MarkerRow>(
      `INSERT INTO evidence_index_markers (key, version, completed_at, cursor, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (key) DO UPDATE SET version = EXCLUDED.version, completed_at = EXCLUDED.completed_at,
         cursor = EXCLUDED.cursor, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at
       RETURNING key, version, completed_at, cursor, metadata, updated_at`,
      [marker.key, marker.version, marker.completedAt ?? null, marker.cursor ?? null, JSON.stringify(marker.metadata), marker.updatedAt],
    );
    return rowToMarker(result.rows[0]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
