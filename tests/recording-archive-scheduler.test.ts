import { describe, expect, it } from 'vitest';
import { InMemoryRecordingStore, type RecordingSegment } from '../src/recordings/recording-store.js';
import { RecordingUploadQueue } from '../src/recordings/recording-upload-queue.js';
import { RecordingArchiveScheduler } from '../src/recordings/recording-archive-scheduler.js';

function segment(id: string, backupStatus: RecordingSegment['backupStatus']): RecordingSegment {
  return {
    id,
    camera: 'front',
    startedAt: '2026-09-05T04:00:00.000Z',
    endedAt: '2026-09-05T04:01:00.000Z',
    durationMs: 60_000,
    fileRef: `front/${id}.mkv`,
    bytes: 10,
    mimeType: 'video/x-matroska',
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1280,
    height: 1440,
    backupStatus,
  };
}

describe('scheduler de arquivamento contínuo', () => {
  it('envia segmentos locais/falhos e ignora os já verificados', async () => {
    const store = new InMemoryRecordingStore();
    await store.append(segment('local-1', 'local'));
    await store.append(segment('failed-1', 'failed'));
    await store.append(segment('verified-1', 'verified'));
    const archived: string[] = [];
    const queue = new RecordingUploadQueue({ archive: async (id) => archived.push(id), retryDelayMs: 0 });
    const scheduler = new RecordingArchiveScheduler(store, queue);

    const result = await scheduler.runOnce();

    expect(archived).toEqual(['local-1', 'failed-1']);
    expect(result.map((job) => job.id)).toEqual(['local-1', 'failed-1']);
  });
});
