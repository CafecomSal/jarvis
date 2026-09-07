import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import { WorldStateProjection } from '../src/state/world-state.js';
import { ConfirmedPersonNotifier } from '../src/notifications/person-notification.js';
import type { ModelGateway, ModelRequest, ModelResponse } from '../src/llm/model-gateway.js';

class GroundedFakeGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) => message.role === 'tool');

    if (!hasToolResult) {
      return {
        toolCalls: [{ id: 'call-home-state', name: 'get_home_state', arguments: {} }],
      };
    }

    const toolMessage = request.messages.findLast((message) => message.role === 'tool');
    return {
      content: `Estado consultado: ${toolMessage?.content ?? 'indisponível'}`,
    };
  }
}

class OverconfidentFakeGateway implements ModelGateway {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{ id: 'call-home-state', name: 'get_home_state', arguments: {} }],
      };
    }

    return {
      content: 'Com base no estado atual, não há ninguém no quintal.',
    };
  }
}

describe('Jarvis Core v0.1', () => {
  it('expõe uma rota inicial com os endpoints disponíveis', async () => {
    const app = buildApp({
      gateway: new GroundedFakeGateway(),
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Jarvis Core',
      version: '0.1.0',
      endpoints: {
        health: 'GET /health',
        conversation: 'POST /conversation',
        events: 'GET|POST /events',
      },
    });
  });

  it('projeta a última detecção de pessoa no estado atual', async () => {
    const events = new InMemoryEventStore();
    const worldState = new WorldStateProjection();

    await events.append({
      id: 'evt-001',
      type: 'person.detected',
      timestamp: '2026-08-25T19:12:31-03:00',
      source: { type: 'test', id: 'fixture' },
      location: 'quintal',
      subject: { type: 'person', id: 'davi' },
      confidence: 0.94,
      data: {},
    });
    worldState.apply((await events.list())[0]);

    expect(worldState.snapshot().people.davi).toMatchObject({
      presence: 'home',
      location: 'quintal',
      confidence: 0.94,
    });
  });

  it('não inventa pessoas quando não existe evidência no estado', () => {
    const worldState = new WorldStateProjection();

    expect(worldState.snapshot().people).toEqual({});
  });

  it('não transforma ausência de evidência em ausência de pessoa', async () => {
    const app = buildApp({
      gateway: new OverconfidentFakeGateway(),
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'Tem alguém no quintal agora?' },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.answer.toLowerCase()).toContain('não é possível confirmar');
    expect(body.answer.toLowerCase()).not.toContain('não há ninguém no quintal');
  });

  it('consulta uma tool antes de responder sobre o estado da casa', async () => {
    const gateway = new GroundedFakeGateway();
    const app = buildApp({
      gateway,
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'Tem alguém no quintal?' },
    });

    expect(response.statusCode).toBe(200);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0].tools?.map((tool) => tool.name)).toContain('get_home_state');
    expect(response.json()).toMatchObject({
      answer: expect.stringContaining('presença em tempo real'),
      toolCalls: [{ name: 'get_home_state' }],
    });
  });

  it('busca eventos por termos relevantes de uma consulta natural', async () => {
    const events = new InMemoryEventStore();
    await events.append({
      id: 'evt-search-001',
      type: 'person.detected',
      timestamp: '2026-08-25T19:12:31-03:00',
      source: { type: 'camera', id: 'front' },
      location: 'frente',
      subject: { type: 'person', id: 'unknown-01' },
      confidence: 0.81,
      data: {},
    });

    await expect(events.search('frente de casa')).resolves.toHaveLength(1);
  });

  it('não duplica o mesmo evento quando o detector repete o POST', async () => {
    const events = new InMemoryEventStore();
    const worldState = new WorldStateProjection();
    const app = buildApp({
      gateway: new GroundedFakeGateway(),
      events,
      worldState,
    });
    const payload = {
      id: 'evt-idempotent-detector',
      type: 'person.detected' as const,
      timestamp: '2026-08-29T23:00:00-03:00',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'person', id: 'unknown' },
      confidence: 0.9,
      data: { camera: 'front' },
    };

    const first = await app.inject({ method: 'POST', url: '/events', payload });
    const second = await app.inject({ method: 'POST', url: '/events', payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(await events.list()).toHaveLength(1);
    expect(worldState.snapshot().people.unknown).toMatchObject({
      presence: 'home',
      location: 'frente',
      confidence: 0.9,
    });
  });

  it('aceita eventos estruturados e os torna consultáveis pelo estado', async () => {
    const gateway = new GroundedFakeGateway();
    const events = new InMemoryEventStore();
    const worldState = new WorldStateProjection();
    const app = buildApp({ gateway, events, worldState });

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        id: 'evt-002',
        type: 'person.detected',
        timestamp: '2026-08-25T19:20:00-03:00',
        source: { type: 'camera', id: 'front' },
        location: 'frente',
        subject: { type: 'person', id: 'unknown-01' },
        confidence: 0.81,
        data: { clothing: ['camisa vermelha'] },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(worldState.snapshot().people['unknown-01']).toMatchObject({
      location: 'frente',
      presence: 'home',
    });
  });

  it('notifica uma única vez uma pessoa ONNX confirmada após persistir o evento', async () => {
    const events = new InMemoryEventStore();
    const worldState = new WorldStateProjection();
    const notified: string[] = [];
    const personNotifier = new ConfirmedPersonNotifier({
      sink: {
        notify: async (event) => {
          notified.push(event.id);
        },
      },
    });
    const app = buildApp({
      gateway: new GroundedFakeGateway(),
      events,
      worldState,
      personNotifier,
    });
    const payload = {
      id: 'evt-notify-confirmed',
      type: 'person.detected' as const,
      timestamp: '2026-09-01T22:00:00-03:00',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'person', id: 'unknown' },
      confidence: 0.87,
      data: { camera: 'front', confirmed: true },
    };

    const first = await app.inject({ method: 'POST', url: '/events', payload });
    const second = await app.inject({ method: 'POST', url: '/events', payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(notified).toEqual(['evt-notify-confirmed']);
  });
});
