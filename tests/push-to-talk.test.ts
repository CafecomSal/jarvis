import { describe, expect, it } from 'vitest';
import { PushToTalkLatch } from '../web/src/audio/push-to-talk.js';

describe('latch de push-to-talk', () => {
  it('marca para parar quando o usuário solta antes do microfone ficar pronto', () => {
    const latch = new PushToTalkLatch();
    latch.press();
    latch.release();

    expect(latch.shouldStop()).toBe(true);
  });

  it('permite iniciar somente enquanto o botão está pressionado', () => {
    const latch = new PushToTalkLatch();
    expect(latch.shouldStop()).toBe(true);
    latch.press();
    expect(latch.shouldStop()).toBe(false);
  });
});
