ALTER TABLE devices ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS paired_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW();
ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_hash TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS recovery_code_hash TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS recovery_code_ciphertext TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS playback_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_status_check;
ALTER TABLE devices ADD CONSTRAINT devices_status_check CHECK (status IN ('active','paused','revoked'));
CREATE UNIQUE INDEX IF NOT EXISTS devices_credential_hash_uq ON devices(credential_hash) WHERE credential_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS devices_recovery_hash_uq ON devices(recovery_code_hash) WHERE recovery_code_hash IS NOT NULL;
WITH ranked AS (SELECT id,ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY id) AS rn FROM devices)
UPDATE devices d SET is_primary=TRUE WHERE d.id IN (SELECT id FROM ranked WHERE rn=1) AND NOT EXISTS (SELECT 1 FROM devices x WHERE x.client_id=d.client_id AND x.is_primary=TRUE);

CREATE TABLE IF NOT EXISTS client_pairing_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  device_hint TEXT,
  expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  consumed_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);
ALTER TABLE client_pairing_sessions ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE client_pairing_sessions ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE client_pairing_sessions ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE client_pairing_sessions ADD COLUMN IF NOT EXISTS credential_ciphertext TEXT;
CREATE INDEX IF NOT EXISTS client_pairing_sessions_expiry_idx ON client_pairing_sessions(expires_at);
ALTER TABLE client_pairing_sessions ADD COLUMN IF NOT EXISTS pairing_code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS client_pairing_sessions_pairing_code_uq
  ON client_pairing_sessions(pairing_code_hash)
  WHERE pairing_code_hash IS NOT NULL;
