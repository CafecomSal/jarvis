import { describe, expect, it } from 'vitest';
import { HttpEventPublisher } from '../src/events/http-event-publisher.js';

const event = {
  id: 'evt-http-publisher-001',
  type: 'person.detected' as const,
  timestamp: '2026-08-29T23:00:00-03:00',
  source: { type: 'onnx', id: 'yolo11n.onnx' },
  location: 'frente',
  subject: { type: 'person', id: 'unknown' },
  confidence: 0.91,
  data: { camera: 'front', evidenceEventId: 'evt-evidence-001' },
};

describe('publicador de eventos do detector para o Core', () => {
  it('envia o evento ao endpoint do Core e retorna o evento validado', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const publisher = new HttpEventPublisher({
      baseUrl: 'http://127.0.0.1:3000/',
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: String(init?.method),
          body: String(init?.body),
        });
        return new Response(JSON.stringify(event), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(publisher.append(event)).resolves.toEqual(event);
    expect(calls).toEqual([{
      url: 'http://127.0.0.1:3000/events',
      method: 'POST',
      body: JSON.stringify(event),
    }]);
  });

  it('repete a mesma carga após falha transitória para preservar idempotência', async () => {
    let attempts = 0;
    const bodies: string[] = [];
    const publisher = new HttpEventPublisher({
      baseUrl: 'http://127.0.0.1:3000',
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async (_input, init) => {
        attempts += 1;
        bodies.push(String(init?.body));
        if (attempts === 1) throw new Error('connection reset');
        return new Response(JSON.stringify(event), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(publisher.append(event)).resolves.toEqual(event);
    expect(attempts).toBe(2);
    expect(bodies).toEqual([JSON.stringify(event), JSON.stringify(event)]);
  });

  it('não expõe o corpo da resposta em erro HTTP', async () => {
    const publisher = new HttpEventPublisher({
      fetchImpl: async () => new Response('senha-secreta-no-corpo', { status: 500 }),
      maxAttempts: 1,
    });

    await expect(publisher.append(event)).rejects.toThrow('Core event publish failed with HTTP 500');
    await expect(publisher.append(event)).rejects.not.toThrow('senha-secreta');
  });
});
