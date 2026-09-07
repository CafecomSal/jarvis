import { createHash } from 'node:crypto';
import type { EventStore } from '../events/in-memory-event-store.js';
import type { HomeEvent } from '../events/schema.js';
import {
  ObservationTagSchema,
  type ObservationTag,
  type TagListResult,
  type TagQuery,
  type TagSource,
  type TagStatus,
  type TagValue,
} from './tag-schema.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function scalarValue(value: unknown): TagValue | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

function eventCamera(event: HomeEvent): string | undefined {
  const camera = stringValue(event.data.camera);
  if (camera) return camera;
  if (event.source.type === 'camera' || event.source.type === 'rtsp' || event.source.type === 'recording') {
    return event.source.id;
  }
  return undefined;
}

function statusFor(event: HomeEvent): TagStatus {
  return event.data.confirmed === true ? 'confirmed' : 'observed';
}

function sourceFor(event: HomeEvent): TagSource {
  if (event.type === 'ocr.observation') return 'ocr';
  if (event.source.type === 'vlm' || event.source.type === 'gemma') return 'vlm';
  return 'detector';
}

function tagId(eventId: string, path: string, value: TagValue): string {
  const digest = createHash('sha256')
    .update(`${eventId}\u0000${path}\u0000${JSON.stringify(value)}`)
    .digest('hex')
    .slice(0, 24);
  return `tag-${digest}`;
}

export class TagService {
  constructor(private readonly events: EventStore) {}

  private makeTag(
    event: HomeEvent,
    namespace: string,
    key: string,
    value: TagValue,
    path: string,
    source = sourceFor(event),
  ): ObservationTag {
    const evidenceEventId = stringValue(event.data.evidenceEventId) ?? event.id;
    const recordingId = stringValue(event.data.recordingSegmentId);
    const frameRef = typeof event.data.imageRef === 'string' ? event.data.imageRef : null;
    const camera = eventCamera(event);
    const confidence = typeof event.data.confidence === 'number'
      ? event.data.confidence
      : event.confidence;
    return ObservationTagSchema.parse({
      id: tagId(event.id, path, value),
      evidenceEventId,
      ...(recordingId ? { recordingId } : {}),
      frameRef,
      ...(camera ? { camera } : {}),
      ...(event.location ? { location: event.location } : {}),
      namespace,
      key,
      value,
      ...(confidence === undefined ? {} : { confidence }),
      source,
      status: statusFor(event),
      createdAt: event.timestamp,
    });
  }

  private fromEvent(event: HomeEvent): ObservationTag[] {
    const tags: ObservationTag[] = [];
    if (event.type === 'object.observed' || event.type === 'person.detected') {
      const className = stringValue(event.data.className)
        ?? (event.type === 'person.detected' ? 'person' : stringValue(event.subject?.id));
      if (className) tags.push(this.makeTag(event, 'object', 'class', className, 'class'));

      const attributes = event.data.attributes;
      if (isRecord(attributes) && className) {
        for (const [key, rawValue] of Object.entries(attributes)) {
          const value = scalarValue(rawValue);
          if (value !== undefined) tags.push(this.makeTag(event, className, key, value, `attributes.${key}`));
        }
      }

      const relationships = event.data.relationships;
      if (Array.isArray(relationships)) {
        relationships.forEach((relationship, index) => {
          if (typeof relationship === 'string') {
            tags.push(this.makeTag(event, 'relation', relationship, true, `relationships.${index}`));
            return;
          }
          if (!isRecord(relationship)) return;
          const type = stringValue(relationship.type);
          const target = scalarValue(relationship.target);
          if (type && target !== undefined) {
            tags.push(this.makeTag(event, 'relation', type, target, `relationships.${index}.target`));
          }
        });
      }

      const explicitTags = event.data.tags;
      if (Array.isArray(explicitTags)) {
        explicitTags.forEach((tag, index) => {
          if (!isRecord(tag)) return;
          const namespace = stringValue(tag.namespace);
          const key = stringValue(tag.key);
          const value = scalarValue(tag.value);
          if (namespace && key && value !== undefined) {
            tags.push(this.makeTag(event, namespace, key, value, `tags.${index}`, 'vlm'));
          }
        });
      }
    }

    if (event.type === 'ocr.observation') {
      const normalizedText = stringValue(event.data.normalizedText) ?? stringValue(event.data.text);
      if (normalizedText) tags.push(this.makeTag(event, 'ocr', 'text', normalizedText, 'normalizedText'));
    }

    return tags;
  }

  async list(query: TagQuery = {}): Promise<TagListResult> {
    const events = await this.events.query({ from: query.from, to: query.to, limit: 10_000 });
    const normalizedQuery = query.query?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const normalizedValue = query.value?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const tags = events
      .flatMap((event) => this.fromEvent(event))
      .filter((tag) => query.namespace === undefined || tag.namespace === query.namespace)
      .filter((tag) => query.key === undefined || tag.key === query.key)
      .filter((tag) => query.source === undefined || tag.source === query.source)
      .filter((tag) => query.status === undefined || tag.status === query.status)
      .filter((tag) => query.camera === undefined || tag.camera === query.camera)
      .filter((tag) => normalizedValue === undefined || String(tag.value).toLowerCase().includes(normalizedValue))
      .filter((tag) => normalizedQuery === undefined
        || `${tag.namespace}.${tag.key}=${String(tag.value)}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(normalizedQuery))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const limit = query.limit ?? 100;
    const limited = tags.slice(-limit);
    return { count: limited.length, tags: limited };
  }

  async get(id: string): Promise<ObservationTag | undefined> {
    const result = await this.list({ limit: 10_000 });
    return result.tags.find((tag) => tag.id === id);
  }
}
