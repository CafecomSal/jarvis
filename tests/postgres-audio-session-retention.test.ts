import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresAuditStore } from '../src/audit/postgres-audit-store.js';
import { AudioSessionRetentionService } from '../src/audio/audio-session-retention.js';
import { PostgresAudioSessionStore } from '../src/audio/audio-session-store.js';
import { PostgresRecordingStore } from '../src/recordings/recording-store.js';

const connectionString = process.env.DATABASE_URL;
const sessionIds = [
  'test-pg-retention-old-completed',
  'test-pg-retention-old-failed',
  'test-pg-retention-race',
  'test-pg-retention-active',
  'test-pg-retention-recent',
] as const;
const auditIds = ['test-pg-retention-conversation-entry'] as const;
const conversationId = 'test-pg-retention-conversation';
const recordingId = 'test-pg-retention-recording';
const oldDate = '2026-08-01T03:00:00.000Z';

describe.skipIf(!connectionString)('retenção de sessão de áudio no PostgreSQL', () => {
  const pool = new Pool({ connectionString });
  const sessions = new PostgresAudioSessionStore({ pool });
  const audit = new PostgresAuditStore({ pool });
  const recordings = new PostgresRecordingStore({ pool });
  let tombstoneConversationId: string | undefined;

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM audio_sessions WHERE id = ANY($1::text[])', [sessionIds]);
    await pool.query('DELETE FROM audit_log WHERE id = ANY($1::text[]) OR conversation_id = $2 OR conversation_id = $3', [
      auditIds,
      conversationId,
      tombstoneConversationId ?? 'test-pg-retention-no-tombstone',
    ]);
    await pool.query('DELETE FROM recording_segments WHERE id = $1', [recordingId]);
  }

  beforeAll(async () => {
    await audit.initialize();
    await sessions.initialize();
    await recordings.initialize();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('faz readback de preview, corrida, redaction+tombstone e preserva gravação/Drive', async () => {
    await sessions.append({
      id: sessionIds[0], source: 'pc', status: 'completed', startedAt: oldDate,
      endedAt: '2026-08-01T03:00:02.000Z', conversationId,
      transcript: { text: 'fixture privado', provider: 'fixture', model: 'fixture', latencyMs: 10 },
      responseText: 'resposta fixture',
    });
    await sessions.append({ id: sessionIds[1], source: 'pc', status: 'failed', startedAt: oldDate, endedAt: oldDate, error: 'fixture failure' });
    await sessions.append({
      id: sessionIds[2], source: 'pc', status: 'completed', startedAt: oldDate,
      endedAt: '2026-08-01T03:00:02.000Z', conversationId: 'test-pg-retention-race-conversation',
    });
    await sessions.append({ id: sessionIds[3], source: 'pc', status: 'transcribing', startedAt: oldDate });
    await sessions.append({ id: sessionIds[4], source: 'pc', status: 'completed', startedAt: '2026-09-05T03:00:00.000Z' });
    await audit.append({
      id: auditIds[0], timestamp: oldDate, conversationId, kind: 'conversation', action: 'received', actor: 'fixture',
      data: { message: 'fixture privado' },
    });
    await recordings.append({
      id: recordingId, camera: 'front', startedAt: oldDate, endedAt: '2026-08-01T03:00:05.000Z',
      durationMs: 5_000, fileRef: `fixture/${recordingId}.mkv`, bytes: 7, mimeType: 'video/x-matroska',
      videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 720, backupStatus: 'verified',
      driveFileId: 'drive-fixture-001', driveWebViewLink: 'https://drive.google.com/file/d/drive-fixture-001/view',
      backupVerifiedAt: oldDate,
    });

    const service = new AudioSessionRetentionService(sessions, audit, {
      now: () => new Date('2026-09-06T00:00:00.000Z'),
    });
    const preview = await service.preview({ before: '2026-09-01T00:00:00.000Z' });

    expect(preview.count).toBe(3);
    expect(preview.sessions.map((session) => session.id)).toEqual([
      sessionIds[0], sessionIds[1], sessionIds[2],
    ]);
    expect(JSON.stringify(preview)).not.toContain('fixture privado');
    await expect(service.execute(preview.previewId, 'wrong')).rejects.toThrow('confirmation');

    // Simulate a concurrent status transition after preview; it must remain active.
    await sessions.deleteByIds([sessionIds[2]]);
    await sessions.append({ id: sessionIds[2], source: 'pc', status: 'transcribing', startedAt: oldDate });

    const result = await service.execute(preview.previewId, 'APAGAR 3 SESSÕES', 'retention-fixture');
    tombstoneConversationId = `purge-${preview.previewId}`;
    const retainedRace = await sessions.findById(sessionIds[2]);
    const retainedActive = await sessions.findById(sessionIds[3]);
    const remainingRecent = await sessions.findById(sessionIds[4]);
    const redacted = await audit.forConversation(conversationId);
    const tombstone = await audit.forConversation(tombstoneConversationId);
    const recording = await recordings.findById(recordingId);

    expect(result).toMatchObject({ deletedCount: 2, redactedConversationCount: 1, redactedAuditEntryCount: 1 });
    expect(await sessions.findById(sessionIds[0])).toBeUndefined();
    expect(await sessions.findById(sessionIds[1])).toBeUndefined();
    expect(retainedRace?.status).toBe('transcribing');
    expect(retainedActive?.status).toBe('transcribing');
    expect(remainingRecent?.status).toBe('completed');
    expect(redacted[0]?.data).toEqual({ redacted: true, reason: 'audio-session-purge' });
    expect(tombstone).toHaveLength(1);
    expect(tombstone[0]).toMatchObject({ action: 'audio_session.purge', actor: 'retention-fixture', outcome: 'success' });
    expect(JSON.stringify(redacted)).not.toContain('fixture privado');
    expect(recording).toMatchObject({
      id: recordingId,
      backupStatus: 'verified',
      driveFileId: 'drive-fixture-001',
      driveWebViewLink: 'https://drive.google.com/file/d/drive-fixture-001/view',
    });
  });
});
