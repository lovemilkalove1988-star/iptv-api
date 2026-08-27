const pool = require("./database");

async function main() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_sources (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'primary',
        status TEXT NOT NULL DEFAULT 'unknown',
        last_check TIMESTAMP,
        next_check TIMESTAMP,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("channel_sources: СОЗДАНА/УЖЕ СУЩЕСТВУЕТ");

    const result = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM channel_sources
    `);

    console.log("Источников сейчас:", result.rows[0].count);

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
