CREATE TABLE IF NOT EXISTS milktv_source_ingestion_audit (
  id BIGSERIAL PRIMARY KEY,
  candidate_id INTEGER REFERENCES milktv_m3u_candidates(id) ON DELETE SET NULL,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  source_id INTEGER REFERENCES milktv_channel_sources(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('ingested','skipped','failed')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
