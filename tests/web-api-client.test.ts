import { describe, expect, it, vi } from 'vitest';
import { JarvisApiClient } from '../web/src/api/client.js';

describe('JarvisApiClient', () => {
  it('consulta JSON com erro HTTP explícito', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ status: 'ok' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new JarvisApiClient({ baseUrl: 'http://localhost:3000', fetchImpl });

    await expect(client.getHealth()).resolves.toMatchObject({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3000/system/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('normaliza falha de API sem vazar o corpo inteiro', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ secret: 'hidden', error: 'offline' }),
      { status: 503 },
    ));
    const client = new JarvisApiClient({ fetchImpl });

    await expect(client.getHealth()).rejects.toThrow('Jarvis API HTTP 503');
    await expect(client.getHealth()).rejects.not.toThrow('hidden');
  });
});
