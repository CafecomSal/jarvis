import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';

export interface SttQuotaLimits {
  maxRequestsPerDay: number;
  maxAudioSecondsPerDay: number;
  maxEstimatedMonthlyUsd: number;
}

export interface SttUsageRecord {
  sessionId: string;
  audioSeconds: number;
  estimatedUsd: number;
  recordedAt?: string;
}

export interface SttUsageTotals {
  day: string;
  requests: number;
  audioSeconds: number;
  estimatedUsd: number;
}

export interface SttUsageStore {
  get(day: string): Promise<SttUsageTotals>;
  getMonth(month: string): Promise<SttUsageTotals>;
  record(day: string, record: SttUsageRecord): Promise<SttUsageTotals>;
}

function emptyTotals(day: string): SttUsageTotals {
  return { day, requests: 0, audioSeconds: 0, estimatedUsd: 0 };
}

function billedSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('STT usage audioSeconds must be non-negative');
  return Math.max(10, Math.ceil(seconds));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateGroqCostUsd(seconds: number, model: string): number {
  const ratePerHour = model === 'whisper-large-v3' ? 0.111 : 0.04;
  return billedSeconds(seconds) * ratePerHour / 3_600;
}

export class InMemorySttUsageStore implements SttUsageStore {
  private readonly records = new Map<string, Map<string, SttUsageRecord>>();

  async get(day: string): Promise<SttUsageTotals> {
    const records = this.records.get(day);
    if (!records) return emptyTotals(day);
    return [...records.values()].reduce((totals, record) => ({
      day,
      requests: totals.requests + 1,
      audioSeconds: totals.audioSeconds + record.audioSeconds,
      estimatedUsd: totals.estimatedUsd + record.estimatedUsd,
    }), emptyTotals(day));
  }

  async getMonth(month: string): Promise<SttUsageTotals> {
    const records = [...this.records.entries()]
      .filter(([day]) => day.startsWith(`${month}-`))
      .flatMap(([, values]) => [...values.values()]);
    return records.reduce((totals, record) => ({
      day: month,
      requests: totals.requests + 1,
      audioSeconds: totals.audioSeconds + record.audioSeconds,
      estimatedUsd: totals.estimatedUsd + record.estimatedUsd,
    }), emptyTotals(month));
  }

  async record(day: string, record: SttUsageRecord): Promise<SttUsageTotals> {
    if (!record.sessionId.trim()) throw new Error('STT usage sessionId must not be empty');
    const dayRecords = this.records.get(day) ?? new Map<string, SttUsageRecord>();
    if (!dayRecords.has(record.sessionId)) {
      dayRecords.set(record.sessionId, {
        ...record,
        audioSeconds: billedSeconds(record.audioSeconds),
        estimatedUsd: Math.max(0, record.estimatedUsd),
      });
    }
    this.records.set(day, dayRecords);
    return this.get(day);
  }
}

export interface SttQuotaSnapshot extends SttUsageTotals {
  monthlyEstimatedUsd: number;
  remainingRequests: number;
  remainingAudioSeconds: number;
  remainingEstimatedUsd: number;
}

export class SttQuotaGuard {
  private limits: SttQuotaLimits;

  constructor(
    private readonly store: SttUsageStore,
    limits: SttQuotaLimits,
    private readonly dayProvider: () => string = () => new Date().toISOString().slice(0, 10),
  ) {
    this.validateLimits(limits);
    this.limits = { ...limits };
  }

  private validateLimits(limits: SttQuotaLimits): void {
    if (!Number.isInteger(limits.maxRequestsPerDay) || limits.maxRequestsPerDay < 1) throw new Error('STT quota requests limit must be positive');
    if (!Number.isInteger(limits.maxAudioSecondsPerDay) || limits.maxAudioSecondsPerDay < 1) throw new Error('STT quota audio limit must be positive');
    if (!Number.isFinite(limits.maxEstimatedMonthlyUsd) || limits.maxEstimatedMonthlyUsd < 0) throw new Error('STT quota cost limit must be non-negative');
  }

