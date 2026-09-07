import { realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  evidenceSnapshotsDirectory?: string;
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
  private readonly evidenceSnapshotsDirectory?: string;

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
    this.evidenceSnapshotsDirectory = options.evidenceSnapshotsDirectory ? resolve(options.evidenceSnapshotsDirectory) : undefined;
    if (!Number.isFinite(this.maxAgeDays) || this.maxAgeDays <= 0) {
      throw new Error('Recording retention maxAgeDays must be greater than zero');
    }
    if (this.maxBytes !== undefined && (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0)) {
      throw new Error('Recording retention maxBytes must be greater than zero');
    }
  }

  private async safeExistingRecordingPath(fileRef: string): Promise<string> {
    const rootPath = await realpath(this.rootDirectory);
    const actualPath = await realpath(resolveRecordingFile(this.rootDirectory, fileRef));
    const relativePath = relative(rootPath, actualPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath.split(sep).includes('..') || relativePath === '') {
      throw new Error('Recording file reference escapes archive root');
    }
    return actualPath;
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
        const details = await stat(await this.safeExistingRecordingPath(segment.fileRef));
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
              await this.safeExistingRecordingPath(stored.fileRef);
              await rm(resolveRecordingFile(this.rootDirectory, stored.fileRef), { force: true });
              if (this.evidenceSnapshotsDirectory) {
                const evidenceDirectory = resolve(this.evidenceSnapshotsDirectory, 'recordings', stored.id);
                const evidenceRelative = relative(this.evidenceSnapshotsDirectory, evidenceDirectory);
                if (evidenceRelative.startsWith('..') || isAbsolute(evidenceRelative) || evidenceRelative.split(sep).includes('..')) {
                  throw new Error('Recording evidence path escapes snapshot root');
                }
                try {
                  const snapshotRoot = await realpath(this.evidenceSnapshotsDirectory);
                  const actualEvidenceDirectory = await realpath(evidenceDirectory);
                  const actualRelative = relative(snapshotRoot, actualEvidenceDirectory);
                  if (actualRelative.startsWith('..') || isAbsolute(actualRelative) || actualRelative.split(sep).includes('..') || actualRelative === '') {
                    throw new Error('Recording evidence path escapes snapshot root');
                  }
                } catch (error) {
                  if (error instanceof Error && error.message === 'Recording evidence path escapes snapshot root') throw error;
                  // A missing evidence directory is already equivalent to a
                  // successful cleanup; rm below remains idempotent.
                }
                await rm(evidenceDirectory, { recursive: true, force: true });
              }
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
