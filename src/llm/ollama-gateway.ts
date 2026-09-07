import type { ModelGateway, ModelMessage, ModelRequest, ModelResponse, ToolCall, ToolDefinition } from './model-gateway.js';

interface OllamaToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
}

export interface OllamaGatewayOptions {
  baseUrl?: string;
  model?: string;
  contextSize?: number;
  fetchImpl?: typeof fetch;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toOllamaMessage(message: ModelMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };

  if (message.images?.length) {
    result.images = message.images;
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
  }

  if (message.role === 'tool') {
    result.tool_name = message.toolName;
  }

  return result;
}

function toOllamaTools(tools: ToolDefinition[] | undefined): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export class OllamaGateway implements ModelGateway {
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly contextSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaGatewayOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.defaultModel = options.model ?? 'gemma-hermes:latest';
    this.contextSize = options.contextSize ?? 8192;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model || this.defaultModel,
        messages: request.messages.map(toOllamaMessage),
        tools: toOllamaTools(request.tools),
        stream: false,
        options: {
          num_ctx: this.contextSize,
          temperature: 0.2,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = await response.json() as OllamaResponse;
    const message = payload.message ?? {};
    const toolCalls = (message.tool_calls ?? []).flatMap((call, index): ToolCall[] => {
      const name = call.function?.name;
      if (!name) return [];
      return [{
        id: call.id ?? `ollama-call-${index + 1}`,
        name,
        arguments: parseArguments(call.function?.arguments),
      }];
    });

    return {
      content: message.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}
