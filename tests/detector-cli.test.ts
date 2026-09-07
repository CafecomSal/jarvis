import { describe, expect, it } from 'vitest';
import {
  createDetectorEventAppender,
  parseDetectorOptions,
  startDetectorParentMonitor,
} from '../src/vision/run-person-detector.js';

describe('configuração do worker ONNX', () => {
  it('usa defaults seguros e permite sobrescrever câmera, modelo e amostragem', () => {
    expect(parseDetectorOptions([], {
      JARVIS_ONNX_MODEL_PATH: 'models/custom.onnx',
      JARVIS_DETECTOR_CAMERA: 'front',
      JARVIS_DETECTOR_INTERVAL_MS: '2500',
      JARVIS_DETECTOR_CONFIDENCE_THRESHOLD: '0.4',
    })).toEqual({
      camera: 'front',
      modelPath: 'models/custom.onnx',
      intervalMs: 2500,
      confidenceThreshold: 0.4,
      rtspTransport: 'udp',
      confirmationFrames: 2,
      confirmationWindowMs: 5000,
      dryRun: true,
      once: false,
      statusFile: 'data/detector/status.json',
    });
  });

  it('exige --publish para publicar eventos no Core', () => {
    expect(parseDetectorOptions(['--publish'], {})).toMatchObject({
      dryRun: false,
      once: false,
      statusFile: 'data/detector/status.json',
    });
  });

  it('aceita --once para uma captura controlada sem loop contínuo', () => {
    expect(parseDetectorOptions(['--once'], {})).toMatchObject({
      once: true,
      camera: 'front',
      intervalMs: 1000,
      confidenceThreshold: 0.35,
      rtspTransport: 'udp',
      confirmationFrames: 2,
      confirmationWindowMs: 5000,
      dryRun: true,
      statusFile: 'data/detector/status.json',
    });
  });

  it('aceita --dry-run para observar sem publicar eventos no Core', async () => {
    const calls: string[] = [];
    const appender = createDetectorEventAppender({
      dryRun: true,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response('{}', { status: 500 });
      },
    });

    expect(parseDetectorOptions(['--dry-run'], {})).toMatchObject({
      dryRun: true,
      once: false,
    });
    await appender.append({
      id: 'evt-dry-run-test',
      type: 'person.detected',
      timestamp: '2026-09-01T20:00:00Z',
      source: { type: 'onnx', id: 'yolo11n.onnx' },
      location: 'frente',
      subject: { type: 'person', id: 'unknown' },
      confidence: 0.8,
      data: {},
    });
    expect(calls).toEqual([]);
  });

  it('permite configurar confirmação temporal e rejeita valores inválidos', () => {
    expect(parseDetectorOptions([], {
      JARVIS_DETECTOR_CONFIRMATION_FRAMES: '3',
      JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS: '8000',
    })).toMatchObject({
      confirmationFrames: 3,
      confirmationWindowMs: 8000,
    });
    expect(() => parseDetectorOptions([], {
      JARVIS_DETECTOR_CONFIRMATION_FRAMES: '0',
    })).toThrow('JARVIS_DETECTOR_CONFIRMATION_FRAMES must be a positive integer');
    expect(() => parseDetectorOptions([], {
      JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS: '0',
    })).toThrow('JARVIS_DETECTOR_CONFIRMATION_WINDOW_MS must be greater than zero');
  });

  it('lê regiões excluídas por câmera a partir de JSON validado', () => {
    expect(parseDetectorOptions([], {
      JARVIS_DETECTOR_EXCLUDED_REGIONS: '{"front":[{"x1":400,"y1":0,"x2":520,"y2":180}]}',
    })).toMatchObject({
      excludedRegions: {
        front: [{ x1: 400, y1: 0, x2: 520, y2: 180 }],
      },
    });
  });

  it('rejeita região excluída com limites inválidos', () => {
    expect(() => parseDetectorOptions([], {
      JARVIS_DETECTOR_EXCLUDED_REGIONS: '{"front":[{"x1":10,"y1":10,"x2":5,"y2":20}]}',
    })).toThrow('JARVIS_DETECTOR_EXCLUDED_REGIONS contains an invalid region');
  });

  it('permite selecionar transporte RTSP e rejeita valores desconhecidos', () => {
    expect(parseDetectorOptions([], { JARVIS_RTSP_TRANSPORT: 'tcp' })).toMatchObject({
      rtspTransport: 'tcp',
    });
    expect(() => parseDetectorOptions([], { JARVIS_RTSP_TRANSPORT: 'http' })).toThrow(
      'JARVIS_RTSP_TRANSPORT must be udp or tcp',
    );
  });

  it('rejeita intervalo e limiar fora dos limites', () => {
    expect(() => parseDetectorOptions([], { JARVIS_DETECTOR_INTERVAL_MS: '0' })).toThrow(
      'JARVIS_DETECTOR_INTERVAL_MS must be greater than zero',
    );
    expect(() => parseDetectorOptions([], { JARVIS_DETECTOR_CONFIDENCE_THRESHOLD: '1.2' })).toThrow(
      'JARVIS_DETECTOR_CONFIDENCE_THRESHOLD must be between 0 and 1',
    );
  });

  it('encerra o monitor filho quando o supervisor pai desaparece', () => {
    let heartbeat: (() => void) | undefined;
    let cleared = false;
    let parentAlive = true;
    let parentGone = 0;
    const cleanup = startDetectorParentMonitor('4321', {
      isAlive: () => parentAlive,
      setInterval: (callback) => {
        heartbeat = callback;
        return {} as NodeJS.Timeout;
      },
      clearInterval: () => {
        cleared = true;
      },
      onParentGone: () => {
        parentGone += 1;
      },
    });

    heartbeat?.();
    expect(parentGone).toBe(0);
    parentAlive = false;
    heartbeat?.();
    expect(parentGone).toBe(1);
    expect(cleared).toBe(true);
    cleanup();
    expect(parentGone).toBe(1);
  });
});
