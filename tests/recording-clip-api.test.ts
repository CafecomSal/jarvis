import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { WorldStateProjection } from '../src/state/world-state.js';

const segment: RecordingSegment = {
  id: 'rec-clip-1',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:02:00.000Z',
  durationMs: 120_000,
  fileRef: 'front/2026-09-04/rec-clip-1.mkv',
  bytes: 10,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

describe('reprodução read-only de gravações', () => {
  it('serve o segmento local e não expõe conteúdo como metadata', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-clip-api-'));
    try {
      const path = join(directory, ...segment.fileRef.split('/'));
      await mkdir(join(directory, 'front', '2026-09-04'), { recursive: true });
      await writeFile(path, Buffer.from('clip-bytes'));
      const recordings = new InMemoryRecordingStore();
      await recordings.append({ ...segment, bytes: (await readFile(path)).length });
      const app = buildApp({
        events: new InMemoryEventStore(),
        recordings,
        recordingsDirectory: directory,
        worldState: new WorldStateProjection(),
      });

      const response = await app.inject({ method: 'GET', url: '/recordings/rec-clip-1/clip' });
      await app.close();

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('video/x-matroska');
      expect(response.body).toBe('clip-bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retorna 404 para arquivo ausente e bloqueia referência fora da raiz', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-clip-api-missing-'));
    try {
      const recordings = new InMemoryRecordingStore();
      await recordings.append({ ...segment, id: 'rec-missing', bytes: 1 });
      const app = buildApp({
        events: new InMemoryEventStore(),
        recordings,
        recordingsDirectory: directory,
        worldState: new WorldStateProjection(),
      });
      const missing = await app.inject({ method: 'GET', url: '/recordings/rec-missing/clip' });
      await app.close();
      expect(missing.statusCode).toBe(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
