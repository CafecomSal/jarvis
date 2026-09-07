import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateDetectorStatus,
  type DetectorStatusHealth,
  type DetectorStatusSnapshot,
} from './detector-status.js';

export interface DetectorStatusCliOptions {
  statusFile: string;
  maxAgeMs: number;
}

type Environment = Record<string, string | undefined>;

const STATES = new Set(['starting', 'healthy', 'degraded', 'stopped']);
const MODES = new Set(['dry-run', 'publish']);
const COUNTERS = [
  'attempts',
  'successes',
  'detectedSamples',
  'detections',
  'confirmedSamples',
  'eventsEmitted',
  'skippedOverlaps',
  'errors',
  'consecutiveErrors',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDetectorStatusSnapshot(value: unknown): value is DetectorStatusSnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.state !== 'string' || !STATES.has(value.state)) return false;
  if (typeof value.mode !== 'string' || !MODES.has(value.mode)) return false;
  if (typeof value.camera !== 'string' || typeof value.model !== 'string' || typeof value.provider !== 'string') {
    return false;
  }
  if (value.pid !== undefined
    && (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid < 1)) return false;
  if (typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return false;
  return COUNTERS.every((counter) => typeof value[counter] === 'number' && Number.isFinite(value[counter]));
}

function parsePositiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return parsed;
}

export function parseDetectorStatusOptions(
  env: Environment = process.env,
): DetectorStatusCliOptions {
  return {
    statusFile: env.JARVIS_DETECTOR_STATUS_FILE?.trim() || 'data/detector/status.json',
    maxAgeMs: parsePositiveNumber(
      'JARVIS_DETECTOR_STATUS_MAX_AGE_MS',
      env.JARVIS_DETECTOR_STATUS_MAX_AGE_MS,
      30_000,
    ),
  };
}

export async function loadDetectorStatus(filePath: string): Promise<DetectorStatusSnapshot> {
  const raw = await readFile(resolve(filePath), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Detector status file is not valid JSON');
  }
  if (!isDetectorStatusSnapshot(parsed)) throw new Error('Detector status file has an invalid schema');
  return parsed;
}

export interface DetectorStatusInspection {
  status: DetectorStatusSnapshot;
  health: DetectorStatusHealth;
}

export async function inspectDetectorStatus(
  options: DetectorStatusCliOptions,
  now = new Date(),
): Promise<DetectorStatusInspection> {
  const status = await loadDetectorStatus(options.statusFile);
  return {
    status,
    health: evaluateDetectorStatus(status, now, options.maxAgeMs),
  };
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  inspectDetectorStatus(parseDetectorStatusOptions())
    .then(({ status, health }) => {
      console.log(JSON.stringify({ status, health }));
      if (!health.healthy) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
