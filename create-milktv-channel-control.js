const pool = require("./database");

async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS molktv_channel_control (
        channel_id INTEGER PRIMARY KEY
          REFERENCES channels(id)
          ON DELETE CASCADE,

        view_count INTEGER NOT NULL DEFAULT 0,

        manual_boost INTEGER NOT NULL DEFAULT 0,

        is_quarantined BOOLEAN NOT NULL DEFAULT false,

        quarantine_reason TEXT,

        quarantined_at TIMESTAMP,

        last_viewed_at TIMESTAMP,

        created_at TIMESTAMP NOT NULL DEFAULT NOW(),

        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      INSERT INTO molktv_channel_control (channel_id)
      SELECT id
      FROM channels
      ON CONFLICT (channel_id) DO NOTHING;
    `);

    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE is_quarantined = true
        )::int AS quarantined
      FROM molktv_channel_control
    `);

    console.log("");
    console.log("======================================");
    console.log("МИЛК ТВ — КОНТРОЛЬ КАНАЛОВ");
    console.log("======================================");
    console.log("Всего каналов:", result.rows[0].total);
    console.log("В карантине:", result.rows[0].quarantined);
    console.log("======================================");

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
