import { describe, expect, it } from 'vitest';
import { parseRecordingRetentionOptions } from '../src/recordings/run-recording-retention.js';

describe('CLI de retenção DVR', () => {
  it('usa dry-run, 30 dias contínuos e 90 dias de eventos por padrão', () => {
    expect(parseRecordingRetentionOptions([], {})).toEqual({
      dryRun: true,
      maxAgeDays: 30,
      eventMaxAgeDays: 90,
      maxBytes: undefined,
      deleteAfterVerified: false,
    });
  });

  it('exige --archive para enviar candidatos e valida limites', () => {
    expect(parseRecordingRetentionOptions(['--archive'], {
      JARVIS_RECORDING_MAX_AGE_DAYS: '3',
      JARVIS_RECORDING_EVENT_MAX_AGE_DAYS: '12',
      JARVIS_RECORDING_MAX_BYTES: '1000000',
      JARVIS_RECORDING_DELETE_LOCAL_AFTER_VERIFY: 'true',
    })).toEqual({
      dryRun: false,
      maxAgeDays: 3,
      eventMaxAgeDays: 12,
      maxBytes: 1_000_000,
      deleteAfterVerified: true,
    });
    expect(() => parseRecordingRetentionOptions(['--dry-run', '--archive'], {})).toThrow(
      'Recording retention cannot combine --dry-run and --archive',
    );
    expect(() => parseRecordingRetentionOptions(['--bad'], {})).toThrow(
      'Unknown recording retention argument: --bad',
    );
  });
});
