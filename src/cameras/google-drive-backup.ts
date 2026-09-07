import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { SnapshotBackup, SnapshotBackupReceipt } from './local-snapshot-store.js';

export interface CommandRunnerOptions {
  timeout?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunnerOptions,
) => Promise<CommandResult>;

export interface GoogleDriveSnapshotBackupOptions {
  pythonCommand?: string;
  scriptPath?: string;
  parentFolderId?: string;
  temporaryRoot?: string;
  timeoutMs?: number;
  runCommand?: CommandRunner;
}

function defaultScriptPath(): string {
  const hermesHome = process.env.HERMES_HOME
    ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hermes', 'profiles', 'jarvis');
  return join(hermesHome, 'skills', 'productivity', 'google-workspace', 'scripts', 'google_api.py');
}

const execFileAsync = promisify(execFile);

const defaultCommandRunner: CommandRunner = async (command, args, options = {}) => {
  const result = await execFileAsync(command, args, {
    timeout: options.timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(stdout: string, operation: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (isRecord(parsed)) return parsed;
  } catch {
    // Add a stable operation-specific error below.
  }
  throw new Error(`Google Drive ${operation} returned invalid JSON`);
}

function safeDriveName(reference: string): string {
  const normalized = reference
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `jarvis-${normalized || 'snapshot.jpg'}`;
}

export class GoogleDriveSnapshotBackup implements SnapshotBackup {
  private readonly pythonCommand: string;
  private readonly scriptPath: string;
  private readonly parentFolderId?: string;
  private readonly temporaryRoot: string;
  private readonly timeoutMs: number;
  private readonly runCommand: CommandRunner;

  constructor(options: GoogleDriveSnapshotBackupOptions = {}) {
    this.pythonCommand = options.pythonCommand ?? process.env.JARVIS_PYTHON_COMMAND ?? 'python';
    this.scriptPath = options.scriptPath ?? defaultScriptPath();
    this.parentFolderId = options.parentFolderId;
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.runCommand = options.runCommand ?? defaultCommandRunner;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Google Drive backup timeoutMs must be greater than zero');
    }
  }

  async upload(snapshot: { reference: string; bytes: Buffer; mimeType: string }): Promise<SnapshotBackupReceipt> {
    const temporaryDirectory = await mkdtemp(join(this.temporaryRoot, 'jarvis-drive-upload-'));
    const driveName = safeDriveName(snapshot.reference);
    const temporaryPath = join(temporaryDirectory, basename(driveName));

    try {
      await writeFile(temporaryPath, snapshot.bytes, { mode: 0o600 });
      const uploadArgs = [
        this.scriptPath,
        'drive',
        'upload',
        temporaryPath,
        '--name',
        driveName,
      ];
      if (this.parentFolderId) {
        uploadArgs.push('--parent', this.parentFolderId);
      }
      uploadArgs.push('--mime-type', snapshot.mimeType);

      const uploadResult = await this.runCommand(this.pythonCommand, uploadArgs, { timeout: this.timeoutMs });
      const uploaded = parseJson(uploadResult.stdout, 'upload');
      if (uploaded.status !== 'uploaded' || typeof uploaded.id !== 'string' || uploaded.id.length === 0) {
        throw new Error('Google Drive upload did not return an uploaded file ID');
      }

      const fileId = uploaded.id;
      const verifyResult = await this.runCommand(
        this.pythonCommand,
        [this.scriptPath, 'drive', 'get', fileId],
        { timeout: this.timeoutMs },
      );
      const verified = parseJson(verifyResult.stdout, 'readback');
      if (verified.id !== fileId) {
        throw new Error('Google Drive readback returned a different file ID');
      }
      if (verified.name !== uploaded.name || verified.mimeType !== snapshot.mimeType) {
        throw new Error('Google Drive readback metadata mismatch');
      }

      return {
        id: fileId,
        name: String(verified.name),
        mimeType: String(verified.mimeType),
        ...(typeof uploaded.webViewLink === 'string' && uploaded.webViewLink
          ? { webViewLink: uploaded.webViewLink }
          : {}),
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async delete(fileId: string, permanent = false): Promise<{ status: 'trashed' | 'deleted'; fileId: string; permanent: boolean }> {
    if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('Google Drive file ID is invalid');
    const args = [this.scriptPath, 'drive', 'delete', fileId, ...(permanent ? ['--permanent'] : [])];
    const result = parseJson((await this.runCommand(this.pythonCommand, args, { timeout: this.timeoutMs })).stdout, 'delete');
    if ((result.status !== 'trashed' && result.status !== 'deleted') || result.fileId !== fileId) {
      throw new Error('Google Drive delete returned an invalid receipt');
    }
    return { status: result.status, fileId, permanent };
  }
}
