import { randomUUID } from 'node:crypto';
import type { CameraAdapter } from '../cameras/camera-adapter.js';
import type { EventAppender } from '../events/in-memory-event-store.js';
import type {
  ObjectDetection,
  ObjectInferenceResult,
  OnnxObjectInferenceOptions,
} from './onnx-person-detector.js';
import { OnnxObjectInference } from './onnx-person-detector.js';

export interface ObjectDetectionResult {
  camera: string;
  detected: boolean;
  detections: ObjectDetection[];
  latencyMs: number;
  model: string;
  provider: string;
  confirmed?: boolean;
  confirmedClasses?: string[];
  eventIds?: Record<string, string>;
  evidenceEventId?: string;
}

export interface ObjectDetectionWorkerOptions {
  camera: CameraAdapter;
  events: EventAppender;
  infer: (image: Buffer) => Promise<ObjectInferenceResult>;
  cameraLocations?: Record<string, string>;
  confidenceThreshold?: number;
  confirmationFrames?: number;
  confirmationWindowMs?: number;
  model?: string;
  provider?: string;
  clock?: () => Date;
}

interface ConfirmationState {
  consecutive: number;
  lastCapturedAtMs: number;
  confirmed: boolean;
}

interface ConfirmationUpdate {
  confirmed: boolean;
  shouldEmit: boolean;
}

function stateKey(camera: string, className: string): string {
  return `${camera}\u0000${className}`;
}

export class ObjectDetectionWorker {
  private readonly cameraLocations: Record<string, string>;
  private readonly confidenceThreshold: number;
  private readonly confirmationFrames: number;
  private readonly confirmationWindowMs: number;
  private readonly model: string;
  private readonly provider: string;
  private readonly clock: () => Date;
  private readonly confirmationStates = new Map<string, ConfirmationState>();

  constructor(private readonly options: ObjectDetectionWorkerOptions) {
    this.cameraLocations = options.cameraLocations ?? {};
    this.confidenceThreshold = options.confidenceThreshold ?? 0.35;
    this.confirmationFrames = options.confirmationFrames ?? 2;
    this.confirmationWindowMs = options.confirmationWindowMs ?? 5_000;
    this.model = options.model ?? 'yolo11n.onnx';
    this.provider = options.provider ?? 'CPUExecutionProvider';
    this.clock = options.clock ?? (() => new Date());

    if (!Number.isFinite(this.confidenceThreshold)
      || this.confidenceThreshold < 0
      || this.confidenceThreshold > 1) {
      throw new Error('Object detector confidenceThreshold must be between 0 and 1');
    }
    if (!Number.isInteger(this.confirmationFrames) || this.confirmationFrames < 1) {
      throw new Error('Object detector confirmationFrames must be a positive integer');
    }
    if (!Number.isFinite(this.confirmationWindowMs) || this.confirmationWindowMs <= 0) {
      throw new Error('Object detector confirmationWindowMs must be greater than zero');
    }
    if (!this.model.trim()) throw new Error('Object detector model must not be empty');
    if (!this.provider.trim()) throw new Error('Object detector provider must not be empty');
  }

  private observeDetection(camera: string, className: string, capturedAt: string): ConfirmationUpdate {
    const parsedTimestamp = Date.parse(capturedAt);
    const capturedAtMs = Number.isFinite(parsedTimestamp) ? parsedTimestamp : this.clock().getTime();
    const key = stateKey(camera, className);
    const previous = this.confirmationStates.get(key);
    const withinWindow = previous !== undefined
      && capturedAtMs >= previous.lastCapturedAtMs
      && capturedAtMs - previous.lastCapturedAtMs <= this.confirmationWindowMs;
    const consecutive = withinWindow ? previous.consecutive + 1 : 1;
    const alreadyConfirmed = withinWindow && previous.confirmed;
    const reachedThreshold = consecutive >= this.confirmationFrames;
    this.confirmationStates.set(key, {
      consecutive,
      lastCapturedAtMs: capturedAtMs,
      confirmed: alreadyConfirmed,
    });
    return {
      confirmed: alreadyConfirmed || reachedThreshold,
      shouldEmit: reachedThreshold && !alreadyConfirmed,
    };
  }

  private markConfirmed(camera: string, className: string): void {
    const key = stateKey(camera, className);
    const state = this.confirmationStates.get(key);
    if (state) this.confirmationStates.set(key, { ...state, confirmed: true });
  }

