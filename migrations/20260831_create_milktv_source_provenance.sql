CREATE TABLE IF NOT EXISTS milktv_channel_source_provenance (
 id SERIAL PRIMARY KEY,
 source_id INTEGER NOT NULL REFERENCES milktv_channel_sources(id) ON DELETE CASCADE,
 origin_type TEXT NOT NULL,
 m3u_provider_id INTEGER REFERENCES milktv_m3u_providers(id) ON DELETE SET NULL,
 discovery_source_id INTEGER REFERENCES milktv_discovery_sources(id) ON DELETE SET NULL,
 candidate_id INTEGER REFERENCES milktv_m3u_candidates(id) ON DELETE SET NULL,
 discovery_result_id INTEGER REFERENCES milktv_discovery_results(id) ON DELETE SET NULL,
 first_seen_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
 last_seen_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
 created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
 UNIQUE(source_id,origin_type,m3u_provider_id,discovery_source_id,candidate_id,discovery_result_id)
);
