CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  location TEXT,
  subject_type TEXT,
  subject_id TEXT,
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding VECTOR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON events (occurred_at);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);
CREATE INDEX IF NOT EXISTS events_location_idx ON events (location);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('conversation', 'tool_call', 'policy_decision')),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'error', 'denied')),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log (occurred_at);
CREATE INDEX IF NOT EXISTS audit_log_conversation_idx ON audit_log (conversation_id, occurred_at);
