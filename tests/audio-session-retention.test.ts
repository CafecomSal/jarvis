import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore } from '../src/audit/in-memory-audit-store.js';
import { InMemoryAudioSessionStore } from '../src/audio/audio-session-store.js';
import { AudioSessionRetentionService } from '../src/audio/audio-session-retention.js';

const oldDate = '2026-08-01T03:00:00.000Z';

async function seed() {
  const sessions = new InMemoryAudioSessionStore();
  const audit = new InMemoryAuditStore();
  await sessions.append({
    id: 'old-completed', source: 'pc', status: 'completed', startedAt: oldDate,
    endedAt: '2026-08-01T03:00:02.000Z', conversationId: 'conv-old',
    transcript: { text: 'segredo do transcript', provider: 'fixture', model: 'fixture', latencyMs: 10 },
    responseText: 'resposta sensível',
  });
  await sessions.append({ id: 'old-failed', source: 'pc', status: 'failed', startedAt: oldDate, endedAt: oldDate, error: 'falha' });
  await sessions.append({ id: 'old-active', source: 'pc', status: 'transcribing', startedAt: oldDate });
  await sessions.append({ id: 'recent', source: 'pc', status: 'completed', startedAt: '2026-09-05T03:00:00.000Z' });
  await audit.append({
    id: 'audit-conv-old', timestamp: oldDate, conversationId: 'conv-old', kind: 'conversation', action: 'received', actor: 'user',
    data: { message: 'conteúdo privado' },
  });
  return { sessions, audit };
}

describe('retenção de sessões de áudio', () => {
  it('gera preview somente para sessões antigas e statuses deletáveis', async () => {
    const { sessions, audit } = await seed();
    const service = new AudioSessionRetentionService(sessions, audit, { now: () => new Date('2026-09-06T00:00:00.000Z') });

    const preview = await service.preview({ before: '2026-09-01T00:00:00.000Z' });

    expect(preview).toMatchObject({ count: 2, byStatus: { completed: 1, failed: 1 } });
    expect(preview.sessions.map((session) => session.id)).toEqual(['old-completed', 'old-failed']);
    expect(JSON.stringify(preview)).not.toContain('segredo');
    expect(JSON.stringify(preview)).not.toContain('resposta');
  });

  it('exige confirmação, apaga sessões e redige conteúdo auditado vinculado', async () => {
    const { sessions, audit } = await seed();
    const service = new AudioSessionRetentionService(sessions, audit, { now: () => new Date('2026-09-06T00:00:00.000Z') });
    const preview = await service.preview({ before: '2026-09-01T00:00:00.000Z' });

    await expect(service.execute(preview.previewId, 'wrong')).rejects.toThrow('confirmation');
    const result = await service.execute(preview.previewId, 'APAGAR 2 SESSÕES');
    const remaining = await sessions.list({ limit: 100 });
    const audited = await audit.forConversation('conv-old');
    const tombstones = await audit.list();

    expect(result).toMatchObject({ deletedCount: 2, redactedConversationCount: 1 });
    expect(remaining.map((session) => session.id)).not.toContain('old-completed');
    expect(remaining.map((session) => session.id)).not.toContain('old-failed');
    expect(remaining.map((session) => session.id)).toContain('old-active');
    expect(audited[0]?.data).toMatchObject({ redacted: true, reason: 'audio-session-purge' });
    expect(JSON.stringify(tombstones)).not.toContain('conteúdo privado');
    expect(tombstones.some((entry) => entry.action === 'audio_session.purge')).toBe(true);
    await expect(service.execute(preview.previewId, 'APAGAR 2 SESSÕES')).rejects.toThrow('already used');
  });

  it('revalida o status no momento da exclusão e não remove sessão que ficou ativa', async () => {
    const { sessions, audit } = await seed();
    const service = new AudioSessionRetentionService(sessions, audit, { now: () => new Date('2026-09-06T00:00:00.000Z') });
    const preview = await service.preview({ before: '2026-09-01T00:00:00.000Z' });
    await sessions.deleteByIds(['old-completed']);
    await sessions.append({ id: 'old-completed', source: 'pc', status: 'transcribing', startedAt: oldDate });

    const result = await service.execute(preview.previewId, 'APAGAR 2 SESSÕES');

    expect(result.deletedCount).toBe(1);
    expect((await sessions.findById('old-completed'))?.status).toBe('transcribing');
    expect(result.redactedConversationCount).toBe(0);
  });
});