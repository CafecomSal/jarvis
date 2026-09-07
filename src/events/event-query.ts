import type { EventType } from './schema.js';

export interface EventQuery {
  from?: string;
  to?: string;
  type?: EventType;
  location?: string;
  subjectId?: string;
  limit?: number;
}
