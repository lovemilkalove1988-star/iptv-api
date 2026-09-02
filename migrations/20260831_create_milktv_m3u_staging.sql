CREATE TABLE IF NOT EXISTS milktv_m3u_providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_import TIMESTAMP WITHOUT TIME ZONE,
  import_status TEXT NOT NULL DEFAULT 'never',
  import_error TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT milktv_m3u_providers_name_uq UNIQUE (name),
  CONSTRAINT milktv_m3u_providers_url_uq UNIQUE (url)
);

CREATE TABLE IF NOT EXISTS milktv_m3u_candidates (
  id SERIAL PRIMARY KEY,
  stream_url TEXT NOT NULL,
  name TEXT NOT NULL,
  tvg_id TEXT,
  tvg_name TEXT,
  logo TEXT,
  group_title TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  accepted_channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  first_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT milktv_m3u_candidates_state_check CHECK (state IN ('new','accepted','rejected')),
  CONSTRAINT milktv_m3u_candidates_url_uq UNIQUE (stream_url)
);

CREATE TABLE IF NOT EXISTS milktv_m3u_candidate_providers (
  candidate_id INTEGER NOT NULL REFERENCES milktv_m3u_candidates(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES milktv_m3u_providers(id) ON DELETE CASCADE,
  first_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (candidate_id, provider_id)
);
