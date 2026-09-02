const fs = require('fs');
const db = require('../database');
(async () => {
  const q = async (sql) => (await db.query(sql)).rows;
  const out = { created_at: new Date().toISOString(), counts: {}, sources: await q('SELECT id,name,url,enabled FROM milktv_epg_sources ORDER BY id'), channels: await q('SELECT id,url,current_source_id,milktv_rating,milktv_views,milktv_status FROM channels ORDER BY id'), slots: await q('SELECT * FROM milktv_channel_slots ORDER BY id'), quarantine: await q("SELECT milktv_status,COUNT(*)::int AS count FROM channels GROUP BY milktv_status") };
  for (const table of ['channels','milktv_channel_sources','milktv_channel_slots','milktv_replacement_pool','milktv_epg_sources','milktv_epg_channels','milktv_epg_programmes','milktv_epg_reminders']) out.counts[table] = Number((await q(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
  fs.writeFileSync('milktv-epg-real-pilot-before-20260831.json', JSON.stringify(out, null, 2));
  console.log('snapshot written'); await db.end();
})().catch(e => { console.error(e.message); process.exitCode = 1; });
