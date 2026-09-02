require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../database');
const autopilot = require('../services/milktv-autopilot');
const { safeUrl } = require('../services/milktv-discovery');
const { switchChannelSource } = require('../services/milktv-source-switch');

const MAX_SWITCHES = 3;

function latestSuccessfulFullHealthReport() {
  const reportDir = path.join(__dirname, '..', 'reports');
  const file = fs.readdirSync(reportDir)
    .filter(name => /^milktv-health-full-.*\.json$/i.test(name))
    .map(name => ({ name, full: path.join(reportDir, name), stat: fs.statSync(path.join(reportDir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
  if (!file) throw new Error('successful_full_windows_health_report_missing');
  const report = JSON.parse(fs.readFileSync(file.full, 'utf8'));
  if (report.mode !== 'full' || Number(report.total) !== Number(report.checked) || Number(report.db_errors) !== 0 || Number(report.timeouts) !== 0 || report.circuit_breaker) throw new Error('full_windows_health_report_not_successful');
  return { file: file.full, report };
}

async function liveProbe(rawUrl) {
  const started = Date.now();
  try {
    const url = await safeUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1023' }, redirect: 'error', signal: controller.signal });
      await response.body?.cancel();
      return { result: response.ok ? 'ONLINE_CONFIRMED' : 'OFFLINE', response_time_ms: Date.now() - started, error: response.ok ? null : `HTTP ${response.status}` };
    } finally { clearTimeout(timer); }
  } catch (error) {
    const message = String(error.message || error).slice(0, 240);
    return { result: /abort|timeout/i.test(message) ? 'UNKNOWN' : 'OFFLINE', response_time_ms: Date.now() - started, error: message };
  }
}

function reserveIsAcceptable(source) {
  // This is deliberately conservative: existing stability/public-source policy,
  // plus source trust/provenance where the schema provides it.
  const trustOk = source.trust_level == null || ['trusted', 'unproven'].includes(String(source.trust_level));
  return trustOk && Number(source.provenance_count || 0) > 0;
}

(async () => {
  const report = {
    started_at: new Date().toISOString(), mode: 'recovery_only', max_switches: MAX_SWITCHES,
    background_health: process.env.MILKTV_BACKGROUND_HEALTH_ENABLED === 'true', autopilot_background: process.env.MILKTV_AUTOPILOT_ENABLED === 'true',
    confirmed_failed_channels: 0, candidate_matches: 0, auto_eligible: 0, final_probes: [], switch_attempts: 0, switched: 0, recovered_online: 0,
    no_safe_reserve: 0, skipped_unknown: 0, errors: [], switches: []
  };
  try {
    if (report.background_health || report.autopilot_background) throw new Error('background_automation_must_be_off');
    report.full_windows_health = latestSuccessfulFullHealthReport();
    const canonical = (await db.query(`
      SELECT c.id,c.name,c.url,c.current_source_id,c.milktv_status,c.milktv_failed_checks,
             s.id AS source_id,s.enabled AS current_enabled,s.status AS current_status
      FROM channels c JOIN milktv_channel_sources s ON s.id=c.current_source_id
      WHERE s.enabled=TRUE AND (c.milktv_status='quarantine' OR (c.milktv_status='offline' AND c.milktv_failed_checks>=3)) ORDER BY c.id
    `)).rows;
    report.confirmed_failed_channels = canonical.length;
    for (const channel of canonical) {
      if (report.switch_attempts >= MAX_SWITCHES) break;
      const sources = (await db.query(`
        SELECT s.id,s.channel_id,s.url,s.enabled,s.status,s.failed_checks,s.consecutive_successful_checks,s.priority,s.promo_status,s.response_time,s.trust_level,s.trust_score,
               (SELECT COUNT(*)::int FROM milktv_channel_source_provenance p WHERE p.source_id=s.id) AS provenance_count
        FROM milktv_channel_sources s WHERE s.channel_id=$1 ORDER BY s.priority,s.id`, [channel.id])).rows;
      const current = sources.find(source => Number(source.id) === Number(channel.current_source_id));
      const stable = autopilot.stableAlternates(current, sources.filter(source => Number(source.id) !== Number(channel.current_source_id)));
      const safe = stable.filter(reserveIsAcceptable);
      report.candidate_matches += sources.filter(source => Number(source.id) !== Number(channel.current_source_id)).length;
      if (!safe.length) { report.no_safe_reserve++; continue; }
      report.auto_eligible += safe.length;
      const reserve = safe[0];
      const final = await liveProbe(reserve.url);
      report.final_probes.push({ channel_id: channel.id, source_id: reserve.id, result: final.result, response_time_ms: final.response_time_ms, error: final.error });
      if (final.result === 'UNKNOWN') { report.skipped_unknown++; continue; }
      if (final.result !== 'ONLINE_CONFIRMED') continue;
      report.switch_attempts++;
      const entry = { channel_id: channel.id, old_source_id: current.id, new_source_id: reserve.id, final_probe_result: final.result, post_switch_health_result: null };
      try {
        const switched = await switchChannelSource(db, { channelId: channel.id, fromSourceId: current.id, toSourceId: reserve.id, reason: 'autopilot_current_source_failed', automatic: true });
        if (!switched.success) throw new Error('switch_not_successful');
        report.switched++;
        const post = await liveProbe(reserve.url);
        entry.post_switch_health_result = post.result;
        entry.post_switch_probe = post;
        if (post.result === 'ONLINE_CONFIRMED') report.recovered_online++;
        else report.errors.push({ channel_id: channel.id, error: 'post_switch_current_not_online', result: post.result, detail: post.error });
      } catch (error) { entry.error = String(error.message || error).slice(0, 240); report.errors.push({ channel_id: channel.id, error: entry.error }); }
      report.switches.push(entry);
    }
  } catch (error) { report.errors.push({ error: String(error.message || error).slice(0, 240) }); process.exitCode = 1; }
  finally {
    report.finished_at = new Date().toISOString();
    const filename = `controlled-recovery-autopilot-cycle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ filename, ...report }, null, 2));
    await db.end();
  }
})();
