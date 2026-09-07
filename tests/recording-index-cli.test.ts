import { describe, expect, it } from 'vitest';
import { parseRecordingIndexOptions } from '../src/recordings/run-index-recording.js';

describe('CLI de indexação histórica', () => {
  it('exige ID e usa amostragem sem OCR por padrão', () => {
    expect(parseRecordingIndexOptions(['--id', 'rec-1'], {})).toEqual({
      recordingId: 'rec-1',
      includeOcr: false,
      intervalMs: 1_000,
    });
  });

  it('permite OCR e intervalo configurável sem aceitar argumentos desconhecidos', () => {
    expect(parseRecordingIndexOptions(['--id=rec-2', '--ocr'], {
      JARVIS_RECORDING_INDEX_INTERVAL_MS: '2000',
    })).toEqual({
      recordingId: 'rec-2',
      includeOcr: true,
      intervalMs: 2_000,
    });
    expect(() => parseRecordingIndexOptions([], {})).toThrow('Recording index requires --id');
    expect(() => parseRecordingIndexOptions(['--id', 'rec-1', '--bad'], {})).toThrow(
      'Unknown recording index argument: --bad',
    );
  });
});
