import { describe, expect, it, vi } from 'vitest';
import type { CameraAdapter, CameraSnapshot } from '../src/cameras/camera-adapter.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { PersonDetectionScheduler, PersonDetectionWorker, createOnnxPersonDetectionWorker, type PersonDetectionResult } from '../src/vision/onnx-person-detector.js';

class FakeCamera implements CameraAdapter {
  async snapshot(camera: string): Promise<CameraSnapshot> {
    return {
      camera,
      oid: 1,
      sourceType: 'agent_dvr',
      sourceId: '1',
      capturedAt: '2026-08-29T23:00:00.000Z',
      mimeType: 'image/jpeg',
      bytes: 4,
      base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      imageRef: 'front/frame-positive.jpg',
    };
  }
}

describe('worker de detecção ONNX de pessoas', () => {
  it('emite person.detected ligado ao snapshot de evidência', async () => {
    const events = new InMemoryEventStore();
    const worker = new PersonDetectionWorker({
      camera: new FakeCamera(),
      events,
      cameraLocations: { front: 'frente' },
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      infer: async () => ({
        latencyMs: 48.5,
        detections: [{
          confidence: 0.91,
          box: { x1: 12, y1: 24, x2: 180, y2: 220 },
        }],
      }),
    });

    const result = await worker.detectOnce('front');
    const stored = await events.list();
    const snapshot = stored.find((event) => event.type === 'camera.snapshot');
    const detected = stored.find((event) => event.type === 'person.detected');

    expect(result).toMatchObject({
      camera: 'front',
      detected: true,
      confidence: 0.91,
      eventId: detected?.id,
      evidenceEventId: snapshot?.id,
    });
    expect(stored).toHaveLength(2);
    expect(snapshot).toMatchObject({
      type: 'camera.snapshot',
      source: { type: 'agent_dvr', id: '1' },
      location: 'frente',
      data: {
        camera: 'front',
        imageRef: 'front/frame-positive.jpg',
      },
    });
    expect(detected).toMatchObject({
      type: 'person.detected',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'person', id: 'unknown' },
      confidence: 0.91,
      data: {
        camera: 'front',
        confirmed: true,
        imageRef: 'front/frame-positive.jpg',
        provider: 'CPUExecutionProvider',
        latencyMs: 48.5,
        evidenceEventId: snapshot?.id,
        detections: [{
          confidence: 0.91,
          box: { x1: 12, y1: 24, x2: 180, y2: 220 },
        }],
      },
    });
  });

  it('não emite evento quando nenhuma pessoa supera o limiar', async () => {
    const events = new InMemoryEventStore();
    const worker = new PersonDetectionWorker({
      camera: new FakeCamera(),
      events,
      confidenceThreshold: 0.5,
      infer: async () => ({
        latencyMs: 51,
        detections: [{ confidence: 0.49, box: { x1: 1, y1: 2, x2: 3, y2: 4 } }],
      }),
    });

    const result = await worker.detectOnce('front');

    expect(result.detected).toBe(false);
    expect(result.eventId).toBeUndefined();
    expect(await events.list()).toEqual([]);
  });

  it('exige confirmações consecutivas e emite um único evento por presença', async () => {
    const events = new InMemoryEventStore();
    let inferences = 0;
    const worker = new PersonDetectionWorker({
      camera: new FakeCamera(),
      events,
      confirmationFrames: 2,
      confirmationWindowMs: 5_000,
      infer: async () => {
        inferences += 1;
        return {
          latencyMs: inferences,
          detections: [{ confidence: 0.9, box: { x1: 10, y1: 10, x2: 100, y2: 100 } }],
        };
      },
    });

    const first = await worker.detectOnce('front');
    const second = await worker.detectOnce('front');
    const third = await worker.detectOnce('front');

    expect(first.detected).toBe(true);
    expect(first.confirmed).toBe(false);
    expect(first.eventId).toBeUndefined();
    expect(second.confirmed).toBe(true);
    expect(second.eventId).toBeDefined();
    expect(third.detected).toBe(true);
    expect(third.confirmed).toBe(true);
    expect(third.eventId).toBeUndefined();
    expect(await events.list()).toHaveLength(2);
  });

  it('ignora detecções dentro de uma região excluída da câmera', async () => {
    const events = new InMemoryEventStore();
    const worker = new PersonDetectionWorker({
      camera: new FakeCamera(),
      events,
      excludedRegions: {
        front: [{ x1: 400, y1: 0, x2: 520, y2: 180 }],
      },
      infer: async () => ({
        latencyMs: 1,
        detections: [{ confidence: 0.9, box: { x1: 420, y1: 80, x2: 480, y2: 120 } }],
      }),
    });

    const result = await worker.detectOnce('front');

    expect(result.detected).toBe(false);
    expect(result.detections).toEqual([]);
    expect(await events.list()).toEqual([]);
  });

  it('usa um limiar padrão conservador para não emitir detecções fracas', async () => {
    const events = new InMemoryEventStore();
    const worker = new PersonDetectionWorker({
      camera: new FakeCamera(),
      events,
      infer: async () => ({
        latencyMs: 1,
        detections: [{ confidence: 0.3, box: { x1: 1, y1: 2, x2: 3, y2: 4 } }],
      }),
    });

    const result = await worker.detectOnce('front');

    expect(result.detected).toBe(false);
    expect(await events.list()).toEqual([]);
  });

  it('executa imediatamente, respeita o intervalo e para sem sobreposição', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const result: PersonDetectionResult = {
        camera: 'front',
        detected: false,
        detections: [],
        latencyMs: 1,
        model: 'yolo11n.onnx',
        provider: 'CPUExecutionProvider',
      };
      const runner = {
        detectOnce: async (camera: string): Promise<PersonDetectionResult> => {
          calls.push(camera);
          return result;
        },
      };
      const scheduler = new PersonDetectionScheduler(runner, 'front', { intervalMs: 100 });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toEqual(['front', 'front', 'front']);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contabiliza execuções puladas quando uma inferência ainda está em andamento', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let releaseFirst: (() => void) | undefined;
      const result: PersonDetectionResult = {
        camera: 'front',
        detected: false,
        detections: [],
        latencyMs: 1,
        model: 'yolo11n.onnx',
        provider: 'CPUExecutionProvider',
      };
      const runner = {
        detectOnce: async (): Promise<PersonDetectionResult> => {
          calls += 1;
          if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return result;
        },
      };
      let skipped = 0;
      const scheduler = new PersonDetectionScheduler(runner, 'front', {
        intervalMs: 100,
        onOverlapSkipped: () => { skipped += 1; },
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(skipped).toBe(1);
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mantém o timer referenciado para o processo contínuo não encerrar', () => {
    const runner = {
      detectOnce: async (): Promise<PersonDetectionResult> => ({
        camera: 'front',
        detected: false,
        detections: [],
        latencyMs: 1,
        model: 'yolo11n.onnx',
        provider: 'CPUExecutionProvider',
      }),
    };
    const scheduler = new PersonDetectionScheduler(runner, 'front', { intervalMs: 1000 });

    scheduler.start();
    try {
      const timer = (scheduler as unknown as { timer?: NodeJS.Timeout }).timer;
      expect(timer?.hasRef()).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  it('preserva a origem RTSP na evidência sem inventar OID', async () => {
    const events = new InMemoryEventStore();
    const camera: CameraAdapter = {
      snapshot: async (cameraName) => ({
        camera: cameraName,
        sourceType: 'rtsp',
        sourceId: cameraName,
        capturedAt: '2026-08-29T23:00:00.000Z',
        mimeType: 'image/jpeg',
        bytes: 4,
        base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      }),
    };
    const worker = new PersonDetectionWorker({
      camera,
      events,
      infer: async () => ({
        latencyMs: 2,
        detections: [{ confidence: 0.9, box: { x1: 10, y1: 10, x2: 100, y2: 100 } }],
      }),
    });

    await worker.detectOnce('front');
    const [snapshot] = await events.list();

    expect(snapshot).toMatchObject({
      source: { type: 'rtsp', id: 'front' },
      data: {
        camera: 'front',
        sourceType: 'rtsp',
        sourceId: 'front',
      },
    });
    expect(snapshot.data).not.toHaveProperty('oid');
  });

  it('conecta o worker ao adapter ONNX e identifica o modelo no resultado', async () => {
    const events = new InMemoryEventStore();
    const worker = createOnnxPersonDetectionWorker({
      camera: new FakeCamera(),
      events,
      cameraLocations: { front: 'frente' },
      modelPath: 'models/yolo11n.onnx',
      inputSize: 2,
      decode: async () => new Float32Array(3 * 2 * 2),
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
    });

    const result = await worker.detectOnce('front');

    expect(result).toMatchObject({
      detected: true,
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
    });
  });
});
