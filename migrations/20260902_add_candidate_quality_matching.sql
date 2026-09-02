ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS match_method TEXT NOT NULL DEFAULT 'unmatched';
ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS quality_score NUMERIC;
ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS quality_confidence TEXT;
ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS successful_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS provenance_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE milktv_m3u_candidates ADD COLUMN IF NOT EXISTS trust_level TEXT;
CREATE INDEX IF NOT EXISTS milktv_m3u_candidates_quality_idx ON milktv_m3u_candidates (quality_score DESC NULLS LAST);
