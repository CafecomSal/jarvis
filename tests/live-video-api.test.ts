import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('API de vídeo ao vivo', () => {
  it('declara indisponibilidade sem RTSP em vez de simular um stream', async () => {
    const app = buildApp({ cameraStreams: {} });
    try {
      const response = await app.inject({ method: 'GET', url: '/cameras/front/live-video' });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ error: 'camera_live_video_unavailable' });
    } finally {
      await app.close();
    }
  });
});
