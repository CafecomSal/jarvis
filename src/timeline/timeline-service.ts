import type { EventStore } from '../events/in-memory-event-store.js';
import type { HomeEvent } from '../events/schema.js';
import type { RecordingSegment, RecordingStore } from '../recordings/recording-store.js';

export interface TimelineQuery {
  camera?: string;
  from?: string;
  to?: string;
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
}

export interface TimelineRecordingItem {
  kind: 'recording';
  id: string;
  timestamp: string;
  type: 'recording.segment';
  camera: string;
  recording: RecordingSegment;
}

export type TimelineItem = TimelineEventItem | TimelineRecordingItem;

export interface TimelineResult {
  count: number;
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

export class TimelineService {
  constructor(
    private readonly events: EventStore,
    private readonly recordings?: RecordingStore,
  ) {}

  async query(query: TimelineQuery = {}): Promise<TimelineResult> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Timeline limit must be an integer between 1 and 200');
    }
    const eventRows = await this.events.query({
      from: query.from,
      to: query.to,
      limit: 10_000,
    });
    const eventItems: TimelineEventItem[] = eventRows
      .filter((event) => query.camera === undefined || cameraForEvent(event) === query.camera)
      .map((event) => ({
        kind: 'event',
        id: event.id,
        timestamp: event.timestamp,
        type: event.type,
        ...(cameraForEvent(event) ? { camera: cameraForEvent(event) } : {}),
        ...(event.location ? { location: event.location } : {}),
        ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
        ...(event.subject?.id ? { subjectId: event.subject.id } : {}),
        ...(eventEvidenceId(event) ? { evidenceEventId: eventEvidenceId(event) } : {}),
        ...(typeof event.data.text === 'string' ? { text: event.data.text.slice(0, 500) } : {}),
        ...(typeof event.data.normalizedText === 'string' ? { normalizedText: event.data.normalizedText.slice(0, 500) } : {}),
      }));

    const recordingRows = this.recordings
      ? await this.recordings.list({ camera: query.camera, from: query.from, to: query.to, limit: 10_000 })
      : [];
    const recordingItems: TimelineRecordingItem[] = recordingRows.map((recording) => ({
      kind: 'recording',
      id: recording.id,
      timestamp: recording.startedAt,
      type: 'recording.segment',
      camera: recording.camera,
      recording,
    }));

    const items = [...eventItems, ...recordingItems]
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-limit);
    return { count: items.length, items };
  }
}
