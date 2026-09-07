import { fileURLToPath } from 'node:url';
import { Pool, type QueryResultRow } from 'pg';
import { readPostgresMigration } from '../infrastructure/postgres-migration.js';
import {
  RuntimeSettingsSchema,
  mergeRuntimeSettings,
  type RuntimeSettings,
  type RuntimeSettingsPatch,
} from './runtime-settings.js';

export type RuntimeSettingsSource = 'default' | 'environment' | 'database';

export interface RuntimeSettingsStore {
  get(): Promise<RuntimeSettings | undefined>;
  save(settings: RuntimeSettings): Promise<RuntimeSettings>;
  clear(): Promise<void>;
}

function clone(settings: RuntimeSettings): RuntimeSettings {
  return structuredClone(settings);
}

export class InMemoryRuntimeSettingsStore implements RuntimeSettingsStore {
  private settings?: RuntimeSettings;

  async get(): Promise<RuntimeSettings | undefined> {
    return this.settings ? clone(this.settings) : undefined;
  }

  async save(settings: RuntimeSettings): Promise<RuntimeSettings> {
    this.settings = RuntimeSettingsSchema.parse(clone(settings));
    return clone(this.settings);
  }

  async clear(): Promise<void> {
    this.settings = undefined;
  }
}

export interface RuntimeSettingsEffective {
  settings: RuntimeSettings;
  source: RuntimeSettingsSource;
}

export class RuntimeSettingsService {
  constructor(
    private readonly store: RuntimeSettingsStore,
    private readonly baseSettings: RuntimeSettings,
    private readonly baseSource: Exclude<RuntimeSettingsSource, 'database'> = 'default',
  ) {
    RuntimeSettingsSchema.parse(baseSettings);
  }

  async effective(): Promise<RuntimeSettingsEffective> {
    const override = await this.store.get();
    if (!override) return { settings: clone(this.baseSettings), source: this.baseSource };
    return { settings: mergeRuntimeSettings(this.baseSettings, override), source: 'database' };
  }

  async update(patch: RuntimeSettingsPatch | unknown): Promise<RuntimeSettingsEffective> {
    const current = await this.effective();
    const settings = mergeRuntimeSettings(current.settings, patch);
    await this.store.save(settings);
    return { settings, source: 'database' };
  }

  async replace(settings: RuntimeSettings): Promise<RuntimeSettingsEffective> {
    const validated = RuntimeSettingsSchema.parse(settings);
    await this.store.save(validated);
    return { settings: validated, source: 'database' };
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
}

interface RuntimeSettingsRow extends QueryResultRow {
  settings: RuntimeSettings | string;
}

export interface PostgresRuntimeSettingsStoreOptions {
  pool?: Pool;
  connectionString?: string;
}

export class PostgresRuntimeSettingsStore implements RuntimeSettingsStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresRuntimeSettingsStoreOptions = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
    this.ownsPool = !options.pool;
  }

  async initialize(): Promise<void> {
    const currentFile = fileURLToPath(import.meta.url);
    await this.pool.query(await readPostgresMigration(currentFile, '004_runtime_settings.sql'));
  }

  async get(): Promise<RuntimeSettings | undefined> {
    const result = await this.pool.query<RuntimeSettingsRow>('SELECT settings FROM jarvis_runtime_settings WHERE id = 1');
    if (!result.rows[0]) return undefined;
    const value = typeof result.rows[0].settings === 'string' ? JSON.parse(result.rows[0].settings) : result.rows[0].settings;
    return RuntimeSettingsSchema.parse(value);
  }

  async save(settings: RuntimeSettings): Promise<RuntimeSettings> {
    const validated = RuntimeSettingsSchema.parse(settings);
    await this.pool.query(
      `INSERT INTO jarvis_runtime_settings (id, settings, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [JSON.stringify(validated)],
    );
    return clone(validated);
  }

  async clear(): Promise<void> {
    await this.pool.query('DELETE FROM jarvis_runtime_settings WHERE id = 1');
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
