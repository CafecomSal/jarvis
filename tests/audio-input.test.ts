import { describe, expect, it } from 'vitest';
import { audioConstraints, preferredAudioInput, type AudioInputDevice } from '../web/src/audio/audio-input.js';

describe('seleção de entrada de áudio', () => {
  it('solicita captura de fala mono com ganho e supressão de ruído', () => {
    expect(audioConstraints()).toEqual({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16000 },
        sampleSize: { ideal: 16 },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
      },
    });
    expect(audioConstraints('device-1')).toEqual({
      audio: {
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16000 },
        sampleSize: { ideal: 16 },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        deviceId: { exact: 'device-1' },
      },
    });
  });

  it('prefere microfone físico conhecido a entradas virtuais', () => {
    const inputs: AudioInputDevice[] = [
      { deviceId: 'nvidia', label: 'Microfone (NVIDIA Broadcast)' },
      { deviceId: 'fifine', label: 'Microfone (3- Fifine Microphone)' },
      { deviceId: 'steam', label: 'Microfone (Steam Streaming Microphone)' },
    ];
    expect(preferredAudioInput(inputs)).toEqual(inputs[1]);
  });
});
