import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { TagService } from '../src/tags/tag-service.js';

describe('TagService', () => {
  it('deriva tags estruturadas de objeto, atributos, relação e OCR', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-object-tags',
      type: 'object.observed',
      timestamp: '2026-09-05T01:00:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'object', id: 'car' },
      confidence: 0.91,
      data: {
        camera: 'front',
        className: 'car',
        confirmed: true,
        attributes: { color: 'prata' },
        relationships: [{ type: 'near', target: 'person' }],
      },
    });
    await events.append({
      id: 'evt-ocr-tags',
      type: 'ocr.observation',
      timestamp: '2026-09-05T01:00:01.000Z',
      source: { type: 'ocr', id: 'rapidocr' },
      location: 'frente',
      data: {
        camera: 'front',
        text: 'PORTAO 1234',
        normalizedText: 'PORTAO1234',
        confidence: 0.8,
      },
    });

    const service = new TagService(events);
    const result = await service.list({ camera: 'front' });

    expect(result.count).toBe(4);
    expect(result.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ namespace: 'object', key: 'class', value: 'car', status: 'confirmed' }),
      expect.objectContaining({ namespace: 'car', key: 'color', value: 'prata' }),
      expect.objectContaining({ namespace: 'relation', key: 'near', value: 'person' }),
      expect.objectContaining({ namespace: 'ocr', key: 'text', value: 'PORTAO1234' }),
    ]));
  });

  it('mantém a tag original e não duplica ao listar novamente', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-object-idempotent',
      type: 'object.observed',
      timestamp: '2026-09-05T01:00:00.000Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      subject: { type: 'object', id: 'chair' },
      data: { className: 'chair', confirmed: true },
    });

    const service = new TagService(events);
    const first = await service.list();
    const second = await service.list();

    expect(first.tags).toEqual(second.tags);
    expect(new Set(second.tags.map((tag) => tag.id)).size).toBe(second.count);
  });
});
