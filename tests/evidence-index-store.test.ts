import { describe, expect, it } from 'vitest';
import { InMemoryEvidenceIndexStore } from '../src/evidence/evidence-index-store.js';

describe('índice relacional de evidências em memória', () => {
  it('faz upsert idempotente e filtra texto/classe', async () => {
    const store = new InMemoryEvidenceIndexStore();
    await store.upsertEvidence({
      id: 'ev-1', eventId: 'ev-1', camera: 'front', timestamp: '2026-09-07T10:00:00.000Z',
      recordingSegmentId: 'rec-1', frameTimestampMs: 1000, imageRef: 'recordings/rec-1/frame.jpg',
      mimeType: 'image/jpeg', bytes: 12, historical: true,
    });
    await store.upsertObservation({
      id: 'obj-1', eventId: 'obj-1', evidenceId: 'ev-1', eventType: 'object.observed', kind: 'object',
      camera: 'front', timestamp: '2026-09-07T10:00:00.000Z', objectClass: 'car', confidence: 0.8,
    });
    await store.upsertObservation({
      id: 'ocr-1', eventId: 'ocr-1', evidenceId: 'ev-1', eventType: 'ocr.observation', kind: 'ocr',
      camera: 'front', timestamp: '2026-09-07T10:00:00.000Z', text: 'Portão 12', normalizedText: 'PORTAO12', confidence: 0.9,
    });
    expect(await store.upsertEvidence({
      id: 'ev-1', eventId: 'ev-1', camera: 'front', timestamp: '2026-09-07T10:00:00.000Z',
      imageRef: 'different.jpg', mimeType: 'image/jpeg', bytes: 1, historical: true,
    })).toMatchObject({ imageRef: 'recordings/rec-1/frame.jpg' });
    expect(await store.listEvidence({ objectClass: 'car' })).toHaveLength(1);
    expect(await store.listEvidence({ ocrQuery: 'portão12' })).toHaveLength(1);
    expect(await store.listEvidence({ eventType: 'camera.snapshot' })).toHaveLength(1);
    expect(await store.listObservations('ev-1')).toHaveLength(2);
  });

  it('persiste e lê o marcador de backfill', async () => {
    const store = new InMemoryEvidenceIndexStore();
    await store.setMarker({ key: 'backfill', version: '1', completedAt: '2026-09-07T10:00:00.000Z', metadata: { events: 3 } });
    await expect(store.getMarker('backfill')).resolves.toMatchObject({ version: '1', metadata: { events: 3 } });
  });
});
