ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS trust_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS trust_level TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS trust_updated_at TIMESTAMP WITHOUT TIME ZONE;
