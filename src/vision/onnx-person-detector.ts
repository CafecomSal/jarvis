import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as ort from 'onnxruntime-node';
import type { CameraAdapter } from '../cameras/camera-adapter.js';
import type { EventAppender } from '../events/in-memory-event-store.js';

export interface DetectionBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PersonDetection {
  confidence: number;
  box: DetectionBox;
}

function isValidRegion(region: DetectionBox): boolean {
  return [region.x1, region.y1, region.x2, region.y2].every(Number.isFinite)
    && region.x2 > region.x1
    && region.y2 > region.y1;
}

export interface PersonInferenceResult {
  latencyMs: number;
  detections: PersonDetection[];
}

export interface ObjectDetection extends PersonDetection {
  classId: number;
  className: string;
}

export interface ObjectInferenceResult {
  latencyMs: number;
  detections: ObjectDetection[];
}

export const COCO_CLASS_NAMES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

export interface PersonDetectionWorkerOptions {
  camera: CameraAdapter;
  events: EventAppender;
  infer: (image: Buffer) => Promise<PersonInferenceResult>;
  cameraLocations?: Record<string, string>;
  excludedRegions?: Record<string, DetectionBox[]>;
  confidenceThreshold?: number;
  confirmationFrames?: number;
  confirmationWindowMs?: number;
  model?: string;
  provider?: string;
  clock?: () => Date;
}

export interface PersonDetectionResult {
  camera: string;
  detected: boolean;
  detections: PersonDetection[];
  latencyMs: number;
  model: string;
  provider: string;
  confidence?: number;
  confirmed?: boolean;
  eventId?: string;
  evidenceEventId?: string;
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

export class PersonDetectionWorker {
  private readonly cameraLocations: Record<string, string>;
  private readonly excludedRegions: Record<string, DetectionBox[]>;
  private readonly confirmationStates = new Map<string, ConfirmationState>();
  private readonly confidenceThreshold: number;
  private readonly confirmationFrames: number;
  private readonly confirmationWindowMs: number;
  private readonly model: string;
  private readonly provider: string;
  private readonly clock: () => Date;

  constructor(private readonly options: PersonDetectionWorkerOptions) {
    this.cameraLocations = options.cameraLocations ?? {};
    this.excludedRegions = options.excludedRegions ?? {};
    this.confidenceThreshold = options.confidenceThreshold ?? 0.35;
    this.confirmationFrames = options.confirmationFrames ?? 1;
    this.confirmationWindowMs = options.confirmationWindowMs ?? 5_000;
    this.model = options.model ?? 'yolo11n.onnx';
    this.provider = options.provider ?? 'CPUExecutionProvider';
    this.clock = options.clock ?? (() => new Date());

    if (!Number.isFinite(this.confidenceThreshold)
      || this.confidenceThreshold < 0
      || this.confidenceThreshold > 1) {
      throw new Error('Person detector confidenceThreshold must be between 0 and 1');
    }
    if (!Number.isInteger(this.confirmationFrames) || this.confirmationFrames < 1) {
      throw new Error('Person detector confirmationFrames must be a positive integer');
    }
    if (!Number.isFinite(this.confirmationWindowMs) || this.confirmationWindowMs <= 0) {
      throw new Error('Person detector confirmationWindowMs must be greater than zero');
    }
    if (!this.model.trim()) throw new Error('Person detector model must not be empty');
    if (!this.provider.trim()) throw new Error('Person detector provider must not be empty');
    for (const regions of Object.values(this.excludedRegions)) {
      for (const region of regions) {
        if (!isValidRegion(region)) throw new Error('Person detector excluded region is invalid');
      }
    }
  }

  private isExcluded(camera: string, box: DetectionBox): boolean {
    const centerX = (box.x1 + box.x2) / 2;
    const centerY = (box.y1 + box.y2) / 2;
    return (this.excludedRegions[camera] ?? []).some((region) => (
      centerX >= region.x1
      && centerX <= region.x2
      && centerY >= region.y1
      && centerY <= region.y2
    ));
  }

