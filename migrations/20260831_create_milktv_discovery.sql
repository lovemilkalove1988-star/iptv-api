CREATE TABLE IF NOT EXISTS milktv_discovery_sources (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'index',
  name TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run TIMESTAMP WITHOUT TIME ZONE,
  status TEXT NOT NULL DEFAULT 'never',
  error TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS milktv_discovery_results (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES milktv_discovery_sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE,
  origin_url TEXT NOT NULL,
  result_type TEXT NOT NULL CHECK (result_type IN ('m3u','stream')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','unsafe','error')),
  first_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  provider_id INTEGER REFERENCES milktv_m3u_providers(id) ON DELETE SET NULL,
  candidate_id INTEGER REFERENCES milktv_m3u_candidates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS milktv_discovery_result_sources (
  result_id INTEGER NOT NULL REFERENCES milktv_discovery_results(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES milktv_discovery_sources(id) ON DELETE CASCADE,
  first_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (result_id, source_id)
);

CREATE INDEX IF NOT EXISTS milktv_discovery_results_source_idx
  ON milktv_discovery_results (source_id, last_seen DESC);
