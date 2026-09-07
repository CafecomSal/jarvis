import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
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
import { FfmpegSegmentRecorder, RecordingManager } from './recordings/ffmpeg-recorder.js';
import { FfmpegRecordingFrameSource } from './recordings/recording-frame-extractor.js';
import { getRecordingProfile } from './recordings/recording-profile.js';
import { RecordingIndexer } from './recordings/recording-indexer.js';
import { RecordingRuntime, type RecordingRuntimeHealth } from './recordings/recording-runtime.js';
import { InMemoryRecordingIndexRunStore, PostgresRecordingIndexRunStore } from './recordings/recording-index-run-store.js';
import { OnnxObjectInference } from './vision/onnx-person-detector.js';
import { PersistentRapidOcrEngine, parseOcrExcludedRegions, resolveOcrPythonPath } from './vision/ocr-engine.js';
import { parseObjectDetectorOptions } from './vision/run-object-detector.js';
import { EvidenceEventProjection, ProjectingEventAppender } from './evidence/event-projection.js';
import { InMemoryEvidenceIndexStore, PostgresEvidenceIndexStore } from './evidence/evidence-index-store.js';
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
const postgresConfigured = Boolean(process.env.DATABASE_URL?.trim());
const persistentStore = postgresConfigured ? new PostgresEventStore() : undefined;
const persistentAudit = postgresConfigured ? new PostgresAuditStore() : undefined;
const persistentRecordings = postgresConfigured ? new PostgresRecordingStore() : undefined;
let events = persistentStore ?? new InMemoryEventStore();
let audit = persistentAudit ?? new InMemoryAuditStore();
let recordings = persistentRecordings ?? new InMemoryRecordingStore();
const persistentEvidenceIndex = postgresConfigured ? new PostgresEvidenceIndexStore() : undefined;
let evidenceIndex = persistentEvidenceIndex ?? new InMemoryEvidenceIndexStore();
const persistentIndexRuns = postgresConfigured ? new PostgresRecordingIndexRunStore() : undefined;
let indexRuns = persistentIndexRuns ?? new InMemoryRecordingIndexRunStore();
let evidenceProjection: EvidenceEventProjection;
const persistentAudio = postgresConfigured ? new PostgresAudioSessionStore() : undefined;
let audioSessions = persistentAudio ?? new InMemoryAudioSessionStore();
const persistentRuntimeSettings = postgresConfigured ? new PostgresRuntimeSettingsStore() : undefined;
let runtimeSettingsStore = persistentRuntimeSettings ?? new InMemoryRuntimeSettingsStore();
const persistentSttUsage = postgresConfigured ? new PostgresSttUsageStore() : undefined;
let sttUsageStore = persistentSttUsage ?? new InMemorySttUsageStore();
let audioSessionRetention: AudioSessionRetentionService;
const importance = new InMemoryImportanceStore();
const watchSessions = new InMemoryWatchSessionStore();
const actions = new InMemoryActionProposalStore();
const worldState = new WorldStateProjection();
const snapshotStore = new LocalSnapshotStore(process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots');
const execFileAsync = promisify(execFile);
let databaseAvailable = false;
let persistentStoresClosed = false;

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

async function closePersistentStores(): Promise<void> {
  if (persistentStoresClosed) return;
  persistentStoresClosed = true;
  await Promise.allSettled([
    persistentStore?.close(),
    persistentAudit?.close(),
    persistentRecordings?.close(),
    persistentEvidenceIndex?.close(),
    persistentIndexRuns?.close(),
    persistentAudio?.close(),
    persistentRuntimeSettings?.close(),
    persistentSttUsage?.close(),
  ]);
}

if (postgresConfigured) {
  try {
    await persistentStore!.initialize();
    await persistentAudit!.initialize();
    await persistentRecordings!.initialize();
    await persistentEvidenceIndex!.initialize();
    await persistentIndexRuns!.initialize();
    await persistentAudio!.initialize();
    await persistentRuntimeSettings!.initialize();
    await persistentSttUsage!.initialize();
    const history = await persistentStore!.list(10000);
    for (const event of history) worldState.apply(event);
    console.log(`World State reidratado com ${history.length} evento(s)`);
    databaseAvailable = true;
  } catch (error) {
    databaseAvailable = false;
    console.error('PostgreSQL indisponível; Core continuará degradado:', error instanceof Error ? error.message.slice(0, 200) : 'database initialization failed');
    await closePersistentStores();
    events = new InMemoryEventStore();
    audit = new InMemoryAuditStore();
    recordings = new InMemoryRecordingStore();
    evidenceIndex = new InMemoryEvidenceIndexStore();
    indexRuns = new InMemoryRecordingIndexRunStore();
    audioSessions = new InMemoryAudioSessionStore();
    runtimeSettingsStore = new InMemoryRuntimeSettingsStore();
    sttUsageStore = new InMemorySttUsageStore();
  }
}

// Construct this service only after the guarded PostgreSQL initialization. If
// initialization failed, it must use the fresh in-memory store rather than a
// pool that was already closed during fallback.
const runtimeSettings = new RuntimeSettingsService(runtimeSettingsStore, runtimeSettingsFromEnvironment(), 'environment');
audioSessionRetention = new AudioSessionRetentionService(audioSessions, audit);
evidenceProjection = new EvidenceEventProjection(evidenceIndex, {
  onError: (error) => console.error('Evidence projection failed:', error instanceof Error ? error.message : error),
});

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
    const probedSeconds = await audioDurationProbe.probe(audio, mimeType);
    const hintedSeconds = context?.audioDurationSeconds;
    const seconds = probedSeconds === undefined
      ? hintedSeconds
      : hintedSeconds === undefined ? probedSeconds : Math.max(probedSeconds, hintedSeconds);
    if (seconds === undefined) return false;
    if (context?.sessionId) audioDurations.set(context.sessionId, seconds);
    return audioQuota.canUse({ audioSeconds: seconds, estimatedUsd: estimateGroqCostUsd(seconds, 'whisper-large-v3') });
  },
  recordCloudUsage: async (context, transcript, audio, mimeType) => {
    const sessionId = context?.sessionId;
    if (!sessionId) return;
    const probedSeconds = await audioDurationProbe.probe(audio, mimeType);
    const knownDurations = [
      audioDurations.get(sessionId),
      context?.audioDurationSeconds,
      probedSeconds,
      transcript.durationMs === undefined ? undefined : transcript.durationMs / 1_000,
    ].filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
    const measuredSeconds = knownDurations.length > 0 ? Math.max(...knownDurations) : undefined;
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
const snapshotRetentionBackup = process.env.JARVIS_SNAPSHOT_RETENTION_BACKUP_ENABLED === 'true'
  ? driveBackup
  : undefined;
const retentionService = new SnapshotRetentionService(snapshotStore, {
  maxAgeDays: 7,
  backup: snapshotRetentionBackup,
  // Recording evidence is governed by the segment retention tier, not the
  // general camera-snapshot cleanup policy.
  excludePrefixes: ['recordings/', 'index-tmp/'],
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
const recordingProfile = getRecordingProfile('continuous-economic');
const recordingCamera = 'front';
const recordingStreamUrl = process.env.JARVIS_CAMERA_FRONT_RTSP_URL?.trim();
const recordingIndexIntervalMs = Number(process.env.JARVIS_RECORDING_INDEX_INTERVAL_MS ?? 1_000);
const recordingModelPath = resolve(process.env.JARVIS_ONNX_MODEL_PATH?.trim() || 'models/yolo11n.onnx');
const recordingOcrWorkerPath = resolve(process.env.JARVIS_OCR_WORKER?.trim() || 'tools/ocr/rapidocr_worker.py');
const recordingOcrPythonPath = resolveOcrPythonPath();
const recordingPolicyVersion = 'continuous-v1';

async function commandAvailable(command: string): Promise<boolean> {
  if (command.includes('\\') || command.includes('/')) return fileExists(command);
  try {
    await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { windowsHide: true, timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function continuousDependencyFailure(): Promise<string | undefined> {
  if (!databaseAvailable || !persistentRecordings || !persistentEvidenceIndex || !persistentIndexRuns) return 'postgres_required';
  if (!recordingStreamUrl) return 'front_camera_rtsp_not_configured';
  if (!await fileExists(recordingModelPath)) return 'onnx_model_unavailable';
  if (!await fileExists(recordingOcrWorkerPath)) return 'rapidocr_worker_unavailable';
  if (!await commandAvailable(process.env.FFMPEG_PATH?.trim() || 'ffmpeg')) return 'ffmpeg_unavailable';
  if (!await commandAvailable(recordingOcrPythonPath)) return 'rapidocr_python_unavailable';
  if (!Number.isInteger(recordingIndexIntervalMs) || recordingIndexIntervalMs <= 0) return 'invalid_recording_index_interval';
  return undefined;
}

const evidenceBackfill = await evidenceProjection.backfill(events, recordings);
const recordingBackfillStatus = {
  status: evidenceBackfill.status === 'failed' ? 'failed' as const : evidenceBackfill.status === 'completed' ? 'completed' as const : 'skipped' as const,
  eventsProcessed: evidenceBackfill.eventsProcessed,
  segmentsSeen: evidenceBackfill.segmentsSeen,
  ...(evidenceBackfill.error ? { error: evidenceBackfill.error } : {}),
};

let recordingRuntime: RecordingRuntime | undefined;
let persistentOcrEngine: PersistentRapidOcrEngine | undefined;
let recordingRuntimeReason: string | undefined;
const continuousFailure = evidenceBackfill.status === 'failed'
  ? 'evidence_backfill_failed'
  : await continuousDependencyFailure();
if (!continuousFailure && recordingStreamUrl) {
  try {
    const objectOptions = parseObjectDetectorOptions([]);
    const ocrExcludedRegions = parseOcrExcludedRegions(process.env.JARVIS_OCR_EXCLUDED_REGIONS)?.[recordingCamera];
    const ocr = new PersistentRapidOcrEngine({
      pythonPath: recordingOcrPythonPath,
      workerPath: recordingOcrWorkerPath,
      excludedRegions: ocrExcludedRegions,
    });
    persistentOcrEngine = ocr;
    ocr.start();
    const recorder = new FfmpegSegmentRecorder({
      outputDirectory: recordingDirectory,
      transport: (process.env.JARVIS_RTSP_TRANSPORT as 'udp' | 'tcp' | undefined) ?? 'udp',
      profile: recordingProfile,
    });
    const manager = new RecordingManager(recorder, recordings);
    const objectInference = new OnnxObjectInference({
      modelPath: recordingModelPath,
      inputSize: objectOptions.inputSize,
      confidenceThreshold: objectOptions.confidenceThreshold,
      targetClasses: objectOptions.classes,
    });
    const indexer = new RecordingIndexer({
      events: new ProjectingEventAppender(events, evidenceProjection, (error) => console.error('Continuous evidence projection failed:', error instanceof Error ? error.message : error)),
      frames: new FfmpegRecordingFrameSource({
        recordingsDirectory: recordingDirectory,
        snapshotsDirectory: process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots',
        intervalMs: recordingIndexIntervalMs,
        ffmpegPath: process.env.FFMPEG_PATH,
      }),
      objects: objectInference,
      ocr,
      model: process.env.JARVIS_ONNX_MODEL_PATH?.trim() || 'yolo11n.onnx',
      ocrModel: 'rapidocr-onnxruntime',
      provider: 'CPUExecutionProvider',
      policyVersion: recordingPolicyVersion,
      continuous: true,
      objectMinConfidence: objectOptions.confidenceThreshold,
      ocrMinConfidence: 0.60,
      ocrDedupWindowMs: 30_000,
      confirmObjects: true,
      confirmationFrames: 2,
      confirmationWindowMs: 5_000,
      promoteSegment: async (segmentId) => { await recordings.promoteToEvent?.(segmentId); },
    });
    recordingRuntime = new RecordingRuntime({
      camera: recordingCamera,
      streamUrl: recordingStreamUrl,
      manager,
      recordings,
      indexer,
      indexRuns,
      model: process.env.JARVIS_ONNX_MODEL_PATH?.trim() || 'yolo11n.onnx',
      ocrModel: 'rapidocr-onnxruntime',
      policyVersion: recordingPolicyVersion,
      segmentDurationMs: recordingProfile.segmentDurationMs,
      intervalMs: recordingIndexIntervalMs,
      includeOcr: true,
      maxPendingSegments: 2,
      maxAttempts: 3,
      retryBackoffMs: Number(process.env.JARVIS_RECORDING_INDEX_RETRY_BACKOFF_MS ?? 1_000),
      backfill: recordingBackfillStatus,
      retention: {
        continuousDays: Number(process.env.JARVIS_RECORDING_MAX_AGE_DAYS ?? 30),
        eventDays: Number(process.env.JARVIS_RECORDING_EVENT_MAX_AGE_DAYS ?? 90),
        maxBytes: Number(process.env.JARVIS_RECORDING_MAX_BYTES ?? 50_000_000_000),
      },
      onError: (error) => console.error('Continuous recording/indexing failed:', error instanceof Error ? error.message : error),
    });
  } catch (error) {
    recordingRuntimeReason = error instanceof Error ? error.message.slice(0, 200) : 'continuous_runtime_creation_failed';
    await persistentOcrEngine?.close();
    persistentOcrEngine = undefined;
  }
} else {
  recordingRuntimeReason = continuousFailure;
}
const recordingRetentionService = new RecordingRetentionService(recordings, recordingDirectory, {
  continuousDays: Number(process.env.JARVIS_RECORDING_MAX_AGE_DAYS ?? 30),
  eventDays: Number(process.env.JARVIS_RECORDING_EVENT_MAX_AGE_DAYS ?? 90),
  maxBytes: Number(process.env.JARVIS_RECORDING_MAX_BYTES ?? 50_000_000_000),
  deleteAfterVerified: process.env.JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY === 'true',
  evidenceSnapshotsDirectory: process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots',
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
const recordingRetentionScheduler = new RecordingRetentionScheduler(
  {
    // This phase is dry-run by default. The legacy Drive archive path stays
    // an explicit opt-in and is never selected by the continuous DVR itself.
    run: () => recordingBackupEnabled && archiveOne
      ? recordingRetentionService.run(archiveOne)
      : recordingRetentionService.run(),
  },
  {
    intervalMs: Number(process.env.JARVIS_RECORDING_RETENTION_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    onResult: (result) => {
      if (result.candidates.length > 0 || result.failed > 0) {
        console.log(
          `Recording retention${recordingBackupEnabled ? '' : ' dry-run'}: scanned=${result.scanned} candidates=${result.candidates.length} `
          + `archived=${result.archived} failed=${result.failed} deleted=${result.deleted}`,
        );
      }
    },
    onError: (error) => console.error(
      'Recording retention failed:',
      error instanceof Error ? error.message : error,
    ),
  },
);
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
const unavailableRecordingHealth = async (): Promise<RecordingRuntimeHealth> => ({
  status: 'disabled',
  mode: 'continuous-economic',
  camera: recordingCamera,
  segmentDurationMs: recordingProfile.segmentDurationMs,
  intervalMs: recordingIndexIntervalMs,
  recording: {
    errors: recordingRuntimeReason ? 1 : 0,
    ...(recordingRuntimeReason ? { lastError: recordingRuntimeReason } : {}),
  },
  indexing: {
    queueLength: 0,
    maxPending: 2,
    backpressure: false,
  },
  backfill: { ...recordingBackfillStatus },
  bytesCataloged: 0,
  retention: {
    continuousDays: Number(process.env.JARVIS_RECORDING_MAX_AGE_DAYS ?? 30),
    eventDays: Number(process.env.JARVIS_RECORDING_EVENT_MAX_AGE_DAYS ?? 90),
    maxBytes: Number(process.env.JARVIS_RECORDING_MAX_BYTES ?? 50_000_000_000),
    dryRun: true,
  },
});
const app = buildApp({
  events,
  audit,
  snapshotStore,
  worldState,
  personNotifier,
  recordings,
  recordingsDirectory: process.env.JARVIS_RECORDING_OUTPUT_DIR ?? 'data/recordings',
  evidenceIndex,
  indexRuns,
  evidenceProjection,
  recordingRuntimeHealth: () => recordingRuntime ? recordingRuntime.health() : unavailableRecordingHealth(),
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
  databaseConfigured: databaseAvailable,
});

const shutdown = async (): Promise<void> => {
  retentionScheduler.stop();
  recordingRetentionScheduler?.stop();
  recordingArchiveScheduler?.stop();
  recordingRemoteRetentionScheduler?.stop();
  audioSessionRetentionScheduler.stop();
  await audioRuntime?.close();
  await recordingRuntime?.stop();
  await persistentOcrEngine?.close();
  await app.close();
  await closePersistentStores();
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
  if (recordingRuntime) {
    try {
      await recordingRuntime.start();
      console.log(`Continuous recording runtime started: camera=${recordingCamera} profile=${recordingProfile.name} segmentDurationMs=${recordingProfile.segmentDurationMs}`);
    } catch (error) {
      recordingRuntimeReason = error instanceof Error ? error.message.slice(0, 200) : 'continuous_runtime_start_failed';
      console.error('Continuous recording runtime not started:', recordingRuntimeReason);
      await recordingRuntime.stop();
      recordingRuntime = undefined;
      await persistentOcrEngine?.close();
      persistentOcrEngine = undefined;
    }
  }
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
  await recordingRuntime?.stop();
  await persistentOcrEngine?.close();
  await closePersistentStores();
  process.exit(1);
}
