import { z, type ZodType } from 'zod';
import { randomUUID } from 'node:crypto';
import { EventTypeSchema } from '../events/schema.js';
import type { EventQuery } from '../events/event-query.js';
import type { EventStore } from '../events/in-memory-event-store.js';
import type { HomeState, WorldStateProjection } from '../state/world-state.js';
import type { CameraAdapter } from '../cameras/camera-adapter.js';
import { EpisodicMemory } from '../memory/memory-service.js';
import { SemanticMemory } from '../memory/semantic-memory.js';
import { PolicyEngine } from '../policies/policy-engine.js';
import type { ToolCall, ToolDefinition } from '../llm/model-gateway.js';
import type { AuditStore } from '../audit/audit-store.js';
import { appendAudit, sanitizeAuditValue } from '../audit/audit-utils.js';
import { inspectDetectorStatus, parseDetectorStatusOptions } from '../vision/run-detector-status.js';
import type { RecordingStore } from '../recordings/recording-store.js';
import { TimelineService } from '../timeline/timeline-service.js';
import { type EvidenceIndexStore } from '../evidence/evidence-index-store.js';
import type { RecordingIndexRunStore } from '../recordings/recording-index-run-store.js';
import { matchingRecordingIds } from '../recordings/recording-query.js';

export interface RegisteredTool {
  definition: ToolDefinition;
  input: ZodType;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolExecutionContext {
  conversationId?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(
    private readonly policy = new PolicyEngine(),
    private readonly audit?: AuditStore,
  ) {}

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(call: ToolCall, context: ToolExecutionContext = {}): Promise<unknown> {
    const conversationId = context.conversationId ?? 'system';
    const tool = this.tools.get(call.name);
    if (!tool) {
      const error = `Unknown tool: ${call.name}`;
      await appendAudit(this.audit, {
        conversationId,
        kind: 'tool_call',
        action: 'execute',
        actor: 'tool-registry',
        outcome: 'error',
        data: {
          toolCallId: call.id,
          toolName: call.name,
          arguments: sanitizeAuditValue(call.arguments),
          error,
        },
      });
      throw new Error(error);
    }

    const decision = this.policy.evaluate(tool.definition.risk);
    await appendAudit(this.audit, {
      conversationId,
      kind: 'policy_decision',
      action: 'evaluate',
      actor: 'policy-engine',
      outcome: decision.allowed ? 'success' : 'denied',
      data: {
        toolCallId: call.id,
        toolName: call.name,
        risk: tool.definition.risk,
        allowed: decision.allowed,
        reason: decision.reason,
      },
    });

    if (!decision.allowed) {
      const error = `Policy denied ${call.name}: ${decision.reason}`;
      await appendAudit(this.audit, {
        conversationId,
        kind: 'tool_call',
        action: 'execute',
        actor: 'tool-registry',
        outcome: 'denied',
        data: {
          toolCallId: call.id,
          toolName: call.name,
          arguments: sanitizeAuditValue(call.arguments),
          error,
        },
      });
      throw new Error(error);
    }

    try {
      const input = tool.input.parse(call.arguments) as Record<string, unknown>;
      const result = await tool.execute(input);
      await appendAudit(this.audit, {
        conversationId,
        kind: 'tool_call',
        action: 'execute',
        actor: 'tool-registry',
        outcome: 'success',
        data: {
          toolCallId: call.id,
          toolName: call.name,
          arguments: sanitizeAuditValue(call.arguments),
          result: sanitizeAuditValue(result),
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'tool execution failed';
      await appendAudit(this.audit, {
        conversationId,
        kind: 'tool_call',
        action: 'execute',
        actor: 'tool-registry',
        outcome: 'error',
        data: {
          toolCallId: call.id,
          toolName: call.name,
          arguments: sanitizeAuditValue(call.arguments),
          error: message,
        },
      });
      throw error;
    }
  }
}

const emptyParameters = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export function createDefaultToolRegistry(
  dependencies: {
    events: EventStore;
    worldState: WorldStateProjection;
    camera?: CameraAdapter;
    audit?: AuditStore;
    semanticMemory?: SemanticMemory;
    cameraLocations?: Record<string, string>;
    detectorStatus?: () => Promise<unknown>;
    recordings?: RecordingStore;
    evidenceIndex?: EvidenceIndexStore;
    indexRuns?: RecordingIndexRunStore;
  },
): ToolRegistry {
  const registry = new ToolRegistry(new PolicyEngine(), dependencies.audit);
  const episodicMemory = new EpisodicMemory(dependencies.events);
  const semanticMemory = dependencies.semanticMemory ?? new SemanticMemory();
  const detectorStatus = dependencies.detectorStatus ?? (async (): Promise<unknown> => {
    try {
      return await inspectDetectorStatus(parseDetectorStatusOptions());
    } catch {
      return { available: false, reason: 'detector_status_unavailable' };
    }
  });
  const timeline = new TimelineService(dependencies.events, dependencies.recordings, {
    evidenceIndex: dependencies.evidenceIndex,
    indexRuns: dependencies.indexRuns,
  });

  registry.register({
    definition: {
      name: 'get_home_state',
      description: 'Consulta o estado atual conhecido da residência. Não invente dados ausentes.',
      risk: 'read',
      parameters: emptyParameters,
    },
    input: z.object({}),
    execute: async (): Promise<HomeState> => dependencies.worldState.snapshot(),
  });

  registry.register({
    definition: {
      name: 'get_house_knowledge',
      description: 'Consulta a topologia semântica explicitamente configurada da casa. Não invente cômodos ou conexões ausentes.',
      risk: 'read',
      parameters: emptyParameters,
    },
    input: z.object({}),
    execute: async () => semanticMemory.snapshot(),
  });

  registry.register({
    definition: {
      name: 'search_events',
      description: 'Busca eventos do histórico por texto ou por filtros episódicos de intervalo, local, assunto e tipo.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo livre a pesquisar.' },
          from: { type: 'string', description: 'Início inclusivo em ISO 8601 com timezone.' },
          to: { type: 'string', description: 'Fim inclusivo em ISO 8601 com timezone.' },
          location: { type: 'string', description: 'Local exato do evento.' },
          subjectId: { type: 'string', description: 'ID da pessoa ou objeto observado.' },
          type: { type: 'string', description: 'Tipo estruturado do evento.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    input: z.object({
      query: z.string().min(1).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      location: z.string().min(1).optional(),
      subjectId: z.string().min(1).optional(),
      type: EventTypeSchema.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).refine(
      (value) => Boolean(value.query || value.from || value.to || value.location || value.subjectId || value.type),
      { message: 'search_events requires query or at least one episodic filter' },
    ),
    execute: async (input) => {
      const query = input as {
        query?: string;
        from?: string;
        to?: string;
        location?: string;
        subjectId?: string;
        type?: EventQuery['type'];
        limit?: number;
      };
      const hasFilters = Boolean(query.from || query.to || query.location || query.subjectId || query.type);
      if (hasFilters) {
        return episodicMemory.search({
          from: query.from,
          to: query.to,
          location: query.location,
          subjectId: query.subjectId,
          type: query.type,
          limit: query.limit,
        });
      }
      if (!query.query) throw new Error('search_events requires query or at least one episodic filter');
      return dependencies.events.search(query.query, query.limit);
    },
  });

  registry.register({
    definition: {
      name: 'search_object_observations',
      description: 'Busca observações de objetos detectados por classe, câmera, local e intervalo.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          className: { type: 'string', description: 'Classe COCO, por exemplo car ou motorcycle.' },
          camera: { type: 'string', description: 'Câmera lógica.' },
          from: { type: 'string', description: 'Início inclusivo em ISO 8601 com timezone.' },
          to: { type: 'string', description: 'Fim inclusivo em ISO 8601 com timezone.' },
          location: { type: 'string', description: 'Local exato.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    input: z.object({
      className: z.string().min(1).optional(),
      camera: z.string().min(1).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      location: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).refine(
      (value) => Boolean(value.className || value.camera || value.from || value.to || value.location),
      { message: 'search_object_observations requires at least one filter' },
    ),
    execute: async (input) => {
      const query = input as {
        className?: string;
        camera?: string;
        from?: string;
        to?: string;
        location?: string;
        limit?: number;
      };
      const limit = query.limit ?? 20;
      const observations = await episodicMemory.search({
        type: 'object.observed',
        subjectId: query.className,
        from: query.from,
        to: query.to,
        location: query.location,
        limit: 100,
      });
      const filtered = observations
        .filter((event) => query.camera === undefined || event.data.camera === query.camera)
        .slice(-limit);
      return { count: filtered.length, events: filtered };
    },
  });

  registry.register({
    definition: {
      name: 'search_ocr',
      description: 'Busca texto OCR observado em snapshots por termo, câmera, local e intervalo.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo livre ou texto normalizado.' },
          camera: { type: 'string', description: 'Câmera lógica.' },
          from: { type: 'string', description: 'Início inclusivo em ISO 8601 com timezone.' },
          to: { type: 'string', description: 'Fim inclusivo em ISO 8601 com timezone.' },
          location: { type: 'string', description: 'Local exato.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    input: z.object({
      query: z.string().min(1).optional(),
      camera: z.string().min(1).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      location: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }).refine(
      (value) => Boolean(value.query || value.camera || value.from || value.to || value.location),
      { message: 'search_ocr requires query or at least one filter' },
    ),
    execute: async (input) => {
      const query = input as {
        query?: string;
        camera?: string;
        from?: string;
        to?: string;
        location?: string;
        limit?: number;
      };
      const limit = query.limit ?? 20;
      const candidates = query.query
        ? await dependencies.events.search(query.query, 100)
        : await episodicMemory.search({
          type: 'ocr.observation',
          from: query.from,
          to: query.to,
          location: query.location,
          limit: 100,
        });
      const fromMs = query.from ? Date.parse(query.from) : undefined;
      const toMs = query.to ? Date.parse(query.to) : undefined;
      const filtered = candidates
        .filter((event) => event.type === 'ocr.observation')
        .filter((event) => query.camera === undefined || event.data.camera === query.camera)
        .filter((event) => query.location === undefined || event.location === query.location)
        .filter((event) => fromMs === undefined || Date.parse(event.timestamp) >= fromMs)
        .filter((event) => toMs === undefined || Date.parse(event.timestamp) <= toMs)
        .slice(-limit);
      return { count: filtered.length, events: filtered };
    },
  });

  registry.register({
    definition: {
      name: 'get_detector_status',
      description: 'Consulta o health e as métricas do detector sem iniciar ou alterar processos.',
      risk: 'read',
      parameters: emptyParameters,
    },
    input: z.object({}),
    execute: async () => detectorStatus(),
  });

  registry.register({
    definition: {
      name: 'search_recordings',
      description: 'Busca segmentos de gravação por câmera e intervalo, retornando apenas metadata.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          camera: { type: 'string', description: 'Câmera lógica.' },
          from: { type: 'string', description: 'Início inclusivo em ISO 8601 com timezone.' },
          to: { type: 'string', description: 'Fim inclusivo em ISO 8601 com timezone.' },
          objectClass: { type: 'string', description: 'Classe de objeto presente na evidência.' },
          ocrQuery: { type: 'string', description: 'Texto OCR normalizado ou termo parcial.' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
    input: z.object({
      camera: z.string().min(1).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      objectClass: z.string().min(1).optional(),
      ocrQuery: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).refine(
      (value) => Boolean(value.camera || value.from || value.to || value.objectClass || value.ocrQuery),
      { message: 'search_recordings requires at least one filter' },
    ),
    execute: async (input) => {
      if (!dependencies.recordings) return { available: false, count: 0, recordings: [] };
      const query = input as { camera?: string; from?: string; to?: string; objectClass?: string; ocrQuery?: string; limit?: number };
      const requestedLimit = query.limit ?? 20;
      let recordings = await dependencies.recordings.list({
        camera: query.camera,
        from: query.from,
        to: query.to,
        overlap: true,
        limit: query.objectClass || query.ocrQuery ? 10_000 : requestedLimit,
      });
      if (query.objectClass || query.ocrQuery) {
        const ids = await matchingRecordingIds(dependencies.events, dependencies.evidenceIndex, query);
        recordings = recordings.filter((recording) => ids.has(recording.id));
      }
      recordings = recordings.slice(-requestedLimit);
      return { available: true, count: recordings.length, recordings };
    },
  });

  registry.register({
    definition: {
      name: 'get_recording',
      description: 'Retorna metadata e referência local de um segmento, sem carregar o vídeo no prompt.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID do segmento de gravação.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    input: z.object({ id: z.string().min(1) }),
    execute: async (input) => {
      if (!dependencies.recordings) return { available: false, recording: null };
      const recording = await dependencies.recordings.findById(input.id as string) ?? null;
      if (!recording) return { available: true, recording: null };
      const indexRun = dependencies.indexRuns ? await dependencies.indexRuns.findLatestBySegment(recording.id) : undefined;
      const evidenceCount = dependencies.evidenceIndex
        ? await dependencies.evidenceIndex.countEvidenceByRecording(recording.id)
        : undefined;
      return {
        available: true,
        recording,
        indexing: {
          status: indexRun?.status ?? 'not_indexed',
          attempts: indexRun?.attempts ?? 0,
          evidenceCount: evidenceCount ?? indexRun?.evidenceCount ?? 0,
          framesProcessed: indexRun?.framesProcessed ?? 0,
          objectCount: indexRun?.objectCount ?? 0,
          ocrCount: indexRun?.ocrCount ?? 0,
          ...(indexRun?.error ? { error: indexRun.error } : {}),
        },
      };
    },
  });

  registry.register({
    definition: {
      name: 'get_evidence',
      description: 'Retorna uma evidência de câmera, suas observações e referência segura de mídia. Nunca carrega base64 no prompt.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID da evidência/frame.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    input: z.object({ id: z.string().min(1) }),
    execute: async (input) => {
      if (!dependencies.evidenceIndex) return { available: false, evidence: null, observations: [] };
      const evidence = await dependencies.evidenceIndex.findEvidenceById(input.id as string);
      if (!evidence) return { available: true, evidence: null, observations: [] };
      return {
        available: true,
        evidence: {
          ...evidence,
          imageUrl: `/evidence/${encodeURIComponent(evidence.id)}/image`,
          ...(evidence.recordingSegmentId ? { clipUrl: `/recordings/${encodeURIComponent(evidence.recordingSegmentId)}/clip` } : {}),
        },
        observations: await dependencies.evidenceIndex.listObservations(evidence.id),
        ...(evidence.recordingSegmentId && dependencies.recordings
          ? { recording: await dependencies.recordings.findById(evidence.recordingSegmentId) ?? null }
          : {}),
      };
    },
  });

  registry.register({
    definition: {
      name: 'get_timeline',
      description: 'Consulta a timeline unificada de eventos e gravações por câmera e intervalo.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          camera: { type: 'string', description: 'Câmera lógica.' },
          from: { type: 'string', description: 'Início inclusivo em ISO 8601 com timezone.' },
          to: { type: 'string', description: 'Fim inclusivo em ISO 8601 com timezone.' },
          eventType: { type: 'string', description: 'Tipo de evento ou camera.snapshot.' },
          objectClass: { type: 'string', description: 'Classe de objeto observada.' },
          ocrQuery: { type: 'string', description: 'Texto OCR parcial.' },
          evidenceOnly: { type: 'boolean', description: 'Retorna apenas frames com evidência.' },
          cursor: { type: 'string', description: 'Cursor opaco retornado pela página anterior.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
    },
    input: z.object({
      camera: z.string().min(1).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      eventType: z.string().min(1).optional(),
      objectClass: z.string().min(1).optional(),
      ocrQuery: z.string().min(1).optional(),
      evidenceOnly: z.boolean().optional(),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    execute: async (input) => timeline.query(input as {
      camera?: string;
      from?: string;
      to?: string;
      eventType?: string;
      objectClass?: string;
      ocrQuery?: string;
      evidenceOnly?: boolean;
      cursor?: string;
      limit?: number;
    }),
  });

  registry.register({
    definition: {
      name: 'find_object',
      description: 'Localiza um objeto pela última observação episódica registrada, sem inventar localização.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          object: { type: 'string', description: 'ID lógico do objeto, por exemplo tv_remote.' },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['object'],
        additionalProperties: false,
      },
    },
    input: z.object({
      object: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    execute: async (input) => {
      const objectId = input.object as string;
      const observations = await episodicMemory.search({
        subjectId: objectId,
        type: 'object.observed',
        limit: input.limit as number | undefined,
      });
      const latest = observations.at(-1);
      return {
        object: objectId,
        found: Boolean(latest),
        lastKnown: latest
          ? {
            location: latest.location ?? null,
            timestamp: latest.timestamp,
            confidence: latest.confidence ?? null,
            evidenceEventId: latest.id,
          }
          : null,
        observations,
      };
    },
  });

  if (dependencies.camera) {
    registry.register({
      definition: {
        name: 'get_camera_snapshot',
        description: 'Captura um frame atual da câmera configurada para análise visual.',
        risk: 'read',
        parameters: {
          type: 'object',
          properties: {
            camera: { type: 'string', description: 'Nome lógico da câmera, por exemplo front.' },
          },
          additionalProperties: false,
        },
      },
      input: z.object({ camera: z.string().min(1).default('front') }),
      execute: async (input) => {
        const snapshot = await dependencies.camera!.snapshot(input.camera as string);
        const location = dependencies.cameraLocations?.[snapshot.camera] ?? snapshot.camera;
        const sourceType = snapshot.sourceType ?? 'camera';
        const sourceId = snapshot.sourceId ?? snapshot.camera;
        const event = await dependencies.events.append({
          id: `evt-${randomUUID()}`,
          type: 'camera.snapshot',
          timestamp: snapshot.capturedAt,
          source: { type: sourceType, id: sourceId },
          location,
          data: {
            camera: snapshot.camera,
            location,
            sourceType,
            sourceId,
            ...(snapshot.oid === undefined ? {} : { oid: snapshot.oid }),
            imageRef: snapshot.imageRef ?? null,
            mimeType: snapshot.mimeType,
            bytes: snapshot.bytes,
          },
        });
        return { ...snapshot, eventId: event.id, eventLocation: location };
      },
    });
  }

  return registry;
}
