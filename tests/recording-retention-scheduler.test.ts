import { describe, expect, it, vi } from 'vitest';
import { RecordingRetentionScheduler } from '../src/recordings/recording-retention-scheduler.js';
import type { RecordingRetentionResult } from '../src/recordings/recording-retention.js';

const result: RecordingRetentionResult = {
  scanned: 1,
  totalBytes: 10,
  missingFiles: 0,
  candidates: [],
  archived: 0,
  failed: 0,
  deleted: 0,
};

describe('scheduler de retenção DVR', () => {
  it('executa imediatamente, não sobrepõe e para o intervalo', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      let calls = 0;
      let overlaps = 0;
      const runner = {
        run: async (): Promise<RecordingRetentionResult> => {
          calls += 1;
          if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
          return result;
        },
      };
      const scheduler = new RecordingRetentionScheduler(runner, {
        intervalMs: 100,
        onOverlapSkipped: () => { overlaps += 1; },
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toBe(1);
      expect(overlaps).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(300);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
