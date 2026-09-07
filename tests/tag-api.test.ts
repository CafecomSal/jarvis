import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { TagService } from '../src/tags/tag-service.js';

describe('API de tags', () => {
  it('lista tags filtradas e permite consultar uma tag individual', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-tag-api',
      type: 'object.observed',
      timestamp: '2026-09-05T01:00:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'object', id: 'car' },
      confidence: 0.9,
      data: { camera: 'front', className: 'car', attributes: { color: 'prata' } },
    });
    const app = buildApp({ events, tags: new TagService(events) });

    const listResponse = await app.inject({ method: 'GET', url: '/tags?camera=front&namespace=car' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({ count: 1, tags: [{ namespace: 'car', key: 'color', value: 'prata' }] });

    const tagId = listResponse.json().tags[0].id as string;
    const getResponse = await app.inject({ method: 'GET', url: `/tags/${tagId}` });
    await app.close();

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({ id: tagId, evidenceEventId: 'evt-tag-api' });
  });

  it('rejeita filtro de tags inválido', async () => {
    const app = buildApp({ tags: new TagService(new InMemoryEventStore()) });
    const response = await app.inject({ method: 'GET', url: '/tags?limit=0' });
    await app.close();
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_tag_query' });
  });
});
