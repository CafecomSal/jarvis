CREATE TABLE IF NOT EXISTS jarvis_runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stt_usage_records (
  session_id TEXT PRIMARY KEY,
  usage_day DATE NOT NULL,
  audio_seconds INTEGER NOT NULL CHECK (audio_seconds >= 0),
  estimated_usd DOUBLE PRECISION NOT NULL CHECK (estimated_usd >= 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stt_usage_records_day_idx ON stt_usage_records (usage_day);
