import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PersonDetectionResult } from './onnx-person-detector.js';

export type DetectorRunMode = 'dry-run' | 'publish';
export type DetectorStatusState = 'starting' | 'healthy' | 'degraded' | 'stopped';

export interface DetectorStatusSnapshot {
  schemaVersion: 1;
  state: DetectorStatusState;
  mode: DetectorRunMode;
  camera: string;
  model: string;
  provider: string;
  pid?: number;
  startedAt: string;
  updatedAt: string;
  attempts: number;
  successes: number;
  detectedSamples: number;
  detections: number;
  confirmedSamples: number;
  eventsEmitted: number;
  skippedOverlaps: number;
  errors: number;
  consecutiveErrors: number;
  lastResultAt?: string;
  lastLatencyMs?: number;
  lastErrorAt?: string;
  lastError?: string;
}

export interface DetectorStatusTrackerOptions {
  camera: string;
  model: string;
  provider: string;
  mode: DetectorRunMode;
  clock?: () => Date;
}

export type DetectorStatusHealthReason = 'healthy' | 'stale' | 'degraded' | 'stopped' | 'starting' | 'not_running';

export interface DetectorStatusHealth {
  healthy: boolean;
  reason: DetectorStatusHealthReason;
  ageMs: number;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function evaluateDetectorStatus(
  status: DetectorStatusSnapshot,
  now = new Date(),
  maxAgeMs = 30_000,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive,
): DetectorStatusHealth {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('Detector status maxAgeMs must be zero or greater');
  }
  const updatedAtMs = Date.parse(status.updatedAt);
  const nowMs = now.getTime();
  const ageMs = Number.isFinite(updatedAtMs) && Number.isFinite(nowMs)
    ? Math.max(0, nowMs - updatedAtMs)
    : Number.POSITIVE_INFINITY;
  if (status.state === 'starting') return { healthy: false, reason: 'starting', ageMs };
  if (status.state === 'degraded') return { healthy: false, reason: 'degraded', ageMs };
  if (status.state === 'stopped') return { healthy: false, reason: 'stopped', ageMs };
  if (status.pid !== undefined && !isProcessAlive(status.pid)) {
    return { healthy: false, reason: 'not_running', ageMs };
  }
  if (ageMs > maxAgeMs) return { healthy: false, reason: 'stale', ageMs };
  return { healthy: true, reason: 'healthy', ageMs };
}

function redactSensitiveText(message: string): string {
  return message.replace(/rtsps?:\/\/[^\s'"`]+/gi, '[REDACTED_RTSP_URL]');
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}

export class DetectorStatusTracker {
  private readonly clock: () => Date;
  private readonly startedAt: string;
  private state: DetectorStatusState = 'starting';
  private updatedAt: string;
  private attempts = 0;
  private successes = 0;
  private detectedSamples = 0;
  private detections = 0;
  private confirmedSamples = 0;
  private eventsEmitted = 0;
  private skippedOverlaps = 0;
  private errors = 0;
  private consecutiveErrors = 0;
  private lastResultAt?: string;
  private lastLatencyMs?: number;
  private lastErrorAt?: string;
  private lastError?: string;

  constructor(private readonly options: DetectorStatusTrackerOptions) {
    this.clock = options.clock ?? (() => new Date());
    if (!options.camera.trim()) throw new Error('Detector status camera must not be empty');
    if (!options.model.trim()) throw new Error('Detector status model must not be empty');
    if (!options.provider.trim()) throw new Error('Detector status provider must not be empty');
    this.startedAt = this.clock().toISOString();
    this.updatedAt = this.startedAt;
  }

  private touch(): string {
    this.updatedAt = this.clock().toISOString();
    return this.updatedAt;
  }

  markRunning(): void {
    this.state = 'healthy';
    this.touch();
  }

  recordResult(result: PersonDetectionResult): void {
    this.attempts += 1;
    this.successes += 1;
    if (result.detected) this.detectedSamples += 1;
    this.detections += result.detections.length;
    if (result.confirmed) this.confirmedSamples += 1;
    if (result.eventId !== undefined) this.eventsEmitted += 1;
    this.consecutiveErrors = 0;
    this.state = 'healthy';
    this.lastResultAt = this.touch();
    if (Number.isFinite(result.latencyMs)) this.lastLatencyMs = result.latencyMs;
  }

  recordSkippedOverlap(): void {
    this.skippedOverlaps += 1;
    this.touch();
  }

  recordError(error: unknown): void {
    this.attempts += 1;
    this.errors += 1;
    this.consecutiveErrors += 1;
    this.state = 'degraded';
    this.lastErrorAt = this.touch();
    this.lastError = errorMessage(error);
  }

  stop(): void {
    this.state = 'stopped';
    this.touch();
  }

  snapshot(): DetectorStatusSnapshot {
    return {
      schemaVersion: 1,
      state: this.state,
      mode: this.options.mode,
      camera: this.options.camera,
      model: this.options.model,
      provider: this.options.provider,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      attempts: this.attempts,
      successes: this.successes,
      detectedSamples: this.detectedSamples,
      detections: this.detections,
      confirmedSamples: this.confirmedSamples,
      eventsEmitted: this.eventsEmitted,
      skippedOverlaps: this.skippedOverlaps,
      errors: this.errors,
      consecutiveErrors: this.consecutiveErrors,
      ...(this.lastResultAt === undefined ? {} : { lastResultAt: this.lastResultAt }),
      ...(this.lastLatencyMs === undefined ? {} : { lastLatencyMs: this.lastLatencyMs }),
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }
}

export class DetectorStatusFileWriter {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error('Detector status file path must not be empty');
  }

  write(status: DetectorStatusSnapshot): Promise<void> {
    const operation = this.pending.then(async () => {
      const destination = resolve(this.filePath);
      const temporary = `${destination}.${process.pid}.tmp`;
      await mkdir(dirname(destination), { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
