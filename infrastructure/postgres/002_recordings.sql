CREATE TABLE IF NOT EXISTS recording_segments (
  id TEXT PRIMARY KEY,
  camera TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  duration_ms BIGINT NOT NULL CHECK (duration_ms > 0),
  file_ref TEXT NOT NULL UNIQUE,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  mime_type TEXT NOT NULL,
  video_codec TEXT NOT NULL,
  audio_codec TEXT,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  checksum TEXT,
  backup_status TEXT NOT NULL CHECK (backup_status IN ('local', 'queued', 'uploaded', 'verified', 'failed', 'remote_deleted')),
  drive_file_id TEXT,
  drive_web_view_link TEXT,
  backup_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE recording_segments ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
ALTER TABLE recording_segments ADD COLUMN IF NOT EXISTS drive_web_view_link TEXT;
ALTER TABLE recording_segments ADD COLUMN IF NOT EXISTS backup_verified_at TIMESTAMPTZ;
ALTER TABLE recording_segments ADD COLUMN IF NOT EXISTS retention_tier TEXT NOT NULL DEFAULT 'continuous';
ALTER TABLE recording_segments ADD COLUMN IF NOT EXISTS protected BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recording_segments_retention_tier_check'
  ) THEN
    ALTER TABLE recording_segments ADD CONSTRAINT recording_segments_retention_tier_check
      CHECK (retention_tier IN ('continuous', 'event', 'protected'));
  END IF;
END $$;

ALTER TABLE recording_segments DROP CONSTRAINT IF EXISTS recording_segments_backup_status_check;
ALTER TABLE recording_segments ADD CONSTRAINT recording_segments_backup_status_check
  CHECK (backup_status IN ('local', 'queued', 'uploaded', 'verified', 'failed', 'remote_deleted'));

CREATE INDEX IF NOT EXISTS recording_segments_camera_started_idx
  ON recording_segments (camera, started_at);
CREATE INDEX IF NOT EXISTS recording_segments_started_idx
  ON recording_segments (started_at);
CREATE INDEX IF NOT EXISTS recording_segments_backup_status_idx
  ON recording_segments (backup_status);
