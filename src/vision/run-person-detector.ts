import { access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RtspCameraAdapter, type RtspTransport } from '../cameras/rtsp-camera.js';
import { LocalSnapshotStore } from '../cameras/local-snapshot-store.js';
import { InMemoryEventStore, type EventAppender } from '../events/in-memory-event-store.js';
import { HttpEventPublisher } from '../events/http-event-publisher.js';
import {
  createOnnxPersonDetectionWorker,
  PersonDetectionScheduler,
} from './onnx-person-detector.js';
import {
  DetectorStatusFileWriter,
  DetectorStatusTracker,
} from './detector-status.js';
import type { DetectionBox, OnnxPersonDetectionWorkerOptions } from './onnx-person-detector.js';

export interface DetectorOptions {
  camera: string;
  modelPath: string;
  intervalMs: number;
  confidenceThreshold: number;
  rtspTransport: RtspTransport;
  confirmationFrames: number;
  confirmationWindowMs: number;
  dryRun: boolean;
  once: boolean;
  statusFile: string;
  excludedRegions?: Record<string, DetectionBox[]>;
}

type Environment = Record<string, string | undefined>;

export interface DetectorParentMonitorDependencies {
  isAlive?: (pid: number) => boolean;
  setInterval?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  onParentGone?: () => void;
}

export function startDetectorParentMonitor(
  rawParentPid: string | undefined,
  dependencies: DetectorParentMonitorDependencies = {},
): () => void {
  const parentPid = Number(rawParentPid);
  if (!Number.isInteger(parentPid) || parentPid < 1) return () => undefined;

  const isAlive = dependencies.isAlive ?? ((pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const setMonitorInterval = dependencies.setInterval
    ?? ((callback: () => void, delayMs: number) => setInterval(callback, delayMs));
  const clearMonitorInterval = dependencies.clearInterval ?? clearInterval;
  const onParentGone = dependencies.onParentGone
    ?? (() => process.kill(process.pid, 'SIGTERM'));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearMonitorInterval(timer);
  };

  timer = setMonitorInterval(() => {
    if (!stopped && !isAlive(parentPid)) {
      cleanup();
      onParentGone();
    }
  }, 1_000);
  return cleanup;
}

function parseNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = parseNumber(name, value, fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseTransport(value: string | undefined): RtspTransport {
  const transport = value?.trim() || 'udp';
  if (transport !== 'udp' && transport !== 'tcp') {
    throw new Error('JARVIS_RTSP_TRANSPORT must be udp or tcp');
  }
  return transport;
}

function parseExcludedRegions(raw: string | undefined): Record<string, DetectionBox[]> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JARVIS_DETECTOR_EXCLUDED_REGIONS must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JARVIS_DETECTOR_EXCLUDED_REGIONS must be a JSON object');
  }

  const regions: Record<string, DetectionBox[]> = {};
  for (const [camera, cameraRegions] of Object.entries(parsed)) {
    if (!Array.isArray(cameraRegions)) {
      throw new Error(`JARVIS_DETECTOR_EXCLUDED_REGIONS for ${camera} must be an array`);
    }
    regions[camera] = cameraRegions.map((region) => {
      if (region === null || typeof region !== 'object' || Array.isArray(region)) {
        throw new Error('JARVIS_DETECTOR_EXCLUDED_REGIONS contains an invalid region');
      }
      const candidate = region as Record<string, unknown>;
      const values = [candidate.x1, candidate.y1, candidate.x2, candidate.y2];
      if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('JARVIS_DETECTOR_EXCLUDED_REGIONS contains an invalid region');
      }
      const [x1, y1, x2, y2] = values as number[];
      if (x2 <= x1 || y2 <= y1) {
        throw new Error('JARVIS_DETECTOR_EXCLUDED_REGIONS contains an invalid region');
      }
      return { x1, y1, x2, y2 };
    });
  }
  return regions;
}

export function parseDetectorOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): DetectorOptions {
  const supported = new Set(['--once', '--dry-run', '--publish']);
  const unknown = argv.find((argument) => !supported.has(argument));
  if (unknown) throw new Error(`Unknown detector argument: ${unknown}`);
  if (argv.includes('--dry-run') && argv.includes('--publish')) {
    throw new Error('Detector cannot combine --dry-run and --publish');
  }

  const camera = env.JARVIS_DETECTOR_CAMERA?.trim() || 'front';
  const modelPath = env.JARVIS_ONNX_MODEL_PATH?.trim() || 'models/yolo11n.onnx';
  const intervalMs = parseNumber('JARVIS_DETECTOR_INTERVAL_MS', env.JARVIS_DETECTOR_INTERVAL_MS, 1_000);
  const confidenceThreshold = parseNumber(
    'JARVIS_DETECTOR_CONFIDENCE_THRESHOLD',
    env.JARVIS_DETECTOR_CONFIDENCE_THRESHOLD,
    0.35,
  );
  const confirmationFrames = parsePositiveInteger(
    'JARVIS_DETECTOR_CONFIRMATION_FRAMES',
    env.JARVIS_DETECTOR_CONFIRMATION_FRAMES,
    2,
  );
  const confirmationWindowMs = parseNumber(
    'JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS',
    env.JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS,
    5_000,
  );
  const rtspTransport = parseTransport(env.JARVIS_RTSP_TRANSPORT);
  const excludedRegions = parseExcludedRegions(env.JARVIS_DETECTOR_EXCLUDED_REGIONS);
  const statusFile = env.JARVIS_DETECTOR_STATUS_FILE?.trim() || 'data/detector/status.json';
  if (!camera) throw new Error('JARVIS_DETECTOR_CAMERA must not be empty');
  if (!modelPath) throw new Error('JARVIS_ONNX_MODEL_PATH must not be empty');
  if (intervalMs <= 0) throw new Error('JARVIS_DETECTOR_INTERVAL_MS must be greater than zero');
  if (confirmationWindowMs <= 0) {
    throw new Error('JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS must be greater than zero');
  }
  if (confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error('JARVIS_DETECTOR_CONFIDENCE_THRESHOLD must be between 0 and 1');
  }
  return {
    camera,
    modelPath,
    intervalMs,
    confidenceThreshold,
    rtspTransport,
    confirmationFrames,
    confirmationWindowMs,
    dryRun: !argv.includes('--publish'),
    once: argv.includes('--once'),
    statusFile,
    ...(excludedRegions ? { excludedRegions } : {}),
  };
}

