import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryAuditStore } from '../src/audit/in-memory-audit-store.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import type { ModelGateway, ModelRequest, ModelResponse } from '../src/llm/model-gateway.js';
import { z } from 'zod';

class AuditGateway implements ModelGateway {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!request.messages.some((message) => message.role === 'tool')) {
      return {
        toolCalls: [{ id: 'call-home-state', name: 'get_home_state', arguments: {} }],
      };
    }

    return { content: 'Resposta fundamentada pelo estado consultado.' };
  }
}

describe('audit log do Jarvis Core', () => {
  it('registra conversa, decisão de política e execução de tool com a mesma correlação', async () => {
    const audit = new InMemoryAuditStore();
    const app = buildApp({ gateway: new AuditGateway(), audit });

    const response = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'Qual o estado conhecido da casa?' },
    });
    const body = response.json();
    const entries = await audit.list(20);

    expect(response.statusCode).toBe(200);
    expect(body.conversationId).toMatch(/^conv-/);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'conversation',
      'policy_decision',
      'tool_call',
      'conversation',
    ]);
    expect(entries.every((entry) => entry.conversationId === body.conversationId)).toBe(true);
    expect(entries[0]).toMatchObject({
      action: 'received',
      actor: 'user',
      data: { message: 'Qual o estado conhecido da casa?' },
    });
    expect(entries[1]).toMatchObject({
      action: 'evaluate',
      actor: 'policy-engine',
      data: { toolName: 'get_home_state', risk: 'read', allowed: true },
    });
    expect(entries[2]).toMatchObject({
      action: 'execute',
      actor: 'tool-registry',
      outcome: 'success',
      data: { toolName: 'get_home_state', arguments: {} },
    });
    expect(entries[3]).toMatchObject({
      action: 'completed',
      actor: 'jarvis-core',
      outcome: 'success',
      data: {
        modelAnswer: 'Resposta fundamentada pelo estado consultado.',
        answer: 'Resposta fundamentada pelo estado consultado.',
      },
    });
  });

  it('registra uma decisão de bloqueio antes de negar uma tool crítica', async () => {
    const audit = new InMemoryAuditStore();
    const registry = new ToolRegistry(undefined, audit);
    registry.register({
      definition: {
        name: 'unlock_door',
        description: 'Destranca uma porta.',
        risk: 'critical',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });

    await expect(registry.execute(
      { id: 'call-critical', name: 'unlock_door', arguments: {} },
      { conversationId: 'conv-denied' },
    )).rejects.toThrow('Policy denied unlock_door');

    const entries = await audit.forConversation('conv-denied');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'policy_decision',
      data: { toolName: 'unlock_door', risk: 'critical', allowed: false },
    });
    expect(entries[1]).toMatchObject({
      kind: 'tool_call',
      outcome: 'denied',
      data: { toolName: 'unlock_door', arguments: {} },
    });
  });

  it('expõe o histórico correlacionado pela API local', async () => {
    const audit = new InMemoryAuditStore();
    const app = buildApp({ gateway: new AuditGateway(), audit });

    const conversation = await app.inject({
      method: 'POST',
      url: '/conversation',
      payload: { message: 'Qual o estado conhecido da casa?' },
    });
    const conversationId = conversation.json().conversationId as string;

    const response = await app.inject({
      method: 'GET',
      url: `/audit?conversationId=${encodeURIComponent(conversationId)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toHaveLength(4);
    expect(response.json().entries.every((entry: { conversationId: string }) => entry.conversationId === conversationId)).toBe(true);
  });
});
