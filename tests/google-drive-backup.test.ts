import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoogleDriveSnapshotBackup, type CommandRunner } from '../src/cameras/google-drive-backup.js';

const activeTempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(activeTempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('backup de snapshot no Google Drive', () => {
  it('envia o arquivo temporário e confirma o metadata pelo ID retornado', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-drive-test-'));
    activeTempDirectories.push(temporaryRoot);
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('upload')) {
        const path = args[args.indexOf('upload') + 1];
        await expect(readFile(path)).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return {
          stdout: JSON.stringify({
            status: 'uploaded',
            id: 'drive-file-001',
            name: 'jarvis-front-2026.jpg',
            mimeType: 'image/jpeg',
            webViewLink: 'https://drive.google.com/file/d/drive-file-001/view',
          }),
          stderr: '',
        };
      }
      return {
        stdout: JSON.stringify({
          id: 'drive-file-001',
          name: 'jarvis-front-2026.jpg',
          mimeType: 'image/jpeg',
        }),
        stderr: '',
      };
    };
    const backup = new GoogleDriveSnapshotBackup({
      pythonCommand: 'python-test',
      scriptPath: 'C:/skills/google_api.py',
      parentFolderId: 'folder-001',
      temporaryRoot,
      runCommand: runner,
    });

    const receipt = await backup.upload({
      reference: 'front/captured.jpg',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      mimeType: 'image/jpeg',
    });

    expect(receipt).toEqual({
      id: 'drive-file-001',
      name: 'jarvis-front-2026.jpg',
      mimeType: 'image/jpeg',
      webViewLink: 'https://drive.google.com/file/d/drive-file-001/view',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: 'python-test',
      args: [
        'C:/skills/google_api.py',
        'drive',
        'upload',
        expect.any(String),
        '--name',
        'jarvis-front-captured.jpg',
        '--parent',
        'folder-001',
        '--mime-type',
        'image/jpeg',
      ],
    });
    expect(calls[1]).toMatchObject({
      command: 'python-test',
      args: ['C:/skills/google_api.py', 'drive', 'get', 'drive-file-001'],
    });
    const temporaryPath = calls[0].args[3];
    await expect(access(temporaryPath)).rejects.toThrow();
  });

  it('não aceita um upload sem metadata compatível no readback', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-drive-test-'));
    activeTempDirectories.push(temporaryRoot);
    const runner: CommandRunner = async (_command, args) => ({
      stdout: JSON.stringify(args.includes('upload')
        ? { status: 'uploaded', id: 'drive-file-002', name: 'snapshot.jpg', mimeType: 'image/jpeg' }
        : { id: 'other-file', name: 'snapshot.jpg', mimeType: 'image/jpeg' }),
      stderr: '',
    });
    const backup = new GoogleDriveSnapshotBackup({
      scriptPath: 'C:/skills/google_api.py',
      temporaryRoot,
      runCommand: runner,
    });

    await expect(backup.upload({
      reference: 'front/captured.jpg',
      bytes: Buffer.from([1, 2, 3]),
      mimeType: 'image/jpeg',
    })).rejects.toThrow(/readback/i);
  });
});
