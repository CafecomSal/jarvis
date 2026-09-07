import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DetectorSupervisor } from '../src/vision/detector-supervisor.js';
import {
  buildDetectorChildEnvironment,
  buildDetectorChildCommand,
  parseDetectorSupervisorOptions,
} from '../src/vision/run-detector-supervisor.js';

class FakeChild extends EventEmitter {
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('supervisor do detector', () => {
  it('inicia uma única criança e reinicia após encerramento inesperado', async () => {
    const children: FakeChild[] = [];
    const delays: number[] = [];
    const logs: string[] = [];
    const supervisor = new DetectorSupervisor({
      command: 'node',
      args: ['detector'],
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      maxRestarts: 2,
      restartDelayMs: 25,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      onLog: (message) => logs.push(message),
    });

    supervisor.start();
    supervisor.start();
    expect(children).toHaveLength(1);

    children[0].exit(1);
    await flush();
    expect(children).toHaveLength(2);
    expect(delays).toEqual([25]);
    expect(logs).toContain('Detector exited unexpectedly; restarting (1/2)');
  });

  it('para sem reiniciar e envia SIGTERM para a criança ativa', async () => {
    const children: FakeChild[] = [];
    const supervisor = new DetectorSupervisor({
      command: 'node',
      args: ['detector'],
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      restartDelayMs: 0,
      sleep: async () => undefined,
    });

    supervisor.start();
    supervisor.stop();
    expect(children[0].killCalls).toBe(1);

    children[0].exit(1);
    await flush();
    expect(children).toHaveLength(1);
  });

  it('encerra após o limite de reinícios e registra a falha', async () => {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    const supervisor = new DetectorSupervisor({
      command: 'node',
      args: ['detector'],
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      maxRestarts: 1,
      restartDelayMs: 0,
      sleep: async () => undefined,
      onLog: (message) => logs.push(message),
    });

    supervisor.start();
    children[0].exit(1);
    await flush();
    children[1].exit(1);
    await flush();

    expect(children).toHaveLength(2);
    expect(logs).toContain('Detector restart limit reached (1)');
  });

  it('usa dry-run por padrão e exige --publish para enviar eventos', () => {
    expect(parseDetectorSupervisorOptions([], {})).toEqual({
      dryRun: true,
      maxRestarts: 3,
      restartDelayMs: 5_000,
    });
    expect(parseDetectorSupervisorOptions(['--publish'], {
      JARVIS_DETECTOR_MAX_RESTARTS: '5',
      JARVIS_DETECTOR_RESTART_DELAY_MS: '2500',
    })).toEqual({
      dryRun: false,
      maxRestarts: 5,
      restartDelayMs: 2_500,
    });
  });

  it('rejeita opções conflitantes ou desconhecidas', () => {
    expect(() => parseDetectorSupervisorOptions(['--dry-run', '--publish'], {})).toThrow(
      'Detector supervisor cannot combine --dry-run and --publish',
    );
    expect(() => parseDetectorSupervisorOptions(['--once'], {})).toThrow(
      'Unknown detector supervisor argument: --once',
    );
  });

  it('usa node.exe diretamente para evitar EINVAL ao iniciar no Windows', () => {
    expect(buildDetectorChildCommand(true)).toEqual({
      command: process.execPath,
      args: [
        '--env-file=.env',
        '--import',
        'tsx/esm',
        'src/vision/run-person-detector.ts',
        '--dry-run',
      ],
    });
  });

  it('repassa --publish explicitamente ao filho quando o supervisor publica', () => {
    expect(buildDetectorChildCommand(false)).toEqual({
      command: process.execPath,
      args: [
        '--env-file=.env',
        '--import',
        'tsx/esm',
        'src/vision/run-person-detector.ts',
        '--publish',
      ],
    });
  });

  it('passa o PID do supervisor ao processo filho para evitar órfãos', () => {
    expect(buildDetectorChildEnvironment(2120).JARVIS_DETECTOR_PARENT_PID).toBe('2120');
  });
});
