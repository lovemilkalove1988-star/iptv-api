require("dotenv").config();

const fs = require("fs");
const db = require("../database");

const limit = Number(process.env.MILKTV_HEALTH_LIMIT || 5);

(async () => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("MILKTV_HEALTH_LIMIT must be a positive integer");
  }

  const channels = (await db.query(`
    SELECT id, name, url, milktv_status, milktv_failed_checks,
           milktv_last_check, milktv_check_error, current_source_id
    FROM channels
    WHERE url IS NOT NULL
      AND TRIM(url) <> ''
      AND COALESCE(milktv_status, '') <> 'quarantine'
    ORDER BY name
    LIMIT $1
  `, [limit])).rows;

  const ids = channels.map(channel => channel.id);
  const sources = ids.length === 0 ? [] : (await db.query(`
    SELECT id, channel_id, url, enabled, status, failed_checks,
           consecutive_successful_checks, last_check, check_error
    FROM milktv_channel_sources
    WHERE channel_id = ANY($1::int[])
    ORDER BY channel_id, id
  `, [ids])).rows;

  const snapshot = {
    created_at: new Date().toISOString(),
    limit,
    channel_ids: ids,
    channels,
    sources
  };
  const filename = `health-limit-test-snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ filename, channel_ids: ids, channels: channels.map(({ id, name, milktv_status }) => ({ id, name, milktv_status })), source_count: sources.length }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.end());
