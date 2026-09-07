import { HomeEventSchema, type HomeEvent } from './schema.js';

export interface HttpEventPublisherOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

class CoreEventPublishError extends Error {
  constructor(
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'CoreEventPublishError';
  }
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : undefined;
}

export class HttpEventPublisher {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: HttpEventPublisherOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 5_000;

    if (!this.baseUrl.trim()) throw new Error('Core event publisher baseUrl must not be empty');
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('Core event publisher maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error('Core event publisher retryDelayMs must be zero or greater');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Core event publisher timeoutMs must be greater than zero');
    }
  }

  private async send(event: HomeEvent): Promise<HomeEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new CoreEventPublishError(
          retryable,
          `Core event publish failed with HTTP ${response.status}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new CoreEventPublishError(false, 'Core event publish returned invalid JSON');
      }
      const parsed = HomeEventSchema.safeParse(body);
      if (!parsed.success) {
        throw new CoreEventPublishError(false, 'Core event publish returned an invalid event');
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof CoreEventPublishError) throw error;
      if (controller.signal.aborted || errorName(error) === 'AbortError') {
        throw new CoreEventPublishError(true, 'Core event publish timed out');
      }
      throw new CoreEventPublishError(true, 'Core event publish request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  async append(event: HomeEvent): Promise<HomeEvent> {
    const validated = HomeEventSchema.parse(event);
    let lastError: CoreEventPublishError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.send(validated);
      } catch (error) {
        lastError = error instanceof CoreEventPublishError
          ? error
          : new CoreEventPublishError(true, 'Core event publish request failed');
        if (attempt >= this.maxAttempts || !lastError.retryable) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError ?? new CoreEventPublishError(true, 'Core event publish request failed');
  }
}
