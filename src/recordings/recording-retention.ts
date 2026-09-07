import { rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RecordingSegment, RecordingStore } from './recording-store.js';
import { resolveRecordingFile } from './recording-file.js';
import { RecordingRetentionBudget, type RetentionTier } from './retention-budget.js';

export type RetentionCandidateReason = 'age' | 'size';

export interface RetentionCandidate {
  segment: RecordingSegment;
  localBytes: number;
  reason: RetentionCandidateReason;
}

export interface RecordingRetentionPlan {
  scanned: number;
  totalBytes: number;
  missingFiles: number;
  candidates: RetentionCandidate[];
}

export interface RecordingRetentionResult extends RecordingRetentionPlan {
  archived: number;
  failed: number;
  deleted: number;
}

export interface RecordingRetentionOptions {
  maxAgeDays?: number;
  continuousDays?: number;
  eventDays?: number;
  maxBytes?: number;
  deleteAfterVerified?: boolean;
}

export type RecordingArchiveRunner = (recordingId: string) => Promise<unknown>;

function retentionTierFor(segment: RecordingSegment): RetentionTier {
  if (segment.protected === true) return 'protected';
  return segment.retentionTier ?? 'continuous';
}

export class RecordingRetentionService {
  private readonly rootDirectory: string;
  private readonly maxAgeDays: number;
  private readonly budget: RecordingRetentionBudget;
  private readonly maxBytes?: number;
  private readonly deleteAfterVerified: boolean;

  constructor(
    private readonly store: RecordingStore,
    rootDirectory: string,
    options: RecordingRetentionOptions = {},
  ) {
    this.rootDirectory = resolve(rootDirectory);
    this.maxAgeDays = options.continuousDays ?? options.maxAgeDays ?? 7;
    this.budget = new RecordingRetentionBudget({
      continuousDays: this.maxAgeDays,
      eventDays: options.eventDays ?? 90,
    });
    this.maxBytes = options.maxBytes;
    this.deleteAfterVerified = options.deleteAfterVerified ?? false;
    if (!Number.isFinite(this.maxAgeDays) || this.maxAgeDays <= 0) {
      throw new Error('Recording retention maxAgeDays must be greater than zero');
    }
    if (this.maxBytes !== undefined && (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0)) {
      throw new Error('Recording retention maxBytes must be greater than zero');
    }
  }

  async plan(now = new Date()): Promise<RecordingRetentionPlan> {
    const segments = await this.store.list({ limit: 10_000 });
    const candidates = new Map<string, RetentionCandidate>();
    let totalBytes = 0;
    let missingFiles = 0;
    const localSizes = new Map<string, number>();

    for (const segment of segments) {
      let localBytes = 0;
      try {
        const details = await stat(resolveRecordingFile(this.rootDirectory, segment.fileRef));
        localBytes = details.isFile() ? details.size : 0;
      } catch {
        missingFiles += 1;
      }
      localSizes.set(segment.id, localBytes);
      totalBytes += localBytes;
      const retentionTier = retentionTierFor(segment);
      if (this.budget.isPastAge({ startedAt: segment.startedAt, retentionTier }, now) && localBytes > 0) {
        candidates.set(segment.id, { segment, localBytes, reason: 'age' });
      }
    }

    if (this.maxBytes !== undefined && totalBytes > this.maxBytes) {
      let remainingBytes = totalBytes;
      const oldest = segments
        .slice()
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
      for (const segment of oldest) {
        if (remainingBytes <= this.maxBytes) break;
        if (retentionTierFor(segment) === 'protected') continue;
        const localBytes = localSizes.get(segment.id) ?? 0;
        if (localBytes === 0) continue;
        if (!candidates.has(segment.id)) {
          candidates.set(segment.id, { segment, localBytes, reason: 'size' });
        }
        remainingBytes -= localBytes;
      }
    }

    return {
      scanned: segments.length,
      totalBytes,
      missingFiles,
      candidates: [...candidates.values()]
        .sort((left, right) => Date.parse(left.segment.startedAt) - Date.parse(right.segment.startedAt)),
    };
  }

  async run(archive?: RecordingArchiveRunner, now = new Date()): Promise<RecordingRetentionResult> {
    const plan = await this.plan(now);
    let archived = 0;
    let failed = 0;
    let deleted = 0;
    if (archive) {
      for (const candidate of plan.candidates) {
        try {
          await archive(candidate.segment.id);
          archived += 1;
          if (this.deleteAfterVerified) {
            const stored = await this.store.findById(candidate.segment.id);
            if (stored?.backupStatus === 'verified' && retentionTierFor(stored) !== 'protected') {
              await rm(resolveRecordingFile(this.rootDirectory, stored.fileRef), { force: true });
              deleted += 1;
            }
          }
        } catch {
          failed += 1;
        }
      }
    }
    return { ...plan, archived, failed, deleted };
  }
}
