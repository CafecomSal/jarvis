export type RetentionTier = 'continuous' | 'event' | 'protected';

export interface RetentionRecord {
  startedAt: string;
  retentionTier: RetentionTier;
  backupStatus: string;
}

export interface RecordingRetentionBudgetOptions {
  continuousDays: number;
  eventDays: number;
}

export class RecordingRetentionBudget {
  private readonly continuousDays: number;
  private readonly eventDays: number;

  constructor(options: RecordingRetentionBudgetOptions) {
    this.continuousDays = options.continuousDays;
    this.eventDays = options.eventDays;
    if (!Number.isInteger(this.continuousDays) || this.continuousDays <= 0) throw new Error('continuousDays must be a positive integer');
    if (!Number.isInteger(this.eventDays) || this.eventDays <= 0) throw new Error('eventDays must be a positive integer');
  }

  isPastAge(record: Pick<RetentionRecord, 'startedAt' | 'retentionTier'>, now = new Date()): boolean {
    if (record.retentionTier === 'protected') return false;
    const ageDays = record.retentionTier === 'event' ? this.eventDays : this.continuousDays;
    const startedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAt)) return false;
    const cutoff = now.getTime() - ageDays * 24 * 60 * 60 * 1000;
    return startedAt <= cutoff;
  }

  isEligible(record: RetentionRecord, now = new Date()): boolean {
    if (record.backupStatus !== 'verified' || record.retentionTier === 'protected') return false;
    return this.isPastAge(record, now);
  }
}
