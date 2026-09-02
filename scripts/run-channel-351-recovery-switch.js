const fs = require('fs');
const db = require('../database');
const { safeUrl } = require('../services/milktv-discovery');
const { switchChannelSource } = require('../services/milktv-source-switch');

const CHANNEL_ID = 351;
const FROM_SOURCE_ID = 317;
const TO_SOURCE_ID = 775;
const PREFLIGHT_ONLY = process.env.MILKTV_RECOVERY_PREFLIGHT_ONLY === 'true';

function classifyUrl(raw) {
  let host = '[invalid]';
  try { host = new URL(raw).hostname.toLowerCase(); } catch {}
  return { host, local: ['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(host), privateNet: /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host), marker: /(test|example|dummy|backup-test|test-backup)/i.test(String(raw)) };
}

async function probe(source) {
  const started = Date.now();
  try {
    const safe = await safeUrl(source.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try { const response = await fetch(safe, { headers: { Range: 'bytes=0-1023' }, redirect: 'error', signal: controller.signal }); await response.body?.cancel(); return { status: response.ok ? 'online' : 'offline', response_time: Date.now() - started, error: response.ok ? null : `HTTP ${response.status}`, timestamp: new Date().toISOString() }; }
    finally { clearTimeout(timer); }
  } catch (error) { return { status: 'offline', response_time: Date.now() - started, error: String(error.message || error).slice(0, 300), timestamp: new Date().toISOString() }; }
}

async function saveObservation(source, observation) {
  const success = observation.status === 'online';
  await db.query(`UPDATE milktv_channel_sources SET status=$1,failed_checks=$2,response_time=$3,last_check=NOW(),check_error=$4,successful_checks=CASE WHEN $5 THEN successful_checks+1 ELSE successful_checks END,consecutive_successful_checks=CASE WHEN $5 THEN consecutive_successful_checks+1 ELSE 0 END,first_success_at=CASE WHEN $5 AND first_success_at IS NULL THEN NOW() ELSE first_success_at END,last_success_at=CASE WHEN $5 THEN NOW() ELSE last_success_at END,updated_at=NOW() WHERE id=$6`, [observation.status, success ? 0 : Number(source.failed_checks || 0) + 1, observation.response_time, observation.error, success, source.id]);
}

(async () => {
  const report = { started_at: new Date().toISOString(), global_autoswitch_enabled: false, source_switch_executed: false, switch: { attempted: false, executed: false, from_source_id: FROM_SOURCE_ID, to_source_id: TO_SOURCE_ID, reason: 'manual_recovery_invalid_test_current_source' } };
  try {
    const before = (await db.query('SELECT id,url,current_source_id FROM channels ORDER BY id')).rows;
    const rows = (await db.query(`SELECT s.*,c.name AS channel_name,c.url AS channel_url,c.current_source_id,EXISTS(SELECT 1 FROM milktv_channel_source_provenance p WHERE p.source_id=s.id) AS has_provenance FROM milktv_channel_sources s JOIN channels c ON c.id=s.channel_id WHERE s.id=ANY($1::int[])`, [[FROM_SOURCE_ID, TO_SOURCE_ID]])).rows;
    const from = rows.find(row => Number(row.id) === FROM_SOURCE_ID);
    const to = rows.find(row => Number(row.id) === TO_SOURCE_ID);
    const channel = rows.find(row => Number(row.channel_id) === CHANNEL_ID) || from || to;
    report.before = { channel: channel && { id: channel.logical_channel_id, name: channel.channel_name, url: channel.channel_url, current_source_id: channel.current_source_id }, source_317: from, source_775: to };
    const fromClass = from && classifyUrl(from.url); const toClass = to && classifyUrl(to.url);
    report.preconditions = { channel_current_is_317: !!channel && Number(channel.current_source_id) === FROM_SOURCE_ID, source_317_local_test: !!fromClass && (fromClass.local || fromClass.marker), source_775_channel_match: !!to && Number(to.channel_id) === CHANNEL_ID, source_775_enabled: !!to?.enabled, source_775_public: !!toClass && !toClass.local && !toClass.privateNet && !toClass.marker, source_775_online: to?.status === 'online', source_775_stability: Number(to?.consecutive_successful_checks || 0) >= 3, source_775_provenance: !!to?.has_provenance };
    if (Number(channel?.current_source_id) === TO_SOURCE_ID) report.already_recovered = true;
    else if (!PREFLIGHT_ONLY && !Object.values(report.preconditions).every(Boolean)) report.abort = 'preconditions_failed';
    if (!PREFLIGHT_ONLY && !report.abort && !report.already_recovered) {
      report.final_pre_switch_probe = await probe(to);
      if (report.final_pre_switch_probe.status !== 'online') report.abort = 'final_probe_failed';
      else { await saveObservation(to, report.final_pre_switch_probe); report.switch.attempted = true; const result = await switchChannelSource(db, { channelId: CHANNEL_ID, fromSourceId: FROM_SOURCE_ID, toSourceId: TO_SOURCE_ID, reason: report.switch.reason }); report.switch = { ...report.switch, ...result, executed: !!result.success }; report.source_switch_executed = !!result.success; }
    }
    const after = (await db.query('SELECT id,url,current_source_id FROM channels ORDER BY id')).rows;
    const changed = before.filter((row, index) => row.url !== after[index]?.url || Number(row.current_source_id || 0) !== Number(after[index]?.current_source_id || 0)).map(row => row.id);
    report.integrity = { channels_count: after.length, sources_count: (await db.query('SELECT COUNT(*)::int AS count FROM milktv_channel_sources')).rows[0].count, changed_channel_ids: changed, only_channel_351_changed: changed.every(id => Number(id) === CHANNEL_ID), source_switch_executed: report.switch.executed };
    fs.writeFileSync('channel-351-recovery-switch-20260831.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`RECOVERY_SWITCH_FAILED: ${error.message}`); process.exitCode = 1; }
  finally { await db.end(); }
})();
