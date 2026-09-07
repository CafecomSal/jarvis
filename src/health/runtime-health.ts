import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDefaultSystemHealth, type DefaultSystemHealthOptions, type SystemHealthSnapshot } from './system-health.js';

const execFileAsync = promisify(execFile);

export interface GpuStats {
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  utilizationPercent: number;
}

export interface RuntimeCommandRunner {
  (command: string, args: string[]): Promise<string>;
}

export interface RuntimeHealthOptions extends DefaultSystemHealthOptions {
  ollamaBaseUrl: string;
  fetchImpl?: typeof fetch;
  commandRunner?: RuntimeCommandRunner;
}

export function parseGpuStats(stdout: string): GpuStats | undefined {
  const values = stdout.trim().split(/[\s,]+/).map(Number);
  if (values.length < 3 || values.slice(0, 3).some((value) => !Number.isFinite(value))) return undefined;
  return {
    memoryUsedMiB: values[0],
    memoryTotalMiB: values[1],
    utilizationPercent: values[2],
  };
}

export function countProcesses(stdout: string, names: string[]): Record<string, number> {
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const result: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*"([^"]+)"/);
    const original = match?.[1];
    if (!original) continue;
    const name = wanted.get(original.toLowerCase());
    if (name) result[name] += 1;
  }
  return result;
}

async function defaultCommandRunner(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    windowsHide: true,
    timeout: 2_000,
    maxBuffer: 512 * 1024,
    encoding: 'utf8',
  });
  return String(result.stdout);
}

async function probeOllama(baseUrl: string, fetchImpl: typeof fetch): Promise<{ status: 'ok' | 'unknown'; loadedModels: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/ps`, { signal: controller.signal });
    if (!response.ok) return { status: 'unknown', loadedModels: [] };
    const body = await response.json() as { models?: Array<{ name?: unknown }> };
    const loadedModels = Array.isArray(body.models)
      ? body.models.map((item) => typeof item.name === 'string' ? item.name : '').filter(Boolean)
      : [];
    return { status: 'ok', loadedModels };
  } catch {
    return { status: 'unknown', loadedModels: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function createRuntimeSystemHealth(options: RuntimeHealthOptions): Promise<SystemHealthSnapshot> {
  const base = createDefaultSystemHealth(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const [ollama, gpu, processes] = await Promise.all([
    probeOllama(options.ollamaBaseUrl, fetchImpl),
    commandRunner('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,utilization.gpu',
      '--format=csv,noheader,nounits',
    ]).then(parseGpuStats).catch(() => undefined),
    commandRunner('tasklist', ['/FO', 'CSV', '/NH'])
      .then((stdout) => countProcesses(stdout, ['node.exe', 'ffmpeg.exe', 'python.exe']))
      .catch(() => ({})),
  ]);

  const processStatus = Object.keys(processes).length > 0 ? 'ok' as const : 'unknown' as const;
  return {
    ...base,
    model: {
      ...base.model,
      status: ollama.status === 'ok' ? base.model.status : 'unknown',
    },
    resources: {
      ollama: { status: ollama.status as 'ok' | 'unknown', loadedModels: ollama.loadedModels },
      gpu: gpu ? { status: 'ok' as const, ...gpu } : { status: 'unknown' as const },
      processes: { status: processStatus, ...processes },
    },
  };
}
