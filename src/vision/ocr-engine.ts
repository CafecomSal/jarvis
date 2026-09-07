import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
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

export class RapidOcrEngine {
  private readonly run: OcrRawRunner;
  private readonly excludedRegions: BoundingBox[];

  constructor(options: RapidOcrEngineOptions = {}) {
    this.run = options.run ?? ((image) => runRapidOcrProcess(image, options));
    this.excludedRegions = (options.excludedRegions ?? []).map((region) => BoundingBoxSchema.parse(region));
  }

  private isExcluded(box: BoundingBox): boolean {
    const centerX = (box.x1 + box.x2) / 2;
    const centerY = (box.y1 + box.y2) / 2;
    return this.excludedRegions.some((region) => (
      centerX >= region.x1
      && centerX <= region.x2
      && centerY >= region.y1
      && centerY <= region.y2
    ));
  }

  async recognize(image: Buffer): Promise<OcrResult> {
    if (image.length === 0) throw new Error('OCR image must not be empty');
    const raw = await this.run(image);
    const regions = raw.regions
      .map((region) => ({ ...region, text: region.text.trim() }))
      .filter((region) => region.text.length > 0)
      .filter((region) => !this.isExcluded(region.box));
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
}
