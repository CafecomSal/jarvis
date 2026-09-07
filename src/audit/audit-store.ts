import type { AuditEntry } from './schema.js';

export interface AuditStore {
  append(entry: AuditEntry): Promise<AuditEntry>;
  list(limit?: number): Promise<AuditEntry[]>;
  forConversation(conversationId: string, limit?: number): Promise<AuditEntry[]>;
  redactForConversation(conversationId: string, reason: string): Promise<number>;
}
