import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresAuditStore } from '../src/audit/postgres-audit-store.js';

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://jarvis:jarvis_dev_local_only@127.0.0.1:5434/jarvis';
const entryIds = ['test-audit-pg-001', 'test-audit-pg-002'];
const conversationId = 'conv-test-audit-pg';

describe('PostgresAuditStore', () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresAuditStore({ pool });

  beforeAll(async () => {
    await store.initialize();
    await pool.query('DELETE FROM audit_log WHERE id = ANY($1::text[])', [entryIds]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM audit_log WHERE id = ANY($1::text[])', [entryIds]);
    await pool.end();
  });

  it('persiste e recupera entradas de uma conversa em ordem', async () => {
    await store.append({
      id: entryIds[0],
      timestamp: '2026-08-25T19:40:00-03:00',
      conversationId,
      kind: 'conversation',
      action: 'received',
      actor: 'user',
      data: { message: 'teste' },
    });
    await store.append({
      id: entryIds[1],
      timestamp: '2026-08-25T19:40:01-03:00',
      conversationId,
      kind: 'conversation',
      action: 'completed',
      actor: 'jarvis-core',
      outcome: 'success',
      data: { answer: 'ok' },
    });

    const entries = await store.forConversation(conversationId);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(entryIds);
    expect(entries[1]).toMatchObject({
      action: 'completed',
      outcome: 'success',
      data: { answer: 'ok' },
    });
  });
});
