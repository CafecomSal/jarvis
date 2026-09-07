import { spawn } from 'node:child_process';
import type {
  CameraAdapter,
  CameraHealth,
  CameraHealthStatus,
  CameraSnapshot,
} from './camera-adapter.js';
import type { SnapshotStore } from './local-snapshot-store.js';

export type RtspTransport = 'udp' | 'tcp';
export type RtspCameraErrorCode = Exclude<CameraHealthStatus, 'ok' | 'agent_dvr_unavailable'>;

export class RtspCameraError extends Error {
  constructor(
    readonly code: RtspCameraErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RtspCameraError';
  }
}

export interface RtspFrameCaptureOptions {
  ffmpegPath: string;
  transport: RtspTransport;
  timeoutMs: number;
}

export type RtspFrameCapture = (
  streamUrl: string,
  options: RtspFrameCaptureOptions,
) => Promise<Buffer>;

export interface RtspCameraOptions {
  streams: Record<string, string>;
  transport?: RtspTransport;
  ffmpegPath?: string;
  clock?: () => Date;
  snapshotStore?: SnapshotStore;
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  captureFrame?: RtspFrameCapture;
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : undefined;
}

function captureRtspFrame(
  streamUrl: string,
  options: RtspFrameCaptureOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(options.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      options.transport,
      '-i',
      streamUrl,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ], { windowsHide: true });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new RtspCameraError('timeout', 'RTSP camera capture timed out'));
    }, options.timeoutMs);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => {
      finish(() => reject(new RtspCameraError('rtsp_unavailable', 'RTSP camera process could not start')));
    });
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new RtspCameraError('rtsp_unavailable', 'FFmpeg could not capture an RTSP frame'));
          return;
        }
        const frame = Buffer.concat(chunks);
        if (frame.length === 0) {
          reject(new RtspCameraError('unexpected_response', 'FFmpeg returned an empty RTSP frame'));
          return;
        }
        resolve(frame);
      });
    });
    child.stdin.end();
  });
}

export class RtspCameraAdapter implements CameraAdapter {
  private readonly streams: Record<string, string>;
  private readonly transport: RtspTransport;
  private readonly ffmpegPath: string;
  private readonly clock: () => Date;
  private readonly snapshotStore?: SnapshotStore;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly captureFrame: RtspFrameCapture;

  constructor(options: RtspCameraOptions) {
    this.streams = { ...options.streams };
    this.transport = options.transport ?? 'udp';
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.clock = options.clock ?? (() => new Date());
    this.snapshotStore = options.snapshotStore;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.captureFrame = options.captureFrame ?? captureRtspFrame;

    if (this.transport !== 'udp' && this.transport !== 'tcp') {
      throw new Error('RTSP transport must be udp or tcp');
    }
    if (!this.ffmpegPath.trim()) throw new Error('RTSP ffmpegPath must not be empty');
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('RTSP maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new Error('RTSP retryDelayMs must be zero or greater');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('RTSP timeoutMs must be greater than zero');
    }

    for (const [camera, streamUrl] of Object.entries(this.streams)) {
      if (!camera.trim()) throw new Error('RTSP camera name must not be empty');
      if (!streamUrl.trim()) throw new Error(`RTSP stream URL for camera ${camera} must not be empty`);
      let parsed: URL;
      try {
        parsed = new URL(streamUrl);
      } catch {
        throw new Error(`RTSP stream URL for camera ${camera} is invalid`);
      }
      if (parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') {
        throw new Error(`RTSP stream URL for camera ${camera} must use rtsp:// or rtsps://`);
      }
    }
  }

  private streamFor(camera: string): string {
    const streamUrl = this.streams[camera];
    if (!streamUrl) throw new RtspCameraError('camera_not_found', `Unknown RTSP camera: ${camera}`);
    return streamUrl;
  }

  private isRetryable(error: RtspCameraError): boolean {
    return error.code === 'timeout' || error.code === 'rtsp_unavailable';
  }

  private async readFrame(camera: string): Promise<Buffer> {
    const streamUrl = this.streamFor(camera);
    let lastError: RtspCameraError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const frame = await this.captureFrame(streamUrl, {
          ffmpegPath: this.ffmpegPath,
          transport: this.transport,
          timeoutMs: this.timeoutMs,
        });
        if (frame.length === 0) {
          throw new RtspCameraError('unexpected_response', 'RTSP camera returned an empty frame');
        }
        return frame;
      } catch (error) {
        lastError = error instanceof RtspCameraError
          ? error
          : new RtspCameraError(
            errorName(error) === 'AbortError' ? 'timeout' : 'rtsp_unavailable',
            errorName(error) === 'AbortError'
              ? 'RTSP camera capture timed out'
              : 'RTSP camera request failed',
          );
        if (attempt >= this.maxAttempts || !this.isRetryable(lastError)) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError ?? new RtspCameraError('rtsp_unavailable', 'RTSP camera request failed');
  }

  private async snapshotWithoutStore(camera: string): Promise<CameraSnapshot> {
    const frame = await this.readFrame(camera);
    return {
      camera,
      sourceType: 'rtsp',
      sourceId: camera,
      capturedAt: this.clock().toISOString(),
      mimeType: 'image/jpeg',
      bytes: frame.length,
      base64: frame.toString('base64'),
    };
  }

  async snapshot(camera: string): Promise<CameraSnapshot> {
    const snapshot = await this.snapshotWithoutStore(camera);
    if (this.snapshotStore) snapshot.imageRef = await this.snapshotStore.save(snapshot);
    return snapshot;
  }

  async health(camera: string): Promise<CameraHealth> {
    const checkedAt = this.clock().toISOString();
    if (!this.streams[camera]) {
      return {
        camera,
        sourceType: 'rtsp',
        sourceId: camera,
        status: 'camera_not_found',
        checkedAt,
        detail: `Unknown RTSP camera: ${camera}`,
      };
    }

    try {
      await this.readFrame(camera);
      return {
        camera,
        sourceType: 'rtsp',
        sourceId: camera,
        status: 'ok',
        checkedAt,
      };
    } catch (error) {
      const cameraError = error instanceof RtspCameraError
        ? error
        : new RtspCameraError('rtsp_unavailable', 'RTSP camera request failed');
      return {
        camera,
        sourceType: 'rtsp',
        sourceId: camera,
        status: cameraError.code,
        checkedAt,
        detail: cameraError.message,
      };
    }
  }
}
