import { describe, expect, it } from 'vitest';
import { GoogleDriveSnapshotBackup, type CommandResult } from '../src/cameras/google-drive-backup.js';

describe('delete do Google Drive', () => {
  it('usa trash por padrão e preserva o ID retornado', async () => {
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args);
      return { stdout: JSON.stringify({ status: 'trashed', fileId: 'drive-1', permanent: false }), stderr: '' };
    };
    const backup = new GoogleDriveSnapshotBackup({ scriptPath: 'google_api.py', runCommand: runner });

    const result = await backup.delete('drive-1');

    expect(result).toEqual({ status: 'trashed', fileId: 'drive-1', permanent: false });
    expect(calls[0]).toEqual(['google_api.py', 'drive', 'delete', 'drive-1']);
  });
});
