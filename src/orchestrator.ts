import type { ModelGateway, ModelMessage, ModelResponse, ToolCall } from './llm/model-gateway.js';
import type { EventStore } from './events/in-memory-event-store.js';
import type { ToolRegistry } from './tools/tool-registry.js';
import { randomUUID } from 'node:crypto';

import { GroundingGuard } from './grounding/grounding-guard.js';
import type { AuditStore } from './audit/audit-store.js';
import { appendAudit } from './audit/audit-utils.js';

const SYSTEM_PROMPT = `Você é o Jarvis Core, um assistente residencial local.

Regras obrigatórias:
- Nunca invente o estado atual da residência.
- Para perguntas sobre pessoas, cômodos, objetos, sensores ou segurança, consulte uma ferramenta quando houver uma ferramenta adequada.
- Diferencie observado, provável, incerto e desconhecido.
- Se as ferramentas não tiverem evidência suficiente, diga claramente que não é possível confirmar.
- Você pode interpretar dados e propor ações, mas não autoriza nem executa ações críticas.
- Responda em português do Brasil, de forma objetiva e fundamentada.`;

export interface ToolTrace {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface ConversationResult {
  conversationId: string;
  answer: string;
  toolCalls: ToolTrace[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicToolResult(value: unknown): unknown {
  if (!isRecord(value) || typeof value.base64 !== 'string') return value;
  const metadata = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'base64'),
  );
  return { ...metadata, imageAttached: true };
}

function toolImages(value: unknown): string[] | undefined {
  if (!isRecord(value) || typeof value.base64 !== 'string') return undefined;
  return [value.base64];
}

export class ConversationOrchestrator {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly tools: ToolRegistry,
    private readonly model = 'gemma-hermes:latest',
    private readonly events?: EventStore,
    private readonly groundingGuard = new GroundingGuard(),
    private readonly audit?: AuditStore,
  ) {}

  private async recordVisionObservation(answer: string, traces: ToolTrace[]): Promise<void> {
    if (!this.events) return;

    for (const trace of traces) {
      if (trace.name !== 'get_camera_snapshot' || !isRecord(trace.result)) continue;
      if (typeof trace.result.eventId !== 'string') continue;

      const camera = typeof trace.result.camera === 'string' ? trace.result.camera : undefined;
      const location = typeof trace.result.eventLocation === 'string'
        ? trace.result.eventLocation
        : camera;
      await this.events.append({
        id: `evt-${randomUUID()}`,
        type: 'vision.observation',
        timestamp: new Date().toISOString(),
        source: { type: 'jarvis-core', id: 'vision' },
        location,
        data: {
          interpretation: answer,
          evidenceEventId: trace.result.eventId,
          imageRef: typeof trace.result.imageRef === 'string' ? trace.result.imageRef : null,
        },
      });
    }
  }

  async respond(message: string): Promise<ConversationResult> {
    const conversationId = `conv-${randomUUID()}`;
    await appendAudit(this.audit, {
      conversationId,
      kind: 'conversation',
      action: 'received',
      actor: 'user',
      data: { message },
    });

    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message },
    ];
    const traces: ToolTrace[] = [];

    for (let round = 0; round < 3; round += 1) {
      const response: ModelResponse = await this.gateway.complete({
        model: this.model,
        messages,
        tools: this.tools.definitions(),
      });
      const toolCalls = response.toolCalls ?? [];

      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls,
        });

        for (const call of toolCalls) {
          let result: unknown;
          try {
            result = await this.tools.execute(call, { conversationId });
          } catch (error) {
            result = {
              error: error instanceof Error ? error.message : 'tool execution failed',
            };
          }

          const traceResult = publicToolResult(result);
          const images = toolImages(result);
          traces.push({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            result: traceResult,
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify(traceResult) ?? 'null',
            toolCallId: call.id,
            toolName: call.name,
            ...(images ? { images } : {}),
          });
        }
        continue;
      }

      const answer = response.content?.trim();
      const modelAnswer = answer && answer.length > 0
        ? answer
        : 'Não consegui produzir uma resposta fundamentada.';
      await this.recordVisionObservation(modelAnswer, traces);
      const finalAnswer = this.groundingGuard.calibrate(message, modelAnswer, traces);
      await appendAudit(this.audit, {
        conversationId,
        kind: 'conversation',
        action: 'completed',
        actor: 'jarvis-core',
        outcome: 'success',
        data: {
          modelAnswer,
          answer: finalAnswer,
          toolCalls: traces,
        },
      });
      return {
        conversationId,
        answer: finalAnswer,
        toolCalls: traces,
      };
    }

    const answer = 'A consulta excedeu o limite seguro de etapas de ferramenta.';
    await appendAudit(this.audit, {
      conversationId,
      kind: 'conversation',
      action: 'completed',
      actor: 'jarvis-core',
      outcome: 'error',
      data: { answer, toolCalls: traces },
    });
    return {
      conversationId,
      answer,
      toolCalls: traces,
    };
  }
}
