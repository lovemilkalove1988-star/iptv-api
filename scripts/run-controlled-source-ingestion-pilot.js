const fs = require('fs');
const db = require('../database');
const { classifyCandidateForIngestion, ingestCandidate } = require('../services/milktv-source-ingestion');

const PROVIDER_URL = 'https://iptv-org.github.io/iptv/countries/kz.m3u';
const MAX_SOURCES = 5;

async function count(table) { return (await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count; }
function host(url) { try { return new URL(url).host; } catch { return '[invalid]'; } }

(async () => {
  const report = { started_at: new Date().toISOString(), provider: 'IPTV-org Kazakhstan', max_sources: MAX_SOURCES, source_switch_executed: false, selected_candidates: [], results: { attempted: 0, created: 0, skipped: 0, failed: 0, details: [] } };
  try {
    const before = { channels: await count('channels'), sources: await count('milktv_channel_sources'), ingestion_audit: await count('milktv_source_ingestion_audit') };
    report.before = before;
    const provider = (await db.query('SELECT id,name,url,enabled FROM milktv_m3u_providers WHERE url=$1', [PROVIDER_URL])).rows[0];
    if (!provider) throw new Error('Kazakhstan provider is not registered');
    const rows = (await db.query(`SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.provider_id=$1 AND cp.active=TRUE) AS has_provenance,
      NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp2 WHERE cp2.candidate_id=c.id AND cp2.active=TRUE) AS is_stale,
      ch.name AS channel_name, COALESCE(cat.category,'Без категории') AS category,
      (SELECT COUNT(*) FROM milktv_channel_sources s WHERE s.channel_id=c.suggested_channel_id) AS existing_source_count
      FROM milktv_m3u_candidates c JOIN milktv_m3u_candidate_providers cp0 ON cp0.candidate_id=c.id AND cp0.provider_id=$1 AND cp0.active=TRUE
      LEFT JOIN channels ch ON ch.id=c.suggested_channel_id LEFT JOIN milktv_channel_categories cat ON cat.channel_id=c.suggested_channel_id
      WHERE c.state='new' AND c.health_status='online' AND c.match_confidence='high' ORDER BY (COALESCE(cat.category,'Без категории')='Казахстан') DESC,c.response_time NULLS LAST,c.id`, [provider.id])).rows;
    const classified = [];
    for (const row of rows) classified.push({ row, decision: await classifyCandidateForIngestion(db, row) });
    const eligible = classified.filter(x => x.decision.outcome === 'AUTO_ELIGIBLE');
    const selected = eligible.slice(0, MAX_SOURCES);
    report.selected_candidates = selected.map(({ row, decision }) => ({ candidate_id: row.id, candidate_name: row.name, url_host: host(row.stream_url), response_time: row.response_time, logical_channel_id: decision.channel_id, channel_name: row.channel_name, category: row.category, match_confidence: row.match_confidence, provider: provider.name, existing_source_count: Number(row.existing_source_count) }));
    const channelIds = selected.map(x => x.decision.channel_id);
    report.snapshot = { selected_channel_ids: channelIds, channels: channelIds.length ? (await db.query('SELECT id,url,current_source_id FROM channels WHERE id=ANY($1::int[]) ORDER BY id',[channelIds])).rows : [] };
    for (const { row } of selected) {
      report.results.attempted++;
      try { const priority = await db.query('SELECT COALESCE(MAX(priority),0)+10 AS value FROM milktv_channel_sources WHERE channel_id=$1', [row.suggested_channel_id]); const result = await ingestCandidate(db, row.id, { reservePriority: Number(priority.rows[0].value) }); if (result.outcome === 'AUTO_ELIGIBLE' && result.source_id) { report.results.created++; report.results.details.push({ candidate_id: row.id, result: 'created', source_id: result.source_id, logical_channel_id: result.channel_id, url_host: host(row.stream_url) }); } else { report.results.skipped++; report.results.details.push({ candidate_id: row.id, result: 'skipped', reason: result.reason }); } }
      catch (error) { report.results.failed++; report.results.details.push({ candidate_id: row.id, result: 'failed', reason: String(error.message).slice(0, 300) }); }
    }
    report.after = { channels: await count('channels'), sources: await count('milktv_channel_sources'), ingestion_audit: await count('milktv_source_ingestion_audit') };
    const afterChannels = channelIds.length ? (await db.query('SELECT id,url,current_source_id FROM channels WHERE id=ANY($1::int[]) ORDER BY id',[channelIds])).rows : [];
    report.integrity = { channels_url_unchanged: JSON.stringify(report.snapshot.channels.map(x => [x.id,x.url])) === JSON.stringify(afterChannels.map(x => [x.id,x.url])), current_source_id_unchanged: JSON.stringify(report.snapshot.channels.map(x => [x.id,x.current_source_id])) === JSON.stringify(afterChannels.map(x => [x.id,x.current_source_id])), source_count_delta: report.after.sources - before.sources, ingestion_audit_delta: report.after.ingestion_audit - before.ingestion_audit };
    fs.writeFileSync('controlled-source-ingestion-pilot-20260831.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`CONTROLLED_INGESTION_FAILED: ${error.message}`); process.exitCode = 1; }
  finally { await db.end(); }
})();
