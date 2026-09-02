ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS successful_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS first_success_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE milktv_channel_sources ADD COLUMN IF NOT EXISTS consecutive_successful_checks INTEGER NOT NULL DEFAULT 0;