  private observeDetection(camera: string, capturedAt: string): ConfirmationUpdate {
    const parsedTimestamp = Date.parse(capturedAt);
    const capturedAtMs = Number.isFinite(parsedTimestamp) ? parsedTimestamp : this.clock().getTime();
    const previous = this.confirmationStates.get(camera);
    const withinWindow = previous !== undefined
      && capturedAtMs >= previous.lastCapturedAtMs
      && capturedAtMs - previous.lastCapturedAtMs <= this.confirmationWindowMs;
    const consecutive = withinWindow ? previous.consecutive + 1 : 1;
    const alreadyConfirmed = withinWindow && previous.confirmed;
    const reachedThreshold = consecutive >= this.confirmationFrames;
    this.confirmationStates.set(camera, {
      consecutive,
      lastCapturedAtMs: capturedAtMs,
      confirmed: alreadyConfirmed,
    });
    return {
      confirmed: alreadyConfirmed || reachedThreshold,
      shouldEmit: reachedThreshold && !alreadyConfirmed,
    };
  }

  private markConfirmed(camera: string): void {
    const state = this.confirmationStates.get(camera);
    if (state) this.confirmationStates.set(camera, { ...state, confirmed: true });
  }

  async detectOnce(cameraName: string): Promise<PersonDetectionResult> {
    const snapshot = await this.options.camera.snapshot(cameraName);
    const inference = await this.options.infer(Buffer.from(snapshot.base64, 'base64'));
    const detections = inference.detections.filter(
      (detection) => detection.confidence >= this.confidenceThreshold
        && !this.isExcluded(snapshot.camera, detection.box),
    );
    const confidence = detections.length > 0
      ? Math.max(...detections.map((detection) => detection.confidence))
      : undefined;
    const result: PersonDetectionResult = {
      camera: snapshot.camera,
      detected: detections.length > 0,
      detections,
      latencyMs: inference.latencyMs,
      model: this.model,
      provider: this.provider,
      ...(confidence === undefined ? {} : { confidence }),
    };
    const capturedAt = snapshot.capturedAt || this.clock().toISOString();

    if (detections.length === 0) {
      this.confirmationStates.delete(snapshot.camera);
      return { ...result, confirmed: false };
    }

    const confirmation = this.observeDetection(snapshot.camera, capturedAt);
    const confirmedResult = { ...result, confirmed: confirmation.confirmed };
    if (!confirmation.shouldEmit) return confirmedResult;

    const location = this.cameraLocations[snapshot.camera] ?? snapshot.camera;
    const sourceType = snapshot.sourceType ?? 'camera';
    const sourceId = snapshot.sourceId ?? snapshot.camera;
    const evidenceData = {
      camera: snapshot.camera,
      location,
      sourceType,
      sourceId,
      ...(snapshot.oid === undefined ? {} : { oid: snapshot.oid }),
      imageRef: snapshot.imageRef ?? null,
      mimeType: snapshot.mimeType,
      bytes: snapshot.bytes,
    };
    const evidenceEvent = await this.options.events.append({
      id: `evt-${randomUUID()}`,
      type: 'camera.snapshot',
      timestamp: capturedAt,
      source: { type: sourceType, id: sourceId },
      location,
      data: evidenceData,
    });
    const detectionEvent = await this.options.events.append({
      id: `evt-${randomUUID()}`,
      type: 'person.detected',
      timestamp: capturedAt,
      source: { type: 'onnx', id: this.model },
      location,
      subject: { type: 'person', id: 'unknown' },
      confidence,
      data: {
        camera: snapshot.camera,
        model: this.model,
        provider: this.provider,
        confirmed: true,
        ...(snapshot.imageRef === undefined ? {} : { imageRef: snapshot.imageRef }),
        latencyMs: inference.latencyMs,
        evidenceEventId: evidenceEvent.id,
        detections,
      },
    });
    this.markConfirmed(snapshot.camera);

    return {
      ...confirmedResult,
      eventId: detectionEvent.id,
      evidenceEventId: evidenceEvent.id,
    };
  }
}

interface OnnxTensorLike {
  data: ArrayLike<number>;
  dims: readonly number[];
}

interface OnnxSessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensorLike>>;
}

