import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresSttUsageStore } from '../src/audio/stt-usage-store.js';

const connectionString = process.env.DATABASE_URL;
const sessionPrefix = 'test-pg-stt-usage-001';

describe.skipIf(!connectionString)('PostgresSttUsageStore', () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresSttUsageStore({ pool });

  beforeAll(async () => {
    await store.initialize();
    await pool.query('DELETE FROM stt_usage_records WHERE session_id LIKE $1', [`${sessionPrefix}%`]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM stt_usage_records WHERE session_id LIKE $1', [`${sessionPrefix}%`]);
    await pool.end();
  });

  it('acumula custo por mês e mantém idempotência por sessionId', async () => {
    await store.record('2026-09-01', { sessionId: `${sessionPrefix}-a`, audioSeconds: 1, estimatedUsd: 0.9 });
    await store.record('2026-09-05', { sessionId: `${sessionPrefix}-b`, audioSeconds: 1, estimatedUsd: 0.1 });
    await store.record('2026-09-05', { sessionId: `${sessionPrefix}-b`, audioSeconds: 1, estimatedUsd: 0.1 });

    const month = await store.getMonth('2026-09');
    const day = await store.get('2026-09-05');

    expect(month).toMatchObject({ requests: 2, audioSeconds: 20, estimatedUsd: 1 });
    expect(day).toMatchObject({ requests: 1, audioSeconds: 10, estimatedUsd: 0.1 });
  });
});
