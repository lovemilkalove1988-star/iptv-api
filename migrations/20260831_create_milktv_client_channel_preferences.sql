CREATE TABLE IF NOT EXISTS milktv_client_channel_preferences (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  favorite BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  custom_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, channel_id)
);
CREATE INDEX IF NOT EXISTS milktv_client_channel_preferences_client_idx
  ON milktv_client_channel_preferences(client_id, updated_at DESC);
