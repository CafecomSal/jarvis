import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantAlexaOutput } from '../src/audio/outputs/home-assistant-alexa.js';

describe('saída Alexa via Home Assistant', () => {
  it('envia texto para notify.send_message sem vazar token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]', { status: 200 }));
    const output = new HomeAssistantAlexaOutput({
      baseUrl: 'https://ha.example.local',
      token: 'secret-token-value',
      entityId: 'notify.echo_sala_speak',
      fetchImpl,
    });

    const result = await output.speak('Cheguei ao fim do teste.', 'speak');

    expect(result).toMatchObject({ target: 'alexa', entityId: 'notify.echo_sala_speak' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ha.example.local/api/services/notify/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token-value' }),
        body: JSON.stringify({ entity_id: 'notify.echo_sala_speak', message: 'Cheguei ao fim do teste.' }),
      }),
    );
  });

  it('rejeita destino que não seja notify e resposta HTTP de erro', async () => {
    expect(() => new HomeAssistantAlexaOutput({ baseUrl: 'http://ha', token: 'x', entityId: 'media_player.echo' })).toThrow('Alexa entityId must be a notify entity');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-error', { status: 500 }));
    const output = new HomeAssistantAlexaOutput({ baseUrl: 'http://ha', token: 'x', entityId: 'notify.echo', fetchImpl });
    await expect(output.speak('teste')).rejects.toThrow('Home Assistant Alexa output failed with HTTP 500');
  });
});
