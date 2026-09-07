import { describe, expect, it, vi } from 'vitest';
import { AudioSessionRetentionScheduler } from '../src/audio/audio-session-retention-scheduler.js';

const disabled = {
  autoDeleteEnabled: false,
  retentionDays: 30,
  deletableStatuses: ['completed', 'failed'] as Array<'completed' | 'failed'>,
};
const enabled = { ...disabled, autoDeleteEnabled: true };

describe('scheduler de retenção de sessões de áudio', () => {
  it('não executa nada quando auto-delete está desligado', async () => {
    const preview = vi.fn();
    const execute = vi.fn();
    const scheduler = new AudioSessionRetentionScheduler({ preview, execute }, async () => disabled, { now: () => new Date('2026-09-06T00:00:00.000Z') });

    await scheduler.runOnce();

    expect(preview).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('calcula idade, faz preview e executa somente após encontrar candidatos', async () => {
    const preview = vi.fn(async (filter: { before: string }) => ({
      previewId: 'preview-1', expiresAt: 'later', before: filter.before,
      statuses: ['completed', 'failed'] as Array<'completed' | 'failed'>,
      count: 2, byStatus: { completed: 1, failed: 1 }, sessions: [],
    }));
    const execute = vi.fn(async () => ({ deletedCount: 2, deletedSessionIds: ['a', 'b'], redactedConversationCount: 0, redactedAuditEntryCount: 0, previewId: 'preview-1' }));
    const scheduler = new AudioSessionRetentionScheduler({ preview, execute }, async () => enabled, { now: () => new Date('2026-09-06T00:00:00.000Z') });

    await scheduler.runOnce();

    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ before: '2026-08-07T00:00:00.000Z', statuses: ['completed', 'failed'] }));
    expect(execute).toHaveBeenCalledWith('preview-1', 'APAGAR 2 SESSÕES', 'retention-scheduler');
  });
});
