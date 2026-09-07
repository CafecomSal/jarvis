import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordingSegment } from '../src/recordings/recording-store.js';
import {
  FfmpegRecordingFrameSource,
  type FrameCapture,
} from '../src/recordings/recording-frame-extractor.js';

const segment: RecordingSegment = {
  id: 'rec-frames-1',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:00:02.500Z',
  durationMs: 2_500,
  fileRef: 'front/2026-09-04/rec-frames-1.mkv',
  bytes: 100,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

describe('extrator de frames históricos', () => {
  it('amostra intervalos, salva JPEGs e retorna referências portáteis', async () => {
    const recordingsDirectory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-frames-recordings-'));
    const snapshotsDirectory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-frames-snapshots-'));
    try {
      const segmentPath = join(recordingsDirectory, ...segment.fileRef.split('/'));
      await mkdir(join(recordingsDirectory, 'front', '2026-09-04'), { recursive: true });
      await writeFile(segmentPath, Buffer.from('segment'));
      const calls: number[] = [];
      const capture: FrameCapture = async ({ timestampMs }) => {
        calls.push(timestampMs);
        return Buffer.from(`jpeg-${timestampMs}`);
      };
      const source = new FfmpegRecordingFrameSource({
        recordingsDirectory,
        snapshotsDirectory,
        intervalMs: 1_000,
        capture,
      });

      const frames = await source.extract(segment);

      expect(calls).toEqual([0, 1_000, 2_000]);
      expect(frames.map((frame) => frame.timestampMs)).toEqual(calls);
      expect(frames.map((frame) => frame.imageRef)).toEqual([
        'recordings/rec-frames-1/frame-0000000000.jpg',
        'recordings/rec-frames-1/frame-0000001000.jpg',
        'recordings/rec-frames-1/frame-0000002000.jpg',
      ]);
      await expect(readFile(join(snapshotsDirectory, 'recordings', 'rec-frames-1', 'frame-0000001000.jpg')))
        .resolves.toEqual(Buffer.from('jpeg-1000'));
    } finally {
      await rm(recordingsDirectory, { recursive: true, force: true });
      await rm(snapshotsDirectory, { recursive: true, force: true });
    }
  });

  it('não solicita frame no intervalo final parcial sem decodificação', async () => {
    const recordingsDirectory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-frames-edge-recordings-'));
    const snapshotsDirectory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-frames-edge-snapshots-'));
    try {
      const edgeSegment = { ...segment, durationMs: 5_119, endedAt: '2026-09-04T12:00:05.119Z' };
      const segmentPath = join(recordingsDirectory, ...edgeSegment.fileRef.split('/'));
      await mkdir(join(recordingsDirectory, 'front', '2026-09-04'), { recursive: true });
      await writeFile(segmentPath, Buffer.from('segment'));
      const calls: number[] = [];
      const source = new FfmpegRecordingFrameSource({
        recordingsDirectory,
        snapshotsDirectory,
        intervalMs: 1_000,
        capture: async ({ timestampMs }) => {
          calls.push(timestampMs);
          return Buffer.from(`jpeg-${timestampMs}`);
        },
      });

      await source.extract(edgeSegment);

      expect(calls).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    } finally {
      await rm(recordingsDirectory, { recursive: true, force: true });
      await rm(snapshotsDirectory, { recursive: true, force: true });
    }
  });

  it('rejeita intervalo inválido', () => {
    expect(() => new FfmpegRecordingFrameSource({
      recordingsDirectory: 'data/recordings',
      snapshotsDirectory: 'data/snapshots',
      intervalMs: 0,
    })).toThrow('Frame extraction intervalMs must be greater than zero');
  });
});
