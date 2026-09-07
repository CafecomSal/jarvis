import { describe, expect, it } from 'vitest';
import { OnnxPersonInference } from '../src/vision/onnx-person-detector.js';

describe('inferência ONNX de pessoas', () => {
  it('converte a saída YOLO para detecções de pessoa acima do limiar', async () => {
    const inference = new OnnxPersonInference({
      modelPath: 'model.onnx',
      inputSize: 2,
      sessionFactory: async () => ({
        inputNames: ['images'],
        run: async () => ({
          output0: {
            data: Float32Array.from([
              1, 1, 2, 2, 0.9, 0.1,
              1, 1, 1, 1, 0.2, 0.8,
            ]),
            dims: [1, 6, 2],
          },
        }),
      }),
      decode: async () => new Float32Array(3 * 2 * 2),
    });

    const result = await inference.infer(Buffer.from('jpeg'));

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]).toMatchObject({
      box: { x1: 0, y1: 0, x2: 2, y2: 2 },
    });
    expect(result.detections[0]?.confidence).toBeCloseTo(0.9, 5);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('interpreta a saída YOLO no formato canais-primeiro', async () => {
    const inference = new OnnxPersonInference({
      modelPath: 'model.onnx',
      inputSize: 2,
      sessionFactory: async () => ({
        inputNames: ['images'],
        run: async () => ({
          output0: {
            data: Float32Array.from([
              1, 0, 0, 0, 0, 0, 0, 0,
              1, 0, 0, 0, 0, 0, 0, 0,
              2, 0, 0, 0, 0, 0, 0, 0,
              2, 0, 0, 0, 0, 0, 0, 0,
              0.9, 0, 0, 0, 0, 0, 0, 0,
              0.1, 0, 0, 0, 0, 0, 0, 0,
            ]),
            dims: [1, 6, 8],
          },
        }),
      }),
      decode: async () => new Float32Array(3 * 2 * 2),
    });

    const result = await inference.infer(Buffer.from('jpeg'));

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]).toMatchObject({
      box: { x1: 0, y1: 0, x2: 2, y2: 2 },
    });
    expect(result.detections[0]?.confidence).toBeCloseTo(0.9, 5);
  });

  it('não retorna detecções abaixo do limiar padrão conservador', async () => {
    const inference = new OnnxPersonInference({
      modelPath: 'model.onnx',
      inputSize: 2,
      sessionFactory: async () => ({
        inputNames: ['images'],
        run: async () => ({
          output0: {
            data: Float32Array.from([1, 1, 2, 2, 0.3, 0.1]),
            dims: [1, 6, 1],
          },
        }),
      }),
      decode: async () => new Float32Array(3 * 2 * 2),
    });

    const result = await inference.infer(Buffer.from('jpeg'));

    expect(result.detections).toEqual([]);
  });
});
