import { describe, expect, it } from 'vitest';
import { InMemorySttUsageStore, SttQuotaGuard } from '../src/audio/stt-usage-store.js';

describe('atualização da quota de STT', () => {
  it('aplica novos limites sem perder o uso já registrado', async () => {
    const guard = new SttQuotaGuard(new InMemorySttUsageStore(), {
      maxRequestsPerDay: 2,
      maxAudioSecondsPerDay: 30,
      maxEstimatedMonthlyUsd: 1,
    }, () => '2026-09-05');
    await guard.record({ sessionId: 's1', audioSeconds: 10, estimatedUsd: 0.1 });

    guard.updateLimits({ maxRequestsPerDay: 5, maxAudioSecondsPerDay: 100, maxEstimatedMonthlyUsd: 2 });
    expect(await guard.snapshot()).toMatchObject({ requests: 1, remainingRequests: 4, remainingAudioSeconds: 90, remainingEstimatedUsd: 1.9 });
  });
});
