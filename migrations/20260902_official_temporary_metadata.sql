ALTER TABLE milktv_discovery_results
  ADD COLUMN IF NOT EXISTS classification TEXT,
  ADD COLUMN IF NOT EXISTS temporary BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS config_url TEXT,
  ADD COLUMN IF NOT EXISTS manifest_observed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS manifest_expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_milktv_discovery_results_classification
  ON milktv_discovery_results(classification);
