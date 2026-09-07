import { describe, expect, it } from 'vitest';
import { RecordingScheduler, type RecordingRunner } from '../src/recordings/recording-scheduler.js';
import type { RecordingSegment } from '../src/recordings/recording-store.js';

const segment: RecordingSegment = {
  id: 'rec-scheduler-1',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:00:01.000Z',
  durationMs: 1_000,
  fileRef: 'front/2026-09-04/rec-scheduler-1.mkv',
  bytes: 10,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

describe('scheduler de gravação segmentada', () => {
  it('não sobrepõe segmentos e para depois do segmento ativo', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const runner: RecordingRunner = {
      recordOnce: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return segment;
      },
    };
    const completed: RecordingSegment[] = [];
    const scheduler = new RecordingScheduler(runner, {
      camera: 'front',
      streamUrl: 'rtsp://redacted.example/onvif1',
      segmentDurationMs: 1_000,
      onSegment: (saved) => completed.push(saved),
    });

    scheduler.start();
    expect(calls).toBe(1);
    scheduler.stop();
    release?.();
    await scheduler.wait();

    expect(calls).toBe(1);
    expect(completed).toEqual([segment]);
  });

  it('faz retry limitado após erro e informa a falha', async () => {
    let calls = 0;
    const delays: number[] = [];
    const errors: string[] = [];
    const runner: RecordingRunner = {
      recordOnce: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary recording failure');
        return segment;
      },
    };
    const scheduler = new RecordingScheduler(runner, {
      camera: 'front',
      streamUrl: 'rtsp://redacted.example/onvif1',
      segmentDurationMs: 1_000,
      retryDelayMs: 25,
      sleep: async (delayMs) => { delays.push(delayMs); },
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      onSegment: () => scheduler.stop(),
    });

    scheduler.start();
    await scheduler.wait();

    expect(calls).toBe(2);
    expect(delays).toEqual([25]);
    expect(errors).toEqual(['temporary recording failure']);
  });
});
