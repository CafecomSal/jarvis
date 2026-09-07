import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { WorldStateProjection } from '../src/state/world-state.js';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { createDefaultToolRegistry } from '../src/tools/tool-registry.js';

describe('tools de IA read-only', () => {
  it('busca observações de objetos por classe e intervalo', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-car',
      type: 'object.observed',
      timestamp: '2026-09-04T12:00:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'object', id: 'car' },
      confidence: 0.82,
      data: { camera: 'front', className: 'car', evidenceEventId: 'evt-snapshot' },
    });
    await events.append({
      id: 'evt-dog',
      type: 'object.observed',
      timestamp: '2026-09-04T12:01:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'object', id: 'dog' },
      confidence: 0.7,
      data: { camera: 'front', className: 'dog', evidenceEventId: 'evt-snapshot-2' },
    });
    const registry = createDefaultToolRegistry({
      events,
      worldState: new WorldStateProjection(),
    });

    const result = await registry.execute({
      id: 'call-objects',
      name: 'search_object_observations',
      arguments: { className: 'car', from: '2026-09-04T11:59:00.000Z' },
    });

    expect(result).toMatchObject({
      count: 1,
      events: [{ id: 'evt-car', subject: { id: 'car' } }],
    });
  });

  it('busca OCR por termo e expõe o status do detector sem escrita', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-ocr',
      type: 'ocr.observation',
      timestamp: '2026-09-04T12:00:00.000Z',
      source: { type: 'ocr', id: 'rapidocr-onnxruntime' },
      location: 'frente',
      confidence: 0.91,
      data: {
        camera: 'front',
        text: 'Portão 1234',
        normalizedText: 'PORTAO1234',
        evidenceEventId: 'evt-snapshot',
      },
    });
    const registry = createDefaultToolRegistry({
      events,
      worldState: new WorldStateProjection(),
      detectorStatus: async () => ({
        status: { state: 'healthy', mode: 'dry-run' },
        health: { healthy: true, reason: 'healthy', ageMs: 100 },
      }),
    });

    const ocrResult = await registry.execute({
      id: 'call-ocr',
      name: 'search_ocr',
      arguments: { query: 'portao1234' },
    });
    const statusResult = await registry.execute({
      id: 'call-status',
      name: 'get_detector_status',
      arguments: {},
    });

    expect(ocrResult).toMatchObject({
      count: 1,
      events: [{ id: 'evt-ocr', data: { normalizedText: 'PORTAO1234' } }],
    });
    expect(statusResult).toMatchObject({ health: { healthy: true }, status: { state: 'healthy' } });
  });

  it('busca gravações e retorna metadata de um segmento sem bytes de vídeo', async () => {
    const recordings = new InMemoryRecordingStore();
    const segment: RecordingSegment = {
      id: 'rec-tool-1',
      camera: 'front',
      startedAt: '2026-09-04T12:00:00.000Z',
      endedAt: '2026-09-04T12:02:00.000Z',
      durationMs: 120_000,
      fileRef: 'front/2026-09-04/rec-tool-1.mkv',
      bytes: 1024,
      mimeType: 'video/x-matroska',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1920,
      height: 2160,
      backupStatus: 'local',
    };
    await recordings.append(segment);
    const registry = createDefaultToolRegistry({
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
      recordings,
    });

    const search = await registry.execute({
      id: 'call-recordings',
      name: 'search_recordings',
      arguments: { camera: 'front', from: '2026-09-04T11:59:00.000Z' },
    });
    const detail = await registry.execute({
      id: 'call-recording',
      name: 'get_recording',
      arguments: { id: 'rec-tool-1' },
    });

    expect(search).toMatchObject({ count: 1, recordings: [{ id: 'rec-tool-1' }] });
    expect(detail).toMatchObject({ available: true, recording: segment });
    expect(JSON.stringify(detail)).not.toContain('base64');
  });

  it('consulta a timeline unificada por intervalo', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-timeline-tool',
      type: 'object.observed',
      timestamp: '2026-09-04T12:00:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'object', id: 'car' },
      data: { camera: 'front', className: 'car' },
    });
    const registry = createDefaultToolRegistry({
      events,
      worldState: new WorldStateProjection(),
    });

    const result = await registry.execute({
      id: 'call-timeline',
      name: 'get_timeline',
      arguments: { camera: 'front', from: '2026-09-04T11:59:00.000Z', to: '2026-09-04T12:01:00.000Z' },
    });

    expect(result).toMatchObject({
      count: 1,
      items: [{ kind: 'event', id: 'evt-timeline-tool', type: 'object.observed' }],
    });
  });

  it('registra as novas tools como leitura', () => {
    const registry = createDefaultToolRegistry({
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });
    const names = new Set(['search_object_observations', 'search_ocr', 'get_detector_status', 'search_recordings', 'get_recording', 'get_timeline']);
    expect(registry.definitions().filter((tool) => names.has(tool.name)).every((tool) => tool.risk === 'read')).toBe(true);
  });
});
