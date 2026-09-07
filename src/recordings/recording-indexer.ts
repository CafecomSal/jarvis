import type { EventAppender } from '../events/in-memory-event-store.js';
import {
  ObjectObservationDataSchema,
  OcrObservationDataSchema,
} from '../events/ai-observation-schema.js';
import type { ObjectInferenceResult } from '../vision/onnx-person-detector.js';
import type { OcrEngine, OcrResult } from '../vision/ocr-engine.js';
import type { RecordingFrame, RecordingFrameExtractOptions, RecordingFrameSource } from './recording-frame-extractor.js';
import type { RecordingSegment } from './recording-store.js';
import { normalizeEvidenceText } from '../evidence/evidence-index-store.js';

export type { RecordingFrame } from './recording-frame-extractor.js';

export interface ObjectInferenceRunner {
  infer(image: Buffer): Promise<ObjectInferenceResult>;
}

export interface RecordingIndexOptions {
  includeOcr?: boolean;
  temporaryFrames?: boolean;
  force?: boolean;
}

export interface RecordingIndexerOptions {
  events: EventAppender;
  frames: RecordingFrameSource;
  objects: ObjectInferenceRunner;
  ocr?: OcrEngine;
  model?: string;
  ocrModel?: string;
  provider?: string;
  policyVersion?: string;
  continuous?: boolean;
  objectMinConfidence?: number;
  ocrMinConfidence?: number;
  ocrDedupWindowMs?: number;
  confirmObjects?: boolean;
  confirmationFrames?: number;
  confirmationWindowMs?: number;
  promoteSegment?: (segmentId: string) => Promise<void>;
  clock?: () => Date;
}

export interface RecordingIndexResult {
  segmentId: string;
  framesProcessed: number;
  evidenceEvents: number;
  objectEvents: number;
  ocrEvents: number;
  promotedToEvent: boolean;
}

function eventId(segmentId: string, timestampMs: number, kind: string, identity?: string): string {
  const safeKind = kind.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeIdentity = identity ? `-${identity.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)}` : '';
  return `evt-recording-${segmentId}-frame-${timestampMs}-${safeKind}${safeIdentity}`;
}

