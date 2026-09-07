import { describe, expect, it } from 'vitest';
import { RapidOcrEngine, resolveOcrPythonPath } from '../src/vision/ocr-engine.js';

describe('engine OCR', () => {
  it('combina regiões, normaliza texto e preserva caixas/confiança', async () => {
    const engine = new RapidOcrEngine({
      run: async () => ({
        latencyMs: 125,
        regions: [
          { text: 'Portão 1234', confidence: 0.9, box: { x1: 10, y1: 20, x2: 100, y2: 50 } },
          { text: 'Casa Davi', confidence: 0.8, box: { x1: 10, y1: 60, x2: 140, y2: 90 } },
        ],
      }),
    });

    await expect(engine.recognize(Buffer.from('jpeg'))).resolves.toEqual({
      text: 'Portão 1234 Casa Davi',
      normalizedText: 'PORTAO1234CASADAVI',
      confidence: 0.85,
      regions: [
        { text: 'Portão 1234', confidence: 0.9, box: { x1: 10, y1: 20, x2: 100, y2: 50 } },
        { text: 'Casa Davi', confidence: 0.8, box: { x1: 10, y1: 60, x2: 140, y2: 90 } },
      ],
      latencyMs: 125,
    });
  });

  it('ignora regiões vazias e rejeita resultado sem texto', async () => {
    const engine = new RapidOcrEngine({
      run: async () => ({ latencyMs: 1, regions: [{ text: '   ', confidence: 0.9, box: { x1: 1, y1: 1, x2: 2, y2: 2 } }] }),
    });

    await expect(engine.recognize(Buffer.from('jpeg'))).rejects.toThrow('OCR returned no text');
  });

  it('deduplica textos idênticos em painéis sem remover as regiões', async () => {
    const engine = new RapidOcrEngine({
      run: async () => ({
        latencyMs: 10,
        regions: [
          { text: '2026-09-04 02:43:18', confidence: 0.98, box: { x1: 1, y1: 1, x2: 10, y2: 10 } },
          { text: '2026-09-04 02:43:18', confidence: 0.97, box: { x1: 1, y1: 11, x2: 10, y2: 20 } },
        ],
      }),
    });

    const result = await engine.recognize(Buffer.from('jpeg'));
    expect(result).toMatchObject({
      text: '2026-09-04 02:43:18',
      normalizedText: '20260904024318',
    });
    expect(result.regions).toHaveLength(2);
    expect(result.regions[0]).toMatchObject({ text: '2026-09-04 02:43:18', confidence: 0.98 });
    expect(result.regions[1]).toMatchObject({ text: '2026-09-04 02:43:18', confidence: 0.97 });
  });

  it('ignora regiões fixas de overlay e preserva texto da cena', async () => {
    const engine = new RapidOcrEngine({
      excludedRegions: [{ x1: 0, y1: 0, x2: 600, y2: 80 }],
      run: async () => ({
        latencyMs: 10,
        regions: [
          { text: '2026-09-04 02:43:18', confidence: 0.98, box: { x1: 10, y1: 10, x2: 500, y2: 50 } },
          { text: 'PORTAO', confidence: 0.9, box: { x1: 700, y1: 500, x2: 900, y2: 550 } },
        ],
      }),
    });

    const result = await engine.recognize(Buffer.from('jpeg'));

    expect(result.text).toBe('PORTAO');
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].text).toBe('PORTAO');
  });

  it('prefere o caminho configurado e depois o venv local do OCR', () => {
    expect(resolveOcrPythonPath({ JARVIS_OCR_PYTHON: 'python-custom' }, () => false)).toBe('python-custom');
    expect(resolveOcrPythonPath({}, () => true)).toMatch(/tools[\\/]ocr[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/);
  });
});
