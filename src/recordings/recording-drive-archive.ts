import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SnapshotBackup, SnapshotBackupReceipt } from '../cameras/local-snapshot-store.js';
import type { RecordingSegment, RecordingStore } from './recording-store.js';
import { resolveRecordingFile } from './recording-file.js';

export interface RecordingArchiveResult {
  recordingId: string;
  driveFileId: string;
  backupStatus: 'verified';
  receipt: SnapshotBackupReceipt;
}

export class RecordingDriveArchiver {
  private readonly rootDirectory: string;
  private readonly clock: () => Date;

  constructor(
    private readonly store: RecordingStore,
    private readonly backup: SnapshotBackup,
    rootDirectory: string,
    clock: () => Date = () => new Date(),
  ) {
    this.rootDirectory = resolve(rootDirectory);
    this.clock = clock;
    if (!this.rootDirectory.trim()) throw new Error('Recording archive rootDirectory must not be empty');
  }

  async archive(recordingId: string): Promise<RecordingArchiveResult> {
    const segment = await this.store.findById(recordingId);
    if (!segment) throw new Error(`Recording segment not found: ${recordingId}`);
    const filePath = resolveRecordingFile(this.rootDirectory, segment.fileRef);
    const bytes = await readFile(filePath);
    if (bytes.length !== segment.bytes) {
      throw new Error('Recording file size does not match catalog metadata');
    }

    try {
      await this.store.updateBackup(recordingId, { backupStatus: 'queued' });
      const receipt = await this.backup.upload({
        reference: segment.fileRef,
        bytes,
        mimeType: segment.mimeType,
      });
      if (!receipt || !receipt.id) throw new Error('Recording backup did not return a file ID');
      const verifiedAt = this.clock().toISOString();
      await this.store.updateBackup(recordingId, {
        backupStatus: 'verified',
        driveFileId: receipt.id,
        ...(receipt.webViewLink ? { driveWebViewLink: receipt.webViewLink } : {}),
        backupVerifiedAt: verifiedAt,
      });
      return {
        recordingId,
        driveFileId: receipt.id,
        backupStatus: 'verified',
        receipt,
      };
    } catch (error) {
      await this.store.updateBackup(recordingId, { backupStatus: 'failed' }).catch(() => undefined);
      throw error;
    }
  }
}
