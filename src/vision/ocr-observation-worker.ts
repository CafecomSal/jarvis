import { randomUUID } from 'node:crypto';
import type { CameraAdapter } from '../cameras/camera-adapter.js';
import type { EventAppender } from '../events/in-memory-event-store.js';
import { OcrObservationDataSchema } from '../events/ai-observation-schema.js';
import type { OcrEngine, OcrResult } from './ocr-engine.js';

export interface OcrObservationWorkerOptions {
  camera: CameraAdapter;
  events: EventAppender;
  ocr: OcrEngine;
  cameraLocations?: Record<string, string>;
  model?: string;
  provider?: string;
  clock?: () => Date;
}

export interface OcrObservationResult extends OcrResult {
  camera: string;
  evidenceEventId: string;
  eventId: string;
}

export class OcrObservationWorker {
  private readonly cameraLocations: Record<string, string>;
  private readonly model: string;
  private readonly provider: string;
  private readonly clock: () => Date;

  constructor(private readonly options: OcrObservationWorkerOptions) {
    this.cameraLocations = options.cameraLocations ?? {};
    this.model = options.model ?? 'rapidocr-onnxruntime';
    this.provider = options.provider ?? 'CPUExecutionProvider';
    this.clock = options.clock ?? (() => new Date());
    if (!this.model.trim()) throw new Error('OCR observation model must not be empty');
    if (!this.provider.trim()) throw new Error('OCR observation provider must not be empty');
  }

  async observeOnce(cameraName: string): Promise<OcrObservationResult> {
    const snapshot = await this.options.camera.snapshot(cameraName);
    const capturedAt = snapshot.capturedAt || this.clock().toISOString();
    const location = this.cameraLocations[snapshot.camera] ?? snapshot.camera;
    const sourceType = snapshot.sourceType ?? 'camera';
    const sourceId = snapshot.sourceId ?? snapshot.camera;
    const evidenceEvent = await this.options.events.append({
      id: `evt-${randomUUID()}`,
      type: 'camera.snapshot',
      timestamp: capturedAt,
      source: { type: sourceType, id: sourceId },
      location,
      data: {
        camera: snapshot.camera,
        location,
        sourceType,
        sourceId,
        ...(snapshot.oid === undefined ? {} : { oid: snapshot.oid }),
        imageRef: snapshot.imageRef ?? null,
        mimeType: snapshot.mimeType,
        bytes: snapshot.bytes,
      },
    });

    const ocr = await this.options.ocr.recognize(Buffer.from(snapshot.base64, 'base64'));
    const data = OcrObservationDataSchema.parse({
      camera: snapshot.camera,
      text: ocr.text,
      normalizedText: ocr.normalizedText,
      confidence: ocr.confidence,
      regions: ocr.regions,
      evidenceEventId: evidenceEvent.id,
      imageRef: snapshot.imageRef ?? null,
      latencyMs: ocr.latencyMs,
    });
    const observationEvent = await this.options.events.append({
      id: `evt-${randomUUID()}`,
      type: 'ocr.observation',
      timestamp: capturedAt,
      source: { type: 'ocr', id: this.model },
      location,
      confidence: ocr.confidence,
      data: {
        ...data,
        provider: this.provider,
      },
    });

    return {
      ...ocr,
      camera: snapshot.camera,
      evidenceEventId: evidenceEvent.id,
      eventId: observationEvent.id,
    };
  }
}
