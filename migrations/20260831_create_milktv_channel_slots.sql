CREATE TABLE IF NOT EXISTS milktv_channel_slots (
    id BIGSERIAL PRIMARY KEY,
    original_channel_id INTEGER NOT NULL,
    current_channel_id INTEGER,
    replacement_since TIMESTAMP WITHOUT TIME ZONE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT milktv_channel_slots_original_unique
        UNIQUE (original_channel_id),
    CONSTRAINT milktv_channel_slots_original_fk
        FOREIGN KEY (original_channel_id)
        REFERENCES channels(id)
        ON DELETE RESTRICT,
    CONSTRAINT milktv_channel_slots_current_fk
        FOREIGN KEY (current_channel_id)
        REFERENCES channels(id)
        ON DELETE SET NULL
);

INSERT INTO milktv_channel_slots (
    original_channel_id,
    current_channel_id,
    replacement_since,
    created_at,
    updated_at
)
SELECT
    c.id,
    CASE
        WHEN COALESCE(c.milktv_status, '') = 'quarantine' THEN NULL
        ELSE c.id
    END,
    NULL,
    NOW(),
    NOW()
FROM channels AS c
WHERE c.url IS NOT NULL
  AND BTRIM(c.url) <> ''
ON CONFLICT (original_channel_id) DO NOTHING;
