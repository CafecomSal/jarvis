import type { EventAppender } from '../events/in-memory-event-store.js';
import {
  ObjectObservationDataSchema,
  OcrObservationDataSchema,
} from '../events/ai-observation-schema.js';
import type { ObjectInferenceResult } from '../vision/onnx-person-detector.js';
import type { OcrEngine, OcrResult } from '../vision/ocr-engine.js';
import type { RecordingSegment } from './recording-store.js';

export interface RecordingFrame {
  timestampMs: number;
  image: Buffer;
  imageRef: string;
}

export interface RecordingFrameSource {
  extract(segment: RecordingSegment): Promise<RecordingFrame[]>;
}

export interface ObjectInferenceRunner {
  infer(image: Buffer): Promise<ObjectInferenceResult>;
}

export interface RecordingIndexOptions {
  includeOcr?: boolean;
}

export interface RecordingIndexResult {
  segmentId: string;
  framesProcessed: number;
  evidenceEvents: number;
  objectEvents: number;
  ocrEvents: number;
}

function eventId(segmentId: string, timestampMs: number, kind: string): string {
  const safeKind = kind.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `evt-recording-${segmentId}-frame-${timestampMs}-${safeKind}`;
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

export class RecordingIndexer {
  private readonly model: string;
  private readonly ocrModel: string;
  private readonly provider: string;

  constructor(private readonly options: {
    events: EventAppender;
    frames: RecordingFrameSource;
    objects: ObjectInferenceRunner;
    ocr?: OcrEngine;
    model?: string;
    ocrModel?: string;
    provider?: string;
  }) {
    this.model = options.model ?? 'yolo11n.onnx';
    this.ocrModel = options.ocrModel ?? 'rapidocr-onnxruntime';
    this.provider = options.provider ?? 'CPUExecutionProvider';
    if (!this.model.trim()) throw new Error('Recording indexer model must not be empty');
    if (!this.ocrModel.trim()) throw new Error('Recording indexer ocrModel must not be empty');
    if (!this.provider.trim()) throw new Error('Recording indexer provider must not be empty');
  }

  async index(segment: RecordingSegment, indexOptions: RecordingIndexOptions = {}): Promise<RecordingIndexResult> {
    const frames = (await this.options.frames.extract(segment))
      .slice()
      .sort((left, right) => left.timestampMs - right.timestampMs);
    let evidenceEvents = 0;
    let objectEvents = 0;
    let ocrEvents = 0;

    for (const frame of frames) {
      if (!Number.isInteger(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > segment.durationMs) {
        throw new Error(`Recording frame timestamp is outside segment: ${segment.id}`);
      }
      const objectResult = await this.options.objects.infer(frame.image);
      const ocrResult = indexOptions.includeOcr
        ? await recognizeOptional(this.options.ocr, frame.image)
        : undefined;
      if (objectResult.detections.length === 0 && !ocrResult) continue;

      const timestamp = frameTimestamp(segment, frame.timestampMs);
      const evidenceEvent = await this.options.events.append({
        id: eventId(segment.id, frame.timestampMs, 'evidence'),
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
          historical: true,
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
          historical: true,
          latencyMs: objectResult.latencyMs,
        });
        await this.options.events.append({
          id: eventId(segment.id, frame.timestampMs, `object-${className}`),
          type: 'object.observed',
          timestamp,
          source: { type: 'onnx_historical', id: this.model },
          location: segment.camera,
          subject: { type: 'object', id: className },
          confidence,
          data,
        });
        objectEvents += 1;
      }

      if (ocrResult) {
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
          historical: true,
          model: this.ocrModel,
          provider: this.provider,
          latencyMs: ocrResult.latencyMs,
        });
        await this.options.events.append({
          id: eventId(segment.id, frame.timestampMs, 'ocr'),
          type: 'ocr.observation',
          timestamp,
          source: { type: 'ocr_historical', id: this.ocrModel },
          location: segment.camera,
          confidence: ocrResult.confidence,
          data,
        });
        ocrEvents += 1;
      }
    }

    return {
      segmentId: segment.id,
      framesProcessed: frames.length,
      evidenceEvents,
      objectEvents,
      ocrEvents,
    };
  }
}
