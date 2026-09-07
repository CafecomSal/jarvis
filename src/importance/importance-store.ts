import { z } from 'zod';
import { ImportanceDecisionSchema, ImportanceProposalSchema, type ImportanceDecision, type ImportanceProposal } from './importance-policy.js';

export const ImportanceRecordSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  proposal: ImportanceProposalSchema,
  decision: ImportanceDecisionSchema,
});

export type ImportanceRecord = z.infer<typeof ImportanceRecordSchema>;
export type ImportanceRecordInput = Omit<ImportanceRecord, 'proposal' | 'decision'> & {
  proposal: ImportanceProposal;
  decision: ImportanceDecision;
};

export interface ImportanceStore {
  append(record: ImportanceRecordInput): Promise<ImportanceRecord>;
  list(limit?: number): Promise<ImportanceRecord[]>;
  findById(id: string): Promise<ImportanceRecord | undefined>;
}

function clone(record: ImportanceRecord): ImportanceRecord {
  return structuredClone(record);
}

export class InMemoryImportanceStore implements ImportanceStore {
  private readonly records: ImportanceRecord[] = [];

  async append(record: ImportanceRecordInput): Promise<ImportanceRecord> {
    const validated = ImportanceRecordSchema.parse(record);
    const existing = this.records.find((item) => item.id === validated.id);
    if (existing) return clone(existing);
    this.records.push(clone(validated));
    return clone(validated);
  }

  async list(limit = 100): Promise<ImportanceRecord[]> {
    return this.records.slice(-limit).map(clone);
  }

  async findById(id: string): Promise<ImportanceRecord | undefined> {
    const record = this.records.find((item) => item.id === id);
    return record ? clone(record) : undefined;
  }
}
