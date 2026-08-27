const pool = require("./database");

async function main() {
  try {

    const before = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM channel_sources
    `);

    console.log("Источников до:", before.rows[0].count);

    await pool.query(`
      INSERT INTO channel_sources (
        channel_id,
        url,
        source_type,
        status,
        priority,
        is_active
      )
      SELECT
        c.id,
        c.url,
        'primary',
        'unknown',
        100,
        true
      FROM channels c
      WHERE c.url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM channel_sources s
          WHERE s.channel_id = c.id
            AND s.url = c.url
        )
    `);

    const after = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM channel_sources
    `);

    const channels = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM channels
    `);

    const withoutSource = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM channels c
      WHERE NOT EXISTS (
        SELECT 1
        FROM channel_sources s
        WHERE s.channel_id = c.id
      )
    `);

    console.log("");
    console.log("======================================");
    console.log("ПРИВЯЗКА ИСТОЧНИКОВ ЗАВЕРШЕНА");
    console.log("======================================");
    console.log("Каналов:", channels.rows[0].count);
    console.log("Источников после:", after.rows[0].count);
    console.log("Каналов без источника:", withoutSource.rows[0].count);

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