export interface DetectorEventAppenderOptions {
  dryRun: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createDetectorEventAppender(
  options: DetectorEventAppenderOptions,
): EventAppender {
  if (options.dryRun) return new InMemoryEventStore();
  return new HttpEventPublisher({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

function cameraStreamEnvName(camera: string): string {
  const normalized = camera.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `JARVIS_CAMERA_${normalized}_RTSP_URL`;
}

async function buildWorker(options: DetectorOptions) {
  const modelPath = resolve(options.modelPath);
  await access(modelPath);
  const streamEnvName = cameraStreamEnvName(options.camera);
  const streamUrl = process.env[streamEnvName]?.trim();
  if (!streamUrl) throw new Error(`${streamEnvName} is required for the RTSP camera`);
  const events = createDetectorEventAppender({
    dryRun: options.dryRun,
    baseUrl: process.env.JARVIS_CORE_BASE_URL ?? 'http://127.0.0.1:3000',
  });
  const snapshotStore = new LocalSnapshotStore(process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots');
  const camera = new RtspCameraAdapter({
    streams: { [options.camera]: streamUrl },
    transport: options.rtspTransport,
    ffmpegPath: process.env.FFMPEG_PATH,
    snapshotStore,
  });
  const workerOptions: OnnxPersonDetectionWorkerOptions = {
    camera,
    events,
    modelPath,
    inputSize: parseNumber('JARVIS_ONNX_INPUT_SIZE', process.env.JARVIS_ONNX_INPUT_SIZE, 640),
    confidenceThreshold: options.confidenceThreshold,
    confirmationFrames: options.confirmationFrames,
    confirmationWindowMs: options.confirmationWindowMs,
    excludedRegions: options.excludedRegions,
    cameraLocations: { [options.camera]: process.env.JARVIS_CAMERA_FRONT_LOCATION ?? 'frente' },
    model: basename(modelPath),
    provider: 'CPUExecutionProvider',
  };
  return { events, worker: createOnnxPersonDetectionWorker(workerOptions) };
}

export async function runDetector(options: DetectorOptions): Promise<void> {
  const status = new DetectorStatusTracker({
    camera: options.camera,
    model: basename(resolve(options.modelPath)),
    provider: 'CPUExecutionProvider',
    mode: options.dryRun ? 'dry-run' : 'publish',
  });
  const statusWriter = new DetectorStatusFileWriter(options.statusFile);
  const persistStatus = async (): Promise<void> => {
    try {
      await statusWriter.write(status.snapshot());
    } catch (error) {
      console.error(
        '[detector-status] Could not write status:',
        error instanceof Error ? error.message : error,
      );
    }
  };

  await persistStatus();
  let worker: Awaited<ReturnType<typeof buildWorker>>['worker'];
  try {
    worker = (await buildWorker(options)).worker;
  } catch (error) {
    status.recordError(error);
    status.stop();
    await persistStatus();
    throw error;
  }
  status.markRunning();
  await persistStatus();

  if (options.once) {
    try {
      const result = await worker.detectOnce(options.camera);
      status.recordResult(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      status.recordError(error);
      throw error;
    } finally {
      status.stop();
      await persistStatus();
    }
    return;
  }

  const scheduler = new PersonDetectionScheduler(worker, options.camera, {
    intervalMs: options.intervalMs,
    onResult: (result) => {
      status.recordResult(result);
      void persistStatus();
      if (result.detected) console.log(JSON.stringify(result));
    },
    onError: (error) => {
      status.recordError(error);
      void persistStatus();
      console.error('Person detector failed:', error instanceof Error ? error.message : error);
    },
    onOverlapSkipped: () => {
      status.recordSkippedOverlap();
      void persistStatus();
    },
  });
  let shuttingDown = false;
  const stopParentMonitor = startDetectorParentMonitor(process.env.JARVIS_DETECTOR_PARENT_PID);
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopParentMonitor();
    scheduler.stop();
    status.stop();
    await persistStatus();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  scheduler.start();
  console.log(`ONNX person detector running: camera=${options.camera} intervalMs=${options.intervalMs} mode=${options.dryRun ? 'dry-run' : 'publish'} statusFile=${options.statusFile}`);
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runDetector(parseDetectorOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
