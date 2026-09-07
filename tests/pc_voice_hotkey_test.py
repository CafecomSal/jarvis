import base64
import io
import unittest
import wave

from scripts.pc_voice_hotkey import build_audio_payload, decode_response_audio, encode_wav


class PcVoiceHotkeyTest(unittest.TestCase):
    def test_encode_wav_creates_pcm_file_and_payload_has_no_raw_audio(self):
        wav = encode_wav([0, 1000, -1000], sample_rate=16000)
        with wave.open(io.BytesIO(wav), 'rb') as reader:
            self.assertEqual(reader.getnchannels(), 1)
            self.assertEqual(reader.getframerate(), 16000)
            self.assertEqual(reader.getsampwidth(), 2)
            self.assertEqual(reader.getnframes(), 3)
        payload = build_audio_payload(wav, 'audio/wav')
        self.assertEqual(payload['mimeType'], 'audio/wav')
        self.assertEqual(base64.b64decode(payload['audioBase64']), wav)
        self.assertNotIn('rawAudio', payload)

    def test_decode_response_audio_rejects_missing_or_invalid_payload(self):
        self.assertEqual(decode_response_audio({'audio': {'audioBase64': 'd2F2'}}), b'wav')
        with self.assertRaises(ValueError):
            decode_response_audio({'audio': {}})
        with self.assertRaises(ValueError):
            decode_response_audio({'audio': {'audioBase64': '%%%'}})


if __name__ == '__main__':
    unittest.main()
