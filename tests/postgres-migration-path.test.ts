import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { readPostgresMigration } from '../src/infrastructure/postgres-migration.js';

describe('resolução de migrations PostgreSQL', () => {
  it('encontra a migration a partir de um módulo compilado em dist', async () => {
    const compiledModule = resolve(process.cwd(), 'dist', 'src', 'events', 'postgres-event-store.js');
    const sql = await readPostgresMigration(compiledModule, '001_init.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS events');
  });
});
