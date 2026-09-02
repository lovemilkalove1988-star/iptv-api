require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../database');
const autopilot = require('../services/milktv-autopilot');
const discovery = require('../services/milktv-discovery');
const { switchChannelSource } = require('../services/milktv-source-switch');

function latestHealth() {
  const directory = path.join(__dirname, '..', 'reports');
  const file = fs.readdirSync(directory).filter(name => /^milktv-health-(full|background-equivalent)-.*\.json$/i.test(name)).map(name => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  if (!file) throw new Error('AUTOPILOT_PAUSED_STALE_HEALTH');
  const report = JSON.parse(fs.readFileSync(path.join(directory, file.name), 'utf8'));
  if (Date.now() - new Date(report.created_at).getTime() > 45 * 60 * 1000 || report.circuit_breaker || Number(report.db_errors || 0) > 0) throw new Error('AUTOPILOT_PAUSED_STALE_HEALTH');
  return { file: path.join(directory, file.name), report };
}
async function probe(rawUrl) {
  try { const result = await fetch(await discovery.safeUrl(rawUrl), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) }); await result.body?.cancel(); return { online: result.ok, indeterminate: false }; }
  catch (error) { return { online: false, indeterminate: /timeout|abort/i.test(String(error.message || error)) }; }
}
(async () => {
  const report = { started_at: new Date().toISOString(), mode: 'recovery_only', max_switches: autopilot.configuredMax(), health: latestHealth(), errors: [] };
  try {
    if (process.env.MILKTV_AUTOPILOT_ENABLED !== 'true') throw new Error('autopilot_disabled');
    const result = await autopilot.runAutopilot(db, { dryRun: false, maxSwitches: autopilot.configuredMax(), finalProbe: probe, postSwitchProbe: probe, switchSource: payload => switchChannelSource(db, { ...payload, automatic: true }) });
    report.result = { confirmed_failed: result.failed_channels_considered, auto_eligible: result.eligible_alternates, final_probes: result.final_probes, switched: result.switches_executed, recovered: result.recovered_online, no_safe_reserve: result.skipped_no_alternate, errors: result.switches_failed, switches: result.switches };
  } catch (error) { report.errors.push(String(error.message || error)); process.exitCode = 1; }
  finally { report.finished_at = new Date().toISOString(); const file = `background-autopilot-immediate-cycle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ file, ...report }, null, 2)); await db.end(); }
})();
