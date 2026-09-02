const db = require('../database');
(async () => {
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0] || {};
  const sources = await one('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE enabled)::int AS enabled, MAX(last_import_attempt_at) AS last_attempt, MAX(last_successful_import_at) AS last_success FROM milktv_epg_sources');
  const mappings = await one("SELECT COUNT(*) FILTER (WHERE match_status='manual')::int AS manual, COUNT(*) FILTER (WHERE match_status IN ('matched','suggested'))::int AS automatic, COUNT(*) FILTER (WHERE match_status='unmatched')::int AS unmatched FROM milktv_epg_channels");
  const programmes = await one('SELECT COUNT(*)::int AS total, MIN(start_at) AS earliest, MAX(stop_at) AS latest, COUNT(DISTINCT channel_id) FILTER (WHERE start_at<=NOW() AND stop_at>NOW())::int AS live FROM milktv_epg_programmes');
  const next = await one('SELECT COUNT(DISTINCT channel_id)::int AS count FROM milktv_epg_programmes WHERE start_at>NOW()');
  const stale = await one('SELECT COUNT(DISTINCT e.channel_id)::int AS count FROM milktv_epg_channels e WHERE NOT EXISTS (SELECT 1 FROM milktv_epg_programmes p WHERE p.channel_id=e.channel_id AND p.start_at<=NOW() AND p.stop_at>NOW())');
  const missing = await one('SELECT COUNT(*)::int AS count FROM channels c WHERE NOT EXISTS (SELECT 1 FROM milktv_epg_channels e WHERE e.channel_id=c.id)');
  console.log('MILK TV EPG audit');
  console.log({ scheduler_enabled: process.env.MILKTV_EPG_ENABLED === 'true', sources_total: sources.total || 0, sources_enabled: sources.enabled || 0, last_attempt: sources.last_attempt || null, last_success: sources.last_success || null, mapped_manual: mappings.manual || 0, mapped_automatic: mappings.automatic || 0, unmatched: mappings.unmatched || 0, programmes: programmes.total || 0, live_channels: programmes.live || 0, stale_channels: stale.count || 0, missing_channels: missing.count || 0, channels_with_next: next.count || 0, earliest: programmes.earliest || null, latest: programmes.latest || null });
  await db.end();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
