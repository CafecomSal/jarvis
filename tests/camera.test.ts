import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import type { CameraAdapter, CameraSnapshot } from '../src/cameras/camera-adapter.js';
import { AgentDvrCameraAdapter } from '../src/cameras/agent-dvr-camera.js';
import { LocalSnapshotStore } from '../src/cameras/local-snapshot-store.js';
import { InMemoryEventStore } from '../src/events/in-memory-event-store.js';
import type { ModelGateway, ModelRequest, ModelResponse } from '../src/llm/model-gateway.js';
import { WorldStateProjection } from '../src/state/world-state.js';

class FakeCamera implements CameraAdapter {
  readonly calls: string[] = [];

  async snapshot(camera: string): Promise<CameraSnapshot> {
    this.calls.push(camera);
    return {
      camera,
      oid: 1,
      capturedAt: '2026-08-25T19:30:00.000Z',
      mimeType: 'image/jpeg',
      bytes: 3,
      base64: 'AQID',
    };
  }
}

class VisionFakeGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{
          id: 'call-camera',
          name: 'get_camera_snapshot',
          arguments: { camera: 'front' },
        }],
      };
    }

    const toolMessage = request.messages.findLast((message) => message.role === 'tool');
    return {
      content: toolMessage?.images?.length
        ? 'Imagem recebida para análise.'
        : 'Imagem ausente.',
    };
  }
}

class OverconfidentVisionGateway implements ModelGateway {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{
          id: 'call-camera',
          name: 'get_camera_snapshot',
          arguments: { camera: 'front' },
        }],
      };
    }

    return { content: 'A câmera confirma que há uma pessoa no local.' };
  }
}

class FailingCamera implements CameraAdapter {
  async snapshot(): Promise<CameraSnapshot> {
    throw new Error('Agent DVR indisponível');
  }
}

