CREATE TABLE IF NOT EXISTS milktv_replacement_pool (
    channel_id INTEGER PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT milktv_replacement_pool_channel_fk
        FOREIGN KEY (channel_id)
        REFERENCES channels(id)
        ON DELETE RESTRICT
);
