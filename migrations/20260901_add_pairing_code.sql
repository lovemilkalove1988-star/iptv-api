ALTER TABLE client_pairing_sessions ADD COLUMN IF NOT EXISTS pairing_code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS client_pairing_sessions_pairing_code_uq
  ON client_pairing_sessions(pairing_code_hash)
  WHERE pairing_code_hash IS NOT NULL;