  private resetAbsentClasses(camera: string, presentClasses: ReadonlySet<string>): void {
    const prefix = `${camera}\u0000`;
    for (const key of this.confirmationStates.keys()) {
      if (key.startsWith(prefix) && !presentClasses.has(key.slice(prefix.length))) {
        this.confirmationStates.delete(key);
      }
    }
  }

  async detectOnce(cameraName: string): Promise<ObjectDetectionResult> {
    const snapshot = await this.options.camera.snapshot(cameraName);
    const inference = await this.options.infer(Buffer.from(snapshot.base64, 'base64'));
    const detections = inference.detections.filter(
      (detection) => detection.confidence >= this.confidenceThreshold,
    );
    const result: ObjectDetectionResult = {
      camera: snapshot.camera,
      detected: detections.length > 0,
      detections,
      latencyMs: inference.latencyMs,
      model: this.model,
      provider: this.provider,
    };
    const capturedAt = snapshot.capturedAt || this.clock().toISOString();

    if (detections.length === 0) {
      this.resetAbsentClasses(snapshot.camera, new Set());
      return { ...result, confirmed: false };
    }

    const byClass = new Map<string, ObjectDetection[]>();
    for (const detection of detections) {
      const current = byClass.get(detection.className) ?? [];
      current.push(detection);
      byClass.set(detection.className, current);
    }
    this.resetAbsentClasses(snapshot.camera, new Set(byClass.keys()));

    const confirmedClasses: string[] = [];
    const classesToEmit: string[] = [];
    for (const className of byClass.keys()) {
      const confirmation = this.observeDetection(snapshot.camera, className, capturedAt);
      if (confirmation.confirmed) confirmedClasses.push(className);
      if (confirmation.shouldEmit) classesToEmit.push(className);
    }
    const confirmedResult: ObjectDetectionResult = {
      ...result,
      confirmed: confirmedClasses.length > 0,
      ...(confirmedClasses.length > 0 ? { confirmedClasses } : {}),
    };
    if (classesToEmit.length === 0) return confirmedResult;

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

    const eventIds: Record<string, string> = {};
    for (const className of classesToEmit) {
      const classDetections = byClass.get(className) ?? [];
      const confidence = Math.max(...classDetections.map((detection) => detection.confidence));
      const objectEvent = await this.options.events.append({
        id: `evt-${randomUUID()}`,
        type: 'object.observed',
        timestamp: capturedAt,
        source: { type: 'onnx', id: this.model },
        location,
        subject: { type: 'object', id: className },
        confidence,
        data: {
          camera: snapshot.camera,
          className,
          classId: classDetections[0]?.classId,
          model: this.model,
          provider: this.provider,
          confirmed: true,
          imageRef: snapshot.imageRef ?? null,
          latencyMs: inference.latencyMs,
          evidenceEventId: evidenceEvent.id,
          detections: classDetections.map(({ confidence: itemConfidence, box }) => ({
            confidence: itemConfidence,
            box,
          })),
        },
      });
      eventIds[className] = objectEvent.id;
      this.markConfirmed(snapshot.camera, className);
    }

    return {
      ...confirmedResult,
      eventIds,
      evidenceEventId: evidenceEvent.id,
    };
  }
}

export interface OnnxObjectDetectionWorkerOptions extends OnnxObjectInferenceOptions {
  camera: CameraAdapter;
  events: EventAppender;
  cameraLocations?: Record<string, string>;
  confirmationFrames?: number;
  confirmationWindowMs?: number;
  model?: string;
  provider?: string;
}

export function createOnnxObjectDetectionWorker(
  options: OnnxObjectDetectionWorkerOptions,
): ObjectDetectionWorker {
  const inference = new OnnxObjectInference(options);
  return new ObjectDetectionWorker({
    camera: options.camera,
    events: options.events,
    cameraLocations: options.cameraLocations,
    confidenceThreshold: options.confidenceThreshold,
    confirmationFrames: options.confirmationFrames,
    confirmationWindowMs: options.confirmationWindowMs,
    model: options.model ?? options.modelPath.split(/[\\/]/).at(-1) ?? options.modelPath,
    provider: options.provider ?? 'CPUExecutionProvider',
    infer: (image) => inference.infer(image),
  });
}
