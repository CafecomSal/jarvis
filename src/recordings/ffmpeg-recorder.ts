import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, relative, resolve, sep } from 'node:path';
import type { RtspTransport } from '../cameras/rtsp-camera.js';
import type { RecordingSegment, RecordingStore } from './recording-store.js';
import type { RecordingProfile } from './recording-profile.js';
import type { RetentionTier } from './retention-budget.js';

const execFileAsync = promisify(execFile);

export interface FfmpegProbe {
  durationMs: number;
  videoCodec: string;
  audioCodec?: string;
  width: number;
  height: number;
}

export interface FfmpegRunOptions {
  ffmpegPath: string;
  streamUrl: string;
  outputPath: string;
  transport: RtspTransport;
  durationMs: number;
  timeoutMs: number;
  videoCodec: string;
  audioCodec: string;
  videoFps: number;
  videoPreset: string;
  videoWidth?: number;
  videoHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  signal?: AbortSignal;
}

export type FfmpegRunner = (options: FfmpegRunOptions) => Promise<void>;
export type FfmpegProbeRunner = (path: string, ffprobePath: string) => Promise<FfmpegProbe>;

export interface FfmpegSegmentRecorderOptions {
  outputDirectory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  transport?: RtspTransport;
  timeoutMs?: number;
  profile?: RecordingProfile;
  videoFps?: number;
  videoPreset?: string;
  videoWidth?: number;
  videoHeight?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  retentionTier?: RetentionTier;
  clock?: () => Date;
  runFfmpeg?: FfmpegRunner;
  probe?: FfmpegProbeRunner;
}

function validateStreamUrl(streamUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(streamUrl);
  } catch {
    throw new Error('Recording stream URL is invalid');
  }
  if (parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') {
    throw new Error('Recording stream URL must use rtsp:// or rtsps://');
  }
}

function videoFilterFor(options: FfmpegRunOptions): string {
  const fps = `fps=${options.videoFps}`;
  if (!options.videoWidth || !options.videoHeight) return fps;
  return [
    fps,
    `scale=${options.videoWidth}:${options.videoHeight}:force_original_aspect_ratio=decrease:flags=bilinear`,
    `pad=${options.videoWidth}:${options.videoHeight}:(ow-iw)/2:(oh-ih)/2:color=000000`,
  ].join(',');
}

function defaultRunFfmpeg(options: FfmpegRunOptions): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(options.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      options.transport,
      '-i',
      options.streamUrl,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      videoFilterFor(options),
      '-c:v',
      options.videoCodec,
      '-preset',
      options.videoPreset,
      ...(options.videoBitrateKbps ? ['-b:v', `${options.videoBitrateKbps}k`] : []),
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      options.audioCodec,
      '-ar',
      '8000',
      '-b:a',
      `${options.audioBitrateKbps ?? 64}k`,
      '-avoid_negative_ts',
      'make_zero',
      '-t',
      (options.durationMs / 1000).toFixed(3),
      '-f',
      'matroska',
      options.outputPath,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      child.kill();
      finish(() => reject(new Error('FFmpeg recording stopped')));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('FFmpeg recording timed out'));
    }, options.timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(() => reject(new Error('FFmpeg recorder process could not start'))));
    child.once('close', (code) => finish(() => {
      options.signal?.removeEventListener('abort', abort);
      if (code !== 0) {
        reject(new Error('FFmpeg could not record the RTSP segment'));
        return;
      }
      resolveRun();
    }));
  });
}

