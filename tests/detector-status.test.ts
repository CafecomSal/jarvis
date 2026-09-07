import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DetectorStatusFileWriter,
  DetectorStatusTracker,
  evaluateDetectorStatus,
} from '../src/vision/detector-status.js';

describe('status operacional do detector', () => {
  it('registra métricas de amostras, confirmações, eventos e erros sem guardar URL', () => {
    let now = new Date('2026-09-02T22:00:00.000Z');
    const tracker = new DetectorStatusTracker({
      camera: 'front',
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      mode: 'dry-run',
      clock: () => now,
    });

    tracker.markRunning();
    tracker.recordResult({
      camera: 'front',
      detected: true,
      detections: [{ confidence: 0.8, box: { x1: 1, y1: 2, x2: 3, y2: 4 } }],
      latencyMs: 42,
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      confirmed: false,
    });
    now = new Date('2026-09-02T22:00:01.000Z');
    tracker.recordResult({
      camera: 'front',
      detected: true,
      detections: [
        { confidence: 0.8, box: { x1: 1, y1: 2, x2: 3, y2: 4 } },
        { confidence: 0.7, box: { x1: 5, y1: 6, x2: 7, y2: 8 } },
      ],
      latencyMs: 45,
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      confirmed: true,
      eventId: 'evt-person',
    });
    tracker.recordSkippedOverlap();
    tracker.recordError(new Error('FFmpeg failed for rtsp://user:secret@camera.local/onvif1'));

    expect(tracker.snapshot()).toMatchObject({
      schemaVersion: 1,
      state: 'degraded',
      mode: 'dry-run',
      camera: 'front',
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      attempts: 3,
      successes: 2,
      detectedSamples: 2,
      detections: 3,
      confirmedSamples: 1,
      eventsEmitted: 1,
      skippedOverlaps: 1,
      errors: 1,
      consecutiveErrors: 1,
      lastLatencyMs: 45,
      lastError: 'FFmpeg failed for [REDACTED_RTSP_URL]',
      lastErrorAt: '2026-09-02T22:00:01.000Z',
      updatedAt: '2026-09-02T22:00:01.000Z',
    });
  });

  it('escreve o status em JSON e não deixa arquivo temporário', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-detector-status-'));
    try {
      const path = join(directory, 'nested', 'status.json');
      const writer = new DetectorStatusFileWriter(path);
      const status = {
        schemaVersion: 1 as const,
        state: 'healthy' as const,
        mode: 'dry-run' as const,
        camera: 'front',
        model: 'yolo11n.onnx',
        provider: 'CPUExecutionProvider',
        startedAt: '2026-09-02T22:00:00.000Z',
        updatedAt: '2026-09-02T22:00:01.000Z',
        attempts: 1,
        successes: 1,
        detectedSamples: 0,
        detections: 0,
        confirmedSamples: 0,
        eventsEmitted: 0,
        skippedOverlaps: 0,
        errors: 0,
        consecutiveErrors: 0,
      };

      await writer.write(status);

      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(status);
      expect(await readdir(join(directory, 'nested'))).toEqual(['status.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('classifica status recente, stale, degradado e parado', () => {
    const tracker = new DetectorStatusTracker({
      camera: 'front',
      model: 'yolo11n.onnx',
      provider: 'CPUExecutionProvider',
      mode: 'dry-run',
      clock: () => new Date('2026-09-02T22:00:00.000Z'),
    });
    tracker.markRunning();
    const healthy = tracker.snapshot();

    expect(evaluateDetectorStatus(
      healthy,
      new Date('2026-09-02T22:00:02.000Z'),
      5_000,
    )).toEqual({ healthy: true, reason: 'healthy', ageMs: 2_000 });
    expect(evaluateDetectorStatus(
      { ...healthy, updatedAt: '2026-09-02T21:59:00.000Z' },
      new Date('2026-09-02T22:00:02.000Z'),
      5_000,
    )).toEqual({ healthy: false, reason: 'stale', ageMs: 62_000 });
    expect(evaluateDetectorStatus(
      { ...healthy, state: 'degraded' },
      new Date('2026-09-02T22:00:02.000Z'),
      5_000,
    )).toEqual({ healthy: false, reason: 'degraded', ageMs: 2_000 });
    expect(evaluateDetectorStatus(
      { ...healthy, state: 'stopped' },
      new Date('2026-09-02T22:00:02.000Z'),
      5_000,
    )).toEqual({ healthy: false, reason: 'stopped', ageMs: 2_000 });
    expect(evaluateDetectorStatus(
      { ...healthy, pid: 4321 },
      new Date('2026-09-02T22:00:02.000Z'),
      5_000,
      () => false,
    )).toEqual({ healthy: false, reason: 'not_running', ageMs: 2_000 });
  });
});
