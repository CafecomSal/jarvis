import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { BoundingBoxSchema, type BoundingBox } from '../events/ai-observation-schema.js';

export interface OcrRegion {
  text: string;
  confidence: number;
  box: BoundingBox;
}

export interface OcrRawResult {
  latencyMs: number;
  regions: OcrRegion[];
}

export interface OcrResult extends OcrRawResult {
  text: string;
  normalizedText: string;
  confidence: number;
}

export interface OcrEngine {
  recognize(image: Buffer): Promise<OcrResult>;
}

export type OcrRawRunner = (image: Buffer) => Promise<OcrRawResult>;

export interface RapidOcrEngineOptions {
  pythonPath?: string;
  workerPath?: string;
  excludedRegions?: BoundingBox[];
  run?: OcrRawRunner;
}

export interface PersistentOcrProcess {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
}

export type PersistentOcrProcessSpawner = (command: string, args: string[]) => PersistentOcrProcess;

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function resolveOcrPythonPath(
  env: Record<string, string | undefined> = process.env,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const configured = env.JARVIS_OCR_PYTHON?.trim();
  if (configured) return configured;
  const localVenv = resolve('tools/ocr/.venv/Scripts/python.exe');
  return fileExists(localVenv) ? localVenv : 'python';
}

export function parseOcrExcludedRegions(
  raw: string | undefined,
): Record<string, BoundingBox[]> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JARVIS_OCR_EXCLUDED_REGIONS must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JARVIS_OCR_EXCLUDED_REGIONS must be a JSON object');
  }
  const result: Record<string, BoundingBox[]> = {};
  for (const [camera, regions] of Object.entries(parsed)) {
    if (!Array.isArray(regions)) {
      throw new Error(`JARVIS_OCR_EXCLUDED_REGIONS for ${camera} must be an array`);
    }
    result[camera] = regions.map((region) => {
      const parsedRegion = BoundingBoxSchema.safeParse(region);
      if (!parsedRegion.success) throw new Error('JARVIS_OCR_EXCLUDED_REGIONS contains an invalid region');
      return parsedRegion.data;
    });
  }
  return result;
}

function runRapidOcrProcess(
  image: Buffer,
  options: RapidOcrEngineOptions,
): Promise<OcrRawResult> {
  const pythonPath = options.pythonPath ?? resolveOcrPythonPath();
  const workerPath = options.workerPath
    ?? process.env.JARVIS_OCR_WORKER
    ?? resolve('tools/ocr/rapidocr_worker.py');
  return new Promise((resolveResult, reject) => {
    const child = spawn(pythonPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', () => reject(new Error('RapidOCR process could not start')));
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error('RapidOCR process failed'));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OcrRawResult;
        if (!parsed || !Array.isArray(parsed.regions) || !Number.isFinite(parsed.latencyMs)) {
          reject(new Error('RapidOCR returned an invalid result'));
          return;
        }
        resolveResult(parsed);
      } catch {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(`RapidOCR returned invalid JSON${detail ? `: ${detail.slice(0, 200)}` : ''}`));
      }
    });
    child.stdin.end(JSON.stringify({ imageBase64: image.toString('base64') }) + '\n');
  });
}

function filterOcrResult(raw: OcrRawResult, excludedRegions: readonly BoundingBox[]): OcrResult {
  const isExcluded = (box: BoundingBox): boolean => {
    const centerX = (box.x1 + box.x2) / 2;
    const centerY = (box.y1 + box.y2) / 2;
    return excludedRegions.some((region) => (
      centerX >= region.x1
      && centerX <= region.x2
      && centerY >= region.y1
      && centerY <= region.y2
    ));
  };
  const regions = raw.regions
    .map((region) => ({ ...region, text: region.text.trim() }))
    .filter((region) => region.text.length > 0)
    .filter((region) => !isExcluded(region.box));
  if (regions.length === 0) throw new Error('OCR returned no text');
  const uniqueTexts: string[] = [];
  const seenTexts = new Set<string>();
  for (const region of regions) {
    const key = normalizeText(region.text);
    if (seenTexts.has(key)) continue;
    seenTexts.add(key);
    uniqueTexts.push(region.text);
  }
  const text = uniqueTexts.join(' ');
  const confidence = Number(
    (regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length).toFixed(6),
  );
  return {
    text,
    normalizedText: normalizeText(text),
    confidence,
    regions,
    latencyMs: raw.latencyMs,
  };
}

export class RapidOcrEngine {
  private readonly run: OcrRawRunner;
  private readonly excludedRegions: BoundingBox[];