async function defaultProbe(path: string, ffprobePath: string): Promise<FfmpegProbe> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobePath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      path,
    ], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }));
  } catch {
    throw new Error('FFprobe could not inspect the recorded segment');
  }

  let parsed: {
    format?: { duration?: string | number };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error('FFprobe returned invalid metadata');
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.codec_name || !video.width || !video.height) {
    throw new Error('Recorded segment has no valid video stream');
  }
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  return {
    durationMs,
    videoCodec: video.codec_name,
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    width: video.width,
    height: video.height,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class FfmpegSegmentRecorder {
  private readonly outputDirectory: string;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly transport: RtspTransport;
  private readonly timeoutMs: number;
  private readonly videoFps: number;
  private readonly videoPreset: string;
  private readonly videoWidth?: number;
  private readonly videoHeight?: number;
  private readonly videoBitrateKbps?: number;
  private readonly audioBitrateKbps?: number;
  private readonly retentionTier: RetentionTier;
  private readonly clock: () => Date;
  private readonly runFfmpeg: FfmpegRunner;
  private readonly probe: FfmpegProbeRunner;
  private activeAbortController?: AbortController;

  constructor(options: FfmpegSegmentRecorderOptions) {
    this.outputDirectory = resolve(options.outputDirectory);
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
    this.transport = options.transport ?? 'udp';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.videoFps = options.profile?.videoFps ?? options.videoFps ?? 5;
    this.videoPreset = options.profile?.videoPreset ?? options.videoPreset ?? 'ultrafast';
    this.videoWidth = options.profile?.width ?? options.videoWidth;
    this.videoHeight = options.profile?.height ?? options.videoHeight;
    this.videoBitrateKbps = options.profile?.videoBitrateKbps ?? options.videoBitrateKbps;
    this.audioBitrateKbps = options.profile?.audioBitrateKbps ?? options.audioBitrateKbps;
    this.retentionTier = options.retentionTier
      ?? (options.profile?.name === 'event-high-quality' ? 'event' : 'continuous');
    this.clock = options.clock ?? (() => new Date());
    this.runFfmpeg = options.runFfmpeg ?? defaultRunFfmpeg;
    this.probe = options.probe ?? defaultProbe;
    if (!this.outputDirectory.trim()) throw new Error('Recording outputDirectory must not be empty');
    if (this.transport !== 'udp' && this.transport !== 'tcp') {
      throw new Error('Recording transport must be udp or tcp');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Recording timeoutMs must be greater than zero');
    }
    if (!Number.isFinite(this.videoFps) || this.videoFps <= 0) {
      throw new Error('Recording videoFps must be greater than zero');
    }
    if (!this.videoPreset.trim()) throw new Error('Recording videoPreset must not be empty');
    if (this.videoWidth !== undefined && (!Number.isInteger(this.videoWidth) || this.videoWidth <= 0)) {
      throw new Error('Recording videoWidth must be a positive integer');
    }
    if (this.videoHeight !== undefined && (!Number.isInteger(this.videoHeight) || this.videoHeight <= 0)) {
      throw new Error('Recording videoHeight must be a positive integer');
    }
    if (this.videoBitrateKbps !== undefined && (!Number.isInteger(this.videoBitrateKbps) || this.videoBitrateKbps <= 0)) {
      throw new Error('Recording videoBitrateKbps must be a positive integer');
    }
    if (this.audioBitrateKbps !== undefined && (!Number.isInteger(this.audioBitrateKbps) || this.audioBitrateKbps <= 0)) {
      throw new Error('Recording audioBitrateKbps must be a positive integer');
    }
  }

  async recordOnce(camera: string, streamUrl: string, durationMs: number): Promise<RecordingSegment> {
    if (!camera.trim()) throw new Error('Recording camera must not be empty');
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new Error('Recording durationMs must be a positive integer');
    }
    validateStreamUrl(streamUrl);
    const id = `rec-${randomUUID()}`;
    const startedAt = this.clock();
    const dateDirectory = startedAt.toISOString().slice(0, 10);
    const outputPath = resolve(this.outputDirectory, camera, dateDirectory, `${id}.mkv`);
    await mkdir(dirname(outputPath), { recursive: true });
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    try {
      await this.runFfmpeg({
        ffmpegPath: this.ffmpegPath,
        streamUrl,
        outputPath,
        transport: this.transport,
        durationMs,
        timeoutMs: Math.max(this.timeoutMs, durationMs + 5_000),
        videoCodec: 'libx264',
        audioCodec: 'aac',
        videoFps: this.videoFps,
        videoPreset: this.videoPreset,
        ...(this.videoWidth === undefined ? {} : { videoWidth: this.videoWidth }),
        ...(this.videoHeight === undefined ? {} : { videoHeight: this.videoHeight }),
        ...(this.videoBitrateKbps === undefined ? {} : { videoBitrateKbps: this.videoBitrateKbps }),
        ...(this.audioBitrateKbps === undefined ? {} : { audioBitrateKbps: this.audioBitrateKbps }),
        signal: abortController.signal,
      });
      const fileStats = await stat(outputPath);
      if (!fileStats.isFile() || fileStats.size === 0) throw new Error('FFmpeg produced an empty recording');
      const metadata = await this.probe(outputPath, this.ffprobePath);
      const actualDurationMs = metadata.durationMs > 0 ? metadata.durationMs : durationMs;
      const fileRef = relative(this.outputDirectory, outputPath).split(sep).join('/');
      return {
        id,
        camera,
        startedAt: startedAt.toISOString(),
        endedAt: new Date(startedAt.getTime() + actualDurationMs).toISOString(),
        durationMs: actualDurationMs,
        fileRef,
        bytes: fileStats.size,
        mimeType: 'video/x-matroska',
        videoCodec: metadata.videoCodec,
        ...(metadata.audioCodec ? { audioCodec: metadata.audioCodec } : {}),
        width: metadata.width,
        height: metadata.height,
        checksum: await sha256File(outputPath),
        backupStatus: 'local',
        retentionTier: this.retentionTier,
      };
    } catch (error) {
      await rm(outputPath, { force: true });
      throw error;
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = undefined;
    }
  }

  close(): void {
    this.activeAbortController?.abort();
  }
}

export class RecordingManager {
  constructor(
    private readonly recorder: FfmpegSegmentRecorder,
    private readonly store: RecordingStore,
  ) {}

  async recordOnce(camera: string, streamUrl: string, durationMs: number): Promise<RecordingSegment> {
    const segment = await this.recorder.recordOnce(camera, streamUrl, durationMs);
    return this.store.append(segment);
  }

  close(): void {
    this.recorder.close();
  }
}
