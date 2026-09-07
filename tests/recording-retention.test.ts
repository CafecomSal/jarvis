import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { RecordingRetentionService } from '../src/recordings/recording-retention.js';

const segment = (id: string, startedAt: string, bytes: number): RecordingSegment => ({
  id,
  camera: 'front',
  startedAt,
  endedAt: '2026-09-01T12:00:05.000Z',
  durationMs: 5_000,
  fileRef: `front/2026-09-01/${id}.mkv`,
  bytes,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
});

describe('política de retenção DVR', () => {
  it('planeja candidatos por idade e executa archive sem apagar local', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-retention-recordings-'));
    try {
      const old = segment('rec-old', '2026-09-01T12:00:00.000Z', 10);
      const recent = segment('rec-recent', '2026-09-04T12:00:00.000Z', 10);
      for (const item of [old, recent]) {
        await mkdir(join(directory, ...item.fileRef.split('/').slice(0, -1)), { recursive: true });
      }
      await writeFile(join(directory, ...old.fileRef.split('/')), Buffer.from('old-bytes'));
      await writeFile(join(directory, ...recent.fileRef.split('/')), Buffer.from('recent-bytes'));
      const store = new InMemoryRecordingStore();
      await store.append({ ...old, bytes: (await readFile(join(directory, ...old.fileRef.split('/')))).length });
      await store.append({ ...recent, bytes: (await readFile(join(directory, ...recent.fileRef.split('/')))).length });
      const archived: string[] = [];
      const service = new RecordingRetentionService(store, directory, { maxAgeDays: 2 });

      const plan = await service.plan(new Date('2026-09-04T12:00:00.000Z'));
      const result = await service.run(async (id) => { archived.push(id); }, new Date('2026-09-04T12:00:00.000Z'));

      expect(plan.candidates.map((item) => item.segment.id)).toEqual(['rec-old']);
      expect(result).toMatchObject({ scanned: 2, archived: 1, failed: 0, deleted: 0 });
      expect(archived).toEqual(['rec-old']);
      expect((await store.findById('rec-old'))?.backupStatus).toBe('local');
      expect((await readFile(join(directory, ...old.fileRef.split('/')))).toString()).toBe('old-bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
