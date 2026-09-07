import type { EventAppender, EventStore } from '../events/in-memory-event-store.js';
import type { HomeEvent } from '../events/schema.js';
import type { RecordingSegment, RecordingStore } from '../recordings/recording-store.js';
import type {
  EvidenceIndexStore,
  EvidenceObservation,
  MediaEvidence,
} from './evidence-index-store.js';

const BACKFILL_KEY = 'recording-evidence-backfill';
const BACKFILL_VERSION = '2';
const RECONCILE_LIMIT = 10_000;

function stringValue(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(data: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof data[key] === 'boolean' ? data[key] as boolean : fallback;
}

function cameraForEvent(event: HomeEvent): string | undefined {
  return stringValue(event.data, 'camera')
    ?? (event.location && event.location.trim() ? event.location : undefined)
    ?? (event.source.type === 'camera' || event.source.type === 'rtsp' || event.source.type === 'recording' ? event.source.id : undefined);
}

function observationKind(event: HomeEvent): EvidenceObservation['kind'] {
  if (event.type === 'ocr.observation') return 'ocr';
  if (event.type === 'object.observed' || event.type === 'person.detected' || event.type === 'person.left') return 'object';
  if (event.type === 'vision.observation') return 'vlm';
  return 'event';
}

function mediaEvidenceFromEvent(event: HomeEvent): MediaEvidence | undefined {
  if (event.type !== 'camera.snapshot') return undefined;
  const imageRef = stringValue(event.data, 'imageRef');
  const camera = cameraForEvent(event);
  if (!imageRef || !camera) return undefined;
  const bytes = numberValue(event.data, 'bytes') ?? numberValue(event.data, 'size') ?? 0;
  return {
    id: event.id,
    eventId: event.id,
    camera,
    timestamp: event.timestamp,
    ...(stringValue(event.data, 'recordingSegmentId') ? { recordingSegmentId: stringValue(event.data, 'recordingSegmentId') } : {}),
    ...(numberValue(event.data, 'frameTimestampMs') !== undefined ? { frameTimestampMs: numberValue(event.data, 'frameTimestampMs') } : {}),
    imageRef,
    mimeType: stringValue(event.data, 'mimeType') ?? 'image/jpeg',
    bytes,
    historical: booleanValue(event.data, 'historical', false),
  };
}

function observationFromEvent(event: HomeEvent): EvidenceObservation | undefined {
  if (event.type === 'camera.snapshot') return undefined;
  const evidenceId = stringValue(event.data, 'evidenceEventId');
  if (!evidenceId) return undefined;
  const camera = cameraForEvent(event);
  const text = stringValue(event.data, 'text');
  const normalizedText = stringValue(event.data, 'normalizedText');
  const objectClass = stringValue(event.data, 'className') ?? (event.subject?.type === 'object' ? event.subject.id : undefined);
  return {
    id: event.id,
    eventId: event.id,
    evidenceId,
    eventType: event.type,
    kind: observationKind(event),
    ...(camera ? { camera } : {}),
    timestamp: event.timestamp,
    ...(objectClass ? { objectClass } : {}),
    ...(text ? { text: text.slice(0, 2_000) } : {}),
    ...(normalizedText ? { normalizedText } : {}),
    ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    ...(stringValue(event.data, 'model') ? { model: stringValue(event.data, 'model') } : {}),
    ...(stringValue(event.data, 'provider') ? { provider: stringValue(event.data, 'provider') } : {}),
    ...(stringValue(event.data, 'recordingSegmentId') ? { recordingSegmentId: stringValue(event.data, 'recordingSegmentId') } : {}),
    ...(numberValue(event.data, 'frameTimestampMs') !== undefined ? { frameTimestampMs: numberValue(event.data, 'frameTimestampMs') } : {}),
  };
}

export interface EvidenceProjectionBackfillResult {
  status: 'completed' | 'skipped' | 'failed';
  eventsProcessed: number;
  evidenceProjected: number;
  observationsProjected: number;
  segmentsSeen: number;
  marker: string;
  error?: string;
}

export interface EvidenceProjectionOptions {
  batchSize?: number;
  onError?: (error: unknown) => void;
}

export interface EvidenceProjectionSink {
  project(event: HomeEvent): Promise<void>;
}

export class EvidenceEventProjection {
  private readonly batchSize: number;
  private readonly onError?: (error: unknown) => void;

  constructor(
    private readonly index: EvidenceIndexStore,
    options: EvidenceProjectionOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 500;
    this.onError = options.onError;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) throw new Error('Evidence projection batchSize must be positive');
  }

  async project(event: HomeEvent): Promise<void> {
    const evidence = mediaEvidenceFromEvent(event);
    if (evidence) await this.index.upsertEvidence(evidence);
    const observation = observationFromEvent(event);
    if (observation) await this.index.upsertObservation(observation);
  }

  async projectSafely(event: HomeEvent): Promise<void> {
    try {
      await this.project(event);
    } catch (error) {
      try { this.onError?.(error); } catch { /* projection observability is best-effort */ }
    }
  }

  async backfill(events: EventStore, recordings: RecordingStore): Promise<EvidenceProjectionBackfillResult> {
    let existingMarker: Awaited<ReturnType<EvidenceIndexStore['getMarker']>>;
    try {
      existingMarker = await this.index.getMarker(BACKFILL_KEY);
    } catch (error) {
      try { this.onError?.(error); } catch { /* preserve degraded startup */ }
      return {
        status: 'failed',
        eventsProcessed: 0,
        evidenceProjected: 0,
        observationsProjected: 0,
        segmentsSeen: 0,
        marker: BACKFILL_KEY,
        error: error instanceof Error ? error.message.slice(0, 300) : 'evidence backfill failed',
      };
    }
    if (existingMarker?.version === BACKFILL_VERSION && existingMarker.completedAt) {
      // A completed marker prevents another full historical rebuild, while a
      // bounded tail reconciliation repairs rows that may have been missed by
      // a best-effort live projection (or by a process crash between the
      // canonical event append and the relational upsert).
      try {
        const recentEvents = await events.list(RECONCILE_LIMIT);
        for (const event of recentEvents) {
          const hasEvidence = event.type === 'camera.snapshot'
            ? Boolean(await this.index.findEvidenceById(event.id))
            : true;
          const hasObservation = event.type === 'camera.snapshot'
            ? true
            : Boolean(await this.index.findObservationByEventId?.(event.id));
          if (!hasEvidence || !hasObservation) await this.projectSafely(event);
        }
      } catch (error) {
        try { this.onError?.(error); } catch { /* preserve the skipped result */ }
      }
      return {
        status: 'skipped',
        eventsProcessed: Number(existingMarker.metadata.eventsProcessed ?? 0),
        evidenceProjected: Number(existingMarker.metadata.evidenceProjected ?? 0),
        observationsProjected: Number(existingMarker.metadata.observationsProjected ?? 0),
        segmentsSeen: Number(existingMarker.metadata.segmentsSeen ?? 0),
        marker: BACKFILL_KEY,
      };
    }

    let eventsProcessed = 0;
    let evidenceProjected = 0;
    let observationsProjected = 0;
    try {
      const allEvents = await events.query({ limit: 100_000 });
      for (let offset = 0; offset < allEvents.length; offset += this.batchSize) {
        const batch = allEvents.slice(offset, offset + this.batchSize);
        for (const event of batch) {
          const beforeEvidence = await this.index.findEvidenceById(event.id);
          const beforeObservation = event.type === 'camera.snapshot'
            ? undefined
            : await this.index.findObservationByEventId?.(event.id);
          await this.project(event);
          if (!beforeEvidence && event.type === 'camera.snapshot' && mediaEvidenceFromEvent(event)) evidenceProjected += 1;
          if (!beforeObservation && observationFromEvent(event)) observationsProjected += 1;
          eventsProcessed += 1;
        }
      }
      const segments = await recordings.list({ limit: 100_000 });
      const marker = await this.index.setMarker({
        key: BACKFILL_KEY,
        version: BACKFILL_VERSION,
        completedAt: new Date().toISOString(),
        metadata: { eventsProcessed, evidenceProjected, observationsProjected, segmentsSeen: segments.length },
      });
      return {
        status: 'completed',
        eventsProcessed,
        evidenceProjected,
        observationsProjected,
        segmentsSeen: segments.length,
        marker: marker.key,
      };
    } catch (error) {
      try { this.onError?.(error); } catch { /* preserve the failed result */ }
      return {
        status: 'failed',
        eventsProcessed,
        evidenceProjected,
        observationsProjected,
        segmentsSeen: 0,
        marker: BACKFILL_KEY,
        error: error instanceof Error ? error.message.slice(0, 300) : 'evidence backfill failed',
      };
    }
  }
}

