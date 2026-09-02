ALTER TABLE milktv_m3u_candidates
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS failed_checks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_time INTEGER,
  ADD COLUMN IF NOT EXISTS last_check TIMESTAMP WITHOUT TIME ZONE,
  ADD COLUMN IF NOT EXISTS health_error TEXT,
  ADD COLUMN IF NOT EXISTS suggested_channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS match_confidence TEXT NOT NULL DEFAULT 'no-match';

ALTER TABLE milktv_m3u_candidates
  DROP CONSTRAINT IF EXISTS milktv_m3u_candidates_health_status_check,
  DROP CONSTRAINT IF EXISTS milktv_m3u_candidates_match_confidence_check;

ALTER TABLE milktv_m3u_candidates
  ADD CONSTRAINT milktv_m3u_candidates_health_status_check
    CHECK (health_status IN ('unknown','online','offline','error')),
  ADD CONSTRAINT milktv_m3u_candidates_match_confidence_check
    CHECK (match_confidence IN ('high','possible','no-match'));