  constructor(options: RapidOcrEngineOptions = {}) {
    this.run = options.run ?? ((image) => runRapidOcrProcess(image, options));
    this.excludedRegions = (options.excludedRegions ?? []).map((region) => BoundingBoxSchema.parse(region));
  }

  async recognize(image: Buffer): Promise<OcrResult> {
    if (image.length === 0) throw new Error('OCR image must not be empty');
    const raw = await this.run(image);
    return filterOcrResult(raw, this.excludedRegions);
  }
}

export interface PersistentRapidOcrEngineOptions extends Omit<RapidOcrEngineOptions, 'run'> {
  spawnProcess?: PersistentOcrProcessSpawner;
}

/**
 * Keeps one RapidOCR Python process resident and serializes requests through
 * its line-delimited JSON protocol. This avoids loading the ONNX OCR model for
 * every sampled DVR frame and can be closed deterministically with the Core.
 */
export class PersistentRapidOcrEngine implements OcrEngine {
  private readonly pythonPath: string;
  private readonly workerPath: string;
  private readonly excludedRegions: BoundingBox[];
  private readonly spawnProcess: PersistentOcrProcessSpawner;
  private child?: PersistentOcrProcess;
  private outputBuffer = '';
  private pending: Array<{ resolve: (result: OcrRawResult) => void; reject: (error: unknown) => void }> = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: PersistentRapidOcrEngineOptions = {}) {
    this.pythonPath = options.pythonPath ?? resolveOcrPythonPath();
    this.workerPath = options.workerPath
      ?? process.env.JARVIS_OCR_WORKER
      ?? resolve('tools/ocr/rapidocr_worker.py');
    this.excludedRegions = (options.excludedRegions ?? []).map((region) => BoundingBoxSchema.parse(region));
    this.spawnProcess = options.spawnProcess ?? ((command, args) => spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }));
  }

  private fail(error: unknown): void {
    const child = this.child;
    this.child = undefined;
    this.outputBuffer = '';
    const pending = this.pending.splice(0);
    for (const request of pending) request.reject(error);
    if (child && !this.closed) {
      try { child.kill(); } catch { /* process already exited */ }
    }
  }

  private handleOutput(chunk: Buffer | string): void {
    this.outputBuffer += Buffer.from(chunk).toString('utf8');
    let newlineIndex = this.outputBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.outputBuffer.slice(0, newlineIndex).trim();
      this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
      newlineIndex = this.outputBuffer.indexOf('\n');
      if (!line) continue;
      const request = this.pending.shift();
      if (!request) continue;
      try {
        const parsed = JSON.parse(line) as OcrRawResult;
        if (!parsed || !Array.isArray(parsed.regions) || !Number.isFinite(parsed.latencyMs)) {
          request.reject(new Error('RapidOCR returned an invalid result'));
        } else {
          request.resolve(parsed);
        }
      } catch {
        request.reject(new Error('RapidOCR returned invalid JSON'));
      }
    }
  }

  private ensureChild(): PersistentOcrProcess {
    if (this.closed) throw new Error('RapidOCR worker is closed');
    if (this.child) return this.child;
    let child: PersistentOcrProcess;
    try {
      child = this.spawnProcess(this.pythonPath, [this.workerPath]);
    } catch {
      throw new Error('RapidOCR process could not start');
    }
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    child.once('error', () => this.fail(new Error('RapidOCR process failed')));
    child.once('close', () => {
      if (this.child === child) this.fail(new Error('RapidOCR process closed'));
    });
    return child;
  }

  private send(image: Buffer): Promise<OcrRawResult> {
    const child = this.ensureChild();
    return new Promise<OcrRawResult>((resolveResult, reject) => {
      this.pending.push({ resolve: resolveResult, reject });
      try {
        child.stdin.write(`${JSON.stringify({ imageBase64: image.toString('base64') })}\n`);
      } catch (error) {
        this.pending.pop();
        reject(new Error(error instanceof Error ? 'RapidOCR process failed' : 'RapidOCR process failed'));
      }
    });
  }

  async recognize(image: Buffer): Promise<OcrResult> {
    if (image.length === 0) throw new Error('OCR image must not be empty');
    const operation = this.queue.then(async () => filterOcrResult(await this.send(image), this.excludedRegions));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  start(): void {
    this.ensureChild();
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    const pending = this.pending.splice(0);
    for (const request of pending) request.reject(new Error('RapidOCR worker closed'));
    if (child) {
      try { child.stdin.end(); } catch { /* process already exited */ }
      try { child.kill(); } catch { /* process already exited */ }
    }
    await this.queue.catch(() => undefined);
  }
}
