ALTER TABLE milktv_m3u_providers
  ADD COLUMN IF NOT EXISTS last_import_diagnostic JSONB;
