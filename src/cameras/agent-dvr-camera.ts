import type { CameraAdapter, CameraHealth, CameraHealthStatus, CameraSnapshot } from './camera-adapter.js';
import type { SnapshotStore } from './local-snapshot-store.js';

export type AgentDvrCameraErrorCode = Exclude<CameraHealthStatus, 'ok'>;

export class AgentDvrCameraError extends Error {
  constructor(
    readonly code: AgentDvrCameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentDvrCameraError';
  }
}

export interface AgentDvrCameraOptions {
  baseUrl?: string;
  cameras: Record<string, number>;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  snapshotStore?: SnapshotStore;
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentDvrCameraAdapter implements CameraAdapter {
  private readonly baseUrl: string;
  private readonly cameras: Record<string, number>;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly snapshotStore?: SnapshotStore;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: AgentDvrCameraOptions) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8090').replace(/\/+$/, '');
    this.cameras = options.cameras;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? (() => new Date());
    this.snapshotStore = options.snapshotStore;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('Agent DVR maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error('Agent DVR retryDelayMs must be zero or greater');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Agent DVR timeoutMs must be greater than zero');
    }
  }

  private oidFor(camera: string): number {
    const oid = this.cameras[camera];
    if (!Number.isInteger(oid)) {
      throw new AgentDvrCameraError('camera_not_found', `Unknown camera: ${camera}`);
    }
    return oid;
  }

  private async request(camera: string, oid: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(
        `${this.baseUrl}/liveimage.jpg?oid=${encodeURIComponent(String(oid))}`,
        { headers: { accept: 'image/jpeg' }, signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted || errorName(error) === 'AbortError') {
        throw new AgentDvrCameraError('timeout', `Agent DVR timed out while reading camera ${camera}`);
      }
      throw new AgentDvrCameraError('agent_dvr_unavailable', `Agent DVR request failed: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private responseError(status: number): AgentDvrCameraError {
    if (status === 404) {
      return new AgentDvrCameraError('camera_not_found', `Agent DVR returned HTTP ${status}`);
    }
    if (status === 429 || status >= 500) {
      return new AgentDvrCameraError('agent_dvr_unavailable', `Agent DVR returned HTTP ${status}`);
    }
    return new AgentDvrCameraError('unexpected_response', `Agent DVR returned HTTP ${status}`);
  }

  private isRetryable(error: AgentDvrCameraError): boolean {
    return error.code === 'timeout' || error.code === 'agent_dvr_unavailable';
  }

  private async fetchImage(camera: string, oid: number, maxAttempts: number): Promise<CameraSnapshot> {
    let lastError: AgentDvrCameraError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.request(camera, oid);
        if (!response.ok) throw this.responseError(response.status);

        const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0];
        if (!mimeType.startsWith('image/')) {
          throw new AgentDvrCameraError(
            'unexpected_response',
            `Agent DVR returned an unexpected content type: ${mimeType || 'unknown'}`,
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
          throw new AgentDvrCameraError('unexpected_response', 'Agent DVR returned an empty snapshot');
        }

        return {
          camera,
          sourceType: 'agent_dvr',
          sourceId: String(oid),
          oid,
          capturedAt: this.clock().toISOString(),
          mimeType,
          bytes: buffer.length,
          base64: buffer.toString('base64'),
        };
      } catch (error) {
        lastError = error instanceof AgentDvrCameraError
          ? error
          : new AgentDvrCameraError('agent_dvr_unavailable', `Agent DVR request failed: ${errorMessage(error)}`);
        if (attempt >= maxAttempts || !this.isRetryable(lastError)) throw lastError;
        await this.sleep(this.retryDelayMs);
      }
    }
    throw lastError ?? new AgentDvrCameraError('agent_dvr_unavailable', 'Agent DVR request failed');
  }

  async snapshot(camera: string): Promise<CameraSnapshot> {
    const oid = this.oidFor(camera);
    const snapshot = await this.fetchImage(camera, oid, this.maxAttempts);
    if (this.snapshotStore) {
      snapshot.imageRef = await this.snapshotStore.save(snapshot);
    }
    return snapshot;
  }

  async health(camera: string): Promise<CameraHealth> {
    const checkedAt = this.clock().toISOString();
    const oid = this.cameras[camera];
    if (!Number.isInteger(oid)) {
      return {
        camera,
        status: 'camera_not_found',
        checkedAt,
        detail: `Unknown camera: ${camera}`,
      };
    }

    try {
      await this.fetchImage(camera, oid, this.maxAttempts);
      return { camera, oid, status: 'ok', checkedAt };
    } catch (error) {
      const cameraError = error instanceof AgentDvrCameraError
        ? error
        : new AgentDvrCameraError('agent_dvr_unavailable', errorMessage(error));
      return {
        camera,
        oid,
        status: cameraError.code,
        checkedAt,
        detail: cameraError.message,
      };
    }
  }
}
