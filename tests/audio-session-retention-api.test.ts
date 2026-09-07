import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore } from '../src/audit/in-memory-audit-store.js';
import { InMemoryAudioSessionStore } from '../src/audio/audio-session-store.js';
import { buildApp } from '../src/app.js';
import { AudioSessionRetentionService } from '../src/audio/audio-session-retention.js';

async function createApp() {
  const audioSessions = new InMemoryAudioSessionStore();
  const audit = new InMemoryAuditStore();
  await audioSessions.append({
    id: 'route-old', source: 'pc', status: 'completed', startedAt: '2026-08-01T03:00:00.000Z',
    conversationId: 'route-conv', transcript: { text: 'private', provider: 'fixture', model: 'fixture', latencyMs: 1 },
  });
  await audit.append({
    id: 'route-audit', timestamp: '2026-08-01T03:00:00.000Z', conversationId: 'route-conv',
    kind: 'conversation', action: 'received', actor: 'user', data: { message: 'private' },
  });
  const retention = new AudioSessionRetentionService(audioSessions, audit, { now: () => new Date('2026-09-06T00:00:00.000Z') });
  const app = buildApp({ audioSessions, audit, audioSessionRetention: retention });
  return { app, audioSessions, audit };
}

describe('API de limpeza de sessões de áudio', () => {
  it('faz preview e só executa com confirmação exata', async () => {
    const { app } = await createApp();
    const preview = await app.inject({
      method: 'POST', url: '/audio/sessions/delete-preview',
      payload: { before: '2026-09-01T00:00:00.000Z' },
    });
    const noConfirmation = await app.inject({
      method: 'DELETE', url: '/audio/sessions',
      payload: { previewId: preview.json().previewId, confirmation: 'wrong' },
    });
    const deleted = await app.inject({
      method: 'DELETE', url: '/audio/sessions',
      payload: { previewId: preview.json().previewId, confirmation: 'APAGAR 1 SESSÃO' },
    });
    await app.close();

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ count: 1 });
    expect(noConfirmation.statusCode).toBe(400);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ deletedCount: 1, redactedConversationCount: 1 });
    expect(deleted.body).not.toContain('private');
  });

  it('retorna 501 sem store/serviço e 400 para filtro inválido', async () => {
    const unavailable = buildApp();
    const noStore = await unavailable.inject({ method: 'POST', url: '/audio/sessions/delete-preview', payload: { before: '2026-09-01T00:00:00.000Z' } });
    await unavailable.close();
    const { app } = await createApp();
    const invalid = await app.inject({ method: 'POST', url: '/audio/sessions/delete-preview', payload: { before: 'not-a-date' } });
    await app.close();

    expect(noStore.statusCode).toBe(501);
    expect(invalid.statusCode).toBe(400);
  });
});