  updateLimits(limits: SttQuotaLimits): void {
    this.validateLimits(limits);
    this.limits = { ...limits };
  }

  async canUse(input: { audioSeconds: number; estimatedUsd: number }): Promise<boolean> {
    const day = this.dayProvider();
    const [current, monthly] = await Promise.all([this.store.get(day), this.store.getMonth(day.slice(0, 7))]);
    const seconds = billedSeconds(input.audioSeconds);
    const cost = Math.max(0, input.estimatedUsd);
    return current.requests + 1 <= this.limits.maxRequestsPerDay
      && current.audioSeconds + seconds <= this.limits.maxAudioSecondsPerDay
      && monthly.estimatedUsd + cost <= this.limits.maxEstimatedMonthlyUsd;
  }

  async record(record: SttUsageRecord): Promise<SttQuotaSnapshot> {
    const day = this.dayProvider();
    await this.store.record(day, record);
    return this.snapshot();
  }

  async snapshot(): Promise<SttQuotaSnapshot> {
    const day = this.dayProvider();
    const [totals, monthly] = await Promise.all([this.store.get(day), this.store.getMonth(day.slice(0, 7))]);
    return {
      ...totals,
      monthlyEstimatedUsd: monthly.estimatedUsd,
      remainingRequests: Math.max(0, this.limits.maxRequestsPerDay - totals.requests),
      remainingAudioSeconds: Math.max(0, this.limits.maxAudioSecondsPerDay - totals.audioSeconds),
      remainingEstimatedUsd: Math.max(0, roundUsd(this.limits.maxEstimatedMonthlyUsd - monthly.estimatedUsd)),
    };
  }
}

interface SttUsageRow extends QueryResultRow {
  requests: string | number;
  audio_seconds: string | number;
  estimated_usd: string | number;
}

export interface PostgresSttUsageStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresSttUsageStore implements SttUsageStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresSttUsageStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    await this.pool.query(await readPostgresMigration(currentFile, '004_runtime_settings.sql'));
  }

  async get(day: string): Promise<SttUsageTotals> {
    const result = await this.pool.query<SttUsageRow>(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(audio_seconds), 0)::int AS audio_seconds,
              COALESCE(SUM(estimated_usd), 0)::double precision AS estimated_usd
         FROM stt_usage_records WHERE usage_day = $1`,
      [day],
    );
    const row = result.rows[0];
    return {
      day,
      requests: Number(row?.requests ?? 0),
      audioSeconds: Number(row?.audio_seconds ?? 0),
      estimatedUsd: Number(row?.estimated_usd ?? 0),
    };
  }

  async getMonth(month: string): Promise<SttUsageTotals> {
    const result = await this.pool.query<SttUsageRow>(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(audio_seconds), 0)::int AS audio_seconds,
              COALESCE(SUM(estimated_usd), 0)::double precision AS estimated_usd
         FROM stt_usage_records
        WHERE usage_day >= ($1 || '-01')::date
          AND usage_day < (($1 || '-01')::date + INTERVAL '1 month')`,
      [month],
    );
    const row = result.rows[0];
    return {
      day: month,
      requests: Number(row?.requests ?? 0),
      audioSeconds: Number(row?.audio_seconds ?? 0),
      estimatedUsd: Number(row?.estimated_usd ?? 0),
    };
  }

  async record(day: string, record: SttUsageRecord): Promise<SttUsageTotals> {
    if (!record.sessionId.trim()) throw new Error('STT usage sessionId must not be empty');
    await this.pool.query(
      `INSERT INTO stt_usage_records (session_id, usage_day, audio_seconds, estimated_usd)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id) DO NOTHING`,
      [record.sessionId, day, billedSeconds(record.audioSeconds), Math.max(0, record.estimatedUsd)],
    );
    return this.get(day);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
