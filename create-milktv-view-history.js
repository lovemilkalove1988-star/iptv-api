const pool = require("./database");

async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS milktv_view_events (
        id BIGSERIAL PRIMARY KEY,

        channel_id INTEGER NOT NULL
          REFERENCES channels(id)
          ON DELETE CASCADE,

        client_id INTEGER
          REFERENCES clients(id)
          ON DELETE SET NULL,

        device_id INTEGER
          REFERENCES devices(id)
          ON DELETE SET NULL,

        started_at TIMESTAMP NOT NULL DEFAULT NOW(),

        stopped_at TIMESTAMP,

        duration_seconds INTEGER,

        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_milktv_view_events_channel
      ON milktv_view_events(channel_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_milktv_view_events_started
      ON milktv_view_events(started_at);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_milktv_view_events_client
      ON milktv_view_events(client_id);
    `);

    const result = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM milktv_view_events
    `);

    console.log("");
    console.log("======================================");
    console.log("МИЛК ТВ — ИСТОРИЯ ПРОСМОТРОВ");
    console.log("======================================");
    console.log("Событий просмотров:", result.rows[0].count);
    console.log("======================================");

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
