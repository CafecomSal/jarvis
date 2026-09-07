import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const supervisorPath = join(process.cwd(), 'ops', 'windows', 'jarvis-supervisor.ps1');
const powershellPath = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

async function runSupervisor(mode: 'Validate' | 'Status'): Promise<Record<string, unknown>> {
  const result = await execFileAsync(
    powershellPath,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      supervisorPath,
      '-Mode',
      mode,
    ],
    { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('supervisor Windows do Jarvis', () => {
  it('expõe preflight seguro sem imprimir configuração do ambiente', async () => {
    const output = await runSupervisor('Validate');
    const checks = output.checks as Record<string, unknown>;

    expect(typeof output.ready).toBe('boolean');
    expect(checks).toMatchObject({
      projectRoot: true,
      envFile: true,
      compiledCore: true,
      node: true,
      docker: true,
      ollama: true,
    });
    expect(JSON.stringify(output)).not.toMatch(/GROQ_API_KEY|DATABASE_URL|rtsp:\/\//i);
  });

  it('expõe status redigido e preserva os defaults opt-in', async () => {
    const output = await runSupervisor('Status');
    const defaults = output.safeDefaults as Record<string, unknown>;

    expect(output.taskName).toBe('Jarvis Core');
    expect(defaults).toEqual({
      detectorAutostart: false,
      cloudSttPromotion: false,
      physicalActions: false,
      funnel: false,
    });
    expect(JSON.stringify(output)).not.toMatch(/GROQ_API_KEY|DATABASE_URL|rtsp:\/\//i);
  }, 20_000);

  it('declara os limites do Task Scheduler e não configura Funnel', async () => {
    const source = await readFile(supervisorPath, 'utf8');

    expect(source).toContain("'InstallTask'");
    expect(source).toContain("'RemoveTask'");
    expect(source).toContain('InteractiveToken');
    expect(source).toContain('IgnoreNew');
    expect(source).toContain('<Delay>PT30S</Delay>');
    expect(source).toContain('RestartOnFailure');
    expect(source).toContain('Test-OwnedProcessIdentity');
    expect(source).toContain('coreStartTimeUtc');
    expect(source).toContain('supervisor_stop_timeout');
    expect(source).toContain('compose_stop_failed');
    expect(source).not.toMatch(/tailscale\s+funnel/i);
  });
});
