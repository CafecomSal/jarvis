import type { EventStore } from '../events/in-memory-event-store.js';
import type { HomeEvent } from '../events/schema.js';
import type { EvidenceIndexStore, EvidenceObservation, MediaEvidence } from '../evidence/evidence-index-store.js';
import type { RecordingIndexRun, RecordingIndexRunStore } from '../recordings/recording-index-run-store.js';
import type { RecordingSegment, RecordingStore } from '../recordings/recording-store.js';
import { normalizeEvidenceText } from '../evidence/evidence-index-store.js';

export interface TimelineQuery {
  camera?: string;
  from?: string;
  to?: string;
  eventType?: string;
  objectClass?: string;
  ocrQuery?: string;
  evidenceOnly?: boolean;
  cursor?: string;
  limit?: number;
}

export interface TimelineEventItem {
  kind: 'event';
  id: string;
  timestamp: string;
  type: HomeEvent['type'];
  camera?: string;
  location?: string;
  confidence?: number;
  subjectId?: string;
  evidenceEventId?: string;
  text?: string;
  normalizedText?: string;
  historical?: boolean;
}

export interface TimelineEvidenceItem {
  kind: 'evidence';
  id: string;
  timestamp: string;
  type: 'camera.snapshot';
  camera: string;
  evidence: MediaEvidence;
  observations: EvidenceObservation[];
  recordingSegmentId?: string;
  imageUrl: string;
  clipUrl?: string;
}

export interface TimelineRecordingItem {
  kind: 'recording';
  id: string;
  timestamp: string;
  type: 'recording.segment';
  camera: string;
  recording: RecordingSegment;
  indexStatus?: RecordingIndexRun['status'] | 'not_indexed';
  evidenceCount?: number;
}

export type TimelineItem = TimelineEventItem | TimelineEvidenceItem | TimelineRecordingItem;

export interface TimelineResult {
  count: number;
  hasMore: boolean;
  nextCursor?: string;
  items: TimelineItem[];
}

function cameraForEvent(event: HomeEvent): string | undefined {
  const camera = event.data.camera;
  if (typeof camera === 'string' && camera.trim()) return camera;
  if (event.source.type === 'camera' || event.source.type === 'rtsp' || event.source.type === 'recording') {
    return event.source.id;
  }
  return undefined;
}

