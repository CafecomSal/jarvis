import type { RecordingSegment } from './recording-store.js';

export interface RecordingRunner {
  recordOnce(camera: string, streamUrl: string, durationMs: number): Promise<RecordingSegment>;
}

export interface RecordingSchedulerOptions {
  camera: string;
  streamUrl: string;
  segmentDurationMs: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onSegment?: (segment: RecordingSegment) => void;
  onError?: (error: unknown) => void;
}

export class RecordingScheduler {
  private readonly camera: string;
  private readonly streamUrl: string;
  private readonly segmentDurationMs: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onSegment?: (segment: RecordingSegment) => void;
  private readonly onError?: (error: unknown) => void;
  private stopping = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly runner: RecordingRunner,
    options: RecordingSchedulerOptions,
  ) {
    this.camera = options.camera.trim();
    this.streamUrl = options.streamUrl.trim();
    this.segmentDurationMs = options.segmentDurationMs;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onSegment = options.onSegment;
    this.onError = options.onError;
    if (!this.camera) throw new Error('Recording scheduler camera must not be empty');
    if (!this.streamUrl) throw new Error('Recording scheduler streamUrl must not be empty');
    if (!Number.isInteger(this.segmentDurationMs) || this.segmentDurationMs <= 0) {
      throw new Error('Recording scheduler segmentDurationMs must be a positive integer');
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error('Recording scheduler retryDelayMs must be zero or greater');
    }
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.runLoop();
  }

  stop(): void {
    this.stopping = true;
  }

  async wait(): Promise<void> {
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.stopping) {
        try {
          const segment = await this.runner.recordOnce(
            this.camera,
            this.streamUrl,
            this.segmentDurationMs,
          );
          this.onSegment?.(segment);
        } catch (error) {
          this.onError?.(error);
          if (this.stopping) break;
          await this.sleep(this.retryDelayMs);
        }
      }
    } finally {
      this.loopPromise = undefined;
    }
  }
}
