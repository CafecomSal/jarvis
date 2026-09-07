import type { RecordingStore } from './recording-store.js';
import { RecordingRetentionBudget, type RetentionTier } from './retention-budget.js';

export interface RecordingRemoteRetentionOptions {
  continuousDays: number;
  eventDays: number;
  deleteRemote: (driveFileId: string) => Promise<void>;
}

export interface RecordingRemoteRetentionResult {
  scanned: number;
  deleted: string[];
  failed: Array<{ id: string; error: string }>;
}

function tierFor(segment: { retentionTier?: RetentionTier; protected?: boolean }): RetentionTier {
  if (segment.protected === true) return 'protected';
  return segment.retentionTier ?? 'continuous';
}

export class RecordingRemoteRetentionService {
  private readonly budget: RecordingRetentionBudget;
  private readonly deleteRemote: (driveFileId: string) => Promise<void>;

  constructor(private readonly store: RecordingStore, options: RecordingRemoteRetentionOptions) {
    this.budget = new RecordingRetentionBudget({
      continuousDays: options.continuousDays,
      eventDays: options.eventDays,
    });
    this.deleteRemote = options.deleteRemote;
  }

  async run(now = new Date()): Promise<RecordingRemoteRetentionResult> {
    const segments = await this.store.list({ limit: 10_000 });
    const result: RecordingRemoteRetentionResult = { scanned: segments.length, deleted: [], failed: [] };
    for (const segment of segments) {
      if (segment.backupStatus !== 'verified' || !segment.driveFileId) continue;
      const retentionTier = tierFor(segment);
      if (!this.budget.isEligible({
        startedAt: segment.startedAt,
        retentionTier,
        backupStatus: segment.backupStatus,
      }, now)) continue;
      try {
        await this.deleteRemote(segment.driveFileId);
        await this.store.updateBackup(segment.id, { backupStatus: 'remote_deleted' });
        result.deleted.push(segment.id);
      } catch (error) {
        result.failed.push({
          id: segment.id,
          error: error instanceof Error ? error.message.slice(0, 300) : 'remote deletion failed',
        });
      }
    }
    return result;
  }
}
