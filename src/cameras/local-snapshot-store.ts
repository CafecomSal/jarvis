import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CameraSnapshot } from './camera-adapter.js';

export interface SnapshotStore {
  save(snapshot: CameraSnapshot): Promise<string>;
}

export interface StoredSnapshot {
  reference: string;
  absolutePath: string;
  bytes: number;
  modifiedAt: string;
  mimeType: string;
}

export interface SnapshotBackupReceipt {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

export interface SnapshotBackup {
  upload(snapshot: { reference: string; bytes: Buffer; mimeType: string }): Promise<SnapshotBackupReceipt | void>;
}

export interface SnapshotRetentionOptions {
  maxAgeDays?: number;
  backup?: SnapshotBackup;
  requireBackup?: boolean;
  excludePrefixes?: string[];
}

export interface SnapshotRetentionResult {
  cutoff: string;
  scanned: number;
  uploaded: number;
  deleted: number;
  failed: number;
  skipped: boolean;
  reason?: 'backup_not_configured';
}

function mimeTypeFor(reference: string): string {
  return reference.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

export class LocalSnapshotStore implements SnapshotStore {
  private readonly directory: string;

  constructor(directory = 'data/snapshots') {
    this.directory = resolve(directory);
  }

  private resolveReference(reference: string): string {
    const absolutePath = resolve(this.directory, reference);
    const directoryPrefix = `${this.directory}${sep}`;
    if (absolutePath !== this.directory && !absolutePath.startsWith(directoryPrefix)) {
      throw new Error('Snapshot reference escapes the snapshot directory');
    }
    return absolutePath;
  }

  private async resolveExistingReference(reference: string): Promise<string> {
    const lexicalPath = this.resolveReference(reference);
    const rootPath = await realpath(this.directory);
    const actualPath = await realpath(lexicalPath);
    const relativePath = relative(rootPath, actualPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath.split(sep).includes('..') || relativePath === '') {
      throw new Error('Snapshot reference escapes the snapshot directory');
    }
    return actualPath;
  }

  resolvePath(reference: string): string {
    return this.resolveReference(reference);
  }

  private async imageReferences(directory: string, prefix = ''): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }

    const references: string[] = [];
    for (const entry of entries) {
      const reference = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(directory, entry.name);
      // Do not follow symlinks while enumerating retention candidates. A
      // symlink may point outside the configured snapshot root and must never
      // turn an external image into a local retention target.
      const metadata = await lstat(absolutePath);
      if (metadata.isDirectory()) {
        references.push(...await this.imageReferences(absolutePath, reference));
      } else if (metadata.isFile() && /\.(?:jpe?g|png)$/i.test(entry.name)) {
        references.push(reference);
      }
    }
    return references;
  }

  async save(snapshot: CameraSnapshot): Promise<string> {
    const camera = snapshot.camera.replace(/[^a-zA-Z0-9_-]/g, '_') || 'camera';
    const cameraDirectory = resolve(this.directory, camera);
    await mkdir(cameraDirectory, { recursive: true });

    const timestamp = snapshot.capturedAt
      .replace(/[^0-9TZ-]/g, '')
      .replace(/Z$/, 'Z');
    const extension = snapshot.mimeType === 'image/png' ? 'png' : 'jpg';
    const filename = `${timestamp}-${randomUUID()}.${extension}`;
    const absolutePath = resolve(cameraDirectory, filename);
    const rootPath = await realpath(this.directory);
    const actualCameraDirectory = await realpath(cameraDirectory);
    const cameraRelative = relative(rootPath, actualCameraDirectory);
    if (cameraRelative.startsWith('..') || isAbsolute(cameraRelative) || cameraRelative.split(sep).includes('..')) {
      throw new Error('Snapshot camera directory escapes the snapshot directory');
    }
    await writeFile(absolutePath, Buffer.from(snapshot.base64, 'base64'), { mode: 0o600, flag: 'wx' });

    const reference = relative(this.directory, absolutePath).split('\\').join('/');
    return basename(cameraDirectory) === camera ? `${camera}/${filename}` : reference;
  }

