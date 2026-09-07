import { describe, expect, it } from 'vitest';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { RecordingRemoteRetentionService } from '../src/recordings/recording-remote-retention.js';

function remoteSegment(id: string, tier: RecordingSegment['retentionTier'], protectedFlag = false): RecordingSegment {
  return {
    id,
    camera: 'front',
    startedAt: '2026-07-01T00:00:00.000Z',
    endedAt: '2026-07-01T00:01:00.000Z',
    durationMs: 60_000,
    fileRef: `front/${id}.mkv`,
    bytes: 10,
    mimeType: 'video/x-matroska',
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1280,
    height: 1440,
    backupStatus: 'verified',
    driveFileId: `drive-${id}`,
    retentionTier: tier,
    protected: protectedFlag,
  };
}

describe('retenção remota do Drive', () => {
  it('remove contínuo vencido, preserva eventos recentes e protegidos', async () => {
    const store = new InMemoryRecordingStore();
    await store.append(remoteSegment('continuous-old', 'continuous'));
    await store.append(remoteSegment('event-recent', 'event'));
    await store.append(remoteSegment('protected-old', 'protected', true));
    const deleted: string[] = [];
    const service = new RecordingRemoteRetentionService(store, {
      deleteRemote: async (fileId) => { deleted.push(fileId); },
      continuousDays: 30,
      eventDays: 90,
    });

    const result = await service.run(new Date('2026-09-05T00:00:00.000Z'));

    expect(deleted).toEqual(['drive-continuous-old']);
    expect(result.deleted).toEqual(['continuous-old']);
    expect((await store.findById('continuous-old'))?.backupStatus).toBe('remote_deleted');
  });
});
