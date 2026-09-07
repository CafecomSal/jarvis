import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { WorldStateProjection } from '../src/state/world-state.js';

const recording: RecordingSegment = {
  id: 'rec-timeline-api',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:01:00.000Z',
  durationMs: 60_000,
  fileRef: 'front/2026-09-04/rec-timeline-api.mkv',
  bytes: 100,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

describe('API de timeline', () => {
  it('retorna eventos e gravações ordenados em uma consulta read-only', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-timeline-api',
      type: 'ocr.observation',
      timestamp: '2026-09-04T12:00:30.000Z',
      source: { type: 'ocr', id: 'rapidocr-onnxruntime' },
      location: 'frente',
      data: { camera: 'front', normalizedText: 'PORTAO1234' },
    });
    const recordings = new InMemoryRecordingStore();
    await recordings.append(recording);
    const app = buildApp({ events, recordings, worldState: new WorldStateProjection() });

    const response = await app.inject({
      method: 'GET',
      url: '/timeline?camera=front&from=2026-09-04T11:59:00.000Z&to=2026-09-04T12:02:00.000Z',
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      count: 2,
      items: [
        { kind: 'recording', id: 'rec-timeline-api' },
        { kind: 'event', id: 'evt-timeline-api', type: 'ocr.observation' },
      ],
    });
  });

  it('rejeita cursor opaco inválido sem produzir erro interno', async () => {
    const app = buildApp({ events: new InMemoryEventStore(), worldState: new WorldStateProjection() });
    const response = await app.inject({ method: 'GET', url: '/timeline?cursor=not-a-cursor' });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_timeline_cursor' });
  });
});
