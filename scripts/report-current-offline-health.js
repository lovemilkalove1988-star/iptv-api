require('dotenv').config();
const db = require('../database');
(async () => {
  const result = await db.query("SELECT c.id AS channel_id,c.current_source_id,COALESCE(c.milktv_failed_checks,0) AS confirmed_failure_count FROM channels c WHERE c.milktv_status='offline' ORDER BY c.id");
  console.log(JSON.stringify(result.rows, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.end());
