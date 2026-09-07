import { describe, expect, it } from 'vitest';
import { cameraFramePresentation, cameraLiveState } from '../web/src/app-model.js';

describe('estado da prévia ao vivo', () => {
  it('não abre MJPEG enquanto o health está consultando', () => {
    expect(cameraLiveState('consultando', false)).toBe('loading');
    expect(cameraLiveState('ok', false)).toBe('ready');
    expect(cameraLiveState('timeout', false)).toBe('unavailable');
    expect(cameraLiveState('ok', true)).toBe('unavailable');
  });

  it('preserva o mosaico vertical completo do RTSP em vez de cortar o enquadramento', () => {
    expect(cameraFramePresentation(1920, 2160)).toEqual({ objectFit: 'contain', aspectRatio: '1920 / 2160' });
    expect(cameraFramePresentation()).toEqual({ objectFit: 'contain' });
  });
});
