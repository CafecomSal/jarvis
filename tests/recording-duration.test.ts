import { describe, expect, it } from 'vitest';
import { getRecordingProfile } from '../src/recordings/recording-profile.js';
import { effectiveRecordingDurationMs } from '../src/recordings/run-recording.js';

describe('duração efetiva dos segmentos', () => {
  it('usa 60 segundos no perfil econômico contínuo', () => {
    expect(effectiveRecordingDurationMs(10_000, getRecordingProfile('continuous-economic'))).toBe(60_000);
  });

  it('preserva duração explícita para export manual', () => {
    expect(effectiveRecordingDurationMs(12_000, undefined)).toBe(12_000);
  });
});
