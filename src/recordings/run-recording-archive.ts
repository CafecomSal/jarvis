import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleDriveSnapshotBackup } from '../cameras/google-drive-backup.js';
import { RecordingDriveArchiver } from './recording-drive-archive.js';
import {
  InMemoryRecordingStore,
  PostgresRecordingStore,
  type RecordingStore,
} from './recording-store.js';

export interface RecordingArchiveOptions {
  recordingId: string;
  rootDirectory: string;
}

type Environment = Record<string, string | undefined>;

export function parseRecordingArchiveOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): RecordingArchiveOptions {
  let recordingId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--id') {
      recordingId = argv[index + 1]?.trim();
      index += 1;
      continue;
    }
    if (argument.startsWith('--id=')) {
      recordingId = argument.slice('--id='.length).trim();
      continue;
    }
    throw new Error(`Unknown recording archive argument: ${argument}`);
  }
  if (!recordingId) throw new Error('Recording archive requires --id');
  return {
    recordingId,
    rootDirectory: env.JARVIS_RECORDING_OUTPUT_DIR?.trim() || 'data/recordings',
  };
}

export async function runRecordingArchive(options: RecordingArchiveOptions): Promise<void> {
  const store: RecordingStore = process.env.DATABASE_URL
    ? new PostgresRecordingStore()
    : new InMemoryRecordingStore();
  const postgres = store instanceof PostgresRecordingStore ? store : undefined;
  try {
    await postgres?.initialize();
    const backup = new GoogleDriveSnapshotBackup({
      parentFolderId: process.env.JARVIS_DRIVE_PARENT_FOLDER_ID || undefined,
    });
    const archiver = new RecordingDriveArchiver(store, backup, options.rootDirectory);
    console.log(JSON.stringify(await archiver.archive(options.recordingId)));
  } finally {
    await postgres?.close();
  }
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runRecordingArchive(parseRecordingArchiveOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
