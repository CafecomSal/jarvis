import { describe, expect, it } from 'vitest';
import { RecordingUploadQueue } from '../src/recordings/recording-upload-queue.js';

describe('fila de upload de gravações', () => {
  it('tenta novamente, deduplica IDs e termina verificada', async () => {
    const calls: string[] = [];
    let attempts = 0;
    const queue = new RecordingUploadQueue({
      archive: async (id) => {
        calls.push(id);
        attempts += 1;
        if (attempts === 1) throw new Error('temporário');
      },
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    const result = await queue.upload(['rec-1', 'rec-1']);

    expect(calls).toEqual(['rec-1', 'rec-1']);
    expect(result).toEqual([{ id: 'rec-1', status: 'verified', attempts: 2 }]);
  });

  it('preserva falha depois do máximo de tentativas', async () => {
    const result = await new RecordingUploadQueue({
      archive: async () => { throw new Error('Drive indisponível'); },
      maxAttempts: 2,
      retryDelayMs: 0,
    }).upload(['rec-fail']);

    expect(result[0]).toMatchObject({ id: 'rec-fail', status: 'failed', attempts: 2, error: 'Drive indisponível' });
  });
});
