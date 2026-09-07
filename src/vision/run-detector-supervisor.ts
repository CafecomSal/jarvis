import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DetectorSupervisor } from './detector-supervisor.js';

export interface DetectorSupervisorCliOptions {
  dryRun: boolean;
  maxRestarts: number;
  restartDelayMs: number;
}

type Environment = Record<string, string | undefined>;

function parseNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function parseNonNegativeInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = parseNumber(name, value, fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseDetectorSupervisorOptions(
  argv: string[] = process.argv.slice(2),
  env: Environment = process.env,
): DetectorSupervisorCliOptions {
  const supported = new Set(['--dry-run', '--publish']);
  const unknown = argv.find((argument) => !supported.has(argument));
  if (unknown) throw new Error(`Unknown detector supervisor argument: ${unknown}`);
  if (argv.includes('--dry-run') && argv.includes('--publish')) {
    throw new Error('Detector supervisor cannot combine --dry-run and --publish');
  }

  const maxRestarts = parseNonNegativeInteger(
    'JARVIS_DETECTOR_MAX_RESTARTS',
    env.JARVIS_DETECTOR_MAX_RESTARTS,
    3,
  );
  const restartDelayMs = parseNumber(
    'JARVIS_DETECTOR_RESTART_DELAY_MS',
    env.JARVIS_DETECTOR_RESTART_DELAY_MS,
    5_000,
  );
  if (restartDelayMs < 0) {
    throw new Error('JARVIS_DETECTOR_RESTART_DELAY_MS must be zero or greater');
  }

  return {
    dryRun: !argv.includes('--publish'),
    maxRestarts,
    restartDelayMs,
  };
}

export function buildDetectorChildCommand(dryRun: boolean): { command: string; args: string[] } {
  const args = [
    '--env-file=.env',
    '--import',
    'tsx/esm',
    'src/vision/run-person-detector.ts',
  ];
  if (dryRun) args.push('--dry-run');
  else args.push('--publish');
  return { command: process.execPath, args };
}

export function buildDetectorChildEnvironment(parentPid: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JARVIS_DETECTOR_PARENT_PID: String(parentPid),
  };
}

export function runDetectorSupervisor(options: DetectorSupervisorCliOptions): void {
  const childCommand = buildDetectorChildCommand(options.dryRun);
  const supervisor = new DetectorSupervisor({
    command: childCommand.command,
    args: childCommand.args,
    spawn: (command, args) => spawn(command, [...args], {
      stdio: 'inherit',
      windowsHide: true,
      env: buildDetectorChildEnvironment(process.pid),
    }),
    maxRestarts: options.maxRestarts,
    restartDelayMs: options.restartDelayMs,
    onLog: (message) => console.error(`[detector-supervisor] ${message}`),
  });

  const shutdown = (): void => {
    supervisor.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  supervisor.start();
  console.log(`Detector supervisor running: mode=${options.dryRun ? 'dry-run' : 'publish'} maxRestarts=${options.maxRestarts} restartDelayMs=${options.restartDelayMs}`);
}

const isMainModule = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  try {
    runDetectorSupervisor(parseDetectorSupervisorOptions());
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
