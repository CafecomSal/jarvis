import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../src/cameras/camera-adapter.js';
import { RtspCameraAdapter } from '../src/cameras/rtsp-camera.js';

const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('integração de câmera via RTSP direto', () => {
  it('captura um JPEG pelo stream RTSP usando UDP por padrão', async () => {
    const calls: Array<{ url: string; transport: string; timeoutMs: number }> = [];
    const camera = new RtspCameraAdapter({
      streams: { front: 'rtsp://camera.local:554/onvif1' },
      captureFrame: async (url, options) => {
        calls.push({ url, transport: options.transport, timeoutMs: options.timeoutMs });
        return frame;
      },
    });

    const snapshot = await camera.snapshot('front');

    expect(calls).toEqual([{
      url: 'rtsp://camera.local:554/onvif1',
      transport: 'udp',
      timeoutMs: 10_000,
    }]);
    expect(snapshot).toMatchObject({
      camera: 'front',
      sourceType: 'rtsp',
      sourceId: 'front',
      mimeType: 'image/jpeg',
      bytes: frame.length,
      base64: frame.toString('base64'),
    });
    expect((snapshot as CameraSnapshot).oid).toBeUndefined();
  });

  it('faz health check sem salvar o JPEG localmente', async () => {
    let captures = 0;
    let saves = 0;
    const camera = new RtspCameraAdapter({
      streams: { front: 'rtsp://camera.local:554/onvif1' },
      captureFrame: async () => {
        captures += 1;
        return frame;
      },
      snapshotStore: {
        save: async () => {
          saves += 1;
          return 'front/should-not-exist.jpg';
        },
      },
    });

    await expect(camera.health('front')).resolves.toMatchObject({
      camera: 'front',
      sourceType: 'rtsp',
      sourceId: 'front',
      status: 'ok',
    });
    expect(captures).toBe(1);
    expect(saves).toBe(0);
  });

  it('classifica câmera não configurada sem tentar abrir um stream', async () => {
    let captures = 0;
    const camera = new RtspCameraAdapter({
      streams: { front: 'rtsp://camera.local:554/onvif1' },
      captureFrame: async () => {
        captures += 1;
        return frame;
      },
    });

    await expect(camera.health('side')).resolves.toMatchObject({
      camera: 'side',
      status: 'camera_not_found',
    });
    expect(captures).toBe(0);
  });

  it('repete falha transitória uma vez e não inclui a URL nos erros', async () => {
    let attempts = 0;
    const secretUrl = 'rtsp://user:secret@camera.local:554/onvif1';
    const camera = new RtspCameraAdapter({
      streams: { front: secretUrl },
      maxAttempts: 2,
      retryDelayMs: 0,
      captureFrame: async () => {
        attempts += 1;
        throw new Error('connection reset');
      },
    });

    await expect(camera.snapshot('front')).rejects.toMatchObject({ code: 'rtsp_unavailable' });
    await expect(camera.snapshot('front')).rejects.toThrow('RTSP camera request failed');
    try {
      await camera.snapshot('front');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain(secretUrl);
    }
    expect(attempts).toBe(6);
  });
});
