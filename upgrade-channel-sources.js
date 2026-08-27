const pool = require("./database");

async function main() {
  try {

    await pool.query(`
      ALTER TABLE channel_sources

      ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100,

      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,

      ADD COLUMN IF NOT EXISTS last_success TIMESTAMP,

      ADD COLUMN IF NOT EXISTS last_failure TIMESTAMP,

      ADD COLUMN IF NOT EXISTS last_error TEXT,

      ADD COLUMN IF NOT EXISTS response_time_ms INTEGER,

      ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,

      ADD COLUMN IF NOT EXISTS consecutive_successes INTEGER NOT NULL DEFAULT 0;
    `);

    console.log("");
    console.log("======================================");
    console.log("channel_sources УСПЕШНО РАСШИРЕНА");
    console.log("======================================");

    const result = await pool.query(`
      SELECT
        column_name,
        data_type,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'channel_sources'
      ORDER BY ordinal_position
    `);

    console.table(result.rows);

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
