import { describe, expect, it } from 'vitest';
import { InMemoryRecordingStore } from '../src/recordings/recording-store.js';

describe('metadata de retenção de gravação', () => {
  it('preserva tier de evento e proteção manual', async () => {
    const store = new InMemoryRecordingStore();
    const segment = await store.append({
      id: 'rec-retention-metadata',
      camera: 'front',
      startedAt: '2026-09-05T04:00:00.000Z',
      endedAt: '2026-09-05T04:01:00.000Z',
      durationMs: 60_000,
      fileRef: 'front/rec-retention-metadata.mkv',
      bytes: 10,
      mimeType: 'video/x-matroska',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 1440,
      backupStatus: 'verified',
      retentionTier: 'protected',
      protected: true,
    });

    expect(segment).toMatchObject({ retentionTier: 'protected', protected: true });
  });
});
