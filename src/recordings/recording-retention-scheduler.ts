import type { RecordingRetentionResult } from './recording-retention.js';

export interface RecordingRetentionRunner {
  run(): Promise<RecordingRetentionResult>;
}

export interface RecordingRetentionSchedulerOptions {
  intervalMs?: number;
  onResult?: (result: RecordingRetentionResult) => void;
  onError?: (error: unknown) => void;
  onOverlapSkipped?: () => void;
}

export class RecordingRetentionScheduler {
  private readonly intervalMs: number;
  private readonly onResult?: (result: RecordingRetentionResult) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onOverlapSkipped?: () => void;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly runner: RecordingRetentionRunner,
    options: RecordingRetentionSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.onOverlapSkipped = options.onOverlapSkipped;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Recording retention intervalMs must be greater than zero');
    }
  }

  start(): void {
    if (this.timer) return;
    void this.execute();
    this.timer = setInterval(() => {
      void this.execute();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async execute(): Promise<void> {
    if (this.running) {
      this.onOverlapSkipped?.();
      return;
    }
    this.running = true;
    try {
      const result = await this.runner.run();
      this.onResult?.(result);
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}
