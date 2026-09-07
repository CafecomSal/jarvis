import { describe, expect, it } from 'vitest';
import { AUDIO_SESSION_DELETE_CONFIRMATION, audioSessionDeleteConfirmation, removeDeletedAudioSessions } from '../web/src/audio/audio-session-actions.js';

describe('ações de sessões de áudio no browser', () => {
  it('exige texto de confirmação que contenha a quantidade exata', () => {
    expect(AUDIO_SESSION_DELETE_CONFIRMATION).toBe('APAGAR SESSÕES');
    expect(audioSessionDeleteConfirmation(2)).toBe('APAGAR 2 SESSÕES');
    expect(audioSessionDeleteConfirmation(1)).toBe('APAGAR 1 SESSÃO');
  });

  it('remove apenas ids confirmados do estado local', () => {
    const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(removeDeletedAudioSessions(sessions, ['a', 'c'])).toEqual([{ id: 'b' }]);
  });
});
