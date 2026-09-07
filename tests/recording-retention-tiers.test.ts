import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { RecordingRetentionService } from '../src/recordings/recording-retention.js';

function segment(id: string, startedAt: string, retentionTier: 'continuous' | 'event' | 'protected'): RecordingSegment {
  return {
    id,
    camera: 'front',
    startedAt,
    endedAt: '2026-08-01T00:01:00.000Z',
    durationMs: 60_000,
    fileRef: `front/${id}.mkv`,
    bytes: 5,
    mimeType: 'video/x-matroska',
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1280,
    height: 1440,
    backupStatus: 'local',
    retentionTier,
    protected: retentionTier === 'protected',
  };
}

describe('integração de tiers de retenção', () => {
  it('respeita 30/90 dias e apaga staging somente após verified', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-retention-tier-'));
    try {
      const continuous = segment('continuous-old', '2026-07-01T00:00:00.000Z', 'continuous');
      const event = segment('event-recent', '2026-08-01T00:00:00.000Z', 'event');
      const protectedSegment = segment('protected-old', '2026-01-01T00:00:00.000Z', 'protected');
      const store = new InMemoryRecordingStore();
      for (const item of [continuous, event, protectedSegment]) {
        await mkdir(join(directory, 'front'), { recursive: true });
        await writeFile(join(directory, item.fileRef), item.id);
        await store.append({ ...item, bytes: (await readFile(join(directory, item.fileRef))).length });
      }
      const service = new RecordingRetentionService(store, directory, { continuousDays: 30, eventDays: 90, deleteAfterVerified: true });
      const plan = await service.plan(new Date('2026-09-05T00:00:00.000Z'));
      const result = await service.run(async (id) => { await store.updateBackup(id, { backupStatus: 'verified' }); }, new Date('2026-09-05T00:00:00.000Z'));

      expect(plan.candidates.map((candidate) => candidate.segment.id)).toEqual(['continuous-old']);
      expect(result).toMatchObject({ archived: 1, deleted: 1, failed: 0 });
      await expect(stat(join(directory, continuous.fileRef))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await stat(join(directory, protectedSegment.fileRef))).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
