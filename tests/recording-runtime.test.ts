import { describe, expect, it } from 'vitest';
import { InMemoryRecordingIndexRunStore } from '../src/recordings/recording-index-run-store.js';
import type { RecordingIndexResult } from '../src/recordings/recording-indexer.js';
import { RecordingRuntime } from '../src/recordings/recording-runtime.js';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';

function segment(id: string): RecordingSegment {
  return {
    id,
    camera: 'front',
    startedAt: '2026-09-07T10:00:00.000Z',
    endedAt: '2026-09-07T10:00:00.010Z',
    durationMs: 10,
    fileRef: `front/${id}.mkv`,
    bytes: 10,
    mimeType: 'video/x-matroska',
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1280,
    height: 1440,
    backupStatus: 'local',
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('runtime test condition timed out');
}

const successfulIndex: Omit<RecordingIndexResult, 'segmentId'> = {
  framesProcessed: 1,
  evidenceEvents: 1,
  objectEvents: 1,
  ocrEvents: 0,
  promotedToEvent: true,
};

function createRuntime(options: {
  manager: { recordOnce: (camera: string, streamUrl: string, durationMs: number) => Promise<RecordingSegment>; close: () => void };
  indexer: { index: (recording: RecordingSegment, options?: { includeOcr: boolean; temporaryFrames: boolean }) => Promise<RecordingIndexResult> };
  runs?: InMemoryRecordingIndexRunStore;
  recordings?: InMemoryRecordingStore;
  sleep?: (delayMs: number) => Promise<void>;
  maxPendingSegments?: number;
  maxAttempts?: number;
}) {
  return new RecordingRuntime({
    camera: 'front',
    streamUrl: 'rtsp://127.0.0.1/front',
    manager: options.manager,
    recordings: options.recordings ?? new InMemoryRecordingStore(),
    indexer: options.indexer,
    indexRuns: options.runs ?? new InMemoryRecordingIndexRunStore(),
    model: 'yolo.onnx',
    ocrModel: 'rapidocr',
    segmentDurationMs: 10,
    intervalMs: 1,
    retryBackoffMs: 1,
    sleep: options.sleep,
    backfill: { status: 'completed' },
    maxPendingSegments: options.maxPendingSegments,
    maxAttempts: options.maxAttempts,
  });
}

describe('runtime DVR contínuo', () => {
  it('aplica backpressure sem descartar segmentos quando há dois pendentes', async () => {
    const recordings = new InMemoryRecordingStore();
    const runs = new InMemoryRecordingIndexRunStore();
    let firstIndexStarted = false;
    let releaseFirst!: () => void;
    const firstIndex = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let indexCalls = 0;
    const managerIds: string[] = [];
    const manager = {
      recordOnce: async (): Promise<RecordingSegment> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const id = `runtime-segment-${managerIds.length + 1}`;
        managerIds.push(id);
        const saved = await recordings.append(segment(id));
        return saved;
      },
      close: () => undefined,
    };
    const indexer = {
      index: async (recording: RecordingSegment): Promise<RecordingIndexResult> => {
        indexCalls += 1;
        if (indexCalls === 1) {
          firstIndexStarted = true;
          await firstIndex;
        }
        return { ...successfulIndex, segmentId: recording.id };
      },
    };
    const runtime = createRuntime({ manager, indexer, runs, recordings });
    await runtime.start();
    await waitFor(async () => firstIndexStarted && (await runtime.health()).indexing.queueLength === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(managerIds).toHaveLength(3);
    expect((await runtime.health()).indexing.backpressure).toBe(true);

    releaseFirst();
    await waitFor(() => indexCalls >= 3);
    await runtime.stop();

    expect(managerIds.length).toBeGreaterThanOrEqual(3);
    expect(await recordings.list({ limit: 100 })).toHaveLength(managerIds.length);
    expect((await runtime.health()).status).toBe('stopped');
  });

  it('repete até três tentativas com backoff e completa o mesmo job', async () => {
    const runs = new InMemoryRecordingIndexRunStore();
    const recording = segment('retry-segment');
    let managerCalls = 0;
    let indexCalls = 0;
    const delays: number[] = [];
    const manager = {
      recordOnce: async (): Promise<RecordingSegment> => {
        managerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return recording;
      },
      close: () => undefined,
    };
    const indexer = {
      index: async (recording: RecordingSegment): Promise<RecordingIndexResult> => {
        indexCalls += 1;
        if (indexCalls < 3) throw new Error('temporary index failure');
        return { ...successfulIndex, segmentId: recording.id };
      },
    };
    const runtime = createRuntime({
      manager,
      indexer,
      runs,
      sleep: async (delayMs) => { delays.push(delayMs); },
    });
    await runtime.start();
    await waitFor(async () => (await runs.findLatestBySegment(recording.id))?.status === 'completed');
    await runtime.stop();

    const completed = await runs.findLatestBySegment(recording.id);
    expect(completed).toMatchObject({ status: 'completed', attempts: 3, framesProcessed: 1 });
    expect(delays).toEqual([1, 2]);
    expect(managerCalls).toBeGreaterThan(0);
  });

  it('recupera job processing deixado por um restart', async () => {
    const runs = new InMemoryRecordingIndexRunStore();
    const recordings = new InMemoryRecordingStore();
    const recording = segment('recovery-segment');
    await recordings.append(recording);
    const queued = await runs.enqueue({ id: 'recovery-run', segmentId: recording.id, model: 'yolo.onnx', ocrModel: 'rapidocr', policyVersion: 'continuous-v1' });
    await runs.markProcessing(queued.id);
    let indexCalls = 0;
    const manager = {
      recordOnce: async (): Promise<RecordingSegment> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return recording;
      },
      close: () => undefined,
    };
    const indexer = {
      index: async (recording: RecordingSegment): Promise<RecordingIndexResult> => {
        indexCalls += 1;
        return { ...successfulIndex, segmentId: recording.id };
      },
    };
    const runtime = createRuntime({ manager, indexer, runs, recordings });
    await runtime.start();
    await waitFor(async () => (await runs.findById(queued.id))?.status === 'completed');
    await runtime.stop();

    expect(indexCalls).toBe(1);
    expect(await runs.findById(queued.id)).toMatchObject({ status: 'completed', attempts: 2 });
  });
});
