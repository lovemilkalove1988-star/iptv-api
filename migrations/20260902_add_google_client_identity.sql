ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS google_sub TEXT,
  ADD COLUMN IF NOT EXISTS google_email TEXT,
  ADD COLUMN IF NOT EXISTS google_name TEXT,
  ADD COLUMN IF NOT EXISTS google_picture TEXT,
  ADD COLUMN IF NOT EXISTS google_linked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS clients_google_sub_unique
  ON clients (google_sub)
  WHERE google_sub IS NOT NULL;
