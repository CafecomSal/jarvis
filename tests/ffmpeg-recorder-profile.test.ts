import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FfmpegSegmentRecorder, type FfmpegRunOptions } from '../src/recordings/ffmpeg-recorder.js';
import { getRecordingProfile } from '../src/recordings/recording-profile.js';

describe('perfil FFmpeg de gravação', () => {
  it('propaga resolução, FPS e bitrate do perfil econômico', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-profile-'));
    const calls: FfmpegRunOptions[] = [];
    try {
      const recorder = new FfmpegSegmentRecorder({
        outputDirectory: directory,
        profile: getRecordingProfile('continuous-economic'),
        runFfmpeg: async (options) => {
          calls.push(options);
          await writeFile(options.outputPath, Buffer.from('segment'));
        },
        probe: async () => ({ durationMs: 1000, videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 1440 }),
      });

      const saved = await recorder.recordOnce('front', 'rtsp://camera.local/live', 1000);

      expect(saved.retentionTier).toBe('continuous');
      expect(calls[0]).toMatchObject({
        videoFps: 5,
        videoPreset: 'veryfast',
        videoWidth: 1280,
        videoHeight: 1440,
        videoBitrateKbps: 1400,
        audioBitrateKbps: 32,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
