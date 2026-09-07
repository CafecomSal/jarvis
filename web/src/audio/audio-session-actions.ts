export const AUDIO_SESSION_DELETE_CONFIRMATION = 'APAGAR SESSÕES';

export function audioSessionDeleteConfirmation(count: number): string {
  const normalized = Number.isInteger(count) && count >= 0 ? count : 0;
  return `APAGAR ${normalized} ${normalized === 1 ? 'SESSÃO' : 'SESSÕES'}`;
}

export function removeDeletedAudioSessions<T extends { id: string }>(sessions: readonly T[], deletedIds: readonly string[]): T[] {
  const deleted = new Set(deletedIds);
  return sessions.filter((session) => !deleted.has(session.id));
}
