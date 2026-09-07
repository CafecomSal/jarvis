CREATE TABLE IF NOT EXISTS media_evidence (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  camera TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recording_segment_id TEXT,
  frame_timestamp_ms BIGINT,
  image_ref TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  historical BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evidence_observations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  evidence_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  camera TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  object_class TEXT,
  text TEXT,
  normalized_text TEXT,
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model TEXT,
  provider TEXT,
  recording_segment_id TEXT,
  frame_timestamp_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS media_evidence_camera_occurred_idx
  ON media_evidence (camera, occurred_at, id);
CREATE INDEX IF NOT EXISTS media_evidence_segment_idx
  ON media_evidence (recording_segment_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS evidence_observations_camera_occurred_idx
  ON evidence_observations (camera, occurred_at, id);
CREATE INDEX IF NOT EXISTS evidence_observations_evidence_idx
  ON evidence_observations (evidence_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS evidence_observations_object_class_idx
  ON evidence_observations (object_class, occurred_at, id);
CREATE INDEX IF NOT EXISTS evidence_observations_normalized_text_idx
  ON evidence_observations (normalized_text, occurred_at, id);
CREATE INDEX IF NOT EXISTS evidence_observations_confidence_idx
  ON evidence_observations (confidence, occurred_at, id);

CREATE TABLE IF NOT EXISTS recording_index_runs (
  id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  frames_processed INTEGER NOT NULL DEFAULT 0 CHECK (frames_processed >= 0),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  ocr_count INTEGER NOT NULL DEFAULT 0 CHECK (ocr_count >= 0),
  model TEXT NOT NULL,
  ocr_model TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  error TEXT,
  next_attempt_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (segment_id, policy_version, model, ocr_model)
);

CREATE INDEX IF NOT EXISTS recording_index_runs_status_idx
  ON recording_index_runs (status, next_attempt_at, queued_at);
CREATE INDEX IF NOT EXISTS recording_index_runs_segment_idx
  ON recording_index_runs (segment_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS evidence_index_markers (
  key TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  cursor TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

