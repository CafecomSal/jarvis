import { describe, expect, it } from 'vitest';
import { InMemoryRecordingIndexRunStore } from '../src/recordings/recording-index-run-store.js';

describe('fila persistente de indexação', () => {
  it('recupera jobs, conta tentativas e encerra no terceiro erro', async () => {
    const store = new InMemoryRecordingIndexRunStore();
    const input = { id: 'run-1', segmentId: 'rec-1', model: 'yolo.onnx', ocrModel: 'rapidocr', policyVersion: 'v1' };
    const created = await store.enqueue(input);
    expect(created.status).toBe('queued');
    const first = await store.markProcessing(created.id);
    expect(first.attempts).toBe(1);
    const queued = await store.markFailure(created.id, 'temporary', '2026-09-07T10:00:01.000Z');
    expect(queued.status).toBe('queued');
    const second = await store.markProcessing(created.id);
    await store.markFailure(created.id, 'temporary', '2026-09-07T10:00:02.000Z');
    const third = await store.markProcessing(created.id);
    const failed = await store.markFailure(created.id, 'permanent');
    expect(third.attempts).toBe(3);
    expect(failed.status).toBe('failed');
    expect(await store.listRecoverable(new Date('2026-09-07T10:00:03.000Z'))).toHaveLength(0);
    void second;
  });
});
