export interface DetectorChild {
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type DetectorSpawn = (command: string, args: readonly string[]) => DetectorChild;

export interface DetectorSupervisorOptions {
  command: string;
  args?: readonly string[];
  spawn: DetectorSpawn;
  maxRestarts?: number;
  restartDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onLog?: (message: string) => void;
}

export class DetectorSupervisor {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly spawn: DetectorSpawn;
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onLog?: (message: string) => void;
  private child?: DetectorChild;
  private restartCount = 0;
  private stopping = false;

  constructor(options: DetectorSupervisorOptions) {
    this.command = options.command.trim();
    this.args = options.args ?? [];
    this.spawn = options.spawn;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.restartDelayMs = options.restartDelayMs ?? 1_000;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onLog = options.onLog;

    if (!this.command) throw new Error('Detector supervisor command must not be empty');
    if (!Number.isInteger(this.maxRestarts) || this.maxRestarts < 0) {
      throw new Error('Detector supervisor maxRestarts must be a non-negative integer');
    }
    if (!Number.isFinite(this.restartDelayMs) || this.restartDelayMs < 0) {
      throw new Error('Detector supervisor restartDelayMs must be zero or greater');
    }
  }

  start(): void {
    if (this.child || this.stopping) return;
    this.stopping = false;
    this.launch();
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGTERM');
  }

  private launch(): void {
    const child = this.spawn(this.command, this.args);
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopping) return;
      void this.handleUnexpectedExit(code, signal);
    });
  }

  private async handleUnexpectedExit(_code: number | null, _signal: NodeJS.Signals | null): Promise<void> {
    if (this.restartCount >= this.maxRestarts) {
      this.onLog?.(`Detector restart limit reached (${this.maxRestarts})`);
      return;
    }

    this.restartCount += 1;
    this.onLog?.(`Detector exited unexpectedly; restarting (${this.restartCount}/${this.maxRestarts})`);
    await this.sleep(this.restartDelayMs);
    if (this.stopping || this.child) return;
    this.launch();
  }
}
