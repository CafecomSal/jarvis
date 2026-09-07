import { describe, expect, it } from 'vitest';
import { parseRecordingOptions } from '../src/recordings/run-recording.js';

describe('CLI de gravação DVR', () => {
  it('usa um segmento curto e armazenamento local por padrão', () => {
    expect(parseRecordingOptions(['--once'], {})).toEqual({
      camera: 'front',
      durationMs: 10_000,
      outputDirectory: 'data/recordings',
      rtspTransport: 'udp',
      videoFps: 5,
      videoPreset: 'ultrafast',
      retryDelayMs: 5_000,
      once: true,
      continuous: false,
    });
  });

  it('permite ajustar duração, caminho e codec sem aceitar argumentos desconhecidos', () => {
    expect(parseRecordingOptions(['--once'], {
      JARVIS_RECORDING_DURATION_MS: '30000',
      JARVIS_RECORDING_OUTPUT_DIR: 'archive/recordings',
      JARVIS_RECORDING_VIDEO_FPS: '2',
      JARVIS_RECORDING_VIDEO_PRESET: 'veryfast',
      JARVIS_RECORDING_RETRY_DELAY_MS: '1500',
    })).toMatchObject({
      durationMs: 30_000,
      outputDirectory: 'archive/recordings',
      videoFps: 2,
      videoPreset: 'veryfast',
      retryDelayMs: 1_500,
      once: true,
      continuous: false,
    });
    expect(parseRecordingOptions(['--continuous'], {})).toMatchObject({
      once: false,
      continuous: true,
    });
    expect(() => parseRecordingOptions([], {})).toThrow('Recording CLI requires --once');
    expect(() => parseRecordingOptions(['--once', '--bad'], {})).toThrow(
      'Unknown recording argument: --bad',
    );
  });
});