export class ProjectingEventAppender implements EventAppender {
  constructor(
    private readonly delegate: EventAppender,
    private readonly projection: EvidenceProjectionSink,
    private readonly onProjectionError?: (error: unknown) => void,
  ) {}

  async append(event: HomeEvent): Promise<HomeEvent> {
    const saved = await this.delegate.append(event);
    try {
      await this.projection.project(saved);
    } catch (error) {
      try { this.onProjectionError?.(error); } catch { /* never make canonical append fail */ }
    }
    return saved;
  }
}

/**
 * EventStore decorator used by Core so every event producer gets the same
 * best-effort evidence projection. Query methods remain delegated to the
 * canonical event store; the relational index is only a read-optimized view.
 */
export class ProjectingEventStore implements EventStore {
  private readonly appender: ProjectingEventAppender;

  constructor(
    private readonly delegate: EventStore,
    projection: EvidenceProjectionSink,
    onProjectionError?: (error: unknown) => void,
  ) {
    this.appender = new ProjectingEventAppender(delegate, projection, onProjectionError);
  }

  append(event: HomeEvent): Promise<HomeEvent> {
    return this.appender.append(event);
  }

  findById(id: string): Promise<HomeEvent | undefined> {
    return this.delegate.findById?.(id) ?? Promise.resolve(undefined);
  }

  list(limit?: number): Promise<HomeEvent[]> {
    return this.delegate.list(limit);
  }

  search(query: string, limit?: number): Promise<HomeEvent[]> {
    return this.delegate.search(query, limit);
  }

  query(filter?: Parameters<EventStore['query']>[0]): Promise<HomeEvent[]> {
    return this.delegate.query(filter);
  }
}

export function evidenceFromEvent(event: HomeEvent): MediaEvidence | undefined {
  return mediaEvidenceFromEvent(event);
}

export function observationFromHomeEvent(event: HomeEvent): EvidenceObservation | undefined {
  return observationFromEvent(event);
}