function frameTimestamp(segment: RecordingSegment, timestampMs: number): string {
  const startedAtMs = Date.parse(segment.startedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error(`Recording segment has invalid start: ${segment.id}`);
  return new Date(startedAtMs + timestampMs).toISOString();
}

async function recognizeOptional(ocr: OcrEngine | undefined, image: Buffer): Promise<OcrResult | undefined> {
  if (!ocr) return undefined;
  try {
    return await ocr.recognize(image);
  } catch (error) {
    if (error instanceof Error && error.message === 'OCR returned no text') return undefined;
    throw error;
  }
}

interface ConfirmationState {
  timestamps: number[];
}

function cloneResult(result: RecordingIndexResult): RecordingIndexResult {
  return { ...result };
}

export class RecordingIndexer {
  private readonly model: string;
  private readonly ocrModel: string;
  private readonly provider: string;
  private readonly policyVersion: string;
  private readonly continuous: boolean;
  private readonly objectMinConfidence: number;
  private readonly ocrMinConfidence: number;
  private readonly ocrDedupWindowMs: number;
  private readonly confirmObjects: boolean;
  private readonly confirmationFrames: number;
  private readonly confirmationWindowMs: number;
  private readonly promoteSegment?: (segmentId: string) => Promise<void>;
  private readonly clock: () => Date;
  private readonly ocrSeen = new Map<string, { timestampMs: number; segmentId: string; frameTimestampMs: number }>();
  private readonly confirmations = new Map<string, ConfirmationState>();
  private readonly completed = new Map<string, RecordingIndexResult>();

  constructor(private readonly options: RecordingIndexerOptions) {
    this.model = options.model ?? 'yolo11n.onnx';
    this.ocrModel = options.ocrModel ?? 'rapidocr-onnxruntime';
    this.provider = options.provider ?? 'CPUExecutionProvider';
    this.policyVersion = options.policyVersion ?? 'continuous-v1';
    this.continuous = options.continuous ?? false;
    this.objectMinConfidence = options.objectMinConfidence ?? 0.35;
    this.ocrMinConfidence = options.ocrMinConfidence ?? 0.6;
    this.ocrDedupWindowMs = options.ocrDedupWindowMs ?? 30_000;
    this.confirmObjects = options.confirmObjects ?? false;
    this.confirmationFrames = options.confirmationFrames ?? 2;
    this.confirmationWindowMs = options.confirmationWindowMs ?? 5_000;
    this.promoteSegment = options.promoteSegment;
    this.clock = options.clock ?? (() => new Date());
    if (!this.model.trim()) throw new Error('Recording indexer model must not be empty');
    if (!this.ocrModel.trim()) throw new Error('Recording indexer ocrModel must not be empty');
    if (!this.provider.trim()) throw new Error('Recording indexer provider must not be empty');
    if (!this.policyVersion.trim()) throw new Error('Recording indexer policyVersion must not be empty');
    if (!Number.isFinite(this.objectMinConfidence) || this.objectMinConfidence < 0 || this.objectMinConfidence > 1) {
      throw new Error('Recording indexer objectMinConfidence must be between zero and one');
    }
    if (!Number.isFinite(this.ocrMinConfidence) || this.ocrMinConfidence < 0 || this.ocrMinConfidence > 1) {
      throw new Error('Recording indexer ocrMinConfidence must be between zero and one');
    }
    if (!Number.isFinite(this.ocrDedupWindowMs) || this.ocrDedupWindowMs < 0) {
      throw new Error('Recording indexer ocrDedupWindowMs must be zero or greater');
    }
    if (!Number.isInteger(this.confirmationFrames) || this.confirmationFrames < 1) {
      throw new Error('Recording indexer confirmationFrames must be positive');
    }
    if (!Number.isFinite(this.confirmationWindowMs) || this.confirmationWindowMs <= 0) {
      throw new Error('Recording indexer confirmationWindowMs must be greater than zero');
    }
  }

  private async extractFrames(segment: RecordingSegment, temporary: boolean): Promise<RecordingFrame[]> {
    const options: RecordingFrameExtractOptions = { temporary };
    return this.options.frames.extract(segment, options);
  }

  private confirmationFor(camera: string, className: string, occurredAtMs: number): boolean {
    const key = `${camera}\u0000${className}`;
    const state = this.confirmations.get(key) ?? { timestamps: [] };
    state.timestamps = state.timestamps.filter((value) => occurredAtMs - value <= this.confirmationWindowMs);
    state.timestamps.push(occurredAtMs);
    this.confirmations.set(key, state);
    return state.timestamps.length >= this.confirmationFrames;
  }

  private acceptsOcr(segment: RecordingSegment, result: OcrResult, timestampMs = 0): boolean {
    const normalizedText = normalizeEvidenceText(result.normalizedText);
    if (result.confidence < this.ocrMinConfidence || !normalizedText) return false;
    if (!this.continuous || this.ocrDedupWindowMs === 0) return true;
    const segmentStartMs = Date.parse(segment.startedAt);
    if (!Number.isFinite(segmentStartMs)) return true;
    const currentTimestamp = segmentStartMs + timestampMs;
    const key = `${segment.camera}\u0000${normalizedText}`;
    const lastSeen = this.ocrSeen.get(key);
    const isRetryOfSameFrame = lastSeen?.segmentId === segment.id && lastSeen.frameTimestampMs === timestampMs;
    if (lastSeen && !isRetryOfSameFrame && Math.abs(currentTimestamp - lastSeen.timestampMs) < this.ocrDedupWindowMs) return false;
    this.ocrSeen.set(key, { timestampMs: currentTimestamp, segmentId: segment.id, frameTimestampMs: timestampMs });
    const cutoff = currentTimestamp - this.ocrDedupWindowMs * 2;
    for (const [seenKey, seenAt] of this.ocrSeen) {
      if (seenKey !== key && seenAt.timestampMs < cutoff) this.ocrSeen.delete(seenKey);
    }
    return true;
  }

  async index(segment: RecordingSegment, indexOptions: RecordingIndexOptions = {}): Promise<RecordingIndexResult> {
    const cacheKey = `${segment.id}\u0000${this.policyVersion}\u0000${this.model}\u0000${this.ocrModel}\u0000${indexOptions.includeOcr === true ? 'ocr' : 'objects'}`;
    const cached = this.completed.get(cacheKey);
    if (cached && !indexOptions.force) return cloneResult(cached);

    const frames = await this.extractFrames(segment, indexOptions.temporaryFrames ?? this.continuous);
    let evidenceEvents = 0;
    let objectEvents = 0;
    let ocrEvents = 0;
    let promotedToEvent = false;
    const temporaryFrames = new Set<RecordingFrame>(frames.filter((frame) => frame.temporary));

    try {
      const sortedFrames = frames.slice().sort((left, right) => left.timestampMs - right.timestampMs);
      for (const originalFrame of sortedFrames) {
        let frame = originalFrame;
        if (!Number.isInteger(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > segment.durationMs) {
          throw new Error(`Recording frame timestamp is outside segment: ${segment.id}`);
        }
        const rawObjectResult = await this.options.objects.infer(frame.image);
        const objectResult = {
          ...rawObjectResult,
          detections: rawObjectResult.detections.filter((detection) => (
            Number.isFinite(detection.confidence) && detection.confidence >= this.objectMinConfidence
          )),
        };
        const rawOcrResult = indexOptions.includeOcr === true
          ? await recognizeOptional(this.options.ocr, frame.image)
          : undefined;
        const ocrResult = rawOcrResult && this.acceptsOcr(segment, rawOcrResult, frame.timestampMs)
          ? rawOcrResult
          : undefined;
        const objectAccepted = objectResult.detections.length > 0;
        if (!objectAccepted && !ocrResult) {
          if (frame.temporary) await this.options.frames.dispose?.(frame);
          temporaryFrames.delete(frame);
          continue;
        }

        if (frame.temporary) {
          if (!this.options.frames.promote) {
            throw new Error('Recording frame source cannot promote temporary evidence frames');
          }
          frame = await this.options.frames.promote(frame);
          if (frame.temporary) throw new Error('Recording frame promotion returned a temporary frame');
          temporaryFrames.delete(originalFrame);
        }
        const timestamp = frameTimestamp(segment, frame.timestampMs);
        const eventIdentity = this.continuous
          ? `${this.policyVersion}-${this.model}-${this.ocrModel}`
          : undefined;
        const historical = !this.continuous;
        const evidenceEvent = await this.options.events.append({
          id: eventId(segment.id, frame.timestampMs, 'evidence', eventIdentity),
          type: 'camera.snapshot',
          timestamp,
          source: { type: 'recording', id: segment.id },
          location: segment.camera,
          data: {
            camera: segment.camera,
            recordingSegmentId: segment.id,
            frameTimestampMs: frame.timestampMs,
            imageRef: frame.imageRef,
            mimeType: 'image/jpeg',
            bytes: frame.image.length,
            historical,
            indexMode: this.continuous ? 'continuous' : 'manual',
          },
        });
        evidenceEvents += 1;

        const byClass = new Map<string, typeof objectResult.detections>();
        for (const detection of objectResult.detections) {
          const current = byClass.get(detection.className) ?? [];
          current.push(detection);
          byClass.set(detection.className, current);
        }
        for (const [className, detections] of byClass) {
          const confidence = Math.max(...detections.map((detection) => detection.confidence));
          const confirmed = this.confirmObjects
            ? this.confirmationFor(segment.camera, className, Date.parse(timestamp))
            : true;
          if (confirmed) promotedToEvent = true;
          const data = ObjectObservationDataSchema.parse({
            camera: segment.camera,
            className,
            classId: detections[0]?.classId,
            model: this.model,
            provider: this.provider,
            detections: detections.map(({ confidence: itemConfidence, box }) => ({
              confidence: itemConfidence,
              box,
            })),
            evidenceEventId: evidenceEvent.id,
            imageRef: frame.imageRef,
            recordingSegmentId: segment.id,
            frameTimestampMs: frame.timestampMs,
            historical,
            latencyMs: objectResult.latencyMs,
            confirmed,
          });
          await this.options.events.append({
            id: eventId(segment.id, frame.timestampMs, `object-${className}`, eventIdentity),
            type: 'object.observed',
            timestamp,
            source: { type: this.continuous ? 'onnx_continuous' : 'onnx_historical', id: this.model },
            location: segment.camera,
            subject: { type: 'object', id: className },
            confidence,
            data,
          });
          objectEvents += 1;
        }

        if (ocrResult) {
          promotedToEvent = true;
          const data = OcrObservationDataSchema.parse({
            camera: segment.camera,
            text: ocrResult.text,
            normalizedText: ocrResult.normalizedText,
            confidence: ocrResult.confidence,
            regions: ocrResult.regions,
            evidenceEventId: evidenceEvent.id,
            imageRef: frame.imageRef,
            recordingSegmentId: segment.id,
            frameTimestampMs: frame.timestampMs,
            historical,
            model: this.ocrModel,
            provider: this.provider,
            latencyMs: ocrResult.latencyMs,
          });
          await this.options.events.append({
            id: eventId(segment.id, frame.timestampMs, 'ocr', eventIdentity),
            type: 'ocr.observation',
            timestamp,
            source: { type: this.continuous ? 'ocr_continuous' : 'ocr_historical', id: this.ocrModel },
            location: segment.camera,
            confidence: ocrResult.confidence,
            data,
          });
          ocrEvents += 1;
        }
      }

      if (promotedToEvent) await this.promoteSegment?.(segment.id);
      const result: RecordingIndexResult = {
        segmentId: segment.id,
        framesProcessed: frames.length,
        evidenceEvents,
        objectEvents,
        ocrEvents,
        promotedToEvent,
      };
      this.completed.set(cacheKey, result);
      return cloneResult(result);
    } finally {
      for (const frame of temporaryFrames) {
        try {
          await this.options.frames.dispose?.(frame);
        } catch {
          // Cleanup is best-effort and must not hide the indexing result.
        }
      }
    }
  }

  now(): Date {
    return this.clock();
  }
}
