import { spawn } from 'node:child_process';

export interface AudioDurationProbe {
  probe(audio: Buffer, mimeType: string): Promise<number | undefined>;
}

export interface FfprobeAudioDurationOptions {
  ffprobePath?: string;
  timeoutMs?: number;
  runner?: (audio: Buffer, mimeType: string) => Promise<string>;
}

export function parseAudioDurationSeconds(stdout: string): number | undefined {
  const value = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * ffprobe cannot always determine the duration of a WAV stream received on
 * stdin because the input is not seekable. The RIFF header still contains
 * enough information for PCM and other constant-byte-rate WAV files, so use
 * it as a bounded fallback instead of treating a valid recording as an
 * exhausted cloud quota.
 */
export function parseWavDurationSeconds(audio: Buffer): number | undefined {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined;
  }

  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= audio.length) {
    const chunkId = audio.toString('ascii', offset, offset + 4);
    const declaredSize = audio.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const availableSize = Math.max(0, Math.min(declaredSize, audio.length - payloadStart));

    if (chunkId === 'fmt ' && availableSize >= 12) {
      byteRate = audio.readUInt32LE(payloadStart + 8);
    } else if (chunkId === 'data') {
      dataBytes = availableSize;
    }

    const nextOffset = payloadStart + declaredSize + (declaredSize % 2);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (!byteRate || dataBytes === undefined) return undefined;
  const seconds = dataBytes / byteRate;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function formatForMimeType(mimeType: string): string | undefined {
  const base = mimeType.split(';', 1)[0].toLowerCase();
  if (base === 'audio/webm') return 'webm';
  if (base === 'audio/ogg') return 'ogg';
  if (base === 'audio/mpeg') return 'mp3';
  if (base === 'audio/flac') return 'flac';
  if (base === 'audio/wav') return 'wav';
  return undefined;
}

function spawnFfprobe(ffprobePath: string, audio: Buffer, mimeType: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const format = formatForMimeType(mimeType);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      ...(format ? ['-f', format] : []),
      '-i', 'pipe:0',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
    ];
    const child = spawn(ffprobePath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      finish(() => reject(new Error('ffprobe audio duration timed out')));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code !== 0) reject(new Error(stderr.trim() || `ffprobe exited (${code ?? 'unknown'})`));
      else resolve(stdout);
    }));
    child.stdin.end(audio);
  });
}

export class FfprobeAudioDurationProbe implements AudioDurationProbe {
  private readonly ffprobePath: string;
  private readonly timeoutMs: number;
  private readonly runner?: (audio: Buffer, mimeType: string) => Promise<string>;

  constructor(options: FfprobeAudioDurationOptions = {}) {
    this.ffprobePath = options.ffprobePath?.trim() || process.env.FFPROBE_PATH?.trim() || 'ffprobe';
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error('ffprobe audio duration timeout is invalid');
    }
    this.runner = options.runner;
  }

  async probe(audio: Buffer, mimeType: string): Promise<number | undefined> {
    if (audio.length === 0) return undefined;
    try {
      const stdout = await (this.runner
        ? this.runner(audio, mimeType)
        : spawnFfprobe(this.ffprobePath, audio, mimeType, this.timeoutMs));
      return parseAudioDurationSeconds(stdout)
        ?? (formatForMimeType(mimeType) === 'wav' ? parseWavDurationSeconds(audio) : undefined);
    } catch {
      return formatForMimeType(mimeType) === 'wav' ? parseWavDurationSeconds(audio) : undefined;
    }
  }
}
