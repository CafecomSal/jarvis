export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

const speechAudioConstraints: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16000 },
  sampleSize: { ideal: 16 },
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
};

export function audioConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      ...speechAudioConstraints,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

export function preferredAudioInput(inputs: readonly AudioInputDevice[]): AudioInputDevice | undefined {
  const fifine = inputs.find((input) => /fifine/i.test(input.label));
  if (fifine) return fifine;
  const physical = inputs.find((input) => !/(nvidia broadcast|steam streaming|virtual|mixagem estéreo|stereo mix|communications)/i.test(input.label));
  return physical ?? inputs[0];
}
