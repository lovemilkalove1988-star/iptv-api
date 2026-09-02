require("dotenv").config();

const fs = require("fs");
const db = require("../database");

(async () => {
  const snapshot = {
    created_at: new Date().toISOString(),
    channels: (await db.query(`
      SELECT milktv_status, COUNT(*)::int AS count,
             COALESCE(SUM(milktv_failed_checks), 0)::int AS failure_streak_total
      FROM channels
      GROUP BY milktv_status
      ORDER BY milktv_status
    `)).rows,
    slots: (await db.query(`
      SELECT COUNT(*) FILTER (WHERE current_channel_id IS NULL)::int AS free,
             COUNT(*) FILTER (WHERE current_channel_id = original_channel_id)::int AS original,
             COUNT(*) FILTER (WHERE current_channel_id IS NOT NULL AND current_channel_id <> original_channel_id)::int AS replacement
      FROM milktv_channel_slots
    `)).rows[0],
    integrity: (await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM milktv_view_events) AS views,
        (SELECT COUNT(*)::int FROM milktv_channel_categories) AS categories,
        (SELECT COUNT(*)::int FROM milktv_epg_channels) AS epg_mappings,
        (SELECT COALESCE(SUM(milktv_rating), 0)::text FROM channels) AS rating_total
    `)).rows[0]
  };
  const filename = `autonomous-operations-v1-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ filename, ...snapshot }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.end());
