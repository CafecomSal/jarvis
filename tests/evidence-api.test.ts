import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
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
});