describe('integração de câmera', () => {
  it('busca um frame JPEG pela API local do Agent DVR', async () => {
    const calls: string[] = [];
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    };
    const camera = new AgentDvrCameraAdapter({
      baseUrl: 'http://127.0.0.1:8090',
      cameras: { front: 1 },
      fetchImpl,
    });

    const snapshot = await camera.snapshot('front');

    expect(calls).toEqual(['http://127.0.0.1:8090/liveimage.jpg?oid=1']);
    expect(snapshot).toMatchObject({
      camera: 'front',
      oid: 1,
      mimeType: 'image/jpeg',
      bytes: 4,
      base64: Buffer.from(bytes).toString('base64'),
    });
  });

  it('salva o JPEG em uma referência local sem depender do base64 no banco', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-snapshot-'));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

    try {
      const store = new LocalSnapshotStore(directory);
      const reference = await store.save({
        camera: 'front',
        oid: 1,
        capturedAt: '2026-08-25T19:30:00.000Z',
        mimeType: 'image/jpeg',
        bytes: bytes.length,
        base64: Buffer.from(bytes).toString('base64'),
      });
      const stored = await readFile(join(directory, reference));

      expect(reference).toMatch(/^front\//);
      expect(stored).toEqual(Buffer.from(bytes));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('configura o health check padrão pela origem RTSP direta', async () => {
    const calls: Array<{ url: string; transport: string }> = [];
    const app = buildApp({
      cameraStreams: { front: 'rtsp://camera.local:554/onvif1' },
      rtspCaptureFrame: async (url, options) => {
        calls.push({ url, transport: options.transport });
        return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      },
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({ method: 'GET', url: '/cameras/front/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      camera: 'front',
      sourceType: 'rtsp',
      sourceId: 'front',
      status: 'ok',
    });
    expect(calls).toEqual([{
      url: 'rtsp://camera.local:554/onvif1',
      transport: 'udp',
    }]);
  });

  it('registra captura RTSP na tool visual sem inventar OID', async () => {
    const camera: CameraAdapter = {
      snapshot: async (cameraName) => ({
        camera: cameraName,
        sourceType: 'rtsp',
        sourceId: cameraName,
        capturedAt: '2026-08-25T19:30:00.000Z',
        mimeType: 'image/jpeg',
        bytes: 3,
        base64: 'AQID',
      }),
    };
    const events = new InMemoryEventStore();
    const app = buildApp({
      gateway: new VisionFakeGateway(),
      camera,
      events,
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'O que há na rua?' },
    });
    const snapshotEvent = (await events.list()).find((event) => event.type === 'camera.snapshot');

    expect(response.statusCode).toBe(200);
    expect(snapshotEvent).toMatchObject({
      source: { type: 'rtsp', id: 'front' },
      data: { sourceType: 'rtsp', sourceId: 'front' },
    });
    expect(snapshotEvent?.data).not.toHaveProperty('oid');
  });

  it('anexa o frame da câmera à mensagem enviada ao VLM sem expor base64 na resposta', async () => {
    const camera = new FakeCamera();
    const gateway = new VisionFakeGateway();
    const events = new InMemoryEventStore();
    const app = buildApp({
      gateway,
      camera,
      events,
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'O que está acontecendo na frente de casa?' },
    });
    const body = response.json();
    const toolMessage = gateway.requests[1].messages.find((message) => message.role === 'tool');
    const storedEvents = await events.list();
    const snapshotEvent = storedEvents.find((event) => event.type === 'camera.snapshot');
    const observationEvent = storedEvents.find((event) => event.type === 'vision.observation');

    expect(response.statusCode).toBe(200);
    expect(camera.calls).toEqual(['front']);
    expect(toolMessage).toMatchObject({ images: ['AQID'] });
    expect(body.answer).toBe('Imagem recebida para análise.');
    expect(JSON.stringify(body)).not.toContain('AQID');
    expect(body.toolCalls[0].result).not.toHaveProperty('base64');
    expect(snapshotEvent).toMatchObject({
      location: 'frente',
      data: { location: 'frente' },
    });
    expect(observationEvent).toMatchObject({
      location: 'frente',
      data: {
        evidenceEventId: snapshotEvent?.id,
        interpretation: 'Imagem recebida para análise.',
      },
    });
  });

  it('não trata falha da câmera como evidência ao vivo', async () => {
    const app = buildApp({
      gateway: new OverconfidentVisionGateway(),
      camera: new FailingCamera(),
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'Tem alguém na frente agora?' },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.answer.toLowerCase()).toContain('não é possível confirmar');
  });

  it('repete uma falha transitória uma vez e retorna a captura quando recupera', async () => {
    let attempts = 0;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    };
    const camera = new AgentDvrCameraAdapter({
      baseUrl: 'http://127.0.0.1:8090',
      cameras: { front: 1 },
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(camera.snapshot('front')).resolves.toMatchObject({ bytes: 4 });
    expect(attempts).toBe(2);
  });

  it('classifica HTTP 404 como câmera inexistente sem repetir a consulta', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      return new Response('not found', { status: 404 });
    };
    const camera = new AgentDvrCameraAdapter({
      baseUrl: 'http://127.0.0.1:8090',
      cameras: { front: 99 },
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(camera.health('front')).resolves.toMatchObject({
      camera: 'front',
      oid: 99,
      status: 'camera_not_found',
    });
    expect(attempts).toBe(1);
  });

  it('classifica content type inválido como resposta inesperada', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const camera = new AgentDvrCameraAdapter({
      baseUrl: 'http://127.0.0.1:8090',
      cameras: { front: 1 },
      fetchImpl,
      maxAttempts: 2,
      retryDelayMs: 0,
    });

    await expect(camera.health('front')).resolves.toMatchObject({
      status: 'unexpected_response',
    });
  });

  it('classifica timeout sem transformar a falha em imagem válida', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    });
    const camera = new AgentDvrCameraAdapter({
      baseUrl: 'http://127.0.0.1:8090',
      cameras: { front: 1 },
      fetchImpl,
      maxAttempts: 1,
      timeoutMs: 1,
    });

    await expect(camera.health('front')).resolves.toMatchObject({
      status: 'timeout',
    });
  });

  it('expõe o diagnóstico classificado da câmera em endpoint local', async () => {
    const camera = new AgentDvrCameraAdapter({
      baseUrl: 'http://127.0.0.1:8090',
      cameras: { front: 1 },
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    const app = buildApp({
      gateway: new VisionFakeGateway(),
      camera,
      events: new InMemoryEventStore(),
      worldState: new WorldStateProjection(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/cameras/front/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      camera: 'front',
      oid: 1,
      status: 'camera_not_found',
    });
  });
});
