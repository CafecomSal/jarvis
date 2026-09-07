import { describe, expect, it, vi } from 'vitest';
import { JarvisApiClient } from '../web/src/api/client.js';

describe('cliente web de propostas', () => {
  it('consulta apenas propostas de ação', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ count: 0, proposals: [] }), { status: 200 }));
    const client = new JarvisApiClient({ fetchImpl });

    expect(await client.getActionProposals()).toEqual({ count: 0, proposals: [] });
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe('/actions/proposals');
  });
});
