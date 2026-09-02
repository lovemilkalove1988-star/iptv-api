ALTER TABLE milktv_m3u_candidate_providers
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS milktv_m3u_candidate_providers_active_idx
  ON milktv_m3u_candidate_providers (provider_id, active);
