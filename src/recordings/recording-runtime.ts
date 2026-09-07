import type { RecordingIndexResult, RecordingIndexer } from './recording-indexer.js';
import type { RecordingIndexRun, RecordingIndexRunStore } from './recording-index-run-store.js';
import { RecordingScheduler, type RecordingRunner } from './recording-scheduler.js';
import type { RecordingSegment, RecordingStore } from './recording-store.js';

export type RecordingRuntimeStatus = 'starting' | 'healthy' | 'degraded' | 'stopped' | 'disabled';

export interface RecordingBackfillStatus {
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'unavailable';
  eventsProcessed?: number;
  segmentsSeen?: number;
  completedAt?: string;
  error?: string;
}

export interface RecordingRuntimeHealth {
  status: RecordingRuntimeStatus;
  mode: 'continuous-economic';
  camera: string;
  segmentDurationMs: number;
  intervalMs: number;
  recording: {
    lastSegment?: { id: string; startedAt: string; endedAt: string; bytes: number; retentionTier?: string };
    errors: number;
    lastError?: string;
    lastErrorAt?: string;
  };
  indexing: {
    queueLength: number;
    maxPending: number;
    backpressure: boolean;
    currentJob?: { id: string; segmentId: string; attempts: number; status: string };
    lastSuccessAt?: string;
    lastFailureAt?: string;
    lastFailure?: string;
  };
  backfill: RecordingBackfillStatus;
  bytesCataloged: number;
  retention: { continuousDays: number; eventDays: number; maxBytes: number; dryRun: true };
}

export interface RecordingRuntimeOptions {
  camera: string;
  streamUrl: string;
  manager: RecordingRunner & { close?: () => void };
  recordings: RecordingStore;
  indexer: Pick<RecordingIndexer, 'index'>;
  indexRuns: RecordingIndexRunStore;
  model: string;
  ocrModel: string;
  policyVersion?: string;
  segmentDurationMs?: number;
  intervalMs?: number;
  includeOcr?: boolean;
  maxPendingSegments?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  clock?: () => Date;
  backfill?: RecordingBackfillStatus;
  retention?: { continuousDays: number; eventDays: number; maxBytes: number };
  onError?: (error: unknown) => void;
}

interface PendingSegment {
  segment: RecordingSegment;
  run: RecordingIndexRun;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/rtsps?:\/\/[^\s'"`]+/gi, '[REDACTED_RTSP_URL]').slice(0, 300);
}

export class RecordingRuntime {
  private readonly camera: string;
  private readonly streamUrl: string;
  private readonly manager: RecordingRunner & { close?: () => void };
  private readonly recordings: RecordingStore;
  private readonly indexer: Pick<RecordingIndexer, 'index'>;
  private readonly indexRuns: RecordingIndexRunStore;
  private readonly model: string;
  private readonly ocrModel: string;
  private readonly policyVersion: string;
  private readonly segmentDurationMs: number;
  private readonly intervalMs: number;
  private readonly includeOcr: boolean;
  private readonly maxPendingSegments: number;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly clock: () => Date;
  private readonly onError?: (error: unknown) => void;
  private readonly pending: PendingSegment[] = [];
  private readonly pendingIds = new Set<string>();
  private readonly enqueuingIds = new Set<string>();
  private readonly capacityWaiters: Array<() => void> = [];
  private scheduler?: RecordingScheduler;
  private activeJob?: Promise<void>;
  private activeRun?: RecordingIndexRun;
  private recoveryInFlight = false;
  private stopping = false;
  private started = false;
  private status: RecordingRuntimeStatus = 'starting';
  private recordingErrors = 0;
  private lastRecordingError?: string;
  private lastRecordingErrorAt?: string;
  private lastSegment?: RecordingSegment;
  private lastIndexSuccessAt?: string;
  private lastIndexFailureAt?: string;
  private lastIndexFailure?: string;
  private bytesCataloged = 0;
  private backfill: RecordingBackfillStatus;
  private readonly retention: { continuousDays: number; eventDays: number; maxBytes: number };

