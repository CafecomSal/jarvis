import { describe, expect, it } from 'vitest';
import { RecordingRemoteRetentionScheduler } from '../src/recordings/recording-remote-retention-scheduler.js';

describe('scheduler de retenção remota', () => {
  it('executa uma vez ao iniciar e para sem deixar timer', async () => {
    let runs = 0;
    const results: number[] = [];
    const scheduler = new RecordingRemoteRetentionScheduler(
      { run: async () => { runs += 1; return { scanned: 1, deleted: ['rec-1'], failed: [] }; } },
      { intervalMs: 60_000, onResult: (result) => results.push(result.deleted.length) },
    );

    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.stop();

    expect(runs).toBe(1);
    expect(results).toEqual([1]);
  });
});
