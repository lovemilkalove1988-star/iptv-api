ALTER TABLE channels ADD COLUMN IF NOT EXISTS current_source_id INTEGER;
DO $$ BEGIN
  ALTER TABLE channels ADD CONSTRAINT channels_current_source_fk FOREIGN KEY (current_source_id) REFERENCES milktv_channel_sources(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE channels c SET current_source_id=s.id FROM milktv_channel_sources s WHERE s.channel_id=c.id AND s.url=c.url AND c.current_source_id IS NULL;
CREATE TABLE IF NOT EXISTS milktv_source_switch_history (
 id SERIAL PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 from_source_id INTEGER REFERENCES milktv_channel_sources(id) ON DELETE SET NULL,
 to_source_id INTEGER REFERENCES milktv_channel_sources(id) ON DELETE SET NULL,
 reason TEXT NOT NULL, from_score NUMERIC, to_score NUMERIC,
 automatic BOOLEAN NOT NULL DEFAULT TRUE, result TEXT NOT NULL, created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS milktv_source_switch_history_channel_idx ON milktv_source_switch_history(channel_id,created_at DESC);
