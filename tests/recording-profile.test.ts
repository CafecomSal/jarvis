import { describe, expect, it } from 'vitest';
import { getRecordingProfile } from '../src/recordings/recording-profile.js';

describe('perfis de gravação', () => {
  it('define um contínuo econômico menor que o evento de alta qualidade', () => {
    const economic = getRecordingProfile('continuous-economic');
    const event = getRecordingProfile('event-high-quality');

    expect(economic.width * economic.height).toBeLessThan(event.width * event.height);
    expect(economic.videoBitrateKbps).toBeLessThan(event.videoBitrateKbps);
    expect(economic.segmentDurationMs).toBeGreaterThan(0);
  });

  it('não compartilha referência mutável entre chamadas', () => {
    const first = getRecordingProfile('continuous-economic');
    first.videoBitrateKbps = 1;
    expect(getRecordingProfile('continuous-economic').videoBitrateKbps).toBeGreaterThan(1);
  });
});
