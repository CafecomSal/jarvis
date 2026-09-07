import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotBackup } from '../src/cameras/local-snapshot-store.js';
import {
  InMemoryRecordingStore,
  type RecordingSegment,
} from '../src/recordings/recording-store.js';
import { RecordingDriveArchiver } from '../src/recordings/recording-drive-archive.js';

const segment: RecordingSegment = {
  id: 'rec-archive-1',
  camera: 'front',
  startedAt: '2026-09-04T12:00:00.000Z',
  endedAt: '2026-09-04T12:00:05.000Z',
  durationMs: 5_000,
  fileRef: 'front/2026-09-04/rec-archive-1.mkv',
  bytes: 15,
  mimeType: 'video/x-matroska',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1920,
  height: 2160,
  backupStatus: 'local',
};

describe('arquivamento de gravação no Drive', () => {
  it('faz upload, recebe receipt verificado e atualiza o catálogo sem apagar local', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-drive-archive-'));
    try {
      const filePath = join(directory, ...segment.fileRef.split('/'));
      await (await import('node:fs/promises')).mkdir(join(directory, 'front', '2026-09-04'), { recursive: true });
      await writeFile(filePath, Buffer.from('recording-bytes'));
      const store = new InMemoryRecordingStore();
      await store.append(segment);
      const uploads: Array<{ reference: string; bytes: Buffer; mimeType: string }> = [];
      const backup: SnapshotBackup = {
        upload: async (input) => {
          uploads.push(input);
          return { id: 'drive-file-1', name: 'jarvis-front-segment.mkv', mimeType: input.mimeType };
        },
      };
      const archiver = new RecordingDriveArchiver(store, backup, directory);

      const result = await archiver.archive('rec-archive-1');
      const readback = await store.findById('rec-archive-1');

      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({ reference: segment.fileRef, mimeType: segment.mimeType });
      expect(uploads[0].bytes.toString()).toBe('recording-bytes');
      expect(result).toMatchObject({
        recordingId: 'rec-archive-1',
        driveFileId: 'drive-file-1',
        backupStatus: 'verified',
      });
      expect(readback).toMatchObject({
        backupStatus: 'verified',
        driveFileId: 'drive-file-1',
      });
      expect((await readFile(filePath)).toString()).toBe('recording-bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('marca falha e preserva o arquivo quando o backup falha', async () => {
    const directory = await mkdtemp(join(process.env.TEMP ?? 'C:/Windows/Temp', 'jarvis-drive-archive-fail-'));
    try {
      const filePath = join(directory, ...segment.fileRef.split('/'));
      await (await import('node:fs/promises')).mkdir(join(directory, 'front', '2026-09-04'), { recursive: true });
      await writeFile(filePath, Buffer.from('recording-bytes'));
      const store = new InMemoryRecordingStore();
      await store.append(segment);
      const backup: SnapshotBackup = {
        upload: async () => { throw new Error('drive unavailable'); },
      };

      await expect(new RecordingDriveArchiver(store, backup, directory).archive(segment.id)).rejects.toThrow(
        'drive unavailable',
      );
      await expect(store.findById(segment.id)).resolves.toMatchObject({ backupStatus: 'failed' });
      expect((await readFile(filePath)).toString()).toBe('recording-bytes');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
