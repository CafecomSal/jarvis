import { describe, expect, it } from 'vitest';
import {
  InMemorySttUsageStore,
  SttQuotaGuard,
  type SttQuotaLimits,
} from '../src/audio/stt-usage-store.js';
import { parseAudioDurationSeconds } from '../src/audio/audio-duration-probe.js';

const limits: SttQuotaLimits = {
  maxRequestsPerDay: 2,
  maxAudioSecondsPerDay: 30,
  maxEstimatedMonthlyUsd: 1,
};

describe('quota local de STT cloud', () => {
  it('bloqueia requisições quando requests ou segundos excedem o teto', async () => {
    const store = new InMemorySttUsageStore();
    const guard = new SttQuotaGuard(store, limits, () => '2026-09-05');

    expect(await guard.canUse({ audioSeconds: 10, estimatedUsd: 0.01 })).toBe(true);
    await guard.record({ sessionId: 's1', audioSeconds: 10, estimatedUsd: 0.01 });
    expect(await guard.canUse({ audioSeconds: 20, estimatedUsd: 0.01 })).toBe(true);
    await guard.record({ sessionId: 's2', audioSeconds: 20, estimatedUsd: 0.01 });
    expect(await guard.canUse({ audioSeconds: 1, estimatedUsd: 0.01 })).toBe(false);
  });

  it('aplica o teto mensal acumulando custo de dias anteriores', async () => {
    const store = new InMemorySttUsageStore();
    await store.record('2026-09-01', { sessionId: 'previous-day', audioSeconds: 10, estimatedUsd: 0.9 });
    const guard = new SttQuotaGuard(store, limits, () => '2026-09-05');

    expect(await guard.canUse({ audioSeconds: 1, estimatedUsd: 0.2 })).toBe(false);
    expect(await guard.snapshot()).toMatchObject({ monthlyEstimatedUsd: 0.9, remainingEstimatedUsd: 0.1 });
  });

  it('é idempotente por sessionId e expõe remaining sem valores negativos', async () => {
    const store = new InMemorySttUsageStore();
    const guard = new SttQuotaGuard(store, limits, () => '2026-09-05');
    await guard.record({ sessionId: 'same', audioSeconds: 10, estimatedUsd: 0.1 });
    await guard.record({ sessionId: 'same', audioSeconds: 10, estimatedUsd: 0.1 });

    expect(await guard.snapshot()).toMatchObject({
      requests: 1,
      audioSeconds: 10,
      estimatedUsd: 0.1,
      remainingRequests: 1,
      remainingAudioSeconds: 20,
      remainingEstimatedUsd: 0.9,
    });
  });
});

describe('parser de duração de áudio', () => {
  it('aceita duração finita e rejeita saída inválida', () => {
    expect(parseAudioDurationSeconds('1.250\n')).toBe(1.25);
    expect(parseAudioDurationSeconds('0')).toBe(0);
    expect(parseAudioDurationSeconds('N/A')).toBeUndefined();
    expect(parseAudioDurationSeconds('-1')).toBeUndefined();
  });
});
