export type AlexaSpeakMode = 'speak' | 'announce';

export interface HomeAssistantAlexaOutputOptions {
  baseUrl: string;
  token: string;
  entityId: string;
  announceEntityId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AlexaOutputReceipt {
  target: 'alexa';
  entityId: string;
  mode: AlexaSpeakMode;
  deliveredAt: string;
}

export class HomeAssistantAlexaOutput {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly entityId: string;
  private readonly announceEntityId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HomeAssistantAlexaOutputOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.token = options.token.trim();
    this.entityId = options.entityId.trim();
    this.announceEntityId = options.announceEntityId?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error('Home Assistant baseUrl must use http or https');
    if (!this.token) throw new Error('Home Assistant token must not be empty');
    if (!this.entityId.startsWith('notify.')) throw new Error('Alexa entityId must be a notify entity');
    if (this.announceEntityId && !this.announceEntityId.startsWith('notify.')) throw new Error('Alexa announceEntityId must be a notify entity');
  }

  async speak(text: string, mode: AlexaSpeakMode = 'speak'): Promise<AlexaOutputReceipt> {
    const message = text.trim();
    if (!message) throw new Error('Alexa message must not be empty');
    const entityId = mode === 'announce' ? this.announceEntityId ?? this.entityId : this.entityId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/services/notify/send`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ entity_id: entityId, message }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Home Assistant Alexa output failed with HTTP ${response.status}`);
      return { target: 'alexa', entityId, mode, deliveredAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Home Assistant Alexa output timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
