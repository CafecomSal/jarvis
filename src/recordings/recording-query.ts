import type { EventStore } from '../events/in-memory-event-store.js';
import type { HomeEvent } from '../events/schema.js';
import { normalizeEvidenceText, type EvidenceIndexStore, type EvidenceObservation } from '../evidence/evidence-index-store.js';

export interface RecordingObservationQuery {
  camera?: string;
  from?: string;
  to?: string;
  objectClass?: string;
  ocrQuery?: string;
}

interface MatchState {
  segmentId?: string;
  object: boolean;
  ocr: boolean;
}

function stringData(event: HomeEvent, key: string): string | undefined {
  const value = event.data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function segmentIdForEvent(event: HomeEvent): string | undefined {
  return stringData(event, 'recordingSegmentId');
}

function evidenceKeyForEvent(event: HomeEvent): string | undefined {
  const evidenceId = stringData(event, 'evidenceEventId');
  const segmentId = segmentIdForEvent(event);
  return evidenceId ?? (segmentId ? `segment:${segmentId}` : undefined);
}

function objectClassForEvent(event: HomeEvent): string | undefined {
  return stringData(event, 'className')
    ?? (event.subject?.type === 'object' ? event.subject.id : undefined)
    ?? (event.type === 'person.detected' || event.type === 'person.left' ? 'person' : undefined);
}

function observationMatches(
  observation: Pick<EvidenceObservation, 'kind' | 'objectClass' | 'text' | 'normalizedText' | 'eventType'>,
  query: RecordingObservationQuery,
): { object: boolean; ocr: boolean } {
  const wanted = query.ocrQuery ? normalizeEvidenceText(query.ocrQuery) : undefined;
  return {
    object: !query.objectClass || observation.objectClass === query.objectClass,
    ocr: !wanted || (
      observation.kind === 'ocr'
      && normalizeEvidenceText(observation.normalizedText ?? observation.text ?? '').includes(wanted)
    ),
  };
}

function eventMatches(event: HomeEvent, query: RecordingObservationQuery): { object: boolean; ocr: boolean } {
  const kind = event.type === 'ocr.observation'
    ? 'ocr'
    : event.type === 'object.observed' || event.type === 'person.detected' || event.type === 'person.left'
      ? 'object'
      : 'event';
  return observationMatches({
    kind,
    objectClass: objectClassForEvent(event),
    text: stringData(event, 'text'),
    normalizedText: stringData(event, 'normalizedText'),
    eventType: event.type,
  }, query);
}

function satisfies(state: MatchState, query: RecordingObservationQuery): boolean {
  return Boolean(state.segmentId)
    && (!query.objectClass || state.object)
    && (!query.ocrQuery || state.ocr);
}

/**
 * Resolves recording segments that satisfy object/OCR filters from both the
 * relational projection and the canonical event stream. The canonical merge
 * keeps a short projection lag from making read-only search look incomplete.
 */
export async function matchingRecordingIds(
  events: EventStore,
  evidenceIndex: EvidenceIndexStore | undefined,
  query: RecordingObservationQuery,
): Promise<Set<string>> {
  const states = new Map<string, MatchState>();
  const stateFor = (key: string, segmentId?: string): MatchState => {
    const existing = states.get(key);
    if (existing) {
      if (segmentId && !existing.segmentId) existing.segmentId = segmentId;
      return existing;
    }
    const created: MatchState = { segmentId, object: false, ocr: false };
    states.set(key, created);
    return created;
  };

  if (evidenceIndex) {
    const indexed = await evidenceIndex.listEvidence({
      camera: query.camera,
      from: query.from,
      to: query.to,
      limit: 100_000,
    });
    for (const evidence of indexed) {
      const key = evidence.id;
      const state = stateFor(key, evidence.recordingSegmentId);
      for (const observation of await evidenceIndex.listObservations(evidence.id)) {
        const matches = observationMatches(observation, query);
        state.object ||= matches.object && Boolean(query.objectClass);
        state.ocr ||= matches.ocr && Boolean(query.ocrQuery);
      }
    }
  }

  const canonical = await events.query({ from: query.from, to: query.to, limit: 100_000 });
  for (const event of canonical) {
    const segmentId = segmentIdForEvent(event);
    const key = evidenceKeyForEvent(event);
    if (!key) continue;
    const state = stateFor(key, segmentId);
    const matches = eventMatches(event, query);
    state.object ||= matches.object && Boolean(query.objectClass);
    state.ocr ||= matches.ocr && Boolean(query.ocrQuery);
  }

  return new Set([...states.values()]
    .filter((state) => satisfies(state, query))
    .map((state) => state.segmentId!));
}
