import { AuditEntrySchema, type AuditEntry } from './schema.js';
import type { AuditStore } from './audit-store.js';

export class InMemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<AuditEntry> {
    const validated = AuditEntrySchema.parse(entry);
    const stored = structuredClone(validated);
    this.entries.push(stored);
    return structuredClone(stored);
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    return structuredClone(this.entries.slice(-limit));
  }

  async forConversation(conversationId: string, limit = 100): Promise<AuditEntry[]> {
    const matches = this.entries.filter((entry) => entry.conversationId === conversationId);
    return structuredClone(matches.slice(-limit));
  }

  async redactForConversation(conversationId: string, reason: string): Promise<number> {
    let count = 0;
    for (const entry of this.entries) {
      if (entry.conversationId !== conversationId) continue;
      entry.data = { redacted: true, reason };
      count += 1;
    }
    return count;
  }
}
