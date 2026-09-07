import { describe, expect, it } from 'vitest';
import { piperRuntimeCommand } from '../src/audio/piper-runtime.js';

describe('comando runtime do Piper', () => {
  it('usa o executável Piper do PATH por padrão, sem forçar o Python errado', () => {
    expect(piperRuntimeCommand({})).toEqual({ command: 'piper', commandArgs: [] });
  });

  it('respeita PIPER_COMMAND explícito', () => {
    expect(piperRuntimeCommand({ PIPER_COMMAND: 'C:/voice/piper.exe' })).toEqual({
      command: 'C:/voice/piper.exe',
      commandArgs: [],
    });
  });
});
