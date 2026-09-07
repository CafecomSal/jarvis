import { describe, expect, it, vi } from 'vitest';
import { JarvisApiClient } from '../web/src/api/client.js';

describe('cliente web de áudio', () => {
  it('envia Blob como base64 para o endpoint PC', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ session: { id: 'audio-1' }, conversation: { answer: 'ok' }, audio: { audioBase64: 'd2F2', mimeType: 'audio/wav' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new JarvisApiClient({ fetchImpl });

    const result = await client.postPcAudio(new Blob([new Uint8Array([119, 97, 118])], { type: 'audio/wav' }));

    expect(result.conversation.answer).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledWith('/audio/pc', expect.objectContaining({ method: 'POST' }));
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ mimeType: 'audio/wav', audioBase64: 'd2F2' });
  });

  it('mantém o request de áudio aberto além do timeout curto das APIs comuns', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
      }));
      const client = new JarvisApiClient({ fetchImpl, timeoutMs: 30_000 });
      const request = client.postPcAudio(new Blob([new Uint8Array([119, 97, 118])], { type: 'audio/wav' }));
      const settled = request.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(150_000);
      expect(aborted).toBe(true);
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toMatchObject({ message: 'Jarvis API timeout after 180000ms' });
    } finally {
      vi.useRealTimers();
    }
  });
});