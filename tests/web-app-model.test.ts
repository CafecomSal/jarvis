import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, formatTimestamp, pageTitle } from '../web/src/app-model.js';

describe('modelo da interface Jarvis', () => {
  it('expõe as áreas operacionais na ordem definida', () => {
    expect(NAV_ITEMS.map((item) => item.id)).toEqual([
      'overview', 'cameras', 'timeline', 'events', 'tags', 'ocr', 'chat', 'audio', 'drive', 'system', 'actions', 'settings',
    ]);
    expect(pageTitle('timeline')).toBe('Timeline / DVR');
  });

  it('formata timestamp inválido sem quebrar o dashboard', () => {
    expect(formatTimestamp('not-a-date')).toBe('data desconhecida');
    expect(formatTimestamp('2026-09-05T03:30:00.000Z')).toContain('05/09/2026');
  });
});
