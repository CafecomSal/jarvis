import { describe, expect, it, vi } from 'vitest';
import { AzureTtsProvider } from '../src/audio/providers/azure-tts.js';

describe('Azure TTS opcional', () => {
  it('envia SSML PT-BR e retorna áudio sem imprimir resposta externa', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('mp3', { status: 200 }));
    const provider = new AzureTtsProvider({ key: 'azure-key', region: 'brazilsouth', fetchImpl });
    const result = await provider.synthesize({ text: 'Olá & teste', language: 'pt-BR' });

    expect(result).toMatchObject({ provider: 'azure-speech', model: 'pt-BR-FranciscaNeural', mimeType: 'audio/mpeg' });
    expect(result.audio.toString()).toBe('mp3');
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ 'Ocp-Apim-Subscription-Key': 'azure-key', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3' });
    expect(String(request?.body)).toContain('&amp;');
  });

  it('não aceita key/region vazios nem resposta HTTP ruim', async () => {
    expect(() => new AzureTtsProvider({ key: '', region: 'br' })).toThrow('Azure key must not be empty');
    expect(() => new AzureTtsProvider({ key: 'x', region: '' })).toThrow('Azure region must not be empty');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ignored', { status: 429 }));
    const provider = new AzureTtsProvider({ key: 'x', region: 'br', fetchImpl });
    await expect(provider.synthesize({ text: 'teste' })).rejects.toThrow('Azure TTS failed with HTTP 429');
  });
});
