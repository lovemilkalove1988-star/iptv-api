CREATE TABLE IF NOT EXISTS milktv_channel_sources (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'unknown',
  failed_checks INTEGER NOT NULL DEFAULT 0,
  response_time INTEGER,
  last_check TIMESTAMP WITHOUT TIME ZONE,
  check_error TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT milktv_channel_sources_channel_fk
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  CONSTRAINT milktv_channel_sources_priority_check CHECK (priority >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS milktv_channel_sources_channel_url_uq
  ON milktv_channel_sources (channel_id, url);

INSERT INTO milktv_channel_sources (channel_id, url, priority)
SELECT c.id, BTRIM(c.url), 100
FROM channels c
WHERE c.url IS NOT NULL
  AND BTRIM(c.url) <> ''
ON CONFLICT (channel_id, url) DO NOTHING;
