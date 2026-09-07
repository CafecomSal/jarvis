import { describe, expect, it } from 'vitest';
import {
  InMemoryRuntimeSettingsStore,
  RuntimeSettingsService,
} from '../src/config/runtime-settings-store.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/config/runtime-settings.js';

describe('runtime settings store', () => {
  it('não tem override inicialmente e persiste uma cópia validada', async () => {
    const store = new InMemoryRuntimeSettingsStore();
    expect(await store.get()).toBeUndefined();
    const saved = await store.save(DEFAULT_RUNTIME_SETTINGS);
    expect(saved).toEqual(DEFAULT_RUNTIME_SETTINGS);
    const loaded = await store.get();
    expect(loaded).toEqual(DEFAULT_RUNTIME_SETTINGS);
    expect(loaded).not.toBe(DEFAULT_RUNTIME_SETTINGS);
  });

  it('combina env/default com override e permite limpar o override', async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const service = new RuntimeSettingsService(store, DEFAULT_RUNTIME_SETTINGS);
    expect((await service.effective()).source).toBe('default');
    await service.update({ stt: { route: 'auto', cloudEnabled: true, fallback: 'local' } });
    const effective = await service.effective();
    expect(effective).toMatchObject({ source: 'database', settings: { stt: { route: 'auto', cloudEnabled: true, fallback: 'local' } } });
    await service.clear();
    expect((await service.effective()).source).toBe('default');
  });
});
