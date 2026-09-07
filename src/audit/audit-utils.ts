import { randomUUID } from 'node:crypto';
import type { AuditStore } from './audit-store.js';
import { AuditEntrySchema, type AuditEntry } from './schema.js';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'base64',
  'cookie',
  'password',
  'secret',
  'token',
]);
const MAX_STRING_LENGTH = 8_000;
const MAX_ARRAY_ITEMS = 100;

export function sanitizeAuditValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEYS.has(key.toLowerCase())) return '[REDACTED]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { binary: true, bytes: value.length };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeAuditValue(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeAuditValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

type AuditEntryInput = Omit<AuditEntry, 'id' | 'timestamp'> & Partial<Pick<AuditEntry, 'id' | 'timestamp'>>;

export async function appendAudit(audit: AuditStore | undefined, entry: AuditEntryInput): Promise<void> {
  if (!audit) return;

  try {
    const validated = AuditEntrySchema.parse({
      ...entry,
      id: entry.id ?? `audit-${randomUUID()}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      data: sanitizeAuditValue(entry.data),
    });
    await audit.append(validated);
  } catch {
    // Observability must not take the residential control path down.
  }
}
