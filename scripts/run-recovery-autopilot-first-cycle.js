const fs = require('fs');
const db = require('../database');
const autopilot = require('../services/milktv-autopilot');
const discovery = require('../services/milktv-discovery');
const m3uPilot = require('../services/milktv-m3u-pilot');
const ingestion = require('../services/milktv-source-ingestion');
const { switchChannelSource } = require('../services/milktv-source-switch');

async function finalProbe(rawUrl) {
  const url = await discovery.safeUrl(rawUrl);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try { const response = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal }); await response.body?.cancel(); return { online: response.ok }; }
  catch (_) { return { online: false }; } finally { clearTimeout(timer); }
}
async function count(sql) { return (await db.query(sql)).rows[0].count; }

(async () => {
  const report = { started_at: new Date().toISOString(), autopilot_enabled: process.env.MILKTV_AUTOPILOT_ENABLED === 'true', mode: 'recovery_only', max_switches_per_run: autopilot.configuredMax(), switches_attempted: 0, switches_executed: 0, channels_recovered: [], integrity_status: {} };
  try {
    if (!report.autopilot_enabled) throw new Error('MILKTV_AUTOPILOT_ENABLED must be true for first cycle');
    report.integrity_before = { ratings: (await db.query('SELECT COUNT(*)::int AS count,COALESCE(SUM(milktv_rating),0)::text AS value FROM channels')).rows[0], views: await count('SELECT COUNT(*)::int AS count FROM milktv_view_events'), categories: await count('SELECT COUNT(*)::int AS count FROM milktv_channel_categories'), epg: await count('SELECT COUNT(*)::int AS count FROM milktv_epg_channels') };
    const before = await autopilot.runAutopilot(db, { dryRun: true });
    report.confirmed_failed_before = before.failed_channels_considered;
    report.stable_reserves_before = before.eligible_alternates;
    const live = await autopilot.runAutopilot(db, { dryRun: false, maxSwitches: autopilot.configuredMax(), finalProbe, switchSource: payload => switchChannelSource(db, { ...payload, automatic: true }) });
    const targets = live.channels.filter(row => row.decision === 'NO_ALTERNATE').map(row => row.channel_id);
    const acquisition = await autopilot.runTargetedReserveAcquisition(db, targets, { refreshHealth: rows => m3uPilot.healthCheckBatch(db, rows, { concurrency: 2, timeoutMs: 8000 }), safeUrl: discovery.safeUrl, classifyCandidate: ingestion.classifyCandidateForIngestion, ingestCandidate: ingestion.ingestCandidate });
    const after = await autopilot.runAutopilot(db, { dryRun: true });
    report.targeted_candidates_found = acquisition.candidate_matches;
    report.auto_eligible = acquisition.auto_eligible;
    report.review_required = acquisition.review_required;
    report.review_queue = acquisition.details.filter(row => row.outcome === 'REVIEW_REQUIRED');
    report.reserves_ingested = acquisition.reserves_ingested;
    report.stability_results = acquisition.stability_results;
    report.reserves_reaching_stability = acquisition.reserves_reaching_stability;
    report.switches_attempted = live.switches_attempted;
    report.switches_executed = live.switches_executed;
    report.channels_recovered = live.switches;
    report.confirmed_failed_after = after.failed_channels_considered;
    report.no_safe_reserve = acquisition.no_safe_reserve;
    report.no_safe_reserve_channels = after.channels.filter(row => row.decision === 'NO_ALTERNATE').map(row => row.channel_id);
    const channel351 = (await db.query(`SELECT c.id,c.name,c.current_source_id,s.enabled,s.status,s.consecutive_successful_checks FROM channels c LEFT JOIN milktv_channel_sources s ON s.id=c.current_source_id WHERE c.id=351`)).rows[0];
    report.channel_351_state = { ...channel351, expected: 'KEEP_CURRENT', source_317_ineligible: !(await db.query('SELECT 1 FROM milktv_channel_sources WHERE id=317 AND enabled=TRUE')).rows.length };
    report.integrity_after = { ratings: (await db.query('SELECT COUNT(*)::int AS count,COALESCE(SUM(milktv_rating),0)::text AS value FROM channels')).rows[0], views: await count('SELECT COUNT(*)::int AS count FROM milktv_view_events'), categories: await count('SELECT COUNT(*)::int AS count FROM milktv_channel_categories'), epg: await count('SELECT COUNT(*)::int AS count FROM milktv_epg_channels') };
    report.integrity_status = Object.fromEntries(Object.keys(report.integrity_before).map(key => [key, JSON.stringify(report.integrity_before[key]) === JSON.stringify(report.integrity_after[key])]));
    report.acquisition_details = acquisition.details;
  } catch (error) { report.error = String(error.message || error); process.exitCode = 1; }
  finally { report.finished_at = new Date().toISOString(); fs.writeFileSync('recovery-autopilot-first-cycle-20260831.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await db.end(); }
})();
