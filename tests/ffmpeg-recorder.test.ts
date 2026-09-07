import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryRecordingStore } from '../src/recordings/recording-store.js';
import {
  FfmpegSegmentRecorder,
  RecordingManager,
  type FfmpegProbe,
} from '../src/recordings/ffmpeg-recorder.js';

describe('gravador de segmentos FFmpeg', () => {
  it('grava um segmento, coleta metadata/checksum e cataloga', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-recorder-'));
    try {
      const probe: FfmpegProbe = {
        durationMs: 2_000,
        videoCodec: 'hevc',
        audioCodec: 'pcm_alaw',
        width: 1920,
        height: 2160,
      };
      const recorder = new FfmpegSegmentRecorder({
        outputDirectory: directory,
        clock: () => new Date('2026-09-04T12:00:00.000Z'),
        runFfmpeg: async (options) => {
          expect(options.videoCodec).toBe('libx264');
          expect(options.audioCodec).toBe('aac');
          expect(options.videoFps).toBe(5);
          expect(options.videoPreset).toBe('ultrafast');
          await (await import('node:fs/promises')).writeFile(options.outputPath, Buffer.from('recording-bytes'));
        },
        probe: async () => probe,
      });
      const manager = new RecordingManager(recorder, new InMemoryRecordingStore());

      const saved = await manager.recordOnce('front', 'rtsp://redacted.example/onvif1', 2_000);
      const bytes = await readFile(join(directory, ...saved.fileRef.split('/')));

      expect(saved).toMatchObject({
        id: expect.stringMatching(/^rec-/),
        camera: 'front',
        startedAt: '2026-09-04T12:00:00.000Z',
        endedAt: '2026-09-04T12:00:02.000Z',
        durationMs: 2_000,
        fileRef: expect.stringMatching(/^front\/2026-09-04\/rec-.*\.mkv$/),
        bytes: bytes.length,
        mimeType: 'video/x-matroska',
        videoCodec: 'hevc',
        audioCodec: 'pcm_alaw',
        width: 1920,
        height: 2160,
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        backupStatus: 'local',
      });
      expect((await stat(join(directory, ...saved.fileRef.split('/')))).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejeita uma origem que não seja RTSP', async () => {
    const recorder = new FfmpegSegmentRecorder({ outputDirectory: 'data/recordings' });
    await expect(recorder.recordOnce('front', 'http://example.test/stream', 1_000)).rejects.toThrow(
      'Recording stream URL must use rtsp:// or rtsps://',
    );
  });
});
