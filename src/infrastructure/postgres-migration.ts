import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function readPostgresMigration(currentModuleFile: string, fileName: string): Promise<string> {
  const candidates = [
    resolve(dirname(currentModuleFile), '../../infrastructure/postgres', fileName),
    resolve(process.cwd(), 'infrastructure', 'postgres', fileName),
  ];
  let lastError: unknown;
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`PostgreSQL migration not found: ${fileName}`);
}
