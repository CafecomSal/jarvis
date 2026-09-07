import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { TimelineService } from '../src/timeline/timeline-service.js';

describe('timeline unificada do Jarvis', () => {
  it('mescla eventos e gravações em ordem e filtra por câmera', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-person',
      type: 'person.detected',
      timestamp: '2026-09-04T12:01:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'person', id: 'unknown' },
      confidence: 0.8,
      data: { camera: 'front', evidenceEventId: 'evt-snapshot' },
    });
    await events.append({
      id: 'evt-ocr',
      type: 'ocr.observation',
      timestamp: '2026-09-04T12:03:00.000Z',
      source: { type: 'ocr', id: 'rapidocr-onnxruntime' },
      location: 'frente',
      confidence: 0.9,
      data: { camera: 'front', normalizedText: 'PORTAO1234' },
    });
    const recordings = new InMemoryRecordingStore();
    const recording: RecordingSegment = {
      id: 'rec-timeline',
      camera: 'front',
      startedAt: '2026-09-04T12:02:00.000Z',
      endedAt: '2026-09-04T12:02:05.000Z',
      durationMs: 5_000,
      fileRef: 'front/2026-09-04/rec-timeline.mkv',
      bytes: 100,
      mimeType: 'video/x-matroska',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 2160,
      backupStatus: 'local',
    };
    await recordings.append(recording);

    const result = await new TimelineService(events, recordings).query({
      camera: 'front',
      from: '2026-09-04T12:00:00.000Z',
      to: '2026-09-04T12:04:00.000Z',
      limit: 10,
    });

    expect(result.count).toBe(3);
    expect(result.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'event:evt-person',
      'recording:rec-timeline',
      'event:evt-ocr',
    ]);
    expect(result.items[1]).toMatchObject({
      kind: 'recording',
      recording: { fileRef: 'front/2026-09-04/rec-timeline.mkv' },
    });
    expect(result.items[0]).not.toHaveProperty('event');
  });

  it('funciona somente com eventos quando o catálogo DVR não existe', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-only',
      type: 'sound.detected',
      timestamp: '2026-09-04T12:00:00.000Z',
      source: { type: 'sensor', id: 'front' },
      data: {},
    });
    await expect(new TimelineService(events).query({ limit: 10 })).resolves.toMatchObject({
      count: 1,
      items: [{ kind: 'event', id: 'evt-only' }],
    });
  });
});
