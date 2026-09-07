import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import type { ObjectInferenceResult } from '../src/vision/onnx-person-detector.js';
import type { OcrEngine } from '../src/vision/ocr-engine.js';
import { RecordingIndexer, type RecordingFrame } from '../src/recordings/recording-indexer.js';
import type { RecordingSegment } from '../src/recordings/recording-store.js';

const segment: RecordingSegment = {
  id: 'continuous-segment', camera: 'front', startedAt: '2026-09-07T10:00:00.000Z', endedAt: '2026-09-07T10:03:00.000Z', durationMs: 180_000,
  fileRef: 'front/continuous.mkv', bytes: 1, mimeType: 'video/x-matroska', videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 720, backupStatus: 'local',
};

describe('indexação contínua', () => {
  it('aplica confiança/deduplicação OCR, confirmação temporal e limpa frames sem evidência', async () => {
    const events = new InMemoryEventStore();
    const disposed: string[] = [];
    const frames: RecordingFrame[] = [
      { timestampMs: 0, image: Buffer.from('no'), imageRef: 'index-tmp/no.jpg', temporary: true },
      { timestampMs: 1_000, image: Buffer.from('object1'), imageRef: 'index-tmp/object1.jpg', temporary: true },
      { timestampMs: 2_000, image: Buffer.from('object2'), imageRef: 'index-tmp/object2.jpg', temporary: true },
      { timestampMs: 3_000, image: Buffer.from('ocr'), imageRef: 'index-tmp/ocr.jpg', temporary: true },
    ];
    let inference = 0;
    const objects = { infer: async (): Promise<ObjectInferenceResult> => {
      inference += 1;
      return inference === 2 || inference === 3 ? { latencyMs: 1, detections: [{ classId: 2, className: 'car', confidence: 0.8, box: { x1: 1, y1: 1, x2: 10, y2: 10 } }] } : { latencyMs: 1, detections: [] };
    } };
    const ocr: OcrEngine = { recognize: async () => ({ text: 'Portão', normalizedText: 'PORTAO', confidence: 0.9, regions: [{ text: 'Portão', confidence: 0.9, box: { x1: 1, y1: 1, x2: 10, y2: 10 } }], latencyMs: 1 }) };
    const promoted: string[] = [];
    const indexer = new RecordingIndexer({
      events, frames: {
        extract: async () => frames,
        promote: async (frame) => ({ ...frame, imageRef: frame.imageRef.replace('index-tmp/', 'recordings/'), temporary: false }),
        dispose: async (frame) => { disposed.push(frame.imageRef); },
      }, objects, ocr, continuous: true, confirmObjects: true, confirmationFrames: 2, confirmationWindowMs: 5_000, promoteSegment: async (id) => { promoted.push(id); },
    });
    const result = await indexer.index(segment, { includeOcr: true, temporaryFrames: true });
    expect(result).toMatchObject({ framesProcessed: 4, evidenceEvents: 3, objectEvents: 2, ocrEvents: 1, promotedToEvent: true });
    expect(promoted).toEqual([segment.id]);
    expect(disposed).toEqual(['index-tmp/ocr.jpg']);
    expect((await events.list()).filter((event) => event.type === 'ocr.observation')).toHaveLength(1);
    expect((await events.list()).filter((event) => event.type === 'object.observed')[0]?.data.confirmed).toBe(false);
    expect((await events.list()).filter((event) => event.type === 'object.observed')[1]?.data.confirmed).toBe(true);
    expect((await events.list()).filter((event) => event.type === 'object.observed')[0]?.source.type).toBe('onnx_continuous');
    expect((await events.list()).find((event) => event.type === 'camera.snapshot')?.data.historical).toBe(false);
  });

  it('descarta detecção abaixo de 0,35 e não conserva frame sem evidência aceita', async () => {
    const events = new InMemoryEventStore();
    const disposed: string[] = [];
    const indexer = new RecordingIndexer({
      events,
      frames: {
        extract: async () => [{ timestampMs: 0, image: Buffer.from('low'), imageRef: 'index-tmp/low.jpg', temporary: true }],
        promote: async (frame) => ({ ...frame, imageRef: 'recordings/low.jpg', temporary: false }),
        dispose: async (frame) => { disposed.push(frame.imageRef); },
      },
      objects: {
        infer: async () => ({ latencyMs: 1, detections: [{ classId: 2, className: 'car', confidence: 0.34, box: { x1: 1, y1: 1, x2: 10, y2: 10 } }] }),
      },
      ocr: { recognize: async () => ({ text: 'baixo', normalizedText: 'BAIXO', confidence: 0.59, regions: [{ text: 'baixo', confidence: 0.59, box: { x1: 1, y1: 1, x2: 10, y2: 10 } }], latencyMs: 1 }) },
      continuous: true,
    });

    const result = await indexer.index(segment, { includeOcr: true, temporaryFrames: true });

    expect(result).toMatchObject({ framesProcessed: 1, evidenceEvents: 0, objectEvents: 0, ocrEvents: 0, promotedToEvent: false });
    expect(disposed).toEqual(['index-tmp/low.jpg']);
    expect(await events.list()).toHaveLength(0);
  });
});
