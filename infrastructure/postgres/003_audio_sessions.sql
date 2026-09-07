CREATE TABLE IF NOT EXISTS audio_sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('pc', 'alexa', 'text')),
  status TEXT NOT NULL CHECK (status IN ('recording', 'transcribing', 'responding', 'speaking', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  pipeline_latency_ms DOUBLE PRECISION,
  transcript JSONB,
  response_text TEXT,
  tts_target TEXT CHECK (tts_target IS NULL OR tts_target IN ('pc', 'alexa')),
  tts_provider TEXT,
  error TEXT,
  conversation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audio_sessions ADD COLUMN IF NOT EXISTS pipeline_latency_ms DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS audio_sessions_started_idx ON audio_sessions (started_at);
CREATE INDEX IF NOT EXISTS audio_sessions_source_status_idx ON audio_sessions (source, status);
