const pool = require("./database");

async function main() {
  try {
    const result = await pool.query(`
      INSERT INTO channel_sources (
        channel_id,
        url,
        source_type,
        status
      )
      SELECT
        c.id,
        c.url,
        'primary',
        'unknown'
      FROM channels c
      WHERE c.url IS NOT NULL
        AND c.url <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM channel_sources s
          WHERE s.channel_id = c.id
            AND s.url = c.url
        )
      ORDER BY c.id
    `);

    console.log("Добавлено источников:", result.rowCount);

    const count = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM channel_sources
    `);

    console.log("Всего источников:", count.rows[0].count);

    const check = await pool.query(`
      SELECT
        s.id,
        s.channel_id,
        c.name,
        s.source_type,
        s.status
      FROM channel_sources s
      JOIN channels c ON c.id = s.channel_id
      ORDER BY s.id
      LIMIT 10
    `);

    console.table(check.rows);

  } catch (error) {
    console.error(error);
  } finally {
    await pool.end();
  }
}

main();
