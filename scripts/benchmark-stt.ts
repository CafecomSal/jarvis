import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { GroqSttProvider } from '../src/audio/providers/groq-stt.js';
import { FasterWhisperSttProvider } from '../src/audio/providers/faster-whisper-stt.js';
import type { SttProvider } from '../src/audio/stt-provider.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordErrorRate(expected: string, actual: string): number | undefined {
  const reference = normalize(expected);
  const hypothesis = normalize(actual);
  if (reference.length === 0) return undefined;
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= hypothesis.length; column += 1) {
      const above = previous[column];
      const cost = reference[row - 1] === hypothesis[column - 1] ? 0 : 1;
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[hypothesis.length] / reference.length;
}

async function runProvider(name: string, provider: SttProvider, audio: Buffer, mimeType: string, expected?: string) {
  const started = performance.now();
  try {
    const result = await provider.transcribe(audio, mimeType);
    return {
      provider: name,
      model: result.model,
      processingLocation: result.processingLocation ?? (name === 'groq' ? 'cloud' : 'local'),
      latencyMs: Math.round(result.latencyMs),
      wallClockMs: Math.round(performance.now() - started),
      confidence: result.confidence,
      durationMs: result.durationMs,
      text: result.text,
      ...(expected ? { wer: wordErrorRate(expected, result.text) } : {}),
    };
  } catch (error) {
    return {
      provider: name,
      error: error instanceof Error ? error.message : 'provider failed',
      wallClockMs: Math.round(performance.now() - started),
    };
  } finally {
    await (provider as SttProvider & { close?: () => Promise<void> }).close?.();
  }
}

const audioPath = arg('--audio') ?? 'data/audio/tts/piper-smoke.wav';
const expected = arg('--expected');
const audio = await readFile(audioPath);
const results = [await runProvider('faster-whisper', new FasterWhisperSttProvider({ model: process.env.JARVIS_STT_MODEL ?? 'medium' }), audio, 'audio/wav', expected)];
const key = process.env.GROQ_API_KEY?.trim();
if (key) {
  results.push(await runProvider('groq-turbo', new GroqSttProvider({ apiKey: key, model: 'whisper-large-v3-turbo', language: 'pt-BR' }), audio, 'audio/wav', expected));
  results.push(await runProvider('groq-large-v3', new GroqSttProvider({ apiKey: key, model: 'whisper-large-v3', language: 'pt-BR' }), audio, 'audio/wav', expected));
} else {
  results.push({ provider: 'groq', skipped: true, reason: 'GROQ_API_KEY não configurada no backend' });
}
console.log(JSON.stringify({ audioPath, audioBytes: audio.length, expectedProvided: Boolean(expected), results }, undefined, 2));
