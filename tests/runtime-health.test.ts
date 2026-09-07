import { describe, expect, it } from 'vitest';
import { countProcesses, parseGpuStats } from '../src/health/runtime-health.js';

describe('parsers de health runtime', () => {
  it('interpreta saída do nvidia-smi sem depender de locale', () => {
    expect(parseGpuStats('3090, 8192, 12\n')).toEqual({
      memoryUsedMiB: 3090,
      memoryTotalMiB: 8192,
      utilizationPercent: 12,
    });
  });

  it('conta processos por nome sem retornar command lines', () => {
    expect(countProcesses('"ffmpeg.exe","1"\n"node.exe","2"\n"ffmpeg.exe","3"\n', ['ffmpeg.exe', 'node.exe'])).toEqual({
      'ffmpeg.exe': 2,
      'node.exe': 1,
    });
  });
});
