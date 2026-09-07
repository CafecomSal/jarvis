import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FasterWhisperSttProvider } from '../src/audio/providers/faster-whisper-stt.js';
import { PiperTtsProvider } from '../src/audio/providers/piper-tts.js';

describe('providers de áudio', () => {
  it('normaliza transcript do Faster-Whisper com metadados', async () => {
    const provider = new FasterWhisperSttProvider({
      runner: async () => ({ text: '  Olá Jarvis  ', language: 'pt', confidence: 0.91 }),
      model: 'base',
    });

    const result = await provider.transcribe(Buffer.from('wav'), 'audio/wav');

    expect(result).toMatchObject({ text: 'Olá Jarvis', language: 'pt-BR', confidence: 0.91, model: 'base', provider: 'faster-whisper' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('usa medium como padrão para priorizar reconhecimento em português', async () => {
    let selectedModel = '';
    const provider = new FasterWhisperSttProvider({
      runner: async (_audio, _mimeType, model) => {
        selectedModel = model;
        return { text: 'Olá Jarvis', language: 'pt', confidence: 0.9 };
      },
    });

    await provider.transcribe(Buffer.from('wav'), 'audio/wav');

    expect(selectedModel).toBe('medium');
  });

  it('mantém o processo do Faster-Whisper residente entre sessões', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-stt-worker-test-'));
    const workerPath = join(directory, 'worker.py');
    await writeFile(workerPath, [
      'import json, sys',
      'count = 0',
      "print(json.dumps({'type': 'ready'}), flush=True)",
      'for line in sys.stdin:',
      '    request = json.loads(line)',
      '    count += 1',
      "    print(json.dumps({'type': 'result', 'id': request['id'], 'ok': True, 'text': f'worker-{count}', 'language': 'pt', 'confidence': 0.95}), flush=True)",
    ].join('\n'));
    const provider = new FasterWhisperSttProvider({ model: 'medium', pythonCommand: 'python', workerPath });
    try {
      const first = await provider.transcribe(Buffer.from('one'), 'audio/wav');
      const second = await provider.transcribe(Buffer.from('two'), 'audio/wav');
      expect(first.text).toBe('worker-1');
      expect(second.text).toBe('worker-2');
    } finally {
      await provider.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('gera áudio Piper por runner injetado e rejeita texto vazio', async () => {
    const provider = new PiperTtsProvider({
      modelPath: 'pt_BR-jeff-medium.onnx',
      runner: async (text) => Buffer.from(`wav:${text}`),
    });

    const result = await provider.synthesize({ text: 'Bom dia, Davi.', language: 'pt-BR' });

    expect(result.audio.toString()).toBe('wav:Bom dia, Davi.');
    expect(result).toMatchObject({ provider: 'piper', model: 'pt_BR-jeff-medium.onnx', mimeType: 'audio/wav' });
    await expect(provider.synthesize({ text: '   ' })).rejects.toThrow('TTS text must not be empty');
  });
});
