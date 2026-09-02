const fs = require('fs');
const db = require('../database');
const { classifyCandidateForIngestion } = require('../services/milktv-source-ingestion');

const BUCKETS = ['Казахстан', 'Детские', 'Кино', 'Музыка', 'Спорт', 'Без категории'];
const priority = new Map(BUCKETS.map((x, i) => [x, i]));
function urlClass(raw) { try { const u = new URL(raw); const h = u.hostname.toLowerCase(); return { host: u.host, public: !['127.0.0.1','localhost','0.0.0.0','::1'].includes(h) && !/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h) && !/(test|example|dummy|backup-test|test-backup)/i.test(raw) }; } catch { return { host: '[invalid]', public: false }; } }
function empty() { return { no_reserve: 0, one_reserve: 0, two_plus_reserves: 0 }; }

(async () => {
  const report = { generated_at: new Date().toISOString(), source_ingestion_executed: false, source_switch_executed: false };
  try {
    const channels = (await db.query('SELECT id,name,current_source_id FROM channels ORDER BY id')).rows;
    const rawCats = (await db.query('SELECT channel_id,category FROM milktv_channel_categories ORDER BY channel_id')).rows;
    const dupMap = new Map(); for (const row of rawCats) { const id = Number(row.channel_id); if (!dupMap.has(id)) dupMap.set(id, []); dupMap.get(id).push(row.category); }
    const duplicates = [...dupMap].filter(([, values]) => values.length > 1).map(([channel_id, categories]) => ({ channel_id, categories }));
    const chosen = new Map(); for (const channel of channels) { const values = (dupMap.get(Number(channel.id)) || []).filter(x => priority.has(x)); chosen.set(Number(channel.id), values.sort((a, b) => priority.get(a) - priority.get(b))[0] || 'Без категории'); }
    const sources = (await db.query('SELECT id,channel_id,url,enabled FROM milktv_channel_sources ORDER BY id')).rows;
    const byChannel = new Map(); for (const source of sources) { const id = Number(source.channel_id); if (!byChannel.has(id)) byChannel.set(id, []); byChannel.get(id).push(source); }
    const coverage = { channels_with_no_reserve: 0, channels_with_1_reserve: 0, channels_with_2plus_reserves: 0, total: channels.length };
    const categoryCoverage = {}; for (const bucket of BUCKETS) categoryCoverage[bucket] = { total_channels: 0, ...empty() };
    const details = [];
    for (const channel of channels) { const category = chosen.get(Number(channel.id)); const usable = (byChannel.get(Number(channel.id)) || []).filter(s => Number(s.id) !== Number(channel.current_source_id) && s.enabled === true && urlClass(s.url).public); const n = usable.length; const key = n === 0 ? 'no_reserve' : n === 1 ? 'one_reserve' : 'two_plus_reserves'; if (n === 0) coverage.channels_with_no_reserve++; else if (n === 1) coverage.channels_with_1_reserve++; else coverage.channels_with_2plus_reserves++; categoryCoverage[category].total_channels++; categoryCoverage[category][key]++; details.push({ channel_id: channel.id, category, usable_reserve_count: n }); }
    report.category_data = { distinct_channel_ids: new Set(rawCats.map(x => Number(x.channel_id))).size, duplicate_category_mappings: duplicates, duplicate_count: duplicates.length, uncategorized: channels.filter(c => chosen.get(Number(c.id)) === 'Без категории').length };
    report.corrected_reserve_coverage = coverage; report.category_coverage = categoryCoverage; report.invariants = { global_387: channels.length === 387 && coverage.channels_with_no_reserve + coverage.channels_with_1_reserve + coverage.channels_with_2plus_reserves === 387, category_totals_387: Object.values(categoryCoverage).reduce((a, x) => a + x.total_channels, 0) === 387, each_channel_once: details.length === new Set(details.map(x => x.channel_id)).size };
    const c351 = channels.find(x => Number(x.id) === 351); report.channel_351 = { channel: c351, sources: (byChannel.get(351) || []).map(s => ({ id: s.id, url_host: urlClass(s.url).host, enabled: s.enabled, classification: Number(s.id) === Number(c351?.current_source_id) ? 'CURRENT' : !s.enabled ? 'IGNORED_DISABLED' : !urlClass(s.url).public ? 'IGNORED_TEST_OR_PRIVATE' : 'USABLE_RESERVE' })), usable_reserve_count: details.find(x => Number(x.channel_id) === 351)?.usable_reserve_count || 0 };
    const c265 = (await db.query(`SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.active=TRUE) AS has_provenance,NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp2 WHERE cp2.candidate_id=c.id AND cp2.active=TRUE) AS is_stale FROM milktv_m3u_candidates c WHERE c.id=265`)).rows[0]; report.candidate_265 = c265 ? { candidate_id: c265.id, channel_id: c265.suggested_channel_id, health_status: c265.health_status, last_check: c265.last_check, match_confidence: c265.match_confidence, decision: await classifyCandidateForIngestion(db, c265), usable_reserve_count: details.find(x => Number(x.channel_id) === Number(c265.suggested_channel_id))?.usable_reserve_count || 0 } : { missing: true };
    report.after = { channels: channels.length, sources: sources.length, ingestion_audit: (await db.query('SELECT COUNT(*)::int AS count FROM milktv_source_ingestion_audit')).rows[0].count }; fs.writeFileSync('reserve-coverage-fix-20260831.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } catch (e) { console.error(`RESERVE_COVERAGE_AUDIT_FAILED: ${e.message}`); process.exitCode = 1; } finally { await db.end(); }
})();
