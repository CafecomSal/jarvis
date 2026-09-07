import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { CameraAdapter } from '../src/cameras/camera-adapter.js';

const camera: CameraAdapter = {
  snapshot: async (name) => ({
    camera: name,
    capturedAt: '2026-09-05T03:50:00.000Z',
    mimeType: 'image/jpeg',
    bytes: 10,
    base64: Buffer.from('jpeg-bytes').toString('base64'),
  }),
};

describe('prévia econômica de câmera', () => {
  it('serve o JPEG atual sem retornar metadata ou base64', async () => {
    const app = buildApp({ camera });
    const response = await app.inject({ method: 'GET', url: '/cameras/front/preview' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.body).toBe('jpeg-bytes');
  });

  it('retorna 501 quando não há câmera configurada', async () => {
    const app = buildApp({ cameraStreams: {} });
    const response = await app.inject({ method: 'GET', url: '/cameras/front/preview' });
    await app.close();
    expect(response.statusCode).toBe(501);
  });
});
