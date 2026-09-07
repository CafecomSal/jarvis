import type { ModelGateway } from './llm/model-gateway.js';
import { OllamaGateway } from './llm/ollama-gateway.js';
import { InMemoryEventStore, type EventStore } from './events/in-memory-event-store.js';
import { HomeEventSchema } from './events/schema.js';
import type { PersonNotifier } from './notifications/person-notification.js';
import { ConversationOrchestrator } from './orchestrator.js';
import { createDefaultToolRegistry, type ToolRegistry } from './tools/tool-registry.js';
import { WorldStateProjection } from './state/world-state.js';
import type { CameraAdapter } from './cameras/camera-adapter.js';
import { RtspCameraAdapter, type RtspFrameCapture, type RtspTransport } from './cameras/rtsp-camera.js';
import { LocalSnapshotStore } from './cameras/local-snapshot-store.js';
import { multipartFrame, liveStreamContentType, LIVE_STREAM_BOUNDARY } from './cameras/live-camera-stream.js';
import { liveVideoContentType, liveVideoFfmpegArgs } from './cameras/live-video-stream.js';
import { InMemoryAuditStore } from './audit/in-memory-audit-store.js';
import type { AuditStore } from './audit/audit-store.js';
import { SemanticMemory } from './memory/semantic-memory.js';
import type { RecordingStore } from './recordings/recording-store.js';
import { resolveRecordingFile } from './recordings/recording-file.js';
import { TimelineService } from './timeline/timeline-service.js';
import { TagQuerySchema } from './tags/tag-schema.js';
import type { TagService } from './tags/tag-service.js';
import type { SystemHealthSnapshot } from './health/system-health.js';
import { createRuntimeSystemHealth } from './health/runtime-health.js';
import { sanitizeAuditValue } from './audit/audit-utils.js';
import type { AudioSessionStore } from './audio/audio-types.js';
import { AudioSourceSchema, AudioSessionStatusSchema } from './audio/audio-types.js';
import { AudioPipeline, type AudioPipeline as AudioPipelineType } from './audio/audio-pipeline.js';
import type { SttProvider } from './audio/stt-provider.js';
import type { AudioRuntime, AudioRuntimeHealth } from './audio/audio-runtime.js';
import type { SttQuotaGuard } from './audio/stt-usage-store.js';
import { AudioSessionRetentionError, AudioSessionRetentionService } from './audio/audio-session-retention.js';
import type { TtsProvider } from './audio/tts-provider.js';
import { appendAudit } from './audit/audit-utils.js';
import { InMemoryRuntimeSettingsStore, RuntimeSettingsService } from './config/runtime-settings-store.js';
import { mergeRuntimeSettings, runtimeSettingsFromEnvironment } from './config/runtime-settings.js';
import type { ImportanceStore } from './importance/importance-store.js';
import type { WatchSessionStore } from './watch/watch-session-store.js';
import type { ActionProposalStore } from './actions/action-store.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface AppDependencies {
  gateway?: ModelGateway;
  events?: EventStore;
  audit?: AuditStore;
  semanticMemory?: SemanticMemory;
  worldState?: WorldStateProjection;
  snapshotStore?: LocalSnapshotStore;
  tools?: ToolRegistry;
  camera?: CameraAdapter;
  cameraStreams?: Record<string, string>;
  rtspTransport?: RtspTransport;
  rtspCaptureFrame?: RtspFrameCapture;
  model?: string;
  ollamaBaseUrl?: string;
  cameraLocations?: Record<string, string>;
  personNotifier?: PersonNotifier;
  recordings?: RecordingStore;
  recordingsDirectory?: string;
  tags?: TagService;
  audioSessions?: AudioSessionStore;
  audioPipeline?: Pick<AudioPipelineType, 'process'>;
  audioStt?: SttProvider;
  audioTts?: TtsProvider;
  audioRuntime?: Pick<AudioRuntime, 'apply' | 'health'>;
  audioQuota?: Pick<SttQuotaGuard, 'snapshot' | 'updateLimits'>;
  runtimeSettings?: RuntimeSettingsService;
  groqApiKeyConfigured?: boolean;
  audioSessionRetention?: Pick<AudioSessionRetentionService, 'preview' | 'execute'>;
  importance?: ImportanceStore;
  watchSessions?: WatchSessionStore;
  actions?: ActionProposalStore;
  systemHealth?: () => Promise<SystemHealthSnapshot>;
  webRoot?: string;
}

const ConversationBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

const EventsQuerySchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const AuditQuerySchema = z.object({
  conversationId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const RecordingsQuerySchema = z.object({
  camera: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const TimelineQuerySchema = z.object({
  camera: z.string().min(1).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const TagHttpQuerySchema = TagQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const AudioSessionsQuerySchema = z.object({
  source: AudioSourceSchema.optional(),
  status: AudioSessionStatusSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const AudioSessionDeleteFilterSchema = z.object({
  before: z.string().datetime({ offset: true }),
  statuses: z.array(z.enum(['completed', 'failed'])).min(1).max(2).optional(),
  ids: z.array(z.string().min(1).max(200)).max(500).optional(),
}).strict();

const AudioSessionDeleteSchema = z.object({
  previewId: z.string().min(1).max(200),
  confirmation: z.string().max(64),
}).strict();

const AudioRequestSchema = z.object({
  mimeType: z.enum(['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mpeg']),
  audioBase64: z.string().min(4).max(14_000_000).refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    'audioBase64 must be valid base64',
  ),
});

const WatchSessionsQuerySchema = z.object({
  camera: z.string().min(1).optional(),
  status: z.enum(['active', 'matched', 'expired', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const ImportanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const ActionProposalQuerySchema = z.object({
  status: z.enum(['proposed', 'confirmed_by_user', 'executing', 'succeeded', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const events = dependencies.events ?? new InMemoryEventStore();
  const audit = dependencies.audit ?? new InMemoryAuditStore();
  const worldState = dependencies.worldState ?? new WorldStateProjection();
  const model = dependencies.model ?? process.env.JARVIS_MODEL ?? 'gemma-hermes:latest';
  const ollamaBaseUrl = dependencies.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const cameraLocations = dependencies.cameraLocations ?? { front: 'frente' };
  const semanticMemory = dependencies.semanticMemory ?? new SemanticMemory({
    cameras: Object.entries(cameraLocations).map(([id, location]) => ({ id, location })),
  });
  const snapshotStore = dependencies.snapshotStore ?? new LocalSnapshotStore(process.env.JARVIS_SNAPSHOT_DIR ?? 'data/snapshots');
  const cameraStreams = dependencies.cameraStreams ?? {
    ...(process.env.JARVIS_CAMERA_FRONT_RTSP_URL?.trim()
      ? { front: process.env.JARVIS_CAMERA_FRONT_RTSP_URL.trim() }
      : {}),
  };
  const rtspTransport = dependencies.rtspTransport
    ?? (process.env.JARVIS_RTSP_TRANSPORT as RtspTransport | undefined)
    ?? 'udp';
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
  const hasConfiguredRtspCamera = Object.values(cameraStreams).some((stream) => stream.trim() !== '');
  const camera = dependencies.camera ?? (hasConfiguredRtspCamera
    ? new RtspCameraAdapter({
      streams: cameraStreams,
      transport: rtspTransport,
      ffmpegPath,
      captureFrame: dependencies.rtspCaptureFrame,
      snapshotStore,
    })
    : undefined);
  const tools = dependencies.tools ?? createDefaultToolRegistry({
    events,
    worldState,
    camera,
    audit,
    semanticMemory,
    cameraLocations,
    recordings: dependencies.recordings,
  });
  const timeline = new TimelineService(events, dependencies.recordings);
  const gateway = dependencies.gateway ?? new OllamaGateway({ baseUrl: ollamaBaseUrl, model });
  const orchestrator = new ConversationOrchestrator(gateway, tools, model, events, undefined, audit);
  const audioPipeline = dependencies.audioPipeline
    ?? (dependencies.audioStt && dependencies.audioTts && dependencies.audioSessions
      ? new AudioPipeline({
        stt: dependencies.audioStt,
        tts: dependencies.audioTts,
        sessions: dependencies.audioSessions,
        respond: (text) => orchestrator.respond(text),
      })
      : undefined);
  const runtimeSettings = dependencies.runtimeSettings
    ?? new RuntimeSettingsService(new InMemoryRuntimeSettingsStore(), runtimeSettingsFromEnvironment());
  const groqApiKeyConfigured = dependencies.groqApiKeyConfigured ?? Boolean(process.env.GROQ_API_KEY?.trim());
  const audioSessionRetention = dependencies.audioSessionRetention
    ?? (dependencies.audioSessions
      ? new AudioSessionRetentionService(dependencies.audioSessions, dependencies.audit ?? audit)
      : undefined);
  const systemHealth = dependencies.systemHealth ?? (() => createRuntimeSystemHealth({
    model,
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    recordingsConfigured: Boolean(dependencies.recordings),
    audioConfigured: Boolean(audioPipeline),
    exposure: process.env.JARVIS_TAILSCALE_SERVE_ENABLED === 'true' ? 'tailscale-only' : 'local-only',
    bind: 'loopback',
    ollamaBaseUrl,
  }));
  const app = Fastify({ logger: false });
  if (dependencies.webRoot) {
    app.register(fastifyStatic, {
      root: resolve(dependencies.webRoot),
      prefix: '/ui/',
      decorateReply: false,
    });
  }

  app.get('/', async () => ({
    name: 'Jarvis Core',
    version: '0.1.0',
    status: 'ok',
    endpoints: {
      health: 'GET /health',
      systemHealth: 'GET /system/health',
      ui: 'GET /ui/',
      conversation: 'POST /conversation',
      events: 'GET|POST /events',
      audit: 'GET /audit',
      recordings: 'GET /recordings',
      recordingClip: 'GET /recordings/:id/clip',
      timeline: 'GET /timeline',
      cameraHealth: 'GET /cameras/:camera/health',
      cameraLive: 'GET /cameras/:camera/live',
      cameraLiveVideo: 'GET /cameras/:camera/live-video',
      settings: 'GET|PUT /settings',
      audioSessionDeletePreview: 'POST /audio/sessions/delete-preview',
      audioSessionDelete: 'DELETE /audio/sessions',
    },
  }));

  app.get('/health', async () => ({
    status: 'ok',
    model,
    ollamaBaseUrl,
  }));

  app.get('/system/health', async (_request, reply) => {
    const snapshot = await systemHealth();
    if (dependencies.audioRuntime) {
      const audioHealth = await dependencies.audioRuntime.health();
      const quota = dependencies.audioQuota ? await dependencies.audioQuota.snapshot() : undefined;
      return reply.send({
        ...snapshot,
        audio: {
          ...snapshot.audio,
          source: audioHealth.processingLocation === 'cloud' ? 'Groq cloud + Piper CPU' : 'Faster-Whisper CPU + Piper CPU',
          stt: audioHealth,
          tts: { provider: 'piper', model: 'pt_BR-jeff-medium' },
          ...(quota ? { quota } : {}),
        },
      });
    }
    return reply.send(snapshot);
  });

  const settingsPayload = async (): Promise<Record<string, unknown>> => {
    const effective = await runtimeSettings.effective();
    const audioHealth: AudioRuntimeHealth | undefined = dependencies.audioRuntime
      ? await dependencies.audioRuntime.health()
      : undefined;
    const quota = dependencies.audioQuota ? await dependencies.audioQuota.snapshot() : undefined;
    return {
      source: effective.source,
      settings: {
        audioEnabled: effective.settings.audioEnabled,
        stt: {
          ...effective.settings.stt,
          ...(audioHealth ? {
            activeProvider: audioHealth.activeProvider,
            processingLocation: audioHealth.processingLocation,
            cloudConfigured: audioHealth.cloudConfigured,
          } : {}),
        },
        quota: {
          ...effective.settings.quota,
          ...(quota ? { usage: quota } : {}),
        },
        audioSessions: effective.settings.audioSessions,
        tts: { provider: 'piper', model: 'pt_BR-jeff-medium', editable: false },
      },
      cloud: { groq: { configured: groqApiKeyConfigured } },
    };
  };

  app.get('/settings', async (_request, reply) => reply.send(await settingsPayload()));

  app.put('/settings', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'invalid_settings' });
    }
    const raw = body as Record<string, unknown>;
    const confirmCloudBoundary = raw.confirmCloudBoundary === true;
    const patch = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'confirmCloudBoundary'));
    let current;
    let candidate;
    try {
      current = await runtimeSettings.effective();
      candidate = mergeRuntimeSettings(current.settings, patch);
    } catch {
      return reply.code(400).send({ error: 'invalid_settings' });
    }
    const requestsCloud = candidate.stt.cloudEnabled || candidate.stt.route !== 'local';
    if (requestsCloud && !confirmCloudBoundary) {
      return reply.code(400).send({ error: 'cloud_confirmation_required' });
    }
    if (requestsCloud && !groqApiKeyConfigured) {
      return reply.code(409).send({ error: 'groq_credentials_unavailable' });
    }
    const sttChanged = JSON.stringify(current.settings.stt) !== JSON.stringify(candidate.stt);
    const quotaChanged = JSON.stringify(current.settings.quota) !== JSON.stringify(candidate.quota);
    const audioEnabledChanged = current.settings.audioEnabled !== candidate.audioEnabled;
    try {
      await runtimeSettings.replace(candidate);
      if (sttChanged && dependencies.audioRuntime) await dependencies.audioRuntime.apply(candidate.stt);
      if (quotaChanged && dependencies.audioQuota) dependencies.audioQuota.updateLimits(candidate.quota);
    } catch (error) {
      if (sttChanged && dependencies.audioRuntime) {
        try { await dependencies.audioRuntime.apply(current.settings.stt); } catch { /* preserve the original apply error */ }
      }
      if (quotaChanged && dependencies.audioQuota) {
        try { dependencies.audioQuota.updateLimits(current.settings.quota); } catch { /* preserve the original apply error */ }
      }
      await runtimeSettings.replace(current.settings);
      return reply.code(409).send({
        error: 'settings_apply_failed',
        message: error instanceof Error ? error.message.slice(0, 200) : 'settings apply failed',
      });
    }
    await appendAudit(dependencies.audit ?? audit, {
      conversationId: `settings-${randomUUID()}`,
      kind: 'policy_decision',
      action: 'runtime_settings.update',
      actor: 'dashboard',
      outcome: 'success',
      data: {
        changed: {
          audioEnabled: audioEnabledChanged,
          stt: sttChanged,
          quota: quotaChanged,
          audioSessions: JSON.stringify(current.settings.audioSessions) !== JSON.stringify(candidate.audioSessions),
        },
        cloudBoundaryConfirmed: confirmCloudBoundary,
      },
    });
    return reply.send({
      ...(await settingsPayload()),
      applied: !sttChanged || Boolean(dependencies.audioRuntime),
      restartRequired: audioEnabledChanged || (sttChanged && !dependencies.audioRuntime),
    });
  });

  const findEventById = async (id: string) => (await events.search(id, 100)).find((event) => event.id === id);

  app.get('/events/:id', async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_event_id', issues: parsed.error.issues });
    const event = await findEventById(parsed.data.id);
    if (!event) return reply.code(404).send({ error: 'event_not_found' });
    return reply.send({ ...event, data: sanitizeAuditValue(event.data) });
  });

  app.get('/evidence/:id', async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_evidence_id', issues: parsed.error.issues });
    const event = await findEventById(parsed.data.id);
    if (!event) return reply.code(404).send({ error: 'evidence_not_found' });
    if (event.type !== 'camera.snapshot' && !event.data.imageRef) {
      return reply.code(404).send({ error: 'evidence_not_found' });
    }
    return reply.send({ ...event, data: sanitizeAuditValue(event.data) });
  });

  app.post('/events', async (request, reply) => {
    const parsed = HomeEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_event',
        issues: parsed.error.issues,
      });
    }

    const event = await events.append(parsed.data);
    worldState.apply(event);
    if (dependencies.personNotifier) {
      try {
        await dependencies.personNotifier.notify(event);
      } catch (error) {
        request.log.error(error, 'Person notification failed');
      }
    }
    return reply.code(201).send(event);
  });

  app.get('/events', async (request, reply) => {
    const parsed = EventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        issues: parsed.error.issues,
      });
    }

    const result = parsed.data.query
      ? await events.search(parsed.data.query, parsed.data.limit)
      : await events.list(parsed.data.limit);
    return reply.send({ events: result });
  });

  app.get('/audit', async (request, reply) => {
    const parsed = AuditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_query',
        issues: parsed.error.issues,
      });
    }

    const result = parsed.data.conversationId
      ? await audit.forConversation(parsed.data.conversationId, parsed.data.limit)
      : await audit.list(parsed.data.limit);
    return reply.send({ entries: result });
  });

  app.get('/timeline', async (request, reply) => {
    const parsed = TimelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_timeline_query',
        issues: parsed.error.issues,
      });
    }
    return reply.send(await timeline.query(parsed.data));
  });

  app.get('/tags', async (request, reply) => {
    if (!dependencies.tags) {
      return reply.code(501).send({
        error: 'tag_service_unavailable',
        message: 'O serviço de tags não está configurado.',
      });
    }
    const parsed = TagHttpQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_tag_query',
        issues: parsed.error.issues,
      });
    }
    return reply.send(await dependencies.tags.list(parsed.data));
  });

  app.get('/tags/:id', async (request, reply) => {
    if (!dependencies.tags) {
      return reply.code(501).send({
        error: 'tag_service_unavailable',
        message: 'O serviço de tags não está configurado.',
      });
    }
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_tag_id',
        issues: parsed.error.issues,
      });
    }
    const tag = await dependencies.tags.get(parsed.data.id);
    if (!tag) return reply.code(404).send({ error: 'tag_not_found' });
    return reply.send(tag);
  });

  app.get('/audio/sessions', async (request, reply) => {
    if (!dependencies.audioSessions) {
      return reply.code(501).send({
        error: 'audio_session_store_unavailable',
        message: 'O histórico de áudio não está configurado.',
      });
    }
    const parsed = AudioSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_audio_session_query',
        issues: parsed.error.issues,
      });
    }
    const sessions = await dependencies.audioSessions.list(parsed.data);
    return reply.send({ count: sessions.length, sessions });
  });

  app.post('/audio/sessions/delete-preview', async (request, reply) => {
    if (!audioSessionRetention) return reply.code(501).send({ error: 'audio_session_store_unavailable' });
    const parsed = AudioSessionDeleteFilterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_audio_session_delete_filter' });
    try {
      return reply.send(await audioSessionRetention.preview(parsed.data));
    } catch (error) {
      if (error instanceof AudioSessionRetentionError) return reply.code(400).send({ error: error.code, message: error.message });
      return reply.code(500).send({ error: 'audio_session_delete_preview_failed' });
    }
  });

  app.delete('/audio/sessions', async (request, reply) => {
    if (!audioSessionRetention) return reply.code(501).send({ error: 'audio_session_store_unavailable' });
    const parsed = AudioSessionDeleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_audio_session_delete_request' });
    try {
      return reply.send(await audioSessionRetention.execute(parsed.data.previewId, parsed.data.confirmation));
    } catch (error) {
      if (error instanceof AudioSessionRetentionError) {
        const status = error.code === 'preview_not_found' ? 404 : error.code === 'preview_expired' || error.code === 'preview_already_used' ? 409 : 400;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: 'audio_session_delete_failed' });
    }
  });

  app.get('/audio/sessions/:id', async (request, reply) => {
    if (!dependencies.audioSessions) {
      return reply.code(501).send({
        error: 'audio_session_store_unavailable',
        message: 'O histórico de áudio não está configurado.',
      });
    }
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_audio_session_id',
        issues: parsed.error.issues,
      });
    }
    const session = await dependencies.audioSessions.findById(parsed.data.id);
    if (!session) return reply.code(404).send({ error: 'audio_session_not_found' });
    return reply.send(session);
  });

  app.post('/audio/pc', async (request, reply) => {
    if (!audioPipeline) {
      return reply.code(501).send({
        error: 'audio_pipeline_unavailable',
        message: 'O pipeline de áudio local não está configurado.',
      });
    }
    const parsed = AudioRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_audio_request',
        issues: parsed.error.issues,
      });
    }
    const audio = Buffer.from(parsed.data.audioBase64, 'base64');
    if (audio.length === 0) return reply.code(400).send({ error: 'invalid_audio_request' });
    try {
      const result = await audioPipeline.process(audio, parsed.data.mimeType, 'pc', 'pc');
      return reply.send({
        session: result.session,
        conversation: result.conversation,
        audio: {
          mimeType: result.audio.mimeType,
          provider: result.audio.provider,
          model: result.audio.model,
          latencyMs: result.audio.latencyMs,
          audioBase64: result.audio.audio.toString('base64'),
        },
      });
    } catch {
      return reply.code(502).send({ error: 'audio_pipeline_failed' });
    }
  });

  app.get('/watch-sessions', async (request, reply) => {
    if (!dependencies.watchSessions) return reply.code(501).send({ error: 'watch_session_store_unavailable' });
    const parsed = WatchSessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_watch_session_query', issues: parsed.error.issues });
    const sessions = await dependencies.watchSessions.list(parsed.data);
    return reply.send({ count: sessions.length, sessions });
  });

  app.get('/watch-sessions/:id', async (request, reply) => {
    if (!dependencies.watchSessions) return reply.code(501).send({ error: 'watch_session_store_unavailable' });
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_watch_session_id', issues: parsed.error.issues });
    const session = await dependencies.watchSessions.findById(parsed.data.id);
    if (!session) return reply.code(404).send({ error: 'watch_session_not_found' });
    return reply.send(session);
  });

  app.get('/importance', async (request, reply) => {
    if (!dependencies.importance) return reply.code(501).send({ error: 'importance_store_unavailable' });
    const parsed = ImportanceQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_importance_query', issues: parsed.error.issues });
    const records = await dependencies.importance.list(parsed.data.limit);
    return reply.send({ count: records.length, records });
  });

  app.get('/importance/:id', async (request, reply) => {
    if (!dependencies.importance) return reply.code(501).send({ error: 'importance_store_unavailable' });
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_importance_id', issues: parsed.error.issues });
    const record = await dependencies.importance.findById(parsed.data.id);
    if (!record) return reply.code(404).send({ error: 'importance_not_found' });
    return reply.send(record);
  });

  app.get('/actions/proposals', async (request, reply) => {
    if (!dependencies.actions) return reply.code(501).send({ error: 'action_store_unavailable' });
    const parsed = ActionProposalQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_action_query', issues: parsed.error.issues });
    const proposals = await dependencies.actions.list(parsed.data);
    return reply.send({ count: proposals.length, proposals });
  });

  app.get('/actions/proposals/:id', async (request, reply) => {
    if (!dependencies.actions) return reply.code(501).send({ error: 'action_store_unavailable' });
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_action_id', issues: parsed.error.issues });
    const proposal = await dependencies.actions.findById(parsed.data.id);
    if (!proposal) return reply.code(404).send({ error: 'action_not_found' });
    return reply.send(proposal);
  });

  app.get('/recordings', async (request, reply) => {
    if (!dependencies.recordings) {
      return reply.code(501).send({
        error: 'recording_catalog_unavailable',
        message: 'O catálogo de gravações não está configurado.',
      });
    }
    const parsed = RecordingsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_recording_query',
        issues: parsed.error.issues,
      });
    }
    const recordings = await dependencies.recordings.list(parsed.data);
    return reply.send({ recordings });
  });

  app.get('/recordings/:id/clip', async (request, reply) => {
    if (!dependencies.recordings || !dependencies.recordingsDirectory) {
      return reply.code(501).send({
        error: 'recording_media_unavailable',
        message: 'A mídia local de gravações não está configurada.',
      });
    }
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_recording_id',
        issues: parsed.error.issues,
      });
    }
    const recording = await dependencies.recordings.findById(parsed.data.id);
    if (!recording) return reply.code(404).send({ error: 'recording_not_found' });
    let filePath: string;
    try {
      filePath = resolveRecordingFile(dependencies.recordingsDirectory, recording.fileRef);
      await access(filePath);
    } catch (error) {
      if (error instanceof Error && error.message === 'Recording file reference escapes archive root') {
        return reply.code(400).send({ error: 'invalid_recording_file_ref' });
      }
      return reply.code(404).send({ error: 'recording_file_not_found' });
    }
    return reply.type(recording.mimeType).send(createReadStream(filePath));
  });

  app.get('/recordings/:id', async (request, reply) => {
    if (!dependencies.recordings) {
      return reply.code(501).send({
        error: 'recording_catalog_unavailable',
        message: 'O catálogo de gravações não está configurado.',
      });
    }
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_recording_id',
        issues: parsed.error.issues,
      });
    }
    const recording = await dependencies.recordings.findById(parsed.data.id);
    if (!recording) return reply.code(404).send({ error: 'recording_not_found' });
    return reply.send(recording);
  });

  app.get('/cameras/:camera/live-video', async (request, reply) => {
    if (!hasConfiguredRtspCamera) {
      return reply.code(501).send({
        error: 'camera_live_video_unavailable',
        message: 'Nenhuma câmera RTSP está configurada.',
      });
    }
    const parsed = z.object({ camera: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_camera',
        issues: parsed.error.issues,
      });
    }
    const streamUrl = cameraStreams[parsed.data.camera];
    if (!streamUrl) return reply.code(404).send({ error: 'camera_not_found' });
    const width = Number(process.env.JARVIS_LIVE_VIDEO_WIDTH ?? 1280);
    let args: string[];
    try {
      args = liveVideoFfmpegArgs(streamUrl, { ffmpegPath, transport: rtspTransport, width });
    } catch {
      return reply.code(400).send({ error: 'invalid_live_video_config' });
    }

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const raw = reply.raw;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (!child.killed) child.kill();
    };
    raw.once('close', stop);
    raw.once('finish', stop);
    child.stderr.resume();
    child.once('error', () => {
      stop();
      if (!raw.destroyed && !raw.writableEnded) raw.end();
    });
    child.once('close', () => {
      if (!raw.destroyed && !raw.writableEnded) raw.end();
    });

    reply.hijack();
    raw.writeHead(200, {
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      'content-type': liveVideoContentType(),
      pragma: 'no-cache',
      'x-accel-buffering': 'no',
    });
    child.stdout.pipe(raw);
    return reply;
  });

  app.get('/cameras/:camera/live', async (request, reply) => {
    if (!camera) {
      return reply.code(501).send({
        error: 'camera_live_unavailable',
        message: 'Nenhuma câmera RTSP está configurada.',
      });
    }
    const parsed = z.object({ camera: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_camera',
        issues: parsed.error.issues,
      });
    }
    const intervalMs = Number(process.env.JARVIS_LIVE_PREVIEW_INTERVAL_MS ?? 1_000);
    if (!Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 10_000) {
      return reply.code(400).send({ error: 'invalid_live_preview_interval' });
    }

    let firstSnapshot;
    try {
      firstSnapshot = await camera.snapshot(parsed.data.camera);
    } catch {
      return reply.code(502).send({ error: 'camera_live_failed' });
    }

    reply.hijack();
    const raw = reply.raw;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    raw.once('close', stop);
    raw.once('finish', stop);
    raw.writeHead(200, {
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      'content-type': liveStreamContentType(LIVE_STREAM_BOUNDARY),
      pragma: 'no-cache',
      'x-accel-buffering': 'no',
    });

    const writeFrame = (snapshot: typeof firstSnapshot) => {
      const frame = Buffer.from(snapshot.base64, 'base64');
      if (frame.length === 0 || stopped || raw.destroyed || raw.writableEnded) return;
      raw.write(multipartFrame(frame, snapshot.mimeType, LIVE_STREAM_BOUNDARY));
    };
    writeFrame(firstSnapshot);

    const pump = async (): Promise<void> => {
      if (stopped || raw.destroyed || raw.writableEnded) return;
      try {
        const snapshot = await camera.snapshot(parsed.data.camera);
        writeFrame(snapshot);
      } catch {
        stop();
        if (!raw.destroyed && !raw.writableEnded) raw.end();
        return;
      }
      if (!stopped) timer = setTimeout(() => { void pump(); }, intervalMs);
    };
    timer = setTimeout(() => { void pump(); }, intervalMs);
    return reply;
  });

  app.get('/cameras/:camera/preview', async (request, reply) => {
    if (!camera) {
      return reply.code(501).send({
        error: 'camera_preview_unavailable',
        message: 'Nenhuma câmera RTSP está configurada.',
      });
    }
    const parsed = z.object({ camera: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_camera',
        issues: parsed.error.issues,
      });
    }
    try {
      const snapshot = await camera.snapshot(parsed.data.camera);
      return reply
        .header('cache-control', 'no-store')
        .type(snapshot.mimeType)
        .send(Buffer.from(snapshot.base64, 'base64'));
    } catch {
      return reply.code(502).send({ error: 'camera_preview_failed' });
    }
  });

  app.get('/cameras/:camera/health', async (request, reply) => {
    const parsed = z.object({ camera: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_camera',
        issues: parsed.error.issues,
      });
    }
    if (!camera?.health) {
      return reply.code(501).send({
        error: 'camera_health_unavailable',
        message: 'Nenhuma câmera RTSP está configurada.',
      });
    }
    return reply.send(await camera.health(parsed.data.camera));
  });

  app.post('/conversation', async (request, reply) => {
    const parsed = ConversationBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
    }

    try {
      const result = await orchestrator.respond(parsed.data.message);
      return reply.send(result);
    } catch (error) {
      request.log.error(error);
      return reply.code(502).send({
        error: 'model_unavailable',
        message: 'O gateway local de IA não respondeu.',
      });
    }
  });

  return app;
}
