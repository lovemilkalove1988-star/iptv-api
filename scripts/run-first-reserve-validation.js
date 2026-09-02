const fs = require('fs');
const db = require('../database');
const { safeUrl } = require('../services/milktv-discovery');

const SOURCE_IDS = [317, 775];
function classifyUrl(raw) {
  const value = String(raw || '').toLowerCase(); let host = '';
  try { host = new URL(raw).hostname; } catch {}
  const local = ['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(host);
  const privateNet = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  const marker = /(test|example|dummy|backup-test|test-backup)/i.test(value);
  return { host: host || '[invalid]', local, privateNet, marker };
}
async function probe(source) {
  const started = Date.now();
  try { const safe = await safeUrl(source.url); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000); try { const response = await fetch(safe, { headers: { Range: 'bytes=0-1023' }, redirect: 'error', signal: controller.signal }); await response.body?.cancel(); return { status: response.ok ? 'online' : 'offline', response_time: Date.now() - started, error: response.ok ? null : `HTTP ${response.status}`, timestamp: new Date().toISOString() }; } finally { clearTimeout(timer); } }
  catch (e) { return { status: 'offline', response_time: Date.now() - started, error: String(e.message || e).slice(0, 300), timestamp: new Date().toISOString() }; }
}
async function save(source, observation) { const ok = observation.status === 'online'; await db.query(`UPDATE milktv_channel_sources SET status=$1,failed_checks=$2,response_time=$3,last_check=NOW(),check_error=$4,successful_checks=CASE WHEN $5 THEN successful_checks+1 ELSE successful_checks END,consecutive_successful_checks=CASE WHEN $5 THEN consecutive_successful_checks+1 ELSE 0 END,first_success_at=CASE WHEN $5 AND first_success_at IS NULL THEN NOW() ELSE first_success_at END,last_success_at=CASE WHEN $5 THEN NOW() ELSE last_success_at END,updated_at=NOW() WHERE id=$6`, [observation.status, ok ? 0 : Number(source.failed_checks || 0) + 1, observation.response_time, observation.error, ok, source.id]); }

(async () => {
  const report = { started_at: new Date().toISOString(), source_switch_executed: false, source_775_observations: [], source_317_observations: [], test_url_audit: { localhost_count: 0, test_placeholder_count: 0, private_network_count: 0, affected_current_sources: [], affected_reserve_sources: [], normal_public_reserves: [] } };
  try {
    const sources = (await db.query(`SELECT s.*,c.name AS channel_name,c.url AS channel_url,c.current_source_id,EXISTS(SELECT 1 FROM milktv_channel_source_provenance p WHERE p.source_id=s.id) AS has_provenance FROM milktv_channel_sources s JOIN channels c ON c.id=s.channel_id WHERE s.id=ANY($1::int[])`, [SOURCE_IDS])).rows;
    for (const source of sources) {
      const cls = classifyUrl(source.url); if (cls.local) report.test_url_audit.localhost_count++; if (cls.marker) report.test_url_audit.test_placeholder_count++; if (cls.privateNet) report.test_url_audit.private_network_count++;
      const key = Number(source.id) === 775 ? 'source_775_observations' : 'source_317_observations'; const attempts = Number(source.id) === 775 ? 3 : 1;
      for (let i = 0; i < attempts; i++) { const observation = await probe(source); report[key].push({ attempt: i + 1, ...observation }); await save(source, observation); source.consecutive_successful_checks = observation.status === 'online' ? Number(source.consecutive_successful_checks || 0) + 1 : 0; }
      const affected = cls.local || cls.privateNet || cls.marker; const current = Number(source.current_source_id) === Number(source.id); if (affected) (current ? report.test_url_audit.affected_current_sources : report.test_url_audit.affected_reserve_sources).push({ channel_id: source.channel_id, source_id: source.id }); else if (!current) report.test_url_audit.normal_public_reserves.push({ channel_id: source.channel_id, source_id: source.id });
      report[`source_${source.id}`] = { source_id: source.id, channel_id: source.channel_id, channel_name: source.channel_name, url_classification: cls, has_provenance: source.has_provenance, final_status: report[key].at(-1)?.status, consecutive_successes: source.consecutive_successful_checks };
    }
    const all = (await db.query('SELECT id,channel_id,url FROM milktv_channel_sources')).rows; for (const source of all) { const cls = classifyUrl(source.url); if (!cls.local && !cls.privateNet && !cls.marker) continue; const current = (await db.query('SELECT current_source_id FROM channels WHERE id=$1', [source.channel_id])).rows[0]?.current_source_id; (Number(current) === Number(source.id) ? report.test_url_audit.affected_current_sources : report.test_url_audit.affected_reserve_sources).push({ channel_id: source.channel_id, source_id: source.id }); }
    report.stability_gate = { source_775_consecutive_successes: report.source_775?.consecutive_successes || 0, passed: (report.source_775?.consecutive_successes || 0) >= 3 }; report.integrity = { expected_channels: 387, expected_sources: 388, source_switch_executed: false }; fs.writeFileSync('first-reserve-validation-20260831.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } catch (e) { console.error(`VALIDATION_FAILED: ${e.message}`); process.exitCode = 1; } finally { await db.end(); }
})();
