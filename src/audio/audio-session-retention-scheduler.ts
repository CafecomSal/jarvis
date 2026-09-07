import {
  audioSessionDeleteConfirmation,
  type AudioSessionDeleteFilter,
  type AudioSessionDeletePreview,
  type AudioSessionDeleteResult,
} from './audio-session-retention.js';
import type { AudioSessionRetentionSettings } from '../config/runtime-settings.js';

interface RetentionServiceLike {
  preview(filter: AudioSessionDeleteFilter): Promise<AudioSessionDeletePreview>;
  execute(previewId: string, confirmation: string, actor?: string): Promise<AudioSessionDeleteResult>;
}

export interface AudioSessionRetentionSchedulerOptions {
  intervalMs?: number;
  now?: () => Date;
  onResult?: (result: AudioSessionDeleteResult | undefined) => void;
  onError?: (error: unknown) => void;
}

export class AudioSessionRetentionScheduler {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onResult?: (result: AudioSessionDeleteResult | undefined) => void;
  private readonly onError?: (error: unknown) => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly service: RetentionServiceLike,
    private readonly settings: () => Promise<AudioSessionRetentionSettings>,
    options: AudioSessionRetentionSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1_000;
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 1_000) throw new Error('Audio session retention interval is invalid');
  }

  async runOnce(): Promise<AudioSessionDeleteResult | undefined> {
    const settings = await this.settings();
    if (!settings.autoDeleteEnabled) {
      this.onResult?.(undefined);
      return undefined;
    }
    const before = new Date(this.now().getTime() - settings.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    const preview = await this.service.preview({ before, statuses: settings.deletableStatuses });
    if (preview.count === 0) {
      this.onResult?.(undefined);
      return undefined;
    }
    const result = await this.service.execute(preview.previewId, audioSessionDeleteConfirmation(preview.count), 'retention-scheduler');
    this.onResult?.(result);
    return result;
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      void this.runOnce().catch((error) => this.onError?.(error));
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
