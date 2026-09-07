import { describe, expect, it } from 'vitest';
import { OnnxObjectInference } from '../src/vision/onnx-person-detector.js';

describe('inferência ONNX de objetos', () => {
  it('retorna pessoa e carro com nomes de classe e permite filtrar alvo', async () => {
    const inference = new OnnxObjectInference({
      modelPath: 'models/yolo11n.onnx',
      inputSize: 2,
      confidenceThreshold: 0.35,
      decode: async () => new Float32Array(3 * 2 * 2),
      sessionFactory: async () => ({
        inputNames: ['images'],
        run: async () => ({
          output0: {
            data: Float32Array.from([
              1, 1, 2, 2, 0.9, 0.05, 0.05,
              3, 3, 2, 2, 0.1, 0.05, 0.8,
            ]),
            dims: [1, 7, 2],
          },
        }),
      }),
    });

    const all = await inference.infer(Buffer.from('jpeg'));
    expect(all.detections).toHaveLength(2);
    expect(all.detections[0]).toMatchObject({
      classId: 0,
      className: 'person',
      box: { x1: 0, y1: 0, x2: 2, y2: 2 },
    });
    expect(all.detections[0].confidence).toBeCloseTo(0.9, 5);
    expect(all.detections[1]).toMatchObject({
      classId: 2,
      className: 'car',
      box: { x1: 2, y1: 2, x2: 4, y2: 4 },
    });
    expect(all.detections[1].confidence).toBeCloseTo(0.8, 5);

    const carsOnly = new OnnxObjectInference({
      modelPath: 'models/yolo11n.onnx',
      inputSize: 2,
      targetClasses: ['car'],
      decode: async () => new Float32Array(3 * 2 * 2),
      sessionFactory: async () => ({
        inputNames: ['images'],
        run: async () => ({
          output0: {
            data: Float32Array.from([
              1, 1, 2, 2, 0.9, 0.05, 0.05,
              3, 3, 2, 2, 0.1, 0.05, 0.8,
            ]),
            dims: [1, 7, 2],
          },
        }),
      }),
    });

    const cars = await carsOnly.infer(Buffer.from('jpeg'));
    expect(cars.detections).toHaveLength(1);
    expect(cars.detections[0]).toMatchObject({
      classId: 2,
      className: 'car',
    });
    expect(cars.detections[0].confidence).toBeCloseTo(0.8, 5);
  });
});
