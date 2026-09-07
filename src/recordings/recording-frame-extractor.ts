import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RecordingSegment } from './recording-store.js';
import { resolveRecordingFile } from './recording-file.js';

export interface FrameCaptureOptions {
  ffmpegPath: string;
  filePath: string;
  timestampMs: number;
  timeoutMs: number;
}

export type FrameCapture = (options: FrameCaptureOptions) => Promise<Buffer>;

export interface RecordingFrame {
  timestampMs: number;
  image: Buffer;
  imageRef: string;
}

export interface FfmpegRecordingFrameSourceOptions {
  recordingsDirectory: string;
  snapshotsDirectory: string;
  intervalMs?: number;
  ffmpegPath?: string;
  timeoutMs?: number;
  capture?: FrameCapture;
}

function defaultCapture(options: FrameCaptureOptions): Promise<Buffer> {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(options.ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      (options.timestampMs / 1000).toFixed(3),
      '-i',
      options.filePath,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('FFmpeg frame extraction timed out'));
    }, options.timeoutMs);
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => finish(() => reject(new Error('FFmpeg frame extractor could not start'))));
    child.once('close', (code) => finish(() => {
      if (code !== 0) {
        reject(new Error('FFmpeg could not extract a recording frame'));
        return;
      }
      const image = Buffer.concat(chunks);
      if (image.length === 0) {
        reject(new Error('FFmpeg returned an empty recording frame'));
        return;
      }
      resolveCapture(image);
    }));
  });
}

function frameName(timestampMs: number): string {
  return `frame-${String(timestampMs).padStart(10, '0')}.jpg`;
}

export class FfmpegRecordingFrameSource {
  private readonly recordingsDirectory: string;
  private readonly snapshotsDirectory: string;
  private readonly intervalMs: number;
  private readonly ffmpegPath: string;
  private readonly timeoutMs: number;
  private readonly capture: FrameCapture;

  constructor(options: FfmpegRecordingFrameSourceOptions) {
    this.recordingsDirectory = resolve(options.recordingsDirectory);
    this.snapshotsDirectory = resolve(options.snapshotsDirectory);
    this.intervalMs = options.intervalMs ?? 1_000;
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.capture = options.capture ?? defaultCapture;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Frame extraction intervalMs must be greater than zero');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Frame extraction timeoutMs must be greater than zero');
    }
  }

  async extract(segment: RecordingSegment): Promise<RecordingFrame[]> {
    const segmentPath = resolveRecordingFile(this.recordingsDirectory, segment.fileRef);
    await access(segmentPath);
    const frames: RecordingFrame[] = [];
    const lastSafeTimestampMs = Math.max(0, segment.durationMs - Math.min(this.intervalMs, 250));
    for (let timestampMs = 0; timestampMs <= lastSafeTimestampMs; timestampMs += this.intervalMs) {
      const image = await this.capture({
        ffmpegPath: this.ffmpegPath,
        filePath: segmentPath,
        timestampMs,
        timeoutMs: this.timeoutMs,
      });
      if (image.length === 0) throw new Error(`Empty frame extracted from segment: ${segment.id}`);
      const fileName = frameName(timestampMs);
      const imageRef = `recordings/${segment.id}/${fileName}`;
      const imagePath = resolve(this.snapshotsDirectory, ...imageRef.split('/'));
      await mkdir(resolve(this.snapshotsDirectory, 'recordings', segment.id), { recursive: true });
      await writeFile(imagePath, image, { mode: 0o600 });
      frames.push({ timestampMs, image, imageRef });
    }
    return frames;
  }
}
