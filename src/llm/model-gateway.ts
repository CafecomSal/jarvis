import type { ToolRisk } from '../policies/policy-engine.js';

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelMessage =
  | { role: 'system' | 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; images?: string[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; images?: string[]; toolCallId: string; toolName: string };

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
}

export interface ModelResponse {
  content?: string;
  toolCalls?: ToolCall[];
}

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
