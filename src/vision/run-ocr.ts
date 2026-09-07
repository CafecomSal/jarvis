import { RtspCameraAdapter, type RtspTransport } from '../cameras/rtsp-camera.js';
import { LocalSnapshotStore } from '../cameras/local-snapshot-store.js';
import { InMemoryEventStore, type EventAppender } from '../events/in-memory-event-store.js';
import { HttpEventPublisher } from '../events/http-event-publisher.js';
import { RapidOcrEngine, parseOcrExcludedRegions } from './ocr-engine.js';
import type { BoundingBox } from '../events/ai-observation-schema.js';
import { OcrObservationWorker } from './ocr-observation-worker.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OcrOptions {
  camera: string;
  model: string;
  provider: string;
  rtspTransport: RtspTransport;
  excludedRegions?: Record<string, BoundingBox[]>;
  once: boolean;
  dryRun: boolean;
}

type Environment = Record<string, string | undefined>;

function parseTransport(value: string | undefined): RtspTransport {
  const transport = value?.trim() || 'udp';
  if (transport !== 'udp' && transport !== 'tcp') {
    throw new Error('JARVIS_RTSP_TRANSPORT must be udp or tcp');
  }
  return transport;
}

export function parseOcrOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): OcrOptions {
  const supported = new Set(['--once', '--dry-run', '--publish']);
  const unknown = argv.find((argument) => !supported.has(argument));
  if (unknown) throw new Error(`Unknown OCR argument: ${unknown}`);
  if (argv.includes('--dry-run') && argv.includes('--publish')) {
    throw new Error('OCR cannot combine --dry-run and --publish');
  }
  const excludedRegions = parseOcrExcludedRegions(env.JARVIS_OCR_EXCLUDED_REGIONS);
  return {
    camera: env.JARVIS_OCR_CAMERA?.trim() || 'front',
    model: env.JARVIS_OCR_MODEL?.trim() || 'rapidocr-onnxruntime',
    provider: env.JARVIS_OCR_PROVIDER?.trim() || 'CPUExecutionProvider',
    rtspTransport: parseTransport(env.JARVIS_RTSP_TRANSPORT),
    ...(excludedRegions ? { excludedRegions } : {}),
    once: argv.includes('--once'),
    dryRun: !argv.includes('--publish'),
  };
}

function cameraStreamEnvName(camera: string): string {
  const normalized = camera.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `JARVIS_CAMERA_${normalized}_RTSP_URL`;
}

async function buildWorker(options: OcrOptions): Promise<OcrObservationWorker> {
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
  return new OcrObservationWorker({
    camera,
    events,
    ocr: new RapidOcrEngine({
      pythonPath: process.env.JARVIS_OCR_PYTHON,
      workerPath: process.env.JARVIS_OCR_WORKER,
      excludedRegions: options.excludedRegions?.[options.camera],
    }),
    cameraLocations: { [options.camera]: process.env.JARVIS_CAMERA_FRONT_LOCATION ?? 'frente' },
    model: options.model,
    provider: options.provider,
  });
}

export async function runOcr(options: OcrOptions): Promise<void> {
  if (!options.once) {
    throw new Error('OCR currently requires --once; continuous OCR will be added only with an explicit sampling policy');
  }
  const worker = await buildWorker(options);
  console.log(JSON.stringify(await worker.observeOnce(options.camera)));
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runOcr(parseOcrOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
