import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectDetectorStatus,
  parseDetectorStatusOptions,
} from '../src/vision/run-detector-status.js';

describe('verificador de status do detector', () => {
  it('usa caminho e idade seguros por padrão e permite configuração local', () => {
    expect(parseDetectorStatusOptions({})).toEqual({
      statusFile: 'data/detector/status.json',
      maxAgeMs: 30_000,
    });
    expect(parseDetectorStatusOptions({
      JARVIS_DETECTOR_STATUS_FILE: 'runtime/detector.json',
      JARVIS_DETECTOR_STATUS_MAX_AGE_MS: '12000',
    })).toEqual({
      statusFile: 'runtime/detector.json',
      maxAgeMs: 12_000,
    });
    expect(() => parseDetectorStatusOptions({
      JARVIS_DETECTOR_STATUS_MAX_AGE_MS: '0',
    })).toThrow('JARVIS_DETECTOR_STATUS_MAX_AGE_MS must be greater than zero');
  });

  it('classifica um status healthy recente e rejeita um status stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-detector-status-cli-'));
    try {
      const path = join(directory, 'status.json');
      const status = {
        schemaVersion: 1,
        state: 'healthy',
        mode: 'dry-run',
        camera: 'front',
        model: 'yolo11n.onnx',
        provider: 'CPUExecutionProvider',
        startedAt: '2026-09-02T22:00:00.000Z',
        updatedAt: '2026-09-02T22:00:00.000Z',
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
      await writeFile(path, JSON.stringify(status), 'utf8');

      await expect(inspectDetectorStatus(
        { statusFile: path, maxAgeMs: 5_000 },
        new Date('2026-09-02T22:00:02.000Z'),
      )).resolves.toMatchObject({
        health: { healthy: true, reason: 'healthy', ageMs: 2_000 },
        status: { state: 'healthy' },
      });
      await expect(inspectDetectorStatus(
        { statusFile: path, maxAgeMs: 5_000 },
        new Date('2026-09-02T22:01:00.000Z'),
      )).resolves.toMatchObject({
        health: { healthy: false, reason: 'stale', ageMs: 60_000 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
