import { describe, expect, it } from 'vitest';
import type { CameraAdapter, CameraSnapshot } from '../src/cameras/camera-adapter.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import type { OcrEngine } from '../src/vision/ocr-engine.js';
import { OcrObservationWorker } from '../src/vision/ocr-observation-worker.js';

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
      imageRef: 'front/ocr.jpg',
    };
  }
}

describe('worker de observação OCR', () => {
  it('persiste OCR sob demanda ligado ao snapshot de evidência', async () => {
    const events = new InMemoryEventStore();
    const ocr: OcrEngine = {
      recognize: async () => ({
        text: 'Portão 1234',
        normalizedText: 'PORTAO1234',
        confidence: 0.91,
        regions: [{
          text: 'Portão 1234',
          confidence: 0.91,
          box: { x1: 10, y1: 20, x2: 100, y2: 50 },
        }],
        latencyMs: 125,
      }),
    };
    const worker = new OcrObservationWorker({
      camera: new FakeCamera(),
      events,
      ocr,
      cameraLocations: { front: 'frente' },
      model: 'rapidocr-onnxruntime',
      provider: 'CPUExecutionProvider',
    });

    const result = await worker.observeOnce('front');
    const stored = await events.list();
    const snapshot = stored.find((event) => event.type === 'camera.snapshot');
    const observation = stored.find((event) => event.type === 'ocr.observation');

    expect(result).toMatchObject({
      camera: 'front',
      text: 'Portão 1234',
      normalizedText: 'PORTAO1234',
      confidence: 0.91,
      evidenceEventId: snapshot?.id,
      eventId: observation?.id,
    });
    expect(stored).toHaveLength(2);
    expect(observation).toMatchObject({
      type: 'ocr.observation',
      source: { type: 'ocr', id: 'rapidocr-onnxruntime' },
      location: 'frente',
      confidence: 0.91,
      data: {
        camera: 'front',
        text: 'Portão 1234',
        normalizedText: 'PORTAO1234',
        evidenceEventId: snapshot?.id,
        imageRef: 'front/ocr.jpg',
        provider: 'CPUExecutionProvider',
      },
    });
  });
});