  constructor(options: RecordingRuntimeOptions) {
    this.camera = options.camera.trim();
    this.streamUrl = options.streamUrl.trim();
    this.manager = options.manager;
    this.recordings = options.recordings;
    this.indexer = options.indexer;
    this.indexRuns = options.indexRuns;
    this.model = options.model.trim();
    this.ocrModel = options.ocrModel.trim();
    this.policyVersion = options.policyVersion ?? 'continuous-v1';
    this.segmentDurationMs = options.segmentDurationMs ?? 60_000;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.includeOcr = options.includeOcr ?? true;
    this.maxPendingSegments = options.maxPendingSegments ?? 2;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryBackoffMs = options.retryBackoffMs ?? 1_000;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.clock = options.clock ?? (() => new Date());
    this.backfill = { status: 'pending', ...(options.backfill ?? {}) };
    this.retention = options.retention ?? { continuousDays: 30, eventDays: 90, maxBytes: 50_000_000_000 };
    this.onError = options.onError;

    if (!this.camera) throw new Error('Recording runtime camera must not be empty');
    if (!this.streamUrl) throw new Error('Recording runtime streamUrl must not be empty');
    if (!this.model) throw new Error('Recording runtime model must not be empty');
    if (!this.ocrModel) throw new Error('Recording runtime ocrModel must not be empty');
    if (!Number.isInteger(this.segmentDurationMs) || this.segmentDurationMs <= 0) throw new Error('Recording runtime segmentDurationMs must be positive');
    if (!Number.isInteger(this.intervalMs) || this.intervalMs <= 0) throw new Error('Recording runtime intervalMs must be positive');
    if (!Number.isInteger(this.maxPendingSegments) || this.maxPendingSegments < 1) throw new Error('Recording runtime maxPendingSegments must be positive');
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error('Recording runtime maxAttempts must be positive');
    if (!Number.isFinite(this.retryBackoffMs) || this.retryBackoffMs < 0) throw new Error('Recording runtime retryBackoffMs must be zero or greater');
  }

  setBackfill(status: RecordingBackfillStatus): void {
    this.backfill = { ...status };
  }

  private runId(segmentId: string): string {
    const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
    return `index-${safe(segmentId)}-${safe(this.policyVersion)}-${safe(this.model)}-${safe(this.ocrModel)}`;
  }

  private capacity(): number {
    return this.pending.length + (this.activeJob ? 1 : 0) + this.enqueuingIds.size;
  }

  private async waitForCapacity(): Promise<void> {
    while (!this.stopping && this.capacity() >= this.maxPendingSegments + 1) {
      await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    }
    if (this.stopping) throw new Error('Recording runtime is stopping');
  }

  private releaseCapacity(): void {
    while (this.capacityWaiters.length > 0 && this.capacity() < this.maxPendingSegments + 1) {
      this.capacityWaiters.shift()?.();
    }
  }

  private async queueSegment(segment: RecordingSegment, existingRun?: RecordingIndexRun): Promise<void> {
    if (this.pendingIds.has(segment.id) || this.enqueuingIds.has(segment.id) || this.activeRun?.segmentId === segment.id) return;
    this.enqueuingIds.add(segment.id);
    try {
      const run = existingRun ?? await this.indexRuns.enqueue({
        id: this.runId(segment.id),
        segmentId: segment.id,
        model: this.model,
        ocrModel: this.ocrModel,
        policyVersion: this.policyVersion,
      });
      if (this.stopping || run.status === 'completed' || run.status === 'failed') return;
      this.pending.push({ segment, run });
      this.pendingIds.add(segment.id);
      void this.pump();
    } finally {
      this.enqueuingIds.delete(segment.id);
      this.releaseCapacity();
    }
  }