export type OnnxSessionFactory = (modelPath: string) => Promise<OnnxSessionLike>;
export type FrameDecoder = (image: Buffer, size: number, ffmpegPath: string) => Promise<Float32Array>;

export interface OnnxPersonInferenceOptions {
  modelPath: string;
  inputSize?: number;
  confidenceThreshold?: number;
  nmsThreshold?: number;
  ffmpegPath?: string;
  sessionFactory?: OnnxSessionFactory;
  decode?: FrameDecoder;
}

export interface OnnxObjectInferenceOptions extends OnnxPersonInferenceOptions {
  classNames?: readonly string[];
  targetClasses?: readonly string[];
}

function decodeJpegWithFfmpeg(image: Buffer, size: number, ffmpegPath: string): Promise<Float32Array> {
  const filter = [
    `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=bilinear`,
    `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=727272`,
  ].join(',');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vf',
      filter,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ], { windowsHide: true });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(`FFmpeg could not decode the camera frame${detail ? `: ${detail}` : ''}`));
        return;
      }
      const decoded = Buffer.concat(chunks);
      const expectedBytes = size * size * 3;
      if (decoded.length !== expectedBytes) {
        reject(new Error(`FFmpeg returned ${decoded.length} bytes; expected ${expectedBytes}`));
        return;
      }
      const pixels = size * size;
      const chw = new Float32Array(pixels * 3);
      for (let pixel = 0; pixel < pixels; pixel += 1) {
        for (let channel = 0; channel < 3; channel += 1) {
          chw[channel * pixels + pixel] = decoded[pixel * 3 + channel] / 255;
        }
      }
      resolve(chw);
    });
    child.stdin.end(image);
  });
}

function tensorValue(
  tensor: OnnxTensorLike,
  anchor: number,
  channel: number,
): number {
  const dims = tensor.dims;
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`Unsupported YOLO output dimensions: ${dims.join('x')}`);
  }
  const channels = dims[1];
  const anchors = dims[2];
  if (channels <= anchors) return Number(tensor.data[channel * anchors + anchor]);
  return Number(tensor.data[anchor * channels + channel]);
}

function intersectionOverUnion(left: DetectionBox, right: DetectionBox): number {
  const x1 = Math.max(left.x1, right.x1);
  const y1 = Math.max(left.y1, right.y1);
  const x2 = Math.min(left.x2, right.x2);
  const y2 = Math.min(left.y2, right.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const leftArea = Math.max(0, left.x2 - left.x1) * Math.max(0, left.y2 - left.y1);
  const rightArea = Math.max(0, right.x2 - right.x1) * Math.max(0, right.y2 - right.y1);
  const union = leftArea + rightArea - intersection;
  return union > 0 ? intersection / union : 0;
}

function postProcessYoloObjects(
  tensor: OnnxTensorLike,
  confidenceThreshold: number,
  nmsThreshold: number,
  classNames: readonly string[],
  targetClasses?: ReadonlySet<string>,
): ObjectDetection[] {
  if (tensor.dims.length !== 3 || tensor.dims[0] !== 1) {
    throw new Error(`Unsupported YOLO output dimensions: ${tensor.dims.join('x')}`);
  }
  const firstDimension = tensor.dims[1];
  const secondDimension = tensor.dims[2];
  const channels = firstDimension < 5
    ? secondDimension
    : secondDimension < 5
      ? firstDimension
      : Math.min(firstDimension, secondDimension);
  const anchors = channels === firstDimension ? secondDimension : firstDimension;
  if (channels <= 4) return [];

  const candidates: ObjectDetection[] = [];
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let bestClass = 0;
    let bestScore = tensorValue(tensor, anchor, 4);
    for (let classId = 1; classId < channels - 4; classId += 1) {
      const score = tensorValue(tensor, anchor, 4 + classId);
      if (score > bestScore) {
        bestScore = score;
        bestClass = classId;
      }
    }
    const className = classNames[bestClass] ?? `class-${bestClass}`;
    if (targetClasses && !targetClasses.has(className)) continue;
    if (bestScore < confidenceThreshold) continue;

    const centerX = tensorValue(tensor, anchor, 0);
    const centerY = tensorValue(tensor, anchor, 1);
    const width = tensorValue(tensor, anchor, 2);
    const height = tensorValue(tensor, anchor, 3);
    candidates.push({
      classId: bestClass,
      className,
      confidence: bestScore,
      box: {
        x1: centerX - width / 2,
        y1: centerY - height / 2,
        x2: centerX + width / 2,
        y2: centerY + height / 2,
      },
    });
  }

  candidates.sort((left, right) => right.confidence - left.confidence);
  const selected: ObjectDetection[] = [];
  for (const candidate of candidates) {
    if (selected.some((item) => (
      item.classId === candidate.classId
      && intersectionOverUnion(item.box, candidate.box) > nmsThreshold
    ))) continue;
    selected.push(candidate);
  }
  return selected;
}

