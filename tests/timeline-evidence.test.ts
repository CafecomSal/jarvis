import { describe, expect, it } from 'vitest';
import { EvidenceEventProjection } from '../src/evidence/event-projection.js';
import { InMemoryEvidenceIndexStore } from '../src/evidence/evidence-index-store.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { InMemoryRecordingIndexRunStore } from '../src/recordings/recording-index-run-store.js';
import { InMemoryRecordingStore } from '../src/recordings/recording-store.js';
import { TimelineService } from '../src/timeline/timeline-service.js';

describe('timeline por evidência', () => {
  it('agrupa observações, filtra OCR/objeto, pagina e inclui segmento por sobreposição', async () => {
    const events = new InMemoryEventStore();
    const index = new InMemoryEvidenceIndexStore();
    const projection = new EvidenceEventProjection(index);
    const snapshot = await events.append({
      id: 'frame-1', type: 'camera.snapshot', timestamp: '2026-09-07T10:00:30.000Z', source: { type: 'recording', id: 'rec-1' }, location: 'front',
      data: { camera: 'front', recordingSegmentId: 'rec-1', frameTimestampMs: 30_000, imageRef: 'recordings/rec-1/frame.jpg', bytes: 10, historical: true },
    });
    const object = await events.append({
      id: 'object-1', type: 'object.observed', timestamp: snapshot.timestamp, source: { type: 'onnx_historical', id: 'yolo.onnx' }, location: 'front', subject: { type: 'object', id: 'car' }, confidence: 0.8,
      data: { camera: 'front', className: 'car', evidenceEventId: snapshot.id, recordingSegmentId: 'rec-1' },
    });
    const ocr = await events.append({
      id: 'ocr-1', type: 'ocr.observation', timestamp: snapshot.timestamp, source: { type: 'ocr_historical', id: 'rapidocr' }, location: 'front', confidence: 0.9,
      data: { camera: 'front', text: 'Portão 12', normalizedText: 'PORTAO12', evidenceEventId: snapshot.id, recordingSegmentId: 'rec-1' },
    });
    await projection.project(snapshot); await projection.project(object); await projection.project(ocr);
    const recordings = new InMemoryRecordingStore();
    await recordings.append({
      id: 'rec-1', camera: 'front', startedAt: '2026-09-07T10:00:00.000Z', endedAt: '2026-09-07T10:01:00.000Z', durationMs: 60_000,
      fileRef: 'front/rec-1.mkv', bytes: 10, mimeType: 'video/x-matroska', videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 720, backupStatus: 'local',
    });
    const runs = new InMemoryRecordingIndexRunStore();
    await runs.enqueue({ id: 'run-1', segmentId: 'rec-1', model: 'yolo.onnx', ocrModel: 'rapidocr', policyVersion: 'v1' });
    const timeline = new TimelineService(events, recordings, { evidenceIndex: index, indexRuns: runs });
    const filtered = await timeline.query({ camera: 'front', objectClass: 'car', ocrQuery: 'portao12', from: '2026-09-07T10:00:01.000Z', to: '2026-09-07T10:00:59.000Z', limit: 2 });
    expect(filtered.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'evidence', id: 'frame-1', observations: expect.arrayContaining([
        expect.objectContaining({ eventId: 'object-1' }),
        expect.objectContaining({ eventId: 'ocr-1' }),
      ]) }),
      expect.objectContaining({ kind: 'recording', id: 'rec-1' }),
    ]));
    expect(filtered.items).toHaveLength(2);
    expect(filtered.hasMore).toBe(false);
    const firstPage = await timeline.query({ from: '2026-09-07T10:00:00.000Z', to: '2026-09-07T10:01:00.000Z', limit: 1 });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();
    await expect(timeline.query({ cursor: firstPage.nextCursor, limit: 10 })).resolves.toMatchObject({ items: expect.any(Array) });
    const all = await timeline.query({ from: '2026-09-07T10:00:59.000Z', to: '2026-09-07T10:01:01.000Z', limit: 10 });
    expect(all.items.some((item) => item.kind === 'recording' && item.id === 'rec-1')).toBe(true);
  });
});
