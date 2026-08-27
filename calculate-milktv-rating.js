const pool = require("./database");

async function main() {
  try {

    const result = await pool.query(`
      UPDATE channels c
      SET milktv_rating =
        ROUND(
          (
            COALESCE(c.milktv_views, 0) * 1.0
            +
            COALESCE(recent.views_24h, 0) * 5.0
            +
            COALESCE(recent.viewers_24h, 0) * 10.0
            +
            COALESCE(c.milktv_manual_boost, 0)
          )::numeric,
          2
        )
      FROM (
        SELECT
          channel_id,
          COUNT(*) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
          ) AS views_24h,
          COUNT(DISTINCT COALESCE(client_id, device_id)) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
          ) AS viewers_24h
        FROM milktv_view_events
        GROUP BY channel_id
      ) recent
      WHERE c.id = recent.channel_id
    `);

    await pool.query(`
      UPDATE channels
      SET milktv_rating =
        ROUND(
          (
            COALESCE(milktv_views, 0) * 1.0
            +
            COALESCE(milktv_manual_boost, 0)
          )::numeric,
          2
        )
      WHERE id NOT IN (
        SELECT DISTINCT channel_id
        FROM milktv_view_events
      )
    `);

    const top = await pool.query(`
      SELECT
        id,
        name,
        milktv_rating,
        milktv_views,
        milktv_viewers,
        milktv_manual_boost,
        milktv_last_view
      FROM channels
      ORDER BY milktv_rating DESC, id ASC
      LIMIT 20
    `);

    console.log("");
    console.log("======================================");
    console.log("МИЛК ТВ — АВТОРЕЙТИНГ");
    console.log("======================================");
    console.log("Каналов пересчитано:", result.rowCount);
    console.log("");
    console.log("ТОП-20:");
    console.table(top.rows);
    console.log("======================================");

  } catch (error) {
    console.error("ОШИБКА АВТОРЕЙТИНГА:", error);
  } finally {
    await pool.end();
  }
}

main();
