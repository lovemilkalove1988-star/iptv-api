ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS visible_to_clients BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS channels_visible_to_clients_idx
  ON channels (visible_to_clients)
  WHERE visible_to_clients = FALSE;