function postProcessYolo(
  tensor: OnnxTensorLike,
  confidenceThreshold: number,
  nmsThreshold: number,
): PersonDetection[] {
  return postProcessYoloObjects(
    tensor,
    confidenceThreshold,
    nmsThreshold,
    COCO_CLASS_NAMES,
    new Set(['person']),
  ).map(({ confidence, box }) => ({ confidence, box }));
}

const defaultSessionFactory: OnnxSessionFactory = async (modelPath) => {
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  });
  return session as unknown as OnnxSessionLike;
};

export class OnnxObjectInference {
  private readonly modelPath: string;
  private readonly inputSize: number;
  private readonly confidenceThreshold: number;
  private readonly nmsThreshold: number;
  private readonly ffmpegPath: string;
  private readonly sessionFactory: OnnxSessionFactory;
  private readonly decode: FrameDecoder;
  private readonly classNames: readonly string[];
  private readonly targetClasses?: ReadonlySet<string>;
  private session?: Promise<OnnxSessionLike>;

  constructor(options: OnnxObjectInferenceOptions) {
    this.modelPath = options.modelPath;
    this.inputSize = options.inputSize ?? 640;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.35;
    this.nmsThreshold = options.nmsThreshold ?? 0.45;
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.decode = options.decode ?? decodeJpegWithFfmpeg;
    this.classNames = options.classNames ?? COCO_CLASS_NAMES;
    this.targetClasses = options.targetClasses === undefined
      ? undefined
      : new Set(options.targetClasses);

    if (!this.modelPath.trim()) throw new Error('ONNX modelPath must not be empty');
    if (!Number.isInteger(this.inputSize) || this.inputSize < 1) {
      throw new Error('ONNX inputSize must be a positive integer');
    }
    if (!Number.isFinite(this.confidenceThreshold)
      || this.confidenceThreshold < 0
      || this.confidenceThreshold > 1) {
      throw new Error('ONNX confidenceThreshold must be between 0 and 1');
    }
    if (!Number.isFinite(this.nmsThreshold) || this.nmsThreshold < 0 || this.nmsThreshold > 1) {
      throw new Error('ONNX nmsThreshold must be between 0 and 1');
    }
    if (this.classNames.length === 0 || this.classNames.some((name) => !name.trim())) {
      throw new Error('ONNX classNames must contain non-empty names');
    }
    if (this.targetClasses?.has('')) throw new Error('ONNX targetClasses must contain non-empty names');
  }

  private getSession(): Promise<OnnxSessionLike> {
    this.session ??= this.sessionFactory(this.modelPath);
    return this.session;
  }

