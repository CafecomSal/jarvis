import { describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSnapshotStore, SnapshotRetentionService, SnapshotRetentionScheduler, type SnapshotRetentionResult } from '../src/cameras/local-snapshot-store.js';

const snapshot = {
  camera: 'front',
  oid: 1,
  capturedAt: '2026-08-25T19:30:00.000Z',
  mimeType: 'image/jpeg',
  bytes: 4,
  base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
};

describe('retenção local de snapshots', () => {
  it('identifica e remove somente arquivos anteriores ao cutoff', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-retention-'));
    try {
      const store = new LocalSnapshotStore(directory);
      const oldReference = await store.save(snapshot);
      const newReference = await store.save({ ...snapshot, capturedAt: '2026-08-25T20:30:00.000Z' });
      const oldDate = new Date('2026-08-17T19:30:00.000Z');
      await utimes(join(directory, oldReference), oldDate, oldDate);
      await utimes(join(directory, newReference), new Date('2026-08-25T20:30:00.000Z'), new Date('2026-08-25T20:30:00.000Z'));

      const candidates = await store.listOlderThan(new Date('2026-08-18T00:00:00.000Z'));
      expect(candidates.map((candidate) => candidate.reference)).toEqual([oldReference]);

      await store.remove(oldReference);
      await expect(access(join(directory, oldReference))).rejects.toThrow();
      await expect(readFile(join(directory, newReference))).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('não apaga snapshots antigos sem backup configurado', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-retention-'));
    try {
      const store = new LocalSnapshotStore(directory);
      const reference = await store.save(snapshot);
      const oldDate = new Date('2026-08-17T19:30:00.000Z');
      await utimes(join(directory, reference), oldDate, oldDate);

      const result = await new SnapshotRetentionService(store).run(new Date('2026-08-25T19:30:00.000Z'));

      expect(result).toMatchObject({ scanned: 1, uploaded: 0, deleted: 0, skipped: true, reason: 'backup_not_configured' });
      await expect(access(join(directory, reference))).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('faz upload antes de remover o snapshot expirado', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-retention-'));
    try {
      const store = new LocalSnapshotStore(directory);
      const reference = await store.save(snapshot);
      const oldDate = new Date('2026-08-17T19:30:00.000Z');
      await utimes(join(directory, reference), oldDate, oldDate);
      const uploads: Array<{ reference: string; bytes: Buffer; mimeType: string }> = [];
      const backup = {
        upload: async (item: { reference: string; bytes: Buffer; mimeType: string }): Promise<void> => {
          uploads.push(item);
        },
      };

      const result = await new SnapshotRetentionService(store, { backup }).run(new Date('2026-08-25T19:30:00.000Z'));

      expect(result).toMatchObject({ scanned: 1, uploaded: 1, deleted: 1, failed: 0, skipped: false });
      expect(uploads).toEqual([{ reference, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' }]);
      await expect(access(join(directory, reference))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('executa a retenção imediatamente e não permite execuções sobrepostas', async () => {
    const result: SnapshotRetentionResult = {
      cutoff: '2026-08-18T19:30:00.000Z',
      scanned: 0,
      uploaded: 0,
      deleted: 0,
      failed: 0,
      skipped: false,
    };
    let calls = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    const service = {
      run: async (): Promise<SnapshotRetentionResult> => {
        calls += 1;
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return result;
      },
    };
    const scheduler = new SnapshotRetentionScheduler(service, { intervalMs: 5 });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 45));
    scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(maximumInFlight).toBe(1);
  });

  it('resolve o caminho absoluto de um snapshot sem permitir escapar do diretório', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-retention-'));
    try {
      const store = new LocalSnapshotStore(directory);
      const reference = await store.save(snapshot);

      expect(store.resolvePath(reference)).toBe(resolve(directory, reference));
      expect(() => store.resolvePath('../outside.jpg')).toThrow('escapes the snapshot directory');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
