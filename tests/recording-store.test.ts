import { describe, expect, it } from 'vitest';
import {
  InMemoryRecordingStore,
  type RecordingSegment,
} from '../src/recordings/recording-store.js';

const segment = (id: string, startedAt: string, camera = 'front'): RecordingSegment => ({
  id,
  camera,
  startedAt,
  endedAt: '2026-09-04T12:02:00.000Z',
  durationMs: 120_000,
  fileRef: `${camera}/2026-09-04/${id}.mkv`,
  bytes: 1024,
  mimeType: 'video/x-matroska',
  videoCodec: 'hevc',
  audioCodec: 'pcm_alaw',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
});

describe('catálogo de segmentos DVR', () => {
  it('persiste em memória, é idempotente e filtra por câmera/intervalo', async () => {
    const store = new InMemoryRecordingStore();
    await store.append(segment('seg-old', '2026-09-04T11:00:00.000Z'));
    const saved = await store.append(segment('seg-new', '2026-09-04T12:00:00.000Z'));
    await store.append(segment('seg-other', '2026-09-04T12:30:00.000Z', 'back'));

    const duplicate = await store.append({ ...saved, bytes: 9999 });
    const matches = await store.list({
      camera: 'front',
      from: '2026-09-04T11:30:00.000Z',
      to: '2026-09-04T12:15:00.000Z',
      limit: 10,
    });

    expect(duplicate).toEqual(saved);
    expect(matches.map((item) => item.id)).toEqual(['seg-new']);
    expect(await store.findById('seg-new')).toEqual(saved);
    await expect(store.findById('missing')).resolves.toBeUndefined();
  });
});
