import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresEventStore } from '../src/events/postgres-event-store.js';
import { WorldStateProjection } from '../src/state/world-state.js';

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://jarvis:jarvis_dev_local_only@127.0.0.1:5434/jarvis';
const testEventId = 'test-pg-event-001';
const orderEventIds = ['test-pg-order-old', 'test-pg-order-new'];
const queryEventIds = ['test-pg-query-kitchen', 'test-pg-query-living'];

describe('PostgresEventStore', () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresEventStore({ pool });

  beforeAll(async () => {
    await store.initialize();
    await pool.query('DELETE FROM events WHERE id = ANY($1::text[])', [[testEventId, ...orderEventIds, ...queryEventIds]]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM events WHERE id = ANY($1::text[])', [[testEventId, ...orderEventIds, ...queryEventIds]]);
    await pool.end();
  });

  it('persiste e busca eventos estruturados', async () => {
    const event = await store.append({
      id: testEventId,
      type: 'person.detected',
      timestamp: '2026-08-25T19:40:00-03:00',
      source: { type: 'camera', id: 'front' },
      location: 'varanda',
      subject: { type: 'person', id: 'davi' },
      confidence: 0.92,
      data: { clothing: ['camisa azul'] },
    });

    const matches = await store.search('varanda');
    const matchesById = await store.search(testEventId);

    expect(event.id).toBe(testEventId);
    expect(matches).toHaveLength(1);
    expect(matchesById).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: testEventId,
      type: 'person.detected',
      location: 'varanda',
      subject: { id: 'davi' },
      confidence: 0.92,
    });
  });

  it('retorna o evento mais recente quando a busca é limitada', async () => {
    await store.append({
      id: orderEventIds[0],
      type: 'sound.detected',
      timestamp: '2026-08-25T19:41:00-03:00',
      source: { type: 'test', id: 'ordering' },
      location: 'ordem',
      data: { marker: 'latest-marker' },
    });
    await store.append({
      id: orderEventIds[1],
      type: 'sound.detected',
      timestamp: '2026-08-25T19:42:00-03:00',
      source: { type: 'test', id: 'ordering' },
      location: 'ordem',
      data: { marker: 'latest-marker' },
    });

    const latest = await store.search('latest-marker', 1);

    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(orderEventIds[1]);
  });

  it('permite reidratar o World State depois de consultar o banco', async () => {
    const worldState = new WorldStateProjection();
    const events = await store.list(1000);

    for (const event of events) {
      worldState.apply(event);
    }

    expect(worldState.snapshot().people.davi).toMatchObject({
      presence: 'home',
      location: 'varanda',
      confidence: 0.92,
    });
  });

  it('filtra eventos persistidos por intervalo, local e assunto', async () => {
    await store.append({
      id: queryEventIds[0],
      type: 'person.detected',
      timestamp: '2026-08-25T20:00:00-03:00',
      source: { type: 'camera', id: 'front' },
      location: 'cozinha',
      subject: { type: 'person', id: 'davi' },
      data: {},
    });
    await store.append({
      id: queryEventIds[1],
      type: 'person.detected',
      timestamp: '2026-08-25T21:00:00-03:00',
      source: { type: 'camera', id: 'front' },
      location: 'sala',
      subject: { type: 'person', id: 'davi' },
      data: {},
    });

    const matches = await store.query({
      from: '2026-08-25T19:30:00-03:00',
      to: '2026-08-25T20:30:00-03:00',
      location: 'cozinha',
      subjectId: 'davi',
      type: 'person.detected',
    });

    expect(matches.map((event) => event.id)).toEqual([queryEventIds[0]]);
  });
});
