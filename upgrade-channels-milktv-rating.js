const pool = require("./database");

async function main() {
  try {

    await pool.query(`
      ALTER TABLE channels
      ADD COLUMN IF NOT EXISTS milktv_manual_boost INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS milktv_rating NUMERIC(12,3) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS milktv_viewers INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS milktv_views INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS milktv_last_view TIMESTAMP;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_channels_milktv_rating
      ON channels(milktv_rating DESC);
    `);

    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS channels,
        COUNT(*) FILTER (
          WHERE milktv_manual_boost <> 0
        )::int AS boosted
      FROM channels
    `);

    console.log("");
    console.log("======================================");
    console.log("МИЛК ТВ — РЕЙТИНГ КАНАЛОВ");
    console.log("======================================");
    console.log("Каналов:", result.rows[0].channels);
    console.log("С ручной корректировкой:", result.rows[0].boosted);
    console.log("======================================");

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
