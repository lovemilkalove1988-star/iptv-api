require("dotenv").config();

const db = require("../database");

(async () => {
  const result = await db.query(`
    SELECT DISTINCT ON (c.id)
      c.id AS channel_id,
      c.name AS channel_name,
      s.id AS source_id,
      s.successful_checks,
      s.consecutive_successful_checks,
      s.last_success_at,
      s.status AS source_status
    FROM channels c
    JOIN milktv_channel_sources s
      ON s.channel_id = c.id
    WHERE c.url IS NOT NULL
      AND BTRIM(c.url) <> ''
      AND COALESCE(c.milktv_status, '') <> 'quarantine'
      AND s.enabled = TRUE
      AND COALESCE(s.successful_checks, 0) > 0
    ORDER BY c.id,
             CASE WHEN s.id = c.current_source_id THEN 0 ELSE 1 END,
             s.successful_checks DESC,
             s.consecutive_successful_checks DESC,
             s.last_success_at DESC NULLS LAST,
             s.id
  `);

  const sample = result.rows
    .sort((a, b) => Number(b.successful_checks || 0) - Number(a.successful_checks || 0)
      || Number(b.consecutive_successful_checks || 0) - Number(a.consecutive_successful_checks || 0)
      || Number(a.channel_id) - Number(b.channel_id))
    .slice(0, 5);
  console.log(JSON.stringify({ channel_ids: sample.map(row => row.channel_id), sample }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.end());
