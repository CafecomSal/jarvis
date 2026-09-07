import { describe, expect, it, vi } from 'vitest';
import { JarvisApiClient } from '../web/src/api/client.js';

describe('cliente web de settings e retenção', () => {
  it('consulta e atualiza settings pelo endpoint redigido', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ source: 'database', settings: {}, cloud: { groq: { configured: false } } }), { status: 200 });
    });
    const client = new JarvisApiClient({ baseUrl: 'http://jarvis', fetchImpl });

    await client.getSettings();
    await client.updateSettings({ stt: { route: 'local' } }, false);

    expect(calls[0]?.url).toBe('http://jarvis/settings');
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ stt: { route: 'local' }, confirmCloudBoundary: false });
  });

  it('envia preview e exclusão com confirmação explícita', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ previewId: 'preview-1', count: 2 }), { status: 200 });
    });
    const client = new JarvisApiClient({ baseUrl: 'http://jarvis', fetchImpl });

    await client.previewAudioSessionDeletion({ before: '2026-09-01T00:00:00.000Z', statuses: ['completed', 'failed'] });
    await client.deleteAudioSessions('preview-1', 'APAGAR SESSÕES');

    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ previewId: 'preview-1', confirmation: 'APAGAR SESSÕES' });
  });
});
