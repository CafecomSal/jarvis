export interface SystemHealthSnapshot {
  status: 'ok' | 'degraded' | 'unknown';
  checkedAt: string;
  core: { status: string };
  model: { status: string; name: string; runtime: string };
  database: { status: string };
  recordings: { status: string; staging: string };
  audio: { status: string; source?: string };
  network: { exposure: string; bind: string };
}

export interface TimelineItem {
  kind: 'event' | 'recording';
  id: string;
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

export interface TimelineResult {
  count: number;
  items: TimelineItem[];
}

export interface ApiTag {
  id: string;
  evidenceEventId: string;
  recordingId?: string;
  frameRef?: string | null;
  camera?: string;
  location?: string;
  namespace: string;
  key: string;
  value: string | number | boolean;
  confidence?: number;
  source: string;
  status: string;
  createdAt: string;
}

export interface AudioSession {
  id: string;
  source: 'pc' | 'alexa' | 'text';
  status: string;
  startedAt: string;
  endedAt?: string;
  pipelineLatencyMs?: number;
  transcript?: { text: string; confidence?: number; provider: string; model: string; latencyMs: number; processingLocation?: 'local' | 'cloud'; fallbackFrom?: string; durationMs?: number; rateLimit?: { limitRequests?: number; remainingRequests?: number; resetRequests?: string; limitTokens?: number; remainingTokens?: number; resetTokens?: string } };
  responseText?: string;
  ttsTarget?: 'pc' | 'alexa';
  error?: string;
}

export interface RuntimeSettingsResponse {
  source: 'default' | 'environment' | 'database';
  settings: {
    audioEnabled: boolean;
    stt: {
      route: 'local' | 'groq' | 'auto';
      localModel: string;
      groqModel: string;
      language: string;
      prompt: string;
      fallback: 'none' | 'local';
      timeoutMs: number;
      cloudEnabled: boolean;
      activeProvider?: string;
      processingLocation?: string;
      cloudConfigured?: boolean;
    };
    quota: {
      maxRequestsPerDay: number;
      maxAudioSecondsPerDay: number;
      maxEstimatedMonthlyUsd: number;
      usage?: Record<string, number | string>;
    };
    audioSessions: {
      autoDeleteEnabled: boolean;
      retentionDays: number;
      deletableStatuses: Array<'completed' | 'failed'>;
    };
    tts: { provider: string; model: string; editable: boolean };
  };
  cloud: { groq: { configured: boolean } };
}

export interface AudioSessionDeletePreview {
  previewId: string;
  expiresAt: string;
  before: string;
  statuses: Array<'completed' | 'failed'>;
  count: number;
  byStatus: { completed: number; failed: number };
  sessions: Array<{ id: string; source: string; status: string; startedAt: string; endedAt?: string; conversationId?: string }>;
}

export interface AudioSessionDeleteResult {
  previewId: string;
  deletedCount: number;
  deletedSessionIds: string[];
  redactedConversationCount: number;
  redactedAuditEntryCount: number;
}

export interface ConversationResult {
  conversationId: string;
  answer: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; result: unknown }>;
}

export interface AudioPipelineResponse {
  session: AudioSession;
  conversation: ConversationResult;
  audio: { mimeType: string; provider: string; model: string; latencyMs: number; audioBase64: string };
}

export interface JarvisApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  audioTimeoutMs?: number;
}

export class JarvisApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly audioTimeoutMs: number;

  constructor(options: JarvisApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.audioTimeoutMs = options.audioTimeoutMs ?? 180_000;
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init?.headers ?? {}) },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Jarvis API HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Jarvis API timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  getHealth(): Promise<SystemHealthSnapshot> {
    return this.request<SystemHealthSnapshot>('/system/health');
  }

  getTimeline(query = ''): Promise<TimelineResult> {
    return this.request<TimelineResult>(`/timeline${query}`);
  }

  getCameraHealth(camera: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/cameras/${encodeURIComponent(camera)}/health`);
  }

  getCameraLiveUrl(camera: string): string {
    return `/cameras/${encodeURIComponent(camera)}/live`;
  }

  getCameraLiveVideoUrl(camera: string): string {
    return `/cameras/${encodeURIComponent(camera)}/live-video`;
  }

  getTags(query = ''): Promise<{ count: number; tags: ApiTag[] }> {
    return this.request<{ count: number; tags: ApiTag[] }>(`/tags${query}`);
  }

  getActionProposals(query = ''): Promise<{ count: number; proposals: Array<Record<string, unknown>> }> {
    return this.request<{ count: number; proposals: Array<Record<string, unknown>> }>(`/actions/proposals${query}`);
  }

  getRecordings(query = ''): Promise<{ recordings: Array<Record<string, unknown>> }> {
    return this.request<{ recordings: Array<Record<string, unknown>> }>(`/recordings${query}`);
  }

  getAudioSessions(query = ''): Promise<{ count: number; sessions: AudioSession[] }> {
    return this.request<{ count: number; sessions: AudioSession[] }>(`/audio/sessions${query}`);
  }

  getSettings(): Promise<RuntimeSettingsResponse> {
    return this.request<RuntimeSettingsResponse>('/settings');
  }

  updateSettings(patch: Record<string, unknown>, confirmCloudBoundary = false): Promise<RuntimeSettingsResponse & { applied: boolean; restartRequired: boolean }> {
    return this.request<RuntimeSettingsResponse & { applied: boolean; restartRequired: boolean }>('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...patch, confirmCloudBoundary }),
    });
  }

  previewAudioSessionDeletion(filter: { before: string; statuses?: Array<'completed' | 'failed'>; ids?: string[] }): Promise<AudioSessionDeletePreview> {
    return this.request<AudioSessionDeletePreview>('/audio/sessions/delete-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(filter),
    });
  }

  deleteAudioSessions(previewId: string, confirmation: string): Promise<AudioSessionDeleteResult> {
    return this.request<AudioSessionDeleteResult>('/audio/sessions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewId, confirmation }),
    });
  }

  getEvents(query = ''): Promise<{ events: Array<Record<string, unknown>> }> {
    return this.request<{ events: Array<Record<string, unknown>> }>(`/events${query}`);
  }

  async postPcAudio(blob: Blob, durationMs?: number): Promise<AudioPipelineResponse> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    const audioBase64 = btoa(binary);
    const mimeType = blob.type.split(';', 1)[0] || 'audio/webm';
    return this.request<AudioPipelineResponse>('/audio/pc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mimeType,
        audioBase64,
        ...(durationMs === undefined ? {} : { durationMs }),
      }),
    }, this.audioTimeoutMs);
  }

  postConversation(message: string): Promise<ConversationResult> {
    return this.request<ConversationResult>('/conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }
}
