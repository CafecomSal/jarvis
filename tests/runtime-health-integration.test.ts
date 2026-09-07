import { describe, expect, it } from 'vitest';
import { createRuntimeSystemHealth } from '../src/health/runtime-health.js';

describe('runtime health', () => {
  it('combina Ollama, GPU e processos sem expor command line', async () => {
    const health = await createRuntimeSystemHealth({
      model: 'gemma-hermes:latest',
      databaseConfigured: true,
      recordingsConfigured: true,
      audioConfigured: true,
      exposure: 'tailscale-only',
      ollamaBaseUrl: 'http://ollama.local',
      fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'gemma-hermes:latest' }] }), { status: 200 }),
      commandRunner: async (command) => command === 'nvidia-smi'
        ? '3090, 8192, 12\n'
        : '"ffmpeg.exe","1"\n"node.exe","2"\n',
    });

    expect(health.resources).toEqual({
      ollama: { status: 'ok', loadedModels: ['gemma-hermes:latest'] },
      gpu: { status: 'ok', memoryUsedMiB: 3090, memoryTotalMiB: 8192, utilizationPercent: 12 },
      processes: { status: 'ok', 'node.exe': 1, 'ffmpeg.exe': 1, 'python.exe': 0 },
    });
  });
});
