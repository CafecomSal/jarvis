import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleDriveSnapshotBackup } from '../cameras/google-drive-backup.js';
import { RecordingDriveArchiver } from './recording-drive-archive.js';
import { RecordingRetentionService } from './recording-retention.js';
import {
  InMemoryRecordingStore,
  PostgresRecordingStore,
  type RecordingStore,
} from './recording-store.js';

export interface RecordingRetentionCliOptions {
  dryRun: boolean;
  maxAgeDays: number;
  eventMaxAgeDays: number;
  maxBytes: number | undefined;
  deleteAfterVerified: boolean;
}

type Environment = Record<string, string | undefined>;

function parsePositiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

export function parseRecordingRetentionOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): RecordingRetentionCliOptions {
  const supported = new Set(['--dry-run', '--archive']);
  const unknown = argv.find((argument) => !supported.has(argument));
  if (unknown) throw new Error(`Unknown recording retention argument: ${unknown}`);
  if (argv.includes('--dry-run') && argv.includes('--archive')) {
    throw new Error('Recording retention cannot combine --dry-run and --archive');
  }
  const maxBytes = env.JARVIS_RECORDING_MAX_BYTES === undefined
    ? undefined
    : parsePositiveNumber('JARVIS_RECORDING_MAX_BYTES', env.JARVIS_RECORDING_MAX_BYTES, 1);
  return {
    dryRun: !argv.includes('--archive'),
    maxAgeDays: parsePositiveNumber('JARVIS_RECORDING_MAX_AGE_DAYS', env.JARVIS_RECORDING_MAX_AGE_DAYS, 30),
    eventMaxAgeDays: parsePositiveNumber(
      'JARVIS_RECORDING_EVENT_MAX_AGE_DAYS',
      env.JARVIS_RECORDING_EVENT_MAX_AGE_DAYS,
      90,
    ),
    maxBytes,
    deleteAfterVerified: env.JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY === 'true',
  };
}

export async function runRecordingRetention(options: RecordingRetentionCliOptions): Promise<void> {
  const store: RecordingStore = process.env.DATABASE_URL
    ? new PostgresRecordingStore()
    : new InMemoryRecordingStore();
  const postgres = store instanceof PostgresRecordingStore ? store : undefined;
  try {
    await postgres?.initialize();
    const service = new RecordingRetentionService(store, process.env.JARVIS_RECORDING_OUTPUT_DIR ?? 'data/recordings', {
      continuousDays: options.maxAgeDays,
      eventDays: options.eventMaxAgeDays,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      deleteAfterVerified: options.deleteAfterVerified,
    });
    if (options.dryRun) {
      console.log(JSON.stringify(await service.run()));
      return;
    }
    const backup = new GoogleDriveSnapshotBackup({
      parentFolderId: process.env.JARVIS_DRIVE_PARENT_FOLDER_ID || undefined,
    });
    const archiver = new RecordingDriveArchiver(
      store,
      backup,
      process.env.JARVIS_RECORDING_OUTPUT_DIR ?? 'data/recordings',
    );
    console.log(JSON.stringify(await service.run((id) => archiver.archive(id))));
  } finally {
    await postgres?.close();
  }
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runRecordingRetention(parseRecordingRetentionOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
