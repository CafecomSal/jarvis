import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryRecordingStore, PostgresRecordingStore, type RecordingStore } from './recording-store.js';
import { FfmpegSegmentRecorder, RecordingManager } from './ffmpeg-recorder.js';
import { RecordingScheduler } from './recording-scheduler.js';
import { getRecordingProfile, RecordingProfileNameSchema, type RecordingProfile } from './recording-profile.js';
import type { RtspTransport } from '../cameras/rtsp-camera.js';

export interface RecordingOptions {
  camera: string;
  durationMs: number;
  outputDirectory: string;
  rtspTransport: RtspTransport;
  videoFps: number;
  videoPreset: string;
  retryDelayMs: number;
  once: boolean;
  continuous: boolean;
}

type Environment = Record<string, string | undefined>;

function parsePositiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be greater than zero`);
  return parsed;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(name, value, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseTransport(value: string | undefined): RtspTransport {
  const transport = value?.trim() || 'udp';
  if (transport !== 'udp' && transport !== 'tcp') throw new Error('JARVIS_RTSP_TRANSPORT must be udp or tcp');
  return transport;
}

export function parseRecordingOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): RecordingOptions {
  const supported = new Set(['--once', '--continuous']);
  const unknown = argv.find((argument) => !supported.has(argument));
  if (unknown) throw new Error(`Unknown recording argument: ${unknown}`);
  const once = argv.includes('--once');
  const continuous = argv.includes('--continuous');
  if (!once && !continuous) throw new Error('Recording CLI requires --once');
  if (once && continuous) throw new Error('Recording CLI cannot combine --once and --continuous');
  return {
    camera: env.JARVIS_RECORDING_CAMERA?.trim() || 'front',
    durationMs: parsePositiveInteger('JARVIS_RECORDING_DURATION_MS', env.JARVIS_RECORDING_DURATION_MS, 10_000),
    outputDirectory: env.JARVIS_RECORDING_OUTPUT_DIR?.trim() || 'data/recordings',
    rtspTransport: parseTransport(env.JARVIS_RTSP_TRANSPORT),
    videoFps: parsePositiveNumber('JARVIS_RECORDING_VIDEO_FPS', env.JARVIS_RECORDING_VIDEO_FPS, 5),
    videoPreset: env.JARVIS_RECORDING_VIDEO_PRESET?.trim() || 'ultrafast',
    retryDelayMs: parsePositiveNumber('JARVIS_RECORDING_RETRY_DELAY_MS', env.JARVIS_RECORDING_RETRY_DELAY_MS, 5_000),
    once,
    continuous,
  };
}

function cameraStreamEnvName(camera: string): string {
  const normalized = camera.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  return `JARVIS_CAMERA_${normalized}_RTSP_URL`;
}

export function effectiveRecordingDurationMs(configuredMs: number, profile?: RecordingProfile): number {
  return profile?.segmentDurationMs ?? configuredMs;
}

export async function runRecording(options: RecordingOptions): Promise<void> {
  const streamUrl = process.env[cameraStreamEnvName(options.camera)]?.trim();
  if (!streamUrl) throw new Error(`${cameraStreamEnvName(options.camera)} is required for the RTSP camera`);

  const store: RecordingStore = process.env.DATABASE_URL
    ? new PostgresRecordingStore()
    : new InMemoryRecordingStore();
  const postgres = store instanceof PostgresRecordingStore ? store : undefined;
  try {
    await postgres?.initialize();
    const configuredProfile = process.env.JARVIS_RECORDING_PROFILE?.trim();
    const profileName = configuredProfile || (options.continuous ? 'continuous-economic' : undefined);
    const profile = profileName
      ? getRecordingProfile(RecordingProfileNameSchema.parse(profileName))
      : undefined;
    const recorder = new FfmpegSegmentRecorder({
      outputDirectory: options.outputDirectory,
      transport: options.rtspTransport,
      videoFps: options.videoFps,
      videoPreset: options.videoPreset,
      ...(profile ? { profile } : {}),
    });
    const manager = new RecordingManager(recorder, store);

    if (options.once) {
      const saved = await manager.recordOnce(options.camera, streamUrl, options.durationMs);
      const readback = await store.findById(saved.id);
      console.log(JSON.stringify({ saved, readbackMatches: JSON.stringify(saved) === JSON.stringify(readback) }));
      return;
    }

    const scheduler = new RecordingScheduler(manager, {
      camera: options.camera,
      streamUrl,
      segmentDurationMs: effectiveRecordingDurationMs(options.durationMs, profile),
      retryDelayMs: options.retryDelayMs,
      onSegment: (segment) => console.log(JSON.stringify({ type: 'recording.segment', segment })),
      onError: (error) => console.error(
        'Recording scheduler failed:',
        error instanceof Error ? error.message : error,
      ),
    });
    const stop = (): void => scheduler.stop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    scheduler.start();
    console.log(`Recording scheduler running: camera=${options.camera} segmentDurationMs=${options.durationMs} outputDirectory=${options.outputDirectory}`);
    await scheduler.wait();
  } finally {
    await postgres?.close();
  }
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runRecording(parseRecordingOptions()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