  async listOlderThan(cutoff: Date): Promise<StoredSnapshot[]> {
    const references = await this.imageReferences(this.directory);
    const candidates: StoredSnapshot[] = [];
    for (const reference of references) {
      const absolutePath = this.resolveReference(reference);
      const metadata = await stat(absolutePath);
      if (!metadata.isFile() || metadata.mtime >= cutoff) continue;
      candidates.push({
        reference,
        absolutePath,
        bytes: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
        mimeType: mimeTypeFor(reference),
      });
    }
    return candidates.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
  }

  async read(reference: string): Promise<Buffer> {
    return readFile(await this.resolveExistingReference(reference));
  }

  async remove(reference: string): Promise<void> {
    await rm(await this.resolveExistingReference(reference), { force: true });
  }
}

export interface SnapshotRetentionRunner {
  run(now?: Date): Promise<SnapshotRetentionResult>;
}

export interface SnapshotRetentionSchedulerOptions {
  intervalMs?: number;
  onResult?: (result: SnapshotRetentionResult) => void;
  onError?: (error: unknown) => void;
}

export class SnapshotRetentionScheduler {
  private readonly intervalMs: number;
  private readonly onResult?: (result: SnapshotRetentionResult) => void;
  private readonly onError?: (error: unknown) => void;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly service: SnapshotRetentionRunner,
    options: SnapshotRetentionSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.onResult = options.onResult;
    this.onError = options.onError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error('Snapshot retention intervalMs must be greater than zero');
    }
  }

  start(): void {
    if (this.timer) return;
    void this.execute();
    this.timer = setInterval(() => {
      void this.execute();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async execute(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.service.run();
      this.onResult?.(result);
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}

export class SnapshotRetentionService {
  private readonly maxAgeDays: number;
  private readonly backup?: SnapshotBackup;
  private readonly requireBackup: boolean;
  private readonly excludePrefixes: string[];

  constructor(
    private readonly store: LocalSnapshotStore,
    options: SnapshotRetentionOptions = {},
  ) {
    this.maxAgeDays = options.maxAgeDays ?? 7;
    if (!Number.isFinite(this.maxAgeDays) || this.maxAgeDays <= 0) {
      throw new Error('Snapshot retention maxAgeDays must be greater than zero');
    }
    this.backup = options.backup;
    this.requireBackup = options.requireBackup ?? true;
    this.excludePrefixes = (options.excludePrefixes ?? [])
      .map((prefix) => prefix.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter(Boolean)
      .map((prefix) => `${prefix}/`);
  }

  async run(now = new Date()): Promise<SnapshotRetentionResult> {
    const cutoff = new Date(now.getTime() - this.maxAgeDays * 24 * 60 * 60 * 1000);
    const candidates = (await this.store.listOlderThan(cutoff)).filter((candidate) => (
      !this.excludePrefixes.some((prefix) => candidate.reference === prefix.slice(0, -1) || candidate.reference.startsWith(prefix))
    ));
    const result: SnapshotRetentionResult = {
      cutoff: cutoff.toISOString(),
      scanned: candidates.length,
      uploaded: 0,
      deleted: 0,
      failed: 0,
      skipped: false,
    };

    if (candidates.length > 0 && !this.backup && this.requireBackup) {
      result.skipped = true;
      result.reason = 'backup_not_configured';
      return result;
    }

    for (const candidate of candidates) {
      try {
        if (this.backup) {
          await this.backup.upload({
            reference: candidate.reference,
            bytes: await this.store.read(candidate.reference),
            mimeType: candidate.mimeType,
          });
          result.uploaded += 1;
        }
        await this.store.remove(candidate.reference);
        result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }

    return result;
  }
}
