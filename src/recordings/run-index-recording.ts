import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryEventStore } from '../events/in-memory-event-store.js';
import { PostgresEventStore } from '../events/postgres-event-store.js';
import { OnnxObjectInference } from '../vision/onnx-person-detector.js';
import { RapidOcrEngine, parseOcrExcludedRegions } from '../vision/ocr-engine.js';
import { parseObjectDetectorOptions } from '../vision/run-object-detector.js';
import { FfmpegRecordingFrameSource } from './recording-frame-extractor.js';
import { RecordingIndexer } from './recording-indexer.js';
import { InMemoryRecordingStore, PostgresRecordingStore, type RecordingStore } from './recording-store.js';

export interface RecordingIndexOptions {
  recordingId: string;
  includeOcr: boolean;
  intervalMs: number;
  force?: boolean;
}

type Environment = Record<string, string | undefined>;

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseRecordingIndexOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): RecordingIndexOptions {
  let recordingId: string | undefined;
  let includeOcr = false;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ocr') {
      includeOcr = true;
      continue;
    }
    if (argument === '--force') {
      force = true;
      continue;
    }
    if (argument === '--id') {
      recordingId = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    if (argument.startsWith('--id=')) {
      recordingId = argument.slice('--id='.length).trim();
      continue;
    }
    throw new Error(`Unknown recording index argument: ${argument}`);
  }
  if (!recordingId) throw new Error('Recording index requires --id');
  return {
    recordingId,
    includeOcr,
    ...(force ? { force: true } : {}),
    intervalMs: parsePositiveInteger(
      'JARVIS_RECORDING_INDEX_INTERVAL_MS',
      env.JARVIS_RECORDING_INDEX_INTERVAL_MS,
      1_000,
    ),
  };
}

export async function runRecordingIndex(options: RecordingIndexOptions): Promise<void> {
  const recordings: RecordingStore = process.env.DATABASE_URL
    ? new PostgresRecordingStore()
    : new InMemoryRecordingStore();
  const postgresRecordings = recordings instanceof PostgresRecordingStore ? recordings : undefined;
  const events = process.env.DATABASE_URL ? new PostgresEventStore() : new InMemoryEventStore();
  const postgresEvents = events instanceof PostgresEventStore ? events : undefined;
  try {
    await postgresRecordings?.initialize();
    await postgresEvents?.initialize();
    const segment = await recordings.findById(options.recordingId);
    if (!segment) throw new Error(`Recording segment not found: ${options.recordingId}`);

    const objectOptions = parseObjectDetectorOptions(['--once']);
    const objectInference = new OnnxObjectInference({
      modelPath: resolve(objectOptions.modelPath),
      inputSize: objectOptions.inputSize,
      confidenceThreshold: objectOptions.confidenceThreshold,
      targetClasses: objectOptions.classes,
    });
    const indexer = new RecordingIndexer({
      events,
      frames: new FfmpegRecordingFrameSource({
        recordingsDirectory: process.env.JARVIS_RECORDING_OUTPUT_DIR ?? 'data/recordings',
        snapshotsDirectory: process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots',
        intervalMs: options.intervalMs,
      }),
      objects: objectInference,
      ...(options.includeOcr ? {
        ocr: new RapidOcrEngine({
          excludedRegions: parseOcrExcludedRegions(process.env.JARVIS_OCR_EXCLUDED_REGIONS)?.[segment.camera],
        }),
      } : {}),
      model: basename(resolve(objectOptions.modelPath)),
      ocrModel: 'rapidocr-onnxruntime',
      provider: 'CPUExecutionProvider',
    });
    console.log(JSON.stringify(await indexer.index(segment, { includeOcr: options.includeOcr, ...(options.force ? { force: true } : {}) })));
  } finally {
    await postgresRecordings?.close();
    await postgresEvents?.close();
  }
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runRecordingIndex(parseRecordingIndexOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
