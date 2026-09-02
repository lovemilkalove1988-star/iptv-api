ALTER TABLE milktv_epg_sources ADD COLUMN IF NOT EXISTS last_import_attempt_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE milktv_epg_sources ADD COLUMN IF NOT EXISTS last_successful_import_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE milktv_epg_sources ADD COLUMN IF NOT EXISTS last_import_error TEXT;
ALTER TABLE milktv_epg_sources ADD COLUMN IF NOT EXISTS last_import_status TEXT;
ALTER TABLE milktv_epg_programmes ADD COLUMN IF NOT EXISTS programme_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS milktv_epg_programmes_key_uq ON milktv_epg_programmes(channel_id,programme_key);
