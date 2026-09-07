import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { InMemoryAuditStore } from './audit/in-memory-audit-store.js';
import { PostgresAuditStore } from './audit/postgres-audit-store.js';
import { GoogleDriveSnapshotBackup } from './cameras/google-drive-backup.js';
import {
  LocalSnapshotStore,
  SnapshotRetentionScheduler,
  SnapshotRetentionService,
} from './cameras/local-snapshot-store.js';
import { InMemoryEventStore } from './events/in-memory-event-store.js';
import { PostgresEventStore } from './events/postgres-event-store.js';
import { InMemoryRecordingStore, PostgresRecordingStore } from './recordings/recording-store.js';
import { InMemoryAudioSessionStore, PostgresAudioSessionStore } from './audio/audio-session-store.js';
import { AudioSessionRetentionService } from './audio/audio-session-retention.js';
import { AudioSessionRetentionScheduler } from './audio/audio-session-retention-scheduler.js';
import { AudioRuntime } from './audio/audio-runtime.js';
import { GroqSttProvider } from './audio/providers/groq-stt.js';
import { FfprobeAudioDurationProbe } from './audio/audio-duration-probe.js';
import {
  InMemorySttUsageStore,
  PostgresSttUsageStore,
  SttQuotaGuard,
  estimateGroqCostUsd,
} from './audio/stt-usage-store.js';
import { InMemoryRuntimeSettingsStore, PostgresRuntimeSettingsStore, RuntimeSettingsService } from './config/runtime-settings-store.js';
import { runtimeSettingsFromEnvironment } from './config/runtime-settings.js';
import { WorldStateProjection } from './state/world-state.js';
import { createPersonNotifierFromEnvironment } from './notifications/person-notification.js';
import { RecordingDriveArchiver } from './recordings/recording-drive-archive.js';
import { RecordingRetentionScheduler } from './recordings/recording-retention-scheduler.js';
import { RecordingRetentionService } from './recordings/recording-retention.js';
import { RecordingUploadQueue } from './recordings/recording-upload-queue.js';
import { RecordingArchiveScheduler } from './recordings/recording-archive-scheduler.js';
import { RecordingRemoteRetentionService } from './recordings/recording-remote-retention.js';
import { RecordingRemoteRetentionScheduler } from './recordings/recording-remote-retention-scheduler.js';
import { TagService } from './tags/tag-service.js';
import { FasterWhisperSttProvider } from './audio/providers/faster-whisper-stt.js';
import { PiperTtsProvider } from './audio/providers/piper-tts.js';
import { piperRuntimeCommand } from './audio/piper-runtime.js';
import { InMemoryImportanceStore } from './importance/importance-store.js';
import { InMemoryWatchSessionStore } from './watch/watch-session-store.js';
import { InMemoryActionProposalStore } from './actions/action-store.js';
import type { HomeEvent } from './events/schema.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const persistentStore = process.env.DATABASE_URL ? new PostgresEventStore() : undefined;
const persistentAudit = process.env.DATABASE_URL ? new PostgresAuditStore() : undefined;
const persistentRecordings = process.env.DATABASE_URL ? new PostgresRecordingStore() : undefined;
const events = persistentStore ?? new InMemoryEventStore();
const audit = persistentAudit ?? new InMemoryAuditStore();
const recordings = persistentRecordings ?? new InMemoryRecordingStore();
const persistentAudio = process.env.DATABASE_URL ? new PostgresAudioSessionStore() : undefined;
const audioSessions = persistentAudio ?? new InMemoryAudioSessionStore();
const persistentRuntimeSettings = process.env.DATABASE_URL ? new PostgresRuntimeSettingsStore() : undefined;
const runtimeSettingsStore = persistentRuntimeSettings ?? new InMemoryRuntimeSettingsStore();
const runtimeSettings = new RuntimeSettingsService(runtimeSettingsStore, runtimeSettingsFromEnvironment(), 'environment');
const persistentSttUsage = process.env.DATABASE_URL ? new PostgresSttUsageStore() : undefined;
const sttUsageStore = persistentSttUsage ?? new InMemorySttUsageStore();
const audioSessionRetention = new AudioSessionRetentionService(audioSessions, audit);
const importance = new InMemoryImportanceStore();
const watchSessions = new InMemoryWatchSessionStore();
const actions = new InMemoryActionProposalStore();
const worldState = new WorldStateProjection();
const snapshotStore = new LocalSnapshotStore(process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots');

function hermesProfileHome(): string {
  return process.env.HERMES_HOME
    ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hermes', 'profiles', 'jarvis');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (persistentStore) {
  await persistentStore.initialize();
  const history = await persistentStore.list(10000);
  for (const event of history) worldState.apply(event);
  console.log(`World State reidratado com ${history.length} evento(s)`);
}
if (persistentAudit) {
  await persistentAudit.initialize();
}
if (persistentRecordings) {
  await persistentRecordings.initialize();
}
if (persistentAudio) {
  await persistentAudio.initialize();
}
if (persistentRuntimeSettings) {
  await persistentRuntimeSettings.initialize();
}
if (persistentSttUsage) {
  await persistentSttUsage.initialize();
}

const driveTokenPath = join(hermesProfileHome(), 'google_token.json');
const webRootDirectory = join(process.cwd(), 'dist', 'web');
const webRoot = await fileExists(join(webRootDirectory, 'index.html')) ? webRootDirectory : undefined;
const initialRuntimeSettings = (await runtimeSettings.effective()).settings;
const audioEnabled = initialRuntimeSettings.audioEnabled;
const audioModelPath = process.env.JARVIS_PIPER_MODEL?.trim()
  || join(process.cwd(), 'models', 'tts', 'piper', 'pt_BR-jeff-medium.onnx');
const audioQuota = new SttQuotaGuard(sttUsageStore, initialRuntimeSettings.quota);
const audioDurationProbe = new FfprobeAudioDurationProbe();
const audioDurations = new Map<string, number>();
const groqApiKey = process.env.GROQ_API_KEY?.trim();
const audioRuntime = audioEnabled ? new AudioRuntime({
  config: initialRuntimeSettings.stt,
  createLocal: (config) => new FasterWhisperSttProvider({
    model: config.localModel,
    timeoutMs: Math.max(120_000, config.timeoutMs),
  }),
  ...(groqApiKey ? {
    createGroq: (config: typeof initialRuntimeSettings.stt) => new GroqSttProvider({
      apiKey: groqApiKey,
      model: config.groqModel,
      language: config.language,
      prompt: config.prompt,
      timeoutMs: config.timeoutMs,
    }),
  } : {}),
  canUseCloud: async (audio, mimeType, context) => {
    if (!audio || !mimeType) return false;
    const seconds = await audioDurationProbe.probe(audio, mimeType);
    if (seconds === undefined) return false;
    if (context?.sessionId) audioDurations.set(context.sessionId, seconds);
    return audioQuota.canUse({ audioSeconds: seconds, estimatedUsd: estimateGroqCostUsd(seconds, 'whisper-large-v3') });
  },
  recordCloudUsage: async (context, transcript, audio, mimeType) => {
    const sessionId = context?.sessionId;
    if (!sessionId) return;
    const measuredSeconds = transcript.durationMs === undefined
      ? audioDurations.get(sessionId) ?? await audioDurationProbe.probe(audio, mimeType)
      : transcript.durationMs / 1_000;
    if (measuredSeconds === undefined) return;
    await audioQuota.record({
      sessionId,
      audioSeconds: measuredSeconds,
      estimatedUsd: estimateGroqCostUsd(measuredSeconds, transcript.model),
    });
    audioDurations.delete(sessionId);
  },
}) : undefined;
const audioTts = audioEnabled && await fileExists(audioModelPath)
  ? new PiperTtsProvider({ modelPath: audioModelPath, ...piperRuntimeCommand() })
  : undefined;
if (audioEnabled && !audioTts) {
  console.error('Audio enabled but Piper model is unavailable; audio pipeline not started');
}
const driveBackup = await fileExists(driveTokenPath)
  ? new GoogleDriveSnapshotBackup({
    parentFolderId: process.env.JARVIS_DRIVE_PARENT_FOLDER_ID || undefined,
  })
  : undefined;
const retentionService = new SnapshotRetentionService(snapshotStore, {
  maxAgeDays: 7,
  backup: driveBackup,
});
const retentionScheduler = new SnapshotRetentionScheduler(retentionService, {
  onResult: (result) => {
    if (result.scanned > 0 || result.failed > 0) {
      console.log(
        `Snapshot retention: scanned=${result.scanned} uploaded=${result.uploaded} `
        + `deleted=${result.deleted} failed=${result.failed} skipped=${result.skipped}`,
      );
    }
  },
  onError: (error) => {
    console.error('Snapshot retention failed:', error instanceof Error ? error.message : error);
  },
});

const recordingDirectory = process.env.JARVIS_RECORDING_OUTPUT_DIR ?? 'data/recordings';
const recordingRetentionService = new RecordingRetentionService(recordings, recordingDirectory, {
  continuousDays: Number(process.env.JARVIS_RECORDING_MAX_AGE_DAYS ?? 30),
  eventDays: Number(process.env.JARVIS_RECORDING_EVENT_MAX_AGE_DAYS ?? 90),
  maxBytes: Number(process.env.JARVIS_RECORDING_MAX_BYTES ?? 50_000_000_000),
  deleteAfterVerified: process.env.JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY === 'true',
});
const recordingArchiver = driveBackup
  ? new RecordingDriveArchiver(recordings, driveBackup, recordingDirectory)
  : undefined;
const recordingBackupEnabled = process.env.JARVIS_RECORDING_BACKUP_ENABLED === 'true';
const remoteRetentionEnabled = process.env.JARVIS_RECORDING_REMOTE_RETENTION_ENABLED === 'true';
const recordingRemoteRetentionService = remoteRetentionEnabled && driveBackup
  ? new RecordingRemoteRetentionService(recordings, {
    continuousDays: Number(process.env.JARVIS_RECORDING_MAX_AGE_DAYS ?? 30),
    eventDays: Number(process.env.JARVIS_RECORDING_EVENT_MAX_AGE_DAYS ?? 90),
    deleteRemote: (fileId) => driveBackup.delete(fileId, process.env.JARVIS_DRIVE_PERMANENT_DELETE === 'true').then(() => undefined),
  })
  : undefined;
const recordingRemoteRetentionScheduler = recordingRemoteRetentionService
  ? new RecordingRemoteRetentionScheduler(recordingRemoteRetentionService, {
    intervalMs: Number(process.env.JARVIS_RECORDING_REMOTE_RETENTION_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
    onResult: (result) => {
      if (result.deleted.length > 0 || result.failed.length > 0) {
        console.log(`Recording remote retention: scanned=${result.scanned} deleted=${result.deleted.length} failed=${result.failed.length}`);
      }
    },
    onError: (error) => console.error('Recording remote retention failed:', error instanceof Error ? error.message : error),
  })
  : undefined;
const recordingUploadQueue = recordingBackupEnabled && recordingArchiver
  ? new RecordingUploadQueue({
    archive: (id) => recordingArchiver.archive(id),
    maxAttempts: Number(process.env.JARVIS_RECORDING_UPLOAD_MAX_ATTEMPTS ?? 5),
    retryDelayMs: Number(process.env.JARVIS_RECORDING_UPLOAD_RETRY_DELAY_MS ?? 2_000),
  })
  : undefined;
const recordingArchiveScheduler = recordingBackupEnabled && recordingUploadQueue
  ? new RecordingArchiveScheduler(recordings, recordingUploadQueue, {
    intervalMs: Number(process.env.JARVIS_RECORDING_BACKUP_INTERVAL_MS ?? 60 * 60 * 1000),
    onError: (error) => console.error(
      'Recording archive failed:',
      error instanceof Error ? error.message : error,
    ),
  })
  : undefined;
const archiveOne = recordingUploadQueue
  ? async (id: string): Promise<void> => {
    const [job] = await recordingUploadQueue.upload([id]);
    if (job?.status !== 'verified') throw new Error(job?.error ?? `Recording upload failed: ${id}`);
  }
  : undefined;
const recordingRetentionScheduler = recordingBackupEnabled && archiveOne
  ? new RecordingRetentionScheduler(
    {
      run: () => recordingRetentionService.run(archiveOne),
    },
    {
      intervalMs: Number(process.env.JARVIS_RECORDING_RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
      onResult: (result) => {
        if (result.candidates.length > 0 || result.failed > 0) {
          console.log(
            `Recording retention: scanned=${result.scanned} candidates=${result.candidates.length} `
            + `archived=${result.archived} failed=${result.failed} deleted=${result.deleted}`,
          );
        }
      },
      onError: (error) => console.error(
        'Recording retention failed:',
        error instanceof Error ? error.message : error,
      ),
    },
  )
  : undefined;
const tags = new TagService(events);
if (recordingBackupEnabled && !recordingArchiver) {
  console.error('Recording backup enabled but Google Drive is not authenticated; scheduler not started');
}

function stringData(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function resolvePersonNotificationAttachment(event: HomeEvent): Promise<string | undefined> {
  let imageRef = stringData(event.data, 'imageRef');
  if (!imageRef) {
    const evidenceEventId = stringData(event.data, 'evidenceEventId');
    if (evidenceEventId) {
      const evidence = (await events.search(evidenceEventId, 10)).find((candidate) => (
        candidate.id === evidenceEventId && candidate.type === 'camera.snapshot'
      ));
      imageRef = evidence ? stringData(evidence.data, 'imageRef') : undefined;
    }
  }
  if (!imageRef) return undefined;
  try {
    await snapshotStore.read(imageRef);
    return snapshotStore.resolvePath(imageRef);
  } catch {
    return undefined;
  }
}

const personNotifier = createPersonNotifierFromEnvironment(
  process.env,
  undefined,
  resolvePersonNotificationAttachment,
);
const audioSessionRetentionScheduler = new AudioSessionRetentionScheduler(
  audioSessionRetention,
  async () => (await runtimeSettings.effective()).settings.audioSessions,
  {
    intervalMs: Number(process.env.JARVIS_AUDIO_SESSION_RETENTION_INTERVAL_MS ?? 24 * 60 * 60 * 1_000),
    onResult: (result) => {
      if (result && result.deletedCount > 0) console.log(`Audio session retention: deleted=${result.deletedCount} redacted=${result.redactedConversationCount}`);
    },
    onError: (error) => console.error('Audio session retention failed:', error instanceof Error ? error.message : error),
  },
);
const app = buildApp({
  events,
  audit,
  snapshotStore,
  worldState,
  personNotifier,
  recordings,
  recordingsDirectory: process.env.JARVIS_RECORDING_OUTPUT_DIR ?? 'data/recordings',
  tags,
  webRoot,
  audioSessions,
  ...(audioRuntime ? { audioStt: audioRuntime, audioRuntime } : {}),
  ...(audioTts ? { audioTts } : {}),
  audioQuota,
  runtimeSettings,
  groqApiKeyConfigured: Boolean(groqApiKey),
  audioSessionRetention,
  importance,
  watchSessions,
  actions,
});

const shutdown = async (): Promise<void> => {
  retentionScheduler.stop();
  recordingRetentionScheduler?.stop();
  recordingArchiveScheduler?.stop();
  recordingRemoteRetentionScheduler?.stop();
  audioSessionRetentionScheduler.stop();
  await audioRuntime?.close();
  await app.close();
  await persistentStore?.close();
  await persistentAudit?.close();
  await persistentRecordings?.close();
  await persistentAudio?.close();
  await persistentRuntimeSettings?.close();
  await persistentSttUsage?.close();
};

process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});

try {
  await app.listen({ port, host });
  retentionScheduler.start();
  recordingRetentionScheduler?.start();
  recordingArchiveScheduler?.start();
  recordingRemoteRetentionScheduler?.start();
  audioSessionRetentionScheduler.start();
  console.log(`Jarvis Core ouvindo em http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  retentionScheduler.stop();
  recordingRetentionScheduler?.stop();
  recordingArchiveScheduler?.stop();
  recordingRemoteRetentionScheduler?.stop();
  audioSessionRetentionScheduler.stop();
  await persistentStore?.close();
  await persistentRuntimeSettings?.close();
  await persistentSttUsage?.close();
  await persistentAudit?.close();
  process.exit(1);
}
