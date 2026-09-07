import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import type { CameraAdapter } from '../src/cameras/camera-adapter.js';

describe('API de câmera ao vivo', () => {
  it('entrega um stream MJPEG e encerra quando o cliente fecha', async () => {
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let snapshots = 0;
    const camera: CameraAdapter = {
      snapshot: async (name) => {
        snapshots += 1;
        return {
          camera: name,
          capturedAt: '2026-09-05T17:30:00.000Z',
          mimeType: 'image/jpeg',
          bytes: frame.length,
          base64: frame.toString('base64'),
        };
      },
    };
    const app = buildApp({ camera });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/cameras/front/live`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('multipart/x-mixed-replace');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      const payload = Buffer.from(first.value ?? []).toString('latin1');
      expect(payload).toContain('--jarvis-live-frame');
      expect(payload).toContain('Content-Type: image/jpeg');
      expect(snapshots).toBeGreaterThanOrEqual(1);
      await reader!.cancel();
    } finally {
      await app.close();
    }
  });
});