  private async recoverJobs(): Promise<void> {
    if (this.recoveryInFlight || this.stopping) return;
    this.recoveryInFlight = true;
    try {
      const slots = this.maxPendingSegments + 1 - this.capacity();
      if (slots <= 0) return;
      const recoverable = await this.indexRuns.listRecoverable(this.clock(), slots);
      for (const run of recoverable) {
        const segment = await this.recordings.findById(run.segmentId);
        if (segment) await this.queueSegment(segment, run);
      }
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private reportError(error: unknown): void {
    this.status = 'degraded';
    try {
      this.onError?.(error);
    } catch {
      // Health must remain available even if an observability callback fails.
    }
  }

  private async process(item: PendingSegment): Promise<void> {
    let processing: RecordingIndexRun;
    try {
      processing = await this.indexRuns.markProcessing(item.run.id);
    } catch (error) {
      this.lastIndexFailure = errorMessage(error);
      this.lastIndexFailureAt = this.clock().toISOString();
      this.reportError(error);
      return;
    }
    this.activeRun = processing;
    let retryRun: RecordingIndexRun | undefined;
    try {
      const result = await this.indexer.index(item.segment, { includeOcr: this.includeOcr, temporaryFrames: true });
      await this.indexRuns.markCompleted(item.run.id, {
        framesProcessed: result.framesProcessed,
        evidenceCount: result.evidenceEvents,
        objectCount: result.objectEvents,
        ocrCount: result.ocrEvents,
      });
      this.lastIndexSuccessAt = this.clock().toISOString();
    } catch (error) {
      const message = errorMessage(error);
      this.lastIndexFailure = message;
      this.lastIndexFailureAt = this.clock().toISOString();
      const shouldRetry = processing.attempts < this.maxAttempts && !this.stopping;
      const delay = this.retryBackoffMs * (2 ** Math.max(0, processing.attempts - 1));
      const nextAttemptAt = shouldRetry ? new Date(this.clock().getTime() + delay).toISOString() : undefined;
      let failedRun: RecordingIndexRun;
      try {
        failedRun = await this.indexRuns.markFailure(item.run.id, message, nextAttemptAt);
      } catch (failureError) {
        this.reportError(failureError);
        return;
      }
      if (shouldRetry && failedRun.status === 'queued') {
        await this.sleep(delay);
        if (!this.stopping) retryRun = failedRun;
      } else {
        this.reportError(error);
      }
    } finally {
      this.activeRun = undefined;
    }
    // Queue the retry only after clearing activeRun. queueSegment deliberately
    // rejects duplicate active segment IDs, and a retry is the one legitimate
    // case that must re-enter the queue with the same segment.
    if (retryRun && !this.stopping) await this.queueSegment(item.segment, retryRun);
  }

  private async pump(): Promise<void> {
    if (this.activeJob || this.stopping) return;
    const item = this.pending.shift();
    if (!item) {
      this.releaseCapacity();
      return;
    }
    this.pendingIds.delete(item.segment.id);
    const operation = this.process(item);
    this.activeJob = operation;
    try {
      await operation;
    } catch (error) {
      // Keep a malformed adapter or store failure from becoming an
      // unhandled rejection that tears down the Core process.
      this.lastIndexFailure = errorMessage(error);
      this.lastIndexFailureAt = this.clock().toISOString();
      this.reportError(error);
    } finally {
      this.activeJob = undefined;
      this.releaseCapacity();
      if (!this.stopping) {
        void this.recoverJobs()
          .then(() => this.pump())
          .catch((error: unknown) => this.reportError(error));
      }
    }
  }

  private readonly runner: RecordingRunner = {
    recordOnce: async (camera, streamUrl, durationMs) => {
      await this.waitForCapacity();
      return this.manager.recordOnce(camera, streamUrl, durationMs);
    },
  };

  async start(): Promise<void> {
    if (this.started) return;
    if (this.backfill.status !== 'completed' && this.backfill.status !== 'skipped') {
      this.status = 'degraded';
      throw new Error('Recording runtime requires completed evidence backfill');
    }
    this.stopping = false;
    try {
      const existing = await this.recordings.list({ camera: this.camera, limit: 100_000 });
      this.bytesCataloged = existing.reduce((total, segment) => total + segment.bytes, 0);
      this.lastSegment = existing.at(-1);
    } catch (error) {
      this.reportError(error);
    }
    await this.recoverJobs();
    this.scheduler = new RecordingScheduler(this.runner, {
      camera: this.camera,
      streamUrl: this.streamUrl,
      segmentDurationMs: this.segmentDurationMs,
      retryDelayMs: this.retryBackoffMs,
      onSegment: (segment) => {
        this.lastSegment = segment;
        this.bytesCataloged += segment.bytes;
        void this.queueSegment(segment).catch((error) => {
          this.lastIndexFailure = errorMessage(error);
          this.lastIndexFailureAt = this.clock().toISOString();
          this.reportError(error);
        });
      },
      onError: (error) => {
        this.recordingErrors += 1;
        this.lastRecordingError = errorMessage(error);
        this.lastRecordingErrorAt = this.clock().toISOString();
        this.reportError(error);
      },
    });
    this.started = true;
    this.status = this.status === 'degraded' ? 'degraded' : 'healthy';
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    if (!this.started && !this.scheduler && !this.activeJob) return;
    this.stopping = true;
    for (const release of this.capacityWaiters.splice(0)) release();
    this.scheduler?.stop();
    // Abort an in-flight FFmpeg segment before waiting for the scheduler. If
    // this is done afterwards, shutdown can block for the full 60s segment.
    this.manager.close?.();
    await this.scheduler?.wait();
    await this.activeJob?.catch(() => undefined);
    this.status = 'stopped';
    this.started = false;
    this.scheduler = undefined;
  }

  async health(): Promise<RecordingRuntimeHealth> {
    const latestRun = this.activeRun;
    return {
      status: this.status,
      mode: 'continuous-economic',
      camera: this.camera,
      segmentDurationMs: this.segmentDurationMs,
      intervalMs: this.intervalMs,
      recording: {
        ...(this.lastSegment ? {
          lastSegment: {
            id: this.lastSegment.id,
            startedAt: this.lastSegment.startedAt,
            endedAt: this.lastSegment.endedAt,
            bytes: this.lastSegment.bytes,
            ...(this.lastSegment.retentionTier ? { retentionTier: this.lastSegment.retentionTier } : {}),
          },
        } : {}),
        errors: this.recordingErrors,
        ...(this.lastRecordingError ? { lastError: this.lastRecordingError } : {}),
        ...(this.lastRecordingErrorAt ? { lastErrorAt: this.lastRecordingErrorAt } : {}),
      },
      indexing: {
        queueLength: this.pending.length,
        maxPending: this.maxPendingSegments,
        backpressure: this.capacity() >= this.maxPendingSegments + 1 || this.capacityWaiters.length > 0,
        ...(latestRun ? { currentJob: { id: latestRun.id, segmentId: latestRun.segmentId, attempts: latestRun.attempts, status: latestRun.status } } : {}),
        ...(this.lastIndexSuccessAt ? { lastSuccessAt: this.lastIndexSuccessAt } : {}),
        ...(this.lastIndexFailureAt ? { lastFailureAt: this.lastIndexFailureAt } : {}),
        ...(this.lastIndexFailure ? { lastFailure: this.lastIndexFailure } : {}),
      },
      backfill: { ...this.backfill },
      bytesCataloged: this.bytesCataloged,
      retention: { ...this.retention, dryRun: true },
    };
  }

  async wait(): Promise<void> {
    await this.scheduler?.wait();
  }
}

export function recordingIndexResultCounts(result: RecordingIndexResult): Pick<RecordingIndexRun, 'framesProcessed' | 'evidenceCount' | 'objectCount' | 'ocrCount'> {
  return {
    framesProcessed: result.framesProcessed,
    evidenceCount: result.evidenceEvents,
    objectCount: result.objectEvents,
    ocrCount: result.ocrEvents,
  };
}
