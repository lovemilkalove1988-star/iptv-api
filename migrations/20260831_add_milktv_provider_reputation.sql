ALTER TABLE milktv_m3u_providers ADD COLUMN IF NOT EXISTS reputation_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE milktv_m3u_providers ADD COLUMN IF NOT EXISTS reputation_level TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE milktv_m3u_providers ADD COLUMN IF NOT EXISTS reputation_updated_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE milktv_discovery_sources ADD COLUMN IF NOT EXISTS reputation_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE milktv_discovery_sources ADD COLUMN IF NOT EXISTS reputation_level TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE milktv_discovery_sources ADD COLUMN IF NOT EXISTS reputation_updated_at TIMESTAMP WITHOUT TIME ZONE;
