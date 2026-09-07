import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import type { ObjectInferenceResult } from '../src/vision/onnx-person-detector.js';
import type { OcrEngine } from '../src/vision/ocr-engine.js';
import type { RecordingSegment } from '../src/recordings/recording-store.js';
import {
  RecordingIndexer,
  type RecordingFrame,
} from '../src/recordings/recording-indexer.js';

const segment: RecordingSegment = {
  id: 'rec-index-1',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:00:05.000Z',
  durationMs: 5_000,
  fileRef: 'front/2026-09-04/rec-index-1.mkv',
  bytes: 100,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

const frame: RecordingFrame = {
  timestampMs: 1_000,
  image: Buffer.from('jpeg'),
  imageRef: 'recordings/rec-index-1/frame-1000.jpg',
};

describe('indexador histórico de gravações', () => {
  it('liga objeto e OCR à evidência do frame e é idempotente', async () => {
    const events = new InMemoryEventStore();
    const objects = {
      infer: async (): Promise<ObjectInferenceResult> => ({
        latencyMs: 30,
        detections: [{
          classId: 2,
          className: 'car',
          confidence: 0.84,
          box: { x1: 10, y1: 20, x2: 200, y2: 300 },
        }],
      }),
    };
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
    const indexer = new RecordingIndexer({
      events,
      frames: { extract: async () => [frame] },
      objects,
      ocr,
      model: 'yolo11n.onnx',
      ocrModel: 'rapidocr-onnxruntime',
      provider: 'CPUExecutionProvider',
    });

    const first = await indexer.index(segment, { includeOcr: true });
    const second = await indexer.index(segment, { includeOcr: true });
    const stored = await events.list(20);
    const snapshot = stored.find((event) => event.type === 'camera.snapshot');
    const objectEvent = stored.find((event) => event.type === 'object.observed');
    const ocrEvent = stored.find((event) => event.type === 'ocr.observation');

    expect(first).toMatchObject({ framesProcessed: 1, evidenceEvents: 1, objectEvents: 1, ocrEvents: 1 });
    expect(second).toEqual(first);
    expect(stored).toHaveLength(3);
    expect(snapshot).toMatchObject({
      source: { type: 'recording', id: segment.id },
      timestamp: '2026-09-04T12:00:01.000Z',
      data: { recordingSegmentId: segment.id, frameTimestampMs: 1_000, imageRef: frame.imageRef },
    });
    expect(objectEvent).toMatchObject({
      source: { type: 'onnx_historical', id: 'yolo11n.onnx' },
      subject: { type: 'object', id: 'car' },
      data: {
        recordingSegmentId: segment.id,
        frameTimestampMs: 1_000,
        evidenceEventId: snapshot?.id,
        historical: true,
      },
    });
    expect(ocrEvent).toMatchObject({
      source: { type: 'ocr_historical', id: 'rapidocr-onnxruntime' },
      data: {
        recordingSegmentId: segment.id,
        frameTimestampMs: 1_000,
        evidenceEventId: snapshot?.id,
        normalizedText: 'PORTAO1234',
        historical: true,
      },
    });
  });
});
