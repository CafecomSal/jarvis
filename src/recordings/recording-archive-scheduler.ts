import type { RecordingStore } from './recording-store.js';
import { RecordingUploadQueue, type RecordingUploadJob } from './recording-upload-queue.js';

export interface RecordingArchiveSchedulerOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export class RecordingArchiveScheduler {
  private readonly store: RecordingStore;
  private readonly queue: RecordingUploadQueue;
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    store: RecordingStore,
    queue: RecordingUploadQueue,
    options: RecordingArchiveSchedulerOptions = {},
  ) {
    this.store = store;
    this.queue = queue;
    this.intervalMs = options.intervalMs ?? 60 * 60 * 1000;
    this.onError = options.onError ?? (() => undefined);
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Recording archive interval must be greater than zero');
    }
  }

  async runOnce(): Promise<RecordingUploadJob[]> {
    const segments = await this.store.list({ limit: 10_000 });
    const pending = segments
      .filter((segment) => ['local', 'queued', 'failed'].includes(segment.backupStatus))
      .map((segment) => segment.id);
    if (pending.length === 0) return [];
    return this.queue.upload(pending);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce()
        .catch((error: unknown) => this.onError(error))
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
