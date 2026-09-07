import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import type { AudioTranscript } from '../audio-types.js';
import type { SttProvider } from '../stt-provider.js';

export interface FasterWhisperRunnerResult {
  text: string;
  language?: string;
  confidence?: number;
}

export type FasterWhisperRunner = (
  audio: Buffer,
  mimeType: string,
  model: string,
) => Promise<FasterWhisperRunnerResult>;

export interface FasterWhisperSttOptions {
  model?: string;
  runner?: FasterWhisperRunner;
  pythonCommand?: string;
  timeoutMs?: number;
  workerPath?: string;
}

type WorkerMessage = {
  type: 'ready' | 'result';
  id?: string;
  ok?: boolean;
  text?: string;
  language?: string;
  confidence?: number;
  error?: string;
};

interface PendingRequest {
  resolve: (result: FasterWhisperRunnerResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function normalizeLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  return language.toLowerCase() === 'pt' ? 'pt-BR' : language;
}

class FasterWhisperWorker {
  private child?: ChildProcessWithoutNullStreams;
  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly model: string,
    private readonly pythonCommand: string,
    private readonly workerPath: string,
    private readonly timeoutMs: number,
  ) {}

  private consumeOutput(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (!line) continue;
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        continue;
      }
      if (message.type === 'ready') {
        this.resolveReady?.();
        this.resolveReady = undefined;
        this.rejectReady = undefined;
        continue;
      }
      if (message.type !== 'result' || !message.id) continue;
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok && typeof message.text === 'string') {
        request.resolve({
          text: message.text,
          ...(message.language ? { language: message.language } : {}),
          ...(message.confidence === undefined ? {} : { confidence: message.confidence }),
        });
      } else {
        request.reject(new Error(message.error || 'faster-whisper worker failed'));
      }
    }
  }

  private failWorker(error: Error, child: ChildProcessWithoutNullStreams | undefined = this.child): void {
    if (child && this.child && child !== this.child) return;
    this.rejectReady?.(error);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
    this.readyPromise = undefined;
    if (child && !child.killed) child.kill();
  }

  private start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    const child = spawn(this.pythonCommand, ['-u', this.workerPath, this.model], {
      windowsHide: true,
      stdio: 'pipe',
    });
    this.child = child;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    let finished = false;
    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      this.failWorker(error, child);
    };
    child.stdout.on('data', (chunk: Buffer) => this.consumeOutput(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString('utf8')}`.slice(-1000);
    });
    child.once('error', (error) => fail(error instanceof Error ? error : new Error('faster-whisper worker could not start')));
    child.once('close', (code) => {
      const detail = this.stderrBuffer.trim();
      fail(new Error(`faster-whisper worker exited (${code ?? 'unknown'})${detail ? `: ${detail.slice(-500)}` : ''}`));
    });
    return this.readyPromise;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<FasterWhisperRunnerResult> {
    await this.start();
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error('faster-whisper worker is not available');
    const id = randomUUID();
    return new Promise<FasterWhisperRunnerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`faster-whisper timed out after ${this.timeoutMs}ms`);
        reject(error);
        this.failWorker(error, child);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({
          id,
          mimeType,
          audioBase64: audio.toString('base64'),
        }) + '\n', 'utf8', (error) => {
          if (!error) return;
          const request = this.pending.get(id);
          if (!request) return;
          this.pending.delete(id);
          clearTimeout(request.timer);
          request.reject(error);
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('faster-whisper worker request failed'));
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('close', done);
      this.failWorker(new Error('faster-whisper worker closed'), child);
      if (child.exitCode !== null) resolve();
    });
  }
}

export class FasterWhisperSttProvider implements SttProvider {
  private readonly model: string;
  private readonly runner: FasterWhisperRunner;
  private readonly worker?: FasterWhisperWorker;

  constructor(options: FasterWhisperSttOptions = {}) {
    this.model = (options.model ?? process.env.JARVIS_STT_MODEL ?? 'medium').trim();
    const pythonCommand = options.pythonCommand ?? process.env.PYTHON_COMMAND ?? 'python';
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!this.model) throw new Error('STT model must not be empty');
    if (options.runner) {
      this.runner = options.runner;
    } else {
      const worker = new FasterWhisperWorker(
        this.model,
        pythonCommand,
        options.workerPath ?? process.env.JARVIS_STT_WORKER ?? join(process.cwd(), 'scripts', 'faster_whisper_worker.py'),
        timeoutMs,
      );
      this.worker = worker;
      this.runner = (audio, mimeType) => worker.transcribe(audio, mimeType);
    }
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<AudioTranscript> {
    if (audio.length === 0) throw new Error('STT audio must not be empty');
    const started = performance.now();
    const result = await this.runner(audio, mimeType, this.model);
    const text = result.text.trim();
    if (!text) throw new Error('STT returned empty transcript');
    return {
      text,
      ...(normalizeLanguage(result.language) ? { language: normalizeLanguage(result.language) } : {}),
      ...(result.confidence === undefined ? {} : { confidence: Math.max(0, Math.min(1, result.confidence)) }),
      provider: 'faster-whisper',
      model: this.model,
      latencyMs: Math.max(0, performance.now() - started),
    };
  }

  async close(): Promise<void> {
    await this.worker?.close();
  }
}
