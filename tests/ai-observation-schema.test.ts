import { describe, expect, it } from 'vitest';
import {
  BoundingBoxSchema,
  ObjectObservationDataSchema,
  OcrObservationDataSchema,
  RecordingSegmentMetadataSchema,
} from '../src/events/ai-observation-schema.js';

describe('contratos de percepção e mídia', () => {
  it('aceita uma observação de objeto ligada à evidência', () => {
    expect(ObjectObservationDataSchema.parse({
      camera: 'front',
      className: 'car',
      classId: 2,
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      detections: [{
        confidence: 0.82,
        box: { x1: 10, y1: 20, x2: 200, y2: 300 },
      }],
      evidenceEventId: 'evt-snapshot-1',
      imageRef: 'front/frame.jpg',
      latencyMs: 48.2,
    })).toMatchObject({
      camera: 'front',
      className: 'car',
      evidenceEventId: 'evt-snapshot-1',
    });
  });

  it('rejeita caixa inválida e confiança fora do intervalo', () => {
    expect(() => BoundingBoxSchema.parse({ x1: 10, y1: 20, x2: 5, y2: 30 })).toThrow();
    expect(() => ObjectObservationDataSchema.parse({
      camera: 'front',
      className: 'car',
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      detections: [{ confidence: 1.1, box: { x1: 1, y1: 1, x2: 2, y2: 2 } }],
      evidenceEventId: 'evt-1',
    })).toThrow();
  });

  it('aceita OCR com texto normalizado e localização das leituras', () => {
    expect(OcrObservationDataSchema.parse({
      camera: 'front',
      text: 'ABC-1234',
      normalizedText: 'ABC1234',
      language: 'por',
      confidence: 0.91,
      regions: [{
        text: 'ABC-1234',
        confidence: 0.91,
        box: { x1: 100, y1: 200, x2: 300, y2: 260 },
      }],
      evidenceEventId: 'evt-snapshot-2',
      imageRef: 'front/frame-2.jpg',
    })).toMatchObject({
      text: 'ABC-1234',
      normalizedText: 'ABC1234',
      regions: [{ text: 'ABC-1234' }],
    });
  });

  it('aceita metadata de segmento sem permitir URL de origem', () => {
    expect(RecordingSegmentMetadataSchema.parse({
      camera: 'front',
      startedAt: '2026-09-04T12:00:00.000Z',
      endedAt: '2026-09-04T12:02:00.000Z',
      durationMs: 120_000,
      fileRef: 'front/2026-09-04/segment-001.mkv',
      bytes: 1024,
      mimeType: 'video/x-matroska',
      videoCodec: 'hevc',
      audioCodec: 'pcm_alaw',
      width: 1920,
      height: 2160,
      backupStatus: 'local',
    })).toMatchObject({
      camera: 'front',
      videoCodec: 'hevc',
      backupStatus: 'local',
    });
  });
});
