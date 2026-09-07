import { randomUUID } from 'node:crypto';
import type { AuditStore } from '../audit/audit-store.js';
import { appendAudit } from '../audit/audit-utils.js';
import type { AudioSession, AudioSessionStore, AudioSessionStatus } from './audio-types.js';

export const AUDIO_SESSION_DELETE_CONFIRMATION = 'APAGAR SESSÕES';
const DELETABLE_STATUSES = new Set<AudioSessionStatus>(['completed', 'failed']);

type DeletionCandidate = Pick<AudioSession, 'id' | 'source' | 'status' | 'startedAt' | 'endedAt' | 'conversationId'>;

export interface AudioSessionDeleteFilter {
  before: string;
  statuses?: AudioSessionStatus[];
  ids?: string[];
}

export interface AudioSessionDeletePreview {
  previewId: string;
  expiresAt: string;
  before: string;
  statuses: Array<'completed' | 'failed'>;
  count: number;
  byStatus: { completed: number; failed: number };
  sessions: DeletionCandidate[];
}

export interface AudioSessionDeleteResult {
  previewId: string;
  deletedCount: number;
  deletedSessionIds: string[];
  redactedConversationCount: number;
  redactedAuditEntryCount: number;
}

export class AudioSessionRetentionError extends Error {
  constructor(readonly code: 'invalid_filter' | 'preview_not_found' | 'preview_expired' | 'preview_already_used' | 'confirmation_required', message: string) {
    super(message);
    this.name = 'AudioSessionRetentionError';
  }
}

interface StoredPreview extends AudioSessionDeletePreview {
  used: boolean;
}

function candidate(session: AudioSession): DeletionCandidate {
  return {
    id: session.id,
    source: session.source,
    status: session.status,
    startedAt: session.startedAt,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    ...(session.conversationId ? { conversationId: session.conversationId } : {}),
  };
}

export function audioSessionDeleteConfirmation(count: number): string {
  return `APAGAR ${count} ${count === 1 ? 'SESSÃO' : 'SESSÕES'}`;
}

function validateFilter(filter: AudioSessionDeleteFilter): { beforeMs: number; statuses: Array<'completed' | 'failed'>; ids: Set<string> | undefined } {
  const beforeMs = Date.parse(filter.before);
  if (!Number.isFinite(beforeMs)) throw new AudioSessionRetentionError('invalid_filter', 'Audio session deletion before must be an ISO date');
  const rawStatuses = filter.statuses ?? ['completed', 'failed'];
  if (rawStatuses.length === 0 || rawStatuses.some((status) => !DELETABLE_STATUSES.has(status))) {
    throw new AudioSessionRetentionError('invalid_filter', 'Only completed and failed audio sessions can be deleted');
  }
  const statuses = [...new Set(rawStatuses)] as Array<'completed' | 'failed'>;
  const ids = filter.ids === undefined ? undefined : new Set(filter.ids.filter((id) => id.trim()).slice(0, 500));
  return { beforeMs, statuses, ids };
}

export interface AudioSessionRetentionOptions {
  now?: () => Date;
  previewTtlMs?: number;
}

export class AudioSessionRetentionService {
  private readonly now: () => Date;
  private readonly previewTtlMs: number;
  private readonly previews = new Map<string, StoredPreview>();

  constructor(
    private readonly sessions: AudioSessionStore,
    private readonly audit?: AuditStore,
    options: AudioSessionRetentionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.previewTtlMs = options.previewTtlMs ?? 5 * 60_000;
    if (!Number.isInteger(this.previewTtlMs) || this.previewTtlMs < 1_000 || this.previewTtlMs > 60 * 60_000) {
      throw new Error('Audio session preview TTL is invalid');
    }
  }

  async preview(filter: AudioSessionDeleteFilter): Promise<AudioSessionDeletePreview> {
    const { beforeMs, statuses, ids } = validateFilter(filter);
    const listed = await this.sessions.list({ limit: 10_000 });
    const matches = listed
      .filter((session) => DELETABLE_STATUSES.has(session.status))
      .filter((session) => statuses.includes(session.status as 'completed' | 'failed'))
      .filter((session) => Date.parse(session.startedAt) < beforeMs)
      .filter((session) => ids === undefined || ids.has(session.id))
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
    const sessions = matches.map(candidate);
    const byStatus = {
      completed: sessions.filter((session) => session.status === 'completed').length,
      failed: sessions.filter((session) => session.status === 'failed').length,
    };
    const preview: StoredPreview = {
      previewId: `audio-delete-preview-${randomUUID()}`,
      expiresAt: new Date(this.now().getTime() + this.previewTtlMs).toISOString(),
      before: filter.before,
      statuses,
      count: sessions.length,
      byStatus,
      sessions,
      used: false,
    };
    this.previews.set(preview.previewId, preview);
    const { used: _used, ...publicPreview } = preview;
    return structuredClone(publicPreview);
  }

  async execute(previewId: string, confirmation: string, actor = 'dashboard'): Promise<AudioSessionDeleteResult> {
    const preview = this.previews.get(previewId);
    if (!preview) throw new AudioSessionRetentionError('preview_not_found', 'Audio session deletion preview was not found');
    if (preview.used) throw new AudioSessionRetentionError('preview_already_used', 'Audio session deletion preview was already used');
    if (Date.parse(preview.expiresAt) <= this.now().getTime()) throw new AudioSessionRetentionError('preview_expired', 'Audio session deletion preview expired');
    if (confirmation !== audioSessionDeleteConfirmation(preview.count)) {
      throw new AudioSessionRetentionError('confirmation_required', 'Audio session deletion confirmation is required');
    }
    preview.used = true;
    const beforeMs = Date.parse(preview.before);
    const previewById = new Map(preview.sessions.map((session) => [session.id, session]));
    const currentSessions = await Promise.all(preview.sessions.map((session) => this.sessions.findById(session.id)));
    const ids = currentSessions
      .filter((session): session is AudioSession => {
        if (!session || !DELETABLE_STATUSES.has(session.status)) return false;
        const expected = previewById.get(session.id);
        if (!expected) return false;
        return expected.status === session.status
          && expected.startedAt === session.startedAt
          && Date.parse(session.startedAt) < beforeMs;
      })
      .map((session) => session.id);
    const deletableSessions = currentSessions.filter((session): session is AudioSession => session !== undefined && ids.includes(session.id));
    const conversationIds = [...new Set(deletableSessions.map((session) => session.conversationId).filter((id): id is string => Boolean(id)))];
    let redactedAuditEntryCount = 0;
    for (const conversationId of conversationIds) {
      redactedAuditEntryCount += await (this.audit?.redactForConversation(conversationId, 'audio-session-purge') ?? 0);
    }
    const deleted = await this.sessions.deleteByIds(ids);
    const result: AudioSessionDeleteResult = {
      previewId,
      deletedCount: deleted.length,
      deletedSessionIds: deleted.map((session) => session.id),
      redactedConversationCount: conversationIds.length,
      redactedAuditEntryCount,
    };
    await appendAudit(this.audit, {
      conversationId: `purge-${previewId}`,
      kind: 'policy_decision',
      action: 'audio_session.purge',
      actor,
      outcome: 'success',
      data: {
        previewId,
        deletedCount: result.deletedCount,
        deletedSessionIds: result.deletedSessionIds,
        redactedConversationCount: result.redactedConversationCount,
        redactedAuditEntryCount,
        before: preview.before,
        statuses: preview.statuses,
      },
    });
    return result;
  }
}
