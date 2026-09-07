import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { LocalSnapshotStore } from '../src/cameras/local-snapshot-store.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';

describe('API de evidências', () => {
  it('retorna evento e snapshot por ID', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-evidence',
      type: 'camera.snapshot',
      timestamp: '2026-09-05T04:30:00.000Z',
      source: { type: 'rtsp', id: 'front' },
      location: 'frente',
      data: { camera: 'front', imageRef: 'front/frame.jpg' },
    });
    const app = buildApp({ events });

    const eventResponse = await app.inject({ method: 'GET', url: '/events/evt-evidence' });
    const evidenceResponse = await app.inject({ method: 'GET', url: '/evidence/evt-evidence' });
    await app.close();

    expect(eventResponse.statusCode).toBe(200);
    expect(eventResponse.json()).toMatchObject({ id: 'evt-evidence', type: 'camera.snapshot' });
    expect(evidenceResponse.statusCode).toBe(200);
    expect(evidenceResponse.json()).toMatchObject({ id: 'evt-evidence', data: { imageRef: 'front/frame.jpg' } });
  });

  it('retorna 404 para ID inexistente', async () => {
    const app = buildApp({ events: new InMemoryEventStore() });
    const response = await app.inject({ method: 'GET', url: '/events/missing' });
    await app.close();
    expect(response.statusCode).toBe(404);
  });

  it('serve somente imagem local validada e bloqueia data URI/path traversal', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-evidence-api-'));
    try {
      await mkdir(join(directory, 'front'), { recursive: true });
      await writeFile(join(directory, 'front', 'frame.jpg'), Buffer.from('jpeg-bytes'));
      const events = new InMemoryEventStore();
      await events.append({
        id: 'evt-local-image', type: 'camera.snapshot', timestamp: '2026-09-05T04:30:00.000Z',
        source: { type: 'rtsp', id: 'front' }, data: { camera: 'front', imageRef: 'front/frame.jpg', mimeType: 'image/jpeg' },
      });
      const app = buildApp({ events, snapshotStore: new LocalSnapshotStore(directory) });
      const image = await app.inject({ method: 'GET', url: '/evidence/evt-local-image/image' });
      await app.close();
      expect(image.statusCode).toBe(200);
      expect(image.body).toBe('jpeg-bytes');

      const unsafeEvents = new InMemoryEventStore();
      await unsafeEvents.append({
        id: 'evt-unsafe-image', type: 'camera.snapshot', timestamp: '2026-09-05T04:30:00.000Z',
        source: { type: 'rtsp', id: 'front' }, data: { camera: 'front', imageRef: '../outside.jpg' },
      });
      const unsafeApp = buildApp({ events: unsafeEvents, snapshotStore: new LocalSnapshotStore(directory) });
      const traversal = await unsafeApp.inject({ method: 'GET', url: '/evidence/evt-unsafe-image/image' });
      await unsafeApp.close();
      expect(traversal.statusCode).toBe(400);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
