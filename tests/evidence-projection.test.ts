import { describe, expect, it } from 'vitest';
import { EvidenceEventProjection } from '../src/evidence/event-projection.js';
import { InMemoryEvidenceIndexStore } from '../src/evidence/evidence-index-store.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { InMemoryRecordingStore } from '../src/recordings/recording-store.js';

describe('projeção de eventos para evidências', () => {
  it('projeta snapshots e filhos sem falhar o appender', async () => {
    const events = new InMemoryEventStore();
    const index = new InMemoryEvidenceIndexStore();
    const projection = new EvidenceEventProjection(index);
    const snapshot = await events.append({
      id: 'snapshot-1', type: 'camera.snapshot', timestamp: '2026-09-07T10:00:00.000Z',
      source: { type: 'recording', id: 'rec-1' }, location: 'front',
      data: { camera: 'front', recordingSegmentId: 'rec-1', frameTimestampMs: 1000, imageRef: 'recordings/rec-1/frame.jpg', bytes: 8, historical: true },
    });
    const object = await events.append({
      id: 'object-1', type: 'object.observed', timestamp: snapshot.timestamp,
      source: { type: 'onnx_historical', id: 'yolo.onnx' }, location: 'front', subject: { type: 'object', id: 'car' }, confidence: 0.8,
      data: { camera: 'front', className: 'car', evidenceEventId: snapshot.id, recordingSegmentId: 'rec-1', imageRef: 'recordings/rec-1/frame.jpg' },
    });
    await projection.project(snapshot);
    await projection.project(object);
    await projection.project(object);
    expect(await index.listEvidence()).toHaveLength(1);
    expect(await index.listObservations(snapshot.id)).toHaveLength(1);
  });

  it('executa backfill em lotes e não repete depois do marcador', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'snapshot-backfill', type: 'camera.snapshot', timestamp: '2026-09-07T10:00:00.000Z', source: { type: 'rtsp', id: 'front' },
      data: { camera: 'front', imageRef: 'front/snapshot.jpg', bytes: 4 },
    });
    const index = new InMemoryEvidenceIndexStore();
    const projection = new EvidenceEventProjection(index, { batchSize: 1 });
    const recordings = new InMemoryRecordingStore();
    const first = await projection.backfill(events, recordings);
    const second = await projection.backfill(events, recordings);
    expect(first).toMatchObject({ status: 'completed', eventsProcessed: 1, evidenceProjected: 1 });
    expect(second).toMatchObject({ status: 'skipped', eventsProcessed: 1 });
  });

  it('reconcilia relações órfãs no trecho recente sem reconstruir tudo', async () => {
    const events = new InMemoryEventStore();
    const snapshot = await events.append({
      id: 'snapshot-orphan', type: 'camera.snapshot', timestamp: '2026-09-07T10:00:00.000Z',
      source: { type: 'recording', id: 'rec-orphan' }, data: {
        camera: 'front', recordingSegmentId: 'rec-orphan', imageRef: 'recordings/rec-orphan/frame.jpg', bytes: 4,
      },
    });
    await events.append({
      id: 'object-orphan', type: 'object.observed', timestamp: snapshot.timestamp,
      source: { type: 'onnx_continuous', id: 'yolo.onnx' }, subject: { type: 'object', id: 'car' }, confidence: 0.8,
      data: { camera: 'front', className: 'car', evidenceEventId: snapshot.id, recordingSegmentId: 'rec-orphan' },
    });
    const index = new InMemoryEvidenceIndexStore();
    await index.setMarker({ key: 'recording-evidence-backfill', version: '2', completedAt: '2026-09-07T10:01:00.000Z', metadata: {} });
    const projection = new EvidenceEventProjection(index);

    const result = await projection.backfill(events, new InMemoryRecordingStore());

    expect(result.status).toBe('skipped');
    expect(await index.findEvidenceById(snapshot.id)).toBeDefined();
    expect(await index.findObservationByEventId('object-orphan')).toMatchObject({ evidenceId: snapshot.id });
  });
});