function eventEvidenceId(event: HomeEvent): string | undefined {
  const value = event.data.evidenceEventId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function eventObjectClass(event: HomeEvent): string | undefined {
  const dataValue = event.data.className;
  if (typeof dataValue === 'string' && dataValue.trim()) return dataValue;
  return event.subject?.type === 'object' ? event.subject.id : undefined;
}

function eventText(event: HomeEvent): string | undefined {
  const value = event.data.text;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function eventMatches(event: HomeEvent, query: TimelineQuery): boolean {
  if (query.camera && cameraForEvent(event) !== query.camera) return false;
  if (query.eventType && event.type !== query.eventType) return false;
  if (query.objectClass && eventObjectClass(event) !== query.objectClass) return false;
  if (query.ocrQuery) {
    const wanted = normalizeEvidenceText(query.ocrQuery);
    const normalized = typeof event.data.normalizedText === 'string'
      ? normalizeEvidenceText(event.data.normalizedText)
      : normalizeEvidenceText(eventText(event) ?? '');
    if (!wanted || !normalized.includes(wanted)) return false;
  }
  return true;
}

function eventItem(event: HomeEvent): TimelineEventItem {
  const camera = cameraForEvent(event);
  const evidenceEventId = eventEvidenceId(event);
  return {
    kind: 'event',
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    ...(camera ? { camera } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    ...(event.subject?.id ? { subjectId: event.subject.id } : {}),
    ...(evidenceEventId ? { evidenceEventId } : {}),
    ...(eventText(event) ? { text: eventText(event)?.slice(0, 500) } : {}),
    ...(typeof event.data.normalizedText === 'string' ? { normalizedText: event.data.normalizedText.slice(0, 500) } : {}),
    ...(typeof event.data.historical === 'boolean' ? { historical: event.data.historical } : {}),
  };
}

interface CursorKey {
  timestamp: string;
  kind: TimelineItem['kind'];
  id: string;
}

function sortKey(item: TimelineItem): CursorKey {
  return { timestamp: item.timestamp, kind: item.kind, id: item.id };
}

function compareKeys(left: CursorKey, right: CursorKey): number {
  return Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id);
}

function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(value: string): CursorKey {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorKey>;
    if (typeof parsed.timestamp !== 'string' || !Number.isFinite(Date.parse(parsed.timestamp))
      || (parsed.kind !== 'event' && parsed.kind !== 'evidence' && parsed.kind !== 'recording')
      || typeof parsed.id !== 'string' || !parsed.id) {
      throw new Error('invalid cursor');
    }
    return { timestamp: parsed.timestamp, kind: parsed.kind, id: parsed.id };
  } catch {
    throw new Error('Timeline cursor is invalid');
  }
}

export interface TimelineServiceOptions {
  evidenceIndex?: EvidenceIndexStore;
  indexRuns?: RecordingIndexRunStore;
}

export class TimelineService {
  private readonly evidenceIndex?: EvidenceIndexStore;
  private readonly indexRuns?: RecordingIndexRunStore;

  constructor(
    private readonly events: EventStore,
    private readonly recordings?: RecordingStore,
    options: TimelineServiceOptions = {},
  ) {
    this.evidenceIndex = options.evidenceIndex;
    this.indexRuns = options.indexRuns;
  }

  private async evidenceItems(query: TimelineQuery, events: HomeEvent[]): Promise<TimelineEvidenceItem[]> {
    const grouped = new Map<string, { evidence: MediaEvidence; observations: EvidenceObservation[] }>();
    if (this.evidenceIndex) {
      const indexed = await this.evidenceIndex.listEvidence({
        camera: query.camera,
        from: query.from,
        to: query.to,
        limit: 100_000,
      });
      for (const evidence of indexed) {
        grouped.set(evidence.id, { evidence, observations: await this.evidenceIndex.listObservations(evidence.id) });
      }
    }

    for (const event of events) {
      const evidence = event.type === 'camera.snapshot'
        ? (() => {
          const imageRef = typeof event.data.imageRef === 'string' ? event.data.imageRef : undefined;
          const camera = cameraForEvent(event);
          if (!imageRef || !camera) return undefined;
          return {
            id: event.id,
            eventId: event.id,
            camera,
            timestamp: event.timestamp,
            ...(typeof event.data.recordingSegmentId === 'string' ? { recordingSegmentId: event.data.recordingSegmentId } : {}),
            ...(typeof event.data.frameTimestampMs === 'number' ? { frameTimestampMs: event.data.frameTimestampMs } : {}),
            imageRef,
            mimeType: typeof event.data.mimeType === 'string' ? event.data.mimeType : 'image/jpeg',
            bytes: typeof event.data.bytes === 'number' ? event.data.bytes : 0,
            historical: event.data.historical === true,
          } satisfies MediaEvidence;
        })()
        : undefined;
      if (evidence && !grouped.has(evidence.id)) grouped.set(evidence.id, { evidence, observations: [] });
    }

    for (const event of events) {
      const evidenceId = eventEvidenceId(event);
      if (evidenceId) {
        const current = grouped.get(evidenceId);
        if (current && event.type !== 'camera.snapshot' && !current.observations.some((observation) => observation.eventId === event.id)) {
          current.observations.push({
            id: event.id,
            eventId: event.id,
            evidenceId,
            eventType: event.type,
            kind: event.type === 'ocr.observation' ? 'ocr' : event.type === 'object.observed' || event.type === 'person.detected' || event.type === 'person.left' ? 'object' : event.type === 'vision.observation' ? 'vlm' : 'event',
            ...(cameraForEvent(event) ? { camera: cameraForEvent(event) } : {}),
            timestamp: event.timestamp,
            ...(eventObjectClass(event) ? { objectClass: eventObjectClass(event) } : {}),
            ...(eventText(event) ? { text: eventText(event) } : {}),
            ...(typeof event.data.normalizedText === 'string' ? { normalizedText: event.data.normalizedText } : {}),
            ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
            ...(typeof event.data.recordingSegmentId === 'string' ? { recordingSegmentId: event.data.recordingSegmentId } : {}),
            ...(typeof event.data.frameTimestampMs === 'number' ? { frameTimestampMs: event.data.frameTimestampMs } : {}),
          });
        }
      }
    }

    return [...grouped.values()]
      .filter(({ evidence, observations }) => {
        if (query.camera && evidence.camera !== query.camera) return false;
        if (query.eventType && query.eventType !== 'camera.snapshot' && !observations.some((observation) => observation.eventType === query.eventType)) return false;
        if (query.objectClass && !observations.some((observation) => observation.objectClass === query.objectClass)) return false;
        if (query.ocrQuery) {
          const wanted = normalizeEvidenceText(query.ocrQuery);
          if (!observations.some((observation) => observation.kind === 'ocr' && normalizeEvidenceText(observation.normalizedText ?? observation.text ?? '').includes(wanted))) return false;
        }
        return true;
      })
      .map(({ evidence, observations }) => ({
        kind: 'evidence' as const,
        id: evidence.id,
        timestamp: evidence.timestamp,
        type: 'camera.snapshot' as const,
        camera: evidence.camera,
        evidence,
        observations: observations.sort((left, right) => compareKeys({ timestamp: left.timestamp, kind: 'event', id: left.id }, { timestamp: right.timestamp, kind: 'event', id: right.id })),
        ...(evidence.recordingSegmentId ? { recordingSegmentId: evidence.recordingSegmentId } : {}),
        imageUrl: `/evidence/${encodeURIComponent(evidence.id)}/image`,
        ...(evidence.recordingSegmentId ? { clipUrl: `/recordings/${encodeURIComponent(evidence.recordingSegmentId)}/clip` } : {}),
      }));
  }

  async query(query: TimelineQuery = {}): Promise<TimelineResult> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Timeline limit must be an integer between 1 and 200');
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const eventRows = await this.events.query({ from: query.from, to: query.to, limit: 100_000 });
    const evidenceItems = await this.evidenceItems(query, eventRows);
    const groupedEventIds = new Set(evidenceItems.flatMap((item) => [item.id, ...item.observations.map((observation) => observation.eventId)]));
    const eventItems: TimelineEventItem[] = query.evidenceOnly
      ? []
      : eventRows
        .filter((event) => !groupedEventIds.has(event.id))
        .filter((event) => eventMatches(event, query))
        .map(eventItem);

    const recordingRows = this.recordings
      ? await this.recordings.list({ camera: query.camera, from: query.from, to: query.to, overlap: true, limit: 100_000 })
      : [];
    const recordingItems: TimelineRecordingItem[] = [];
    for (const recording of recordingRows) {
      if (query.evidenceOnly) continue;
      const matchingEvidence = evidenceItems.filter((item) => item.recordingSegmentId === recording.id);
      if ((query.objectClass || query.ocrQuery || (query.eventType && query.eventType !== 'recording.segment')) && matchingEvidence.length === 0) continue;
      const run = this.indexRuns ? await this.indexRuns.findLatestBySegment(recording.id) : undefined;
      recordingItems.push({
        kind: 'recording',
        id: recording.id,
        timestamp: recording.startedAt,
        type: 'recording.segment',
        camera: recording.camera,
        recording,
        ...(run ? { indexStatus: run.status, evidenceCount: run.evidenceCount } : { indexStatus: 'not_indexed' }),
      });
    }

    let items = [...eventItems, ...evidenceItems, ...recordingItems]
      .sort((left, right) => compareKeys(sortKey(left), sortKey(right)));
    if (cursor) items = items.filter((item) => compareKeys(sortKey(item), cursor) > 0);
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    return {
      count: page.length,
      hasMore,
      ...(hasMore && page.at(-1) ? { nextCursor: encodeCursor(sortKey(page.at(-1)!)) } : {}),
      items: page,
    };
  }
}

export function decodeTimelineCursor(cursor: string): CursorKey {
  return decodeCursor(cursor);
}
