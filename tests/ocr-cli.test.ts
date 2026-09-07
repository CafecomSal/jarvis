import { describe, expect, it } from 'vitest';
import { parseOcrOptions } from '../src/vision/run-ocr.js';

describe('CLI OCR', () => {
  it('usa captura única, dry-run e configuração local por padrão', () => {
    expect(parseOcrOptions(['--once'], {})).toEqual({
      camera: 'front',
      model: 'rapidocr-onnxruntime',
      provider: 'CPUExecutionProvider',
      rtspTransport: 'udp',
      once: true,
      dryRun: true,
    });
  });

  it('lê regiões excluídas de overlay em JSON', () => {
    expect(parseOcrOptions(['--once'], {
      JARVIS_OCR_EXCLUDED_REGIONS: '{"front":[{"x1":0,"y1":0,"x2":600,"y2":80}]}',
    })).toMatchObject({
      excludedRegions: {
        front: [{ x1: 0, y1: 0, x2: 600, y2: 80 }],
      },
    });
    expect(() => parseOcrOptions(['--once'], {
      JARVIS_OCR_EXCLUDED_REGIONS: '[]',
    })).toThrow('JARVIS_OCR_EXCLUDED_REGIONS must be a JSON object');
  });

  it('exige --publish para persistir OCR no Core', () => {
    expect(parseOcrOptions(['--once', '--publish'], {
      JARVIS_OCR_CAMERA: 'front',
      JARVIS_OCR_MODEL: 'rapidocr-custom',
      JARVIS_OCR_PROVIDER: 'CPUExecutionProvider',
      JARVIS_RTSP_TRANSPORT: 'tcp',
    })).toMatchObject({
      camera: 'front',
      model: 'rapidocr-custom',
      provider: 'CPUExecutionProvider',
      rtspTransport: 'tcp',
      dryRun: false,
    });
    expect(() => parseOcrOptions(['--once', '--dry-run', '--publish'], {})).toThrow(
      'OCR cannot combine --dry-run and --publish',
    );
  });
});
