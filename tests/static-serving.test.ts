import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('serving da interface web', () => {
  it('serve o shell em /ui sem substituir a API raiz', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-web-'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Jarvis UI</title>', 'utf8');
    const app = buildApp({ webRoot: root });

    const uiResponse = await app.inject({ method: 'GET', url: '/ui/' });
    const apiResponse = await app.inject({ method: 'GET', url: '/' });
    await app.close();
    await rm(root, { recursive: true, force: true });

    expect(uiResponse.statusCode).toBe(200);
    expect(uiResponse.body).toContain('Jarvis UI');
    expect(apiResponse.statusCode).toBe(200);
    expect(apiResponse.json()).toMatchObject({ name: 'Jarvis Core' });
  });
});
