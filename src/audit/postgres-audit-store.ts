import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';
import { AuditEntrySchema, type AuditEntry } from './schema.js';
import type { AuditStore } from './audit-store.js';

export interface PostgresAuditStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

interface AuditRow extends QueryResultRow {
  id: string;
  occurred_at: Date | string;
  conversation_id: string;
  kind: string;
  action: string;
  actor: string;
  outcome: string | null;
  data: Record<string, unknown> | string | null;
}

const AUDIT_COLUMNS = `
  id, occurred_at, conversation_id, kind, action, actor, outcome, data
`;

function rowToAudit(row: AuditRow): AuditEntry {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) as Record<string, unknown> : row.data ?? {};
  return AuditEntrySchema.parse({
    id: row.id,
    timestamp: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString(),
    conversationId: row.conversation_id,
    kind: row.kind,
    action: row.action,
    actor: row.actor,
    outcome: row.outcome ?? undefined,
    data,
  });
}

export class PostgresAuditStore implements AuditStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresAuditStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
    });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    const migration = await readPostgresMigration(currentFile, '001_init.sql');
    await this.pool.query(migration);
  }

  async append(entry: AuditEntry): Promise<AuditEntry> {
    const validated = AuditEntrySchema.parse(entry);
    const result = await this.pool.query<AuditRow>(
      `INSERT INTO audit_log (
        id, occurred_at, conversation_id, kind, action, actor, outcome, data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING ${AUDIT_COLUMNS}`,
      [
        validated.id,
        validated.timestamp,
        validated.conversationId,
        validated.kind,
        validated.action,
        validated.actor,
        validated.outcome ?? null,
        JSON.stringify(validated.data),
      ],
    );

    if (result.rows[0]) return rowToAudit(result.rows[0]);

    const existing = await this.pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE id = $1`,
      [validated.id],
    );
    if (!existing.rows[0]) {
      throw new Error(`Audit entry was not returned after append: ${validated.id}`);
    }
    return rowToAudit(existing.rows[0]);
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS}
       FROM (
         SELECT ${AUDIT_COLUMNS}, created_at
         FROM audit_log
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $1
       ) recent
       ORDER BY occurred_at ASC, created_at ASC`,
      [limit],
    );
    return result.rows.map(rowToAudit);
  }

  async forConversation(conversationId: string, limit = 100): Promise<AuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS}
       FROM (
         SELECT ${AUDIT_COLUMNS}, created_at
         FROM audit_log
         WHERE conversation_id = $1
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT $2
       ) recent
       ORDER BY occurred_at ASC, created_at ASC`,
      [conversationId, limit],
    );
    return result.rows.map(rowToAudit);
  }

  async redactForConversation(conversationId: string, reason: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE audit_log
          SET data = jsonb_build_object('redacted', true, 'reason', $2)
        WHERE conversation_id = $1
          AND COALESCE(data->>'redacted', 'false') <> 'true'`,
      [conversationId, reason],
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
