import { describe, expect, it } from 'vitest';
import { parseRecordingArchiveOptions } from '../src/recordings/run-recording-archive.js';

describe('CLI de arquivamento de gravação', () => {
  it('exige ID explícito e usa catálogo/raiz local por padrão', () => {
    expect(parseRecordingArchiveOptions(['--id', 'rec-1'], {})).toEqual({
      recordingId: 'rec-1',
      rootDirectory: 'data/recordings',
    });
    expect(parseRecordingArchiveOptions(['--id=rec-2'], {
      JARVIS_RECORDING_OUTPUT_DIR: 'archive/recordings',
    })).toEqual({
      recordingId: 'rec-2',
      rootDirectory: 'archive/recordings',
    });
  });

  it('rejeita ID ausente ou argumento desconhecido', () => {
    expect(() => parseRecordingArchiveOptions([], {})).toThrow('Recording archive requires --id');
    expect(() => parseRecordingArchiveOptions(['--bad'], {})).toThrow(
      'Unknown recording archive argument: --bad',
    );
  });
});
