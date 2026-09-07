import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import type { TtsProvider, TtsRequest, TtsResult } from '../tts-provider.js';

export type PiperRunner = (text: string, request: TtsRequest) => Promise<Buffer>;

export interface PiperTtsOptions {
  modelPath: string;
  command?: string;
  commandArgs?: string[];
  runner?: PiperRunner;
  timeoutMs?: number;
}

async function defaultRunner(
  text: string,
  options: { modelPath: string; command: string; commandArgs: string[]; timeoutMs: number },
): Promise<Buffer> {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-tts-'));
  const outputPath = join(directory, 'speech.wav');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(options.command, [
        ...options.commandArgs,
        '--model', options.modelPath,
        '--output_file', outputPath,
      ], { windowsHide: true });
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Piper timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', async (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(new Error(`Piper failed${detail ? `: ${detail.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          resolve(await readFile(outputPath));
        } catch {
          reject(new Error('Piper did not produce an audio file'));
        }
      });
      child.stdin.end(text);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class PiperTtsProvider implements TtsProvider {
  private readonly modelPath: string;
  private readonly runner: PiperRunner;

  constructor(options: PiperTtsOptions) {
    this.modelPath = options.modelPath.trim();
    if (!this.modelPath) throw new Error('Piper modelPath must not be empty');
    const command = options.command ?? process.env.PIPER_COMMAND ?? 'piper';
    const commandArgs = options.commandArgs ?? [];
    const timeoutMs = options.timeoutMs ?? 30_000;
    this.runner = options.runner ?? ((text, request) => defaultRunner(text, {
      modelPath: this.modelPath,
      command,
      commandArgs,
      timeoutMs,
    }));
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const text = request.text.trim();
    if (!text) throw new Error('TTS text must not be empty');
    const started = performance.now();
    const audio = await this.runner(text, request);
    if (audio.length === 0) throw new Error('TTS returned empty audio');
    return {
      audio,
      mimeType: 'audio/wav',
      provider: 'piper',
      model: this.modelPath,
      latencyMs: Math.max(0, performance.now() - started),
    };
  }
}
