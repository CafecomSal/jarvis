import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { WorldStateProjection } from '../src/state/world-state.js';

const segment: RecordingSegment = {
  id: 'rec-api-1',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:02:00.000Z',
  durationMs: 120_000,
  fileRef: 'front/2026-09-04/rec-api-1.mkv',
  bytes: 1024,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

describe('API read-only de gravações', () => {
  it('lista e busca metadata de segmentos por câmera/intervalo', async () => {
    const recordings = new InMemoryRecordingStore();
    await recordings.append(segment);
    const app = buildApp({
      events: new InMemoryEventStore(),
      recordings,
      worldState: new WorldStateProjection(),
    });

    const list = await app.inject({
      method: 'GET',
      url: '/recordings?camera=front&from=2026-09-04T11:59:00.000Z',
    });
    const detail = await app.inject({ method: 'GET', url: '/recordings/rec-api-1' });
    const missing = await app.inject({ method: 'GET', url: '/recordings/missing' });
    await app.close();

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ recordings: [segment] });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(segment);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'recording_not_found' });
  });

  it('retorna 501 quando o catálogo não está configurado', async () => {
    const app = buildApp({ events: new InMemoryEventStore(), worldState: new WorldStateProjection() });
    const response = await app.inject({ method: 'GET', url: '/recordings' });
    await app.close();
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ error: 'recording_catalog_unavailable' });
  });
});
