export interface PiperRuntimeCommand {
  command: string;
  commandArgs: string[];
}

export function piperRuntimeCommand(env: Record<string, string | undefined> = process.env): PiperRuntimeCommand {
  return {
    command: env.PIPER_COMMAND?.trim() || 'piper',
    commandArgs: [],
  };
}
