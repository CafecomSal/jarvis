import { describe, expect, it } from 'vitest';
import { pageFromHash } from '../web/src/app-model.js';

describe('navegação persistente do dashboard', () => {
  it('converte hash válido em página e rejeita hash desconhecido', () => {
    expect(pageFromHash('#events')).toBe('events');
    expect(pageFromHash('#actions')).toBe('actions');
    expect(pageFromHash('#not-a-page')).toBe('overview');
    expect(pageFromHash('')).toBe('overview');
  });
});
