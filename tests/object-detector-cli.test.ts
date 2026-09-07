import { describe, expect, it } from 'vitest';
import { parseObjectDetectorOptions } from '../src/vision/run-object-detector.js';

describe('CLI de objetos', () => {
  it('usa dry-run e classes COCO úteis por padrão', () => {
    expect(parseObjectDetectorOptions(['--once'], {})).toEqual({
      camera: 'front',
      modelPath: 'models/yolo11n.onnx',
      classes: ['person', 'car', 'motorcycle', 'bicycle', 'cat', 'dog', 'truck'],
      confidenceThreshold: 0.35,
      confirmationFrames: 2,
      confirmationWindowMs: 5000,
      rtspTransport: 'udp',
      inputSize: 640,
      once: true,
      dryRun: true,
    });
  });

  it('permite publicar somente com --publish e valida classes', () => {
    expect(parseObjectDetectorOptions(['--once', '--publish'], {
      JARVIS_OBJECT_DETECTOR_CLASSES: 'car, motorcycle, car',
      JARVIS_OBJECT_DETECTOR_CONFIDENCE_THRESHOLD: '0.45',
      JARVIS_OBJECT_DETECTOR_CONFIRMATION_FRAMES: '3',
    })).toMatchObject({
      classes: ['car', 'motorcycle'],
      confidenceThreshold: 0.45,
      confirmationFrames: 3,
      dryRun: false,
    });
    expect(() => parseObjectDetectorOptions(['--once', '--dry-run', '--publish'], {})).toThrow(
      'Object detector cannot combine --dry-run and --publish',
    );
    expect(() => parseObjectDetectorOptions(['--once'], {
      JARVIS_OBJECT_DETECTOR_CLASSES: 'car,unknown-class',
    })).toThrow('JARVIS_OBJECT_DETECTOR_CLASSES contains unsupported class: unknown-class');
  });
});
