import type { RecordingRemoteRetentionResult, RecordingRemoteRetentionService } from './recording-remote-retention.js';

export interface RecordingRemoteRetentionSchedulerOptions {
  intervalMs?: number;
  onResult?: (result: RecordingRemoteRetentionResult) => void;
  onError?: (error: unknown) => void;
}

export class RecordingRemoteRetentionScheduler {
  private readonly intervalMs: number;
  private readonly onResult?: (result: RecordingRemoteRetentionResult) => void;
  private readonly onError?: (error: unknown) => void;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly service: Pick<RecordingRemoteRetentionService, 'run'>,
    options: RecordingRemoteRetentionSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
    this.onResult = options.onResult;
    this.onError = options.onError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Remote retention intervalMs must be greater than zero');
    }
  }

  start(): void {
    if (this.timer) return;
    void this.execute();
    this.timer = setInterval(() => { void this.execute(); }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async execute(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.onResult?.(await this.service.run());
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}