  async infer(image: Buffer): Promise<ObjectInferenceResult> {
    const started = process.hrtime.bigint();
    const input = await this.decode(image, this.inputSize, this.ffmpegPath);
    const expectedValues = this.inputSize * this.inputSize * 3;
    if (input.length !== expectedValues) {
      throw new Error(`ONNX decoder returned ${input.length} values; expected ${expectedValues}`);
    }

    const session = await this.getSession();
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error('ONNX model has no input tensor');
    const tensor = new ort.Tensor('float32', input, [1, 3, this.inputSize, this.inputSize]);
    const outputs = await session.run({ [inputName]: tensor });
    const outputName = Object.keys(outputs)[0];
    const output = outputName ? outputs[outputName] : undefined;
    if (!output) throw new Error('ONNX model returned no output tensor');

    return {
      latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      detections: postProcessYoloObjects(
        output,
        this.confidenceThreshold,
        this.nmsThreshold,
        this.classNames,
        this.targetClasses,
      ),
    };
  }
}

export class OnnxPersonInference {
  private readonly objectInference: OnnxObjectInference;

  constructor(options: OnnxPersonInferenceOptions) {
    this.objectInference = new OnnxObjectInference({
      ...options,
      targetClasses: ['person'],
    });
  }

  async infer(image: Buffer): Promise<PersonInferenceResult> {
    const result = await this.objectInference.infer(image);
    return {
      latencyMs: result.latencyMs,
      detections: result.detections.map(({ confidence, box }) => ({ confidence, box })),
    };
  }
}

export interface OnnxPersonDetectionWorkerOptions extends OnnxPersonInferenceOptions {
  camera: CameraAdapter;
  events: EventAppender;
  cameraLocations?: Record<string, string>;
  excludedRegions?: Record<string, DetectionBox[]>;
  confirmationFrames?: number;
  confirmationWindowMs?: number;
  model?: string;
  provider?: string;
}

function modelNameFromPath(modelPath: string): string {
  return modelPath.split(/[\\/]/).at(-1) || modelPath;
}

export function createOnnxPersonDetectionWorker(
  options: OnnxPersonDetectionWorkerOptions,
): PersonDetectionWorker {
  const inference = new OnnxPersonInference(options);
  return new PersonDetectionWorker({
    camera: options.camera,
    events: options.events,
    cameraLocations: options.cameraLocations,
    excludedRegions: options.excludedRegions,
    confidenceThreshold: options.confidenceThreshold,
    confirmationFrames: options.confirmationFrames,
    confirmationWindowMs: options.confirmationWindowMs,
    model: options.model ?? modelNameFromPath(options.modelPath),
    provider: options.provider ?? 'CPUExecutionProvider',
    infer: (image) => inference.infer(image),
  });
}

export interface PersonDetectionRunner {
  detectOnce(camera: string): Promise<PersonDetectionResult>;
}

export interface PersonDetectionSchedulerOptions {
  intervalMs?: number;
  onResult?: (result: PersonDetectionResult) => void;
  onError?: (error: unknown) => void;
  onOverlapSkipped?: () => void;
}

export class PersonDetectionScheduler {
  private readonly intervalMs: number;
  private readonly onResult?: (result: PersonDetectionResult) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onOverlapSkipped?: () => void;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly runner: PersonDetectionRunner,
    private readonly camera: string,
    options: PersonDetectionSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.onOverlapSkipped = options.onOverlapSkipped;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Person detection intervalMs must be greater than zero');
    }
    if (!camera.trim()) throw new Error('Person detection camera must not be empty');
  }

  start(): void {
    if (this.timer) return;
    void this.execute();
    this.timer = setInterval(() => {
      void this.execute();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async execute(): Promise<void> {
    if (this.running) {
      this.onOverlapSkipped?.();
      return;
    }
    this.running = true;
    try {
      const result = await this.runner.detectOnce(this.camera);
      this.onResult?.(result);
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}
