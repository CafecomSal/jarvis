import { describe, expect, it, vi } from 'vitest';
import { JarvisApiClient } from '../web/src/api/client.js';

describe('cliente web de câmera', () => {
  it('consulta health da câmera por ID', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ camera: 'front', status: 'timeout' }), { status: 200 }));
    const client = new JarvisApiClient({ fetchImpl });

    expect(await client.getCameraHealth('front')).toEqual({ camera: 'front', status: 'timeout' });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/cameras/front/health');
  });

  it('mantém a URL MJPEG legada sem expor o RTSP', () => {
    const client = new JarvisApiClient();
    expect(client.getCameraLiveUrl('front door')).toBe('/cameras/front%20door/live');
  });

  it('retorna a URL do stream de vídeo contínuo sem expor o RTSP', () => {
    const client = new JarvisApiClient();
    expect(client.getCameraLiveVideoUrl('front door')).toBe('/cameras/front%20door/live-video');
  });
});
