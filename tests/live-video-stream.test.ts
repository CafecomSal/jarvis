import { describe, expect, it } from 'vitest';
import { liveVideoContentType, liveVideoFfmpegArgs } from '../src/cameras/live-video-stream.js';

describe('stream de vídeo de baixa latência', () => {
  it('produz MPEG-TS H.264 contínuo com flags de baixa latência', () => {
    expect(liveVideoContentType()).toBe('video/mp2t');
    const args = liveVideoFfmpegArgs('rtsp://camera.internal/stream', {
      ffmpegPath: 'ffmpeg',
      transport: 'udp',
      width: 1280,
    });
    expect(args).toEqual(expect.arrayContaining([
      '-rtsp_transport', 'udp',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-analyzeduration', '0',
      '-probesize', '32',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-bf', '0',
      '-f', 'mpegts',
      'pipe:1',
    ]));
    expect(args).toContain('-vf');
    expect(args).toContain('scale=1280:-2');
    expect(args).not.toContain('-frames:v');
    expect(args).not.toContain('image2');
  });
});
