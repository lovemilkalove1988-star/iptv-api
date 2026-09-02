CREATE TABLE IF NOT EXISTS milktv_epg_reminders (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  programme_key TEXT NOT NULL,
  programme_start_at TIMESTAMPTZ NOT NULL,
  programme_title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled','expired','unavailable'))
);
CREATE UNIQUE INDEX IF NOT EXISTS milktv_epg_reminders_client_occurrence_uq ON milktv_epg_reminders(client_id, channel_id, programme_key);
CREATE INDEX IF NOT EXISTS milktv_epg_reminders_due_idx ON milktv_epg_reminders(client_id, status, programme_start_at);
CREATE TABLE IF NOT EXISTS milktv_epg_reminder_deliveries (
  reminder_id BIGINT NOT NULL REFERENCES milktv_epg_reminders(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (reminder_id, device_key)
);
