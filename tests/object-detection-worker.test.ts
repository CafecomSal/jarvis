import { describe, expect, it } from 'vitest';
import type { CameraAdapter, CameraSnapshot } from '../src/cameras/camera-adapter.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import type { ObjectInferenceResult } from '../src/vision/onnx-person-detector.js';
import {
  ObjectDetectionWorker,
} from '../src/vision/object-detection-worker.js';

class FakeCamera implements CameraAdapter {
  async snapshot(camera: string): Promise<CameraSnapshot> {
    return {
      camera,
      sourceType: 'rtsp',
      sourceId: camera,
      capturedAt: '2026-09-04T12:00:00.000Z',
      mimeType: 'image/jpeg',
      bytes: 4,
      base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      imageRef: 'front/object.jpg',
    };
  }
}

const car = {
  classId: 2,
  className: 'car',
  confidence: 0.82,
  box: { x1: 10, y1: 20, x2: 200, y2: 300 },
};

describe('worker de detecção genérica de objetos', () => {
  it('confirma carro após duas observações e liga o evento à evidência', async () => {
    const events = new InMemoryEventStore();
    const worker = new ObjectDetectionWorker({
      camera: new FakeCamera(),
      events,
      cameraLocations: { front: 'frente' },
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      confirmationFrames: 2,
      infer: async (): Promise<ObjectInferenceResult> => ({
        latencyMs: 45,
        detections: [car],
      }),
    });

    const first = await worker.detectOnce('front');
    const second = await worker.detectOnce('front');
    const third = await worker.detectOnce('front');

    expect(first).toMatchObject({ detected: true, confirmed: false });
    expect(first.eventIds).toBeUndefined();
    expect(second).toMatchObject({ detected: true, confirmed: true });
    expect(second.eventIds?.car).toBeDefined();
    expect(third).toMatchObject({ detected: true, confirmed: true });
    expect(third.eventIds).toBeUndefined();

    const stored = await events.list();
    expect(stored).toHaveLength(2);
    const snapshot = stored.find((event) => event.type === 'camera.snapshot');
    const objectEvent = stored.find((event) => event.type === 'object.observed');
    expect(snapshot).toBeDefined();
    expect(objectEvent).toMatchObject({
      type: 'object.observed',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'object', id: 'car' },
      confidence: 0.82,
      data: {
        camera: 'front',
        className: 'car',
        confirmed: true,
        evidenceEventId: snapshot?.id,
        imageRef: 'front/object.jpg',
        provider: 'CPUExecutionProvider',
      },
    });
  });
});
