export interface RecordingUploadJob {
  id: string;
  status: 'verified' | 'failed';
  attempts: number;
  error?: string;
}

export interface RecordingUploadQueueOptions {
  archive: (recordingId: string) => Promise<unknown>;
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export class RecordingUploadQueue {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(private readonly options: RecordingUploadQueueOptions) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error('Upload maxAttempts must be a positive integer');
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) throw new Error('Upload retryDelayMs must be zero or greater');
  }

  async upload(recordingIds: readonly string[]): Promise<RecordingUploadJob[]> {
    const uniqueIds = [...new Set(recordingIds.map((id) => id.trim()).filter(Boolean))];
    const jobs: RecordingUploadJob[] = [];
    for (const id of uniqueIds) {
      let attempts = 0;
      let lastError = 'upload failed';
      while (attempts < this.maxAttempts) {
        attempts += 1;
        try {
          await this.options.archive(id);
          jobs.push({ id, status: 'verified', attempts });
          lastError = '';
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message.slice(0, 500) : 'upload failed';
          if (attempts < this.maxAttempts) await this.sleep(this.retryDelayMs * 2 ** (attempts - 1));
        }
      }
      if (lastError) jobs.push({ id, status: 'failed', attempts, error: lastError });
    }
    return jobs;
  }
}
