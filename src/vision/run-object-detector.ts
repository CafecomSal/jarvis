import { access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RtspCameraAdapter, type RtspTransport } from '../cameras/rtsp-camera.js';
import { LocalSnapshotStore } from '../cameras/local-snapshot-store.js';
import { InMemoryEventStore, type EventAppender } from '../events/in-memory-event-store.js';
import { HttpEventPublisher } from '../events/http-event-publisher.js';
import {
  COCO_CLASS_NAMES,
} from './onnx-person-detector.js';
import {
  createOnnxObjectDetectionWorker,
  type OnnxObjectDetectionWorkerOptions,
} from './object-detection-worker.js';

const DEFAULT_CLASSES = ['person', 'car', 'motorcycle', 'bicycle', 'cat', 'dog', 'truck'];

type Environment = Record<string, string | undefined>;

export interface ObjectDetectorOptions {
  camera: string;
  modelPath: string;
  classes: string[];
  confidenceThreshold: number;
  confirmationFrames: number;
  confirmationWindowMs: number;
  rtspTransport: RtspTransport;
  inputSize: number;
  once: boolean;
  dryRun: boolean;
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

function parseClasses(value: string | undefined): string[] {
  const raw = value?.trim() || DEFAULT_CLASSES.join(',');
  const classes = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
  if (classes.length === 0) throw new Error('JARVIS_OBJECT_DETECTOR_CLASSES must not be empty');
  for (const className of classes) {
    if (!COCO_CLASS_NAMES.includes(className as typeof COCO_CLASS_NAMES[number])) {
      throw new Error(`JARVIS_OBJECT_DETECTOR_CLASSES contains unsupported class: ${className}`);
    }
  }
  return classes;
}

export function parseObjectDetectorOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): ObjectDetectorOptions {
  const supported = new Set(['--once', '--dry-run', '--publish']);
  const unknown = argv.find((argument) => !supported.has(argument));
  if (unknown) throw new Error(`Unknown object detector argument: ${unknown}`);
  if (argv.includes('--dry-run') && argv.includes('--publish')) {
    throw new Error('Object detector cannot combine --dry-run and --publish');
  }

  const camera = env.JARVIS_DETECTOR_CAMERA?.trim() || 'front';
  const modelPath = env.JARVIS_ONNX_MODEL_PATH?.trim() || 'models/yolo11n.onnx';
  const confidenceThreshold = parseNumber(
    'JARVIS_OBJECT_DETECTOR_CONFIDENCE_THRESHOLD',
    env.JARVIS_OBJECT_DETECTOR_CONFIDENCE_THRESHOLD,
    0.35,
  );
  const confirmationFrames = parsePositiveInteger(
    'JARVIS_OBJECT_DETECTOR_CONFIRMATION_FRAMES',
    env.JARVIS_OBJECT_DETECTOR_CONFIRMATION_FRAMES,
    2,
  );
  const confirmationWindowMs = parseNumber(
    'JARVIS_OBJECT_DETECTOR_CONFIRMATION_WINDOW_MS',
    env.JARVIS_OBJECT_DETECTOR_CONFIRMATION_WINDOW_MS,
    5_000,
  );
  const inputSize = parsePositiveInteger('JARVIS_ONNX_INPUT_SIZE', env.JARVIS_ONNX_INPUT_SIZE, 640);
  if (!camera) throw new Error('JARVIS_DETECTOR_CAMERA must not be empty');
  if (!modelPath) throw new Error('JARVIS_ONNX_MODEL_PATH must not be empty');
  if (confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error('JARVIS_OBJECT_DETECTOR_CONFIDENCE_THRESHOLD must be between 0 and 1');
  }
  if (confirmationWindowMs <= 0) {
    throw new Error('JARVIS_OBJECT_DETECTOR_CONFIRMATION_WINDOW_MS must be greater than zero');
  }
  return {
    camera,
    modelPath,
    classes: parseClasses(env.JARVIS_OBJECT_DETECTOR_CLASSES),
    confidenceThreshold,
    confirmationFrames,
    confirmationWindowMs,
    rtspTransport: parseTransport(env.JARVIS_RTSP_TRANSPORT),
    inputSize,
    once: argv.includes('--once'),
    dryRun: !argv.includes('--publish'),
  };
}

function cameraStreamEnvName(camera: string): string {
  const normalized = camera.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `JARVIS_CAMERA_${normalized}_RTSP_URL`;
}

async function buildWorker(options: ObjectDetectorOptions) {
  const modelPath = resolve(options.modelPath);
  await access(modelPath);
  const streamUrl = process.env[cameraStreamEnvName(options.camera)]?.trim();
  if (!streamUrl) throw new Error(`${cameraStreamEnvName(options.camera)} is required for the RTSP camera`);
  const events: EventAppender = options.dryRun
    ? new InMemoryEventStore()
    : new HttpEventPublisher({ baseUrl: process.env.JARVIS_CORE_BASE_URL ?? 'http://127.0.0.1:3000' });
  const snapshotStore = new LocalSnapshotStore(process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots');
  const camera = new RtspCameraAdapter({
    streams: { [options.camera]: streamUrl },
    transport: options.rtspTransport,
    ffmpegPath: process.env.FFMPEG_PATH,
    snapshotStore,
  });
  const workerOptions: OnnxObjectDetectionWorkerOptions = {
    camera,
    events,
    modelPath,
    inputSize: options.inputSize,
    confidenceThreshold: options.confidenceThreshold,
    confirmationFrames: options.once ? 1 : options.confirmationFrames,
    confirmationWindowMs: options.confirmationWindowMs,
    targetClasses: options.classes,
    cameraLocations: { [options.camera]: process.env.JARVIS_CAMERA_FRONT_LOCATION ?? 'frente' },
    model: basename(modelPath),
    provider: 'CPUExecutionProvider',
  };
  return createOnnxObjectDetectionWorker(workerOptions);
}

export async function runObjectDetector(options: ObjectDetectorOptions): Promise<void> {
  if (!options.once) {
    throw new Error('Object detector currently requires --once; continuous mode will be added with dedicated status metrics');
  }
  const worker = await buildWorker(options);
  console.log(JSON.stringify(await worker.detectOnce(options.camera)));
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runObjectDetector(parseObjectDetectorOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
