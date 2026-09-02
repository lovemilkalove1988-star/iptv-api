const fs = require('fs');
const db = require('../database');
const { healthCheckBatch } = require('../services/milktv-m3u-pilot');
const { classifyCandidateForIngestion } = require('../services/milktv-source-ingestion');

const RUSSIA_URL = 'https://iptv-org.github.io/iptv/countries/ru.m3u';
const STALE_MS = 12 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
async function count(table) { return (await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count; }
function fresh(row) { return row.last_check && (Date.now() - new Date(row.last_check).getTime()) <= STALE_MS; }
function host(url) { try { return new URL(url).host; } catch { return '[invalid]'; } }

(async () => {
  const report = { started_at: new Date().toISOString(), source_ingestion_executed: false, source_switch_executed: false, health_summary: { checked_now: 0, skipped_fresh: 0, online: 0, offline: 0, with_error: 0, unknown: 0 }, provider_breakdown: {}, reason_counts: {}, classification: { auto_eligible_new: 0, review_required: 0, rejected: 0 } };
  try {
    report.before = { channels: await count('channels'), sources: await count('milktv_channel_sources'), candidates: await count('milktv_m3u_candidates'), provenance: await count('milktv_m3u_candidate_providers'), audit: await count('milktv_source_ingestion_audit') };
    const provider = (await db.query('SELECT id,name,url FROM milktv_m3u_providers WHERE url=$1', [RUSSIA_URL])).rows[0];
    if (!provider) throw new Error('Russia provider not registered');
    const allCandidates = (await db.query(`SELECT c.* FROM milktv_m3u_candidates c JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id WHERE cp.provider_id=$1 AND cp.active=TRUE ORDER BY c.id`, [provider.id])).rows;
    const pending = allCandidates.filter(row => !fresh(row)); report.health_summary.skipped_fresh = allCandidates.length - pending.length;
    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const batch = pending.slice(offset, offset + BATCH_SIZE); const result = await healthCheckBatch(db, batch, { concurrency: 4, timeoutMs: 8000 });
      report.health_summary.checked_now += result.length; report.health_summary.online += result.filter(x => x.online).length; report.health_summary.offline += result.filter(x => !x.online).length; report.health_summary.with_error += result.filter(x => Boolean(x.error)).length; console.log(`Russia health batch ${Math.floor(offset / BATCH_SIZE) + 1}: ${result.length} checked`);
    }
    const rows = (await db.query(`SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id) AS has_provenance,NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp2 WHERE cp2.candidate_id=c.id AND cp2.active=TRUE) AS is_stale,ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name),NULL) AS providers FROM milktv_m3u_candidates c LEFT JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id GROUP BY c.id ORDER BY c.id`)).rows;
    const categories = new Map((await db.query('SELECT channel_id,category FROM milktv_channel_categories')).rows.map(x => [Number(x.channel_id), x.category]));
    for (const row of rows) {
      const decision = await classifyCandidateForIngestion(db, row); const key = decision.outcome === 'AUTO_ELIGIBLE' ? 'auto_eligible_new' : decision.outcome === 'REVIEW_REQUIRED' ? 'review_required' : 'rejected'; report.classification[key]++; report.reason_counts[decision.reason] = (report.reason_counts[decision.reason] || 0) + 1;
      const providerNames = row.providers || ['unknown']; for (const name of providerNames) { const b = report.provider_breakdown[name] || (report.provider_breakdown[name] = { candidates: 0, online: 0, duplicate_existing: 0, genuinely_new_online: 0, auto_eligible: 0, review: 0, rejected: 0 }); b.candidates++; if (row.health_status === 'online') b.online++; if (decision.reason === 'reject_duplicate_source') b.duplicate_existing++; if (decision.outcome === 'AUTO_ELIGIBLE') { b.genuinely_new_online++; b.auto_eligible++; } if (decision.outcome === 'REVIEW_REQUIRED') b.review++; if (decision.outcome === 'REJECTED') b.rejected++; }
      if (decision.channel_id && decision.outcome === 'AUTO_ELIGIBLE') { const category = categories.get(Number(decision.channel_id)) || 'Без категории'; report.category_coverage ||= {}; report.category_coverage[category] ||= { matched_new: 0, auto_eligible_new: 0 }; report.category_coverage[category].matched_new++; report.category_coverage[category].auto_eligible_new++; }
    }
    report.health_summary.unknown = rows.filter(r => !r.health_status).length;
    const buckets = ['Казахстан','Детские','Кино','Музыка','Спорт','Без категории']; report.category_coverage ||= {}; for (const b of buckets) report.category_coverage[b] ||= { matched_new: 0, auto_eligible_new: 0 };
    const eligible = []; for (const row of rows) { const d = await classifyCandidateForIngestion(db, row); if (d.outcome === 'AUTO_ELIGIBLE') eligible.push({ candidate_id: row.id, candidate_name: row.name, provider: (row.providers || []).join(', '), url_host: host(row.stream_url), response_time: row.response_time, logical_channel_id: d.channel_id, category: categories.get(Number(d.channel_id)) || 'Без категории', match_confidence: row.match_confidence, duplicate_check: false }); }
    report.top_new_candidates = eligible.slice(0, 25);
    const reserveRows = (await db.query(`SELECT c.id,c.name,COALESCE(cat.category,'Без категории') AS category,(SELECT COUNT(*) FROM milktv_channel_sources s WHERE s.channel_id=c.id AND s.id<>c.current_source_id) AS reserves FROM channels c LEFT JOIN milktv_channel_categories cat ON cat.channel_id=c.id`)).rows;
    report.reserve_coverage = { channels_with_no_reserve: reserveRows.filter(x => Number(x.reserves) === 0).length, channels_with_1_reserve: reserveRows.filter(x => Number(x.reserves) === 1).length, channels_with_2plus_reserves: reserveRows.filter(x => Number(x.reserves) >= 2).length, by_category: {} };
    for (const row of reserveRows) { const b = report.reserve_coverage.by_category[row.category] || (report.reserve_coverage.by_category[row.category] = { no_reserve: 0, one_reserve: 0, two_plus_reserves: 0 }); const n = Number(row.reserves); if (!n) b.no_reserve++; else if (n === 1) b.one_reserve++; else b.two_plus_reserves++; }
    report.recommended_next_ingestion = eligible.filter(x => Number(reserveRows.find(r => Number(r.id) === Number(x.logical_channel_id))?.reserves || 0) === 0).slice(0, 10);
    report.after = { channels: await count('channels'), sources: await count('milktv_channel_sources'), candidates: await count('milktv_m3u_candidates'), provenance: await count('milktv_m3u_candidate_providers'), audit: await count('milktv_source_ingestion_audit') }; report.integrity = { channels_unchanged: report.before.channels === report.after.channels, sources_unchanged: report.before.sources === report.after.sources, ingestion_audit_unchanged: report.before.audit === report.after.audit }; fs.writeFileSync('full-candidate-health-sweep-20260831.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`FULL_SWEEP_FAILED: ${error.message}`); process.exitCode = 1; } finally { await db.end(); }
})();
