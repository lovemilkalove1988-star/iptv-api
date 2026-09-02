const DEFAULT_MAX_SWITCHES = 3;
const COOLDOWN_MS = 30 * 60 * 1000;
const CONFIRMED_FAILURE_CHECKS = 3;

function classifyUrl(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    const host = parsed.hostname.toLowerCase();
    const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    const privateV6 = host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
    const marker = /(localhost|test|example|dummy|placeholder|backup-test|test-backup)/i.test(`${host} ${raw}`);
    return { public: ["http:", "https:"].includes(parsed.protocol) && !privateV4 && !privateV6 && !marker, host, marker, private: privateV4 || privateV6 };
  } catch (_) { return { public: false, host: "[invalid]", marker: true, private: false }; }
}

function isConfirmedFailed(current, channel) {
  // Source-local counters may have been written by legacy Windows probes.
  // Autopilot trusts only the canonical channel result produced by
  // runMilktvCheck: three confirmed OFFLINE outcomes (or canonical quarantine).
  return Boolean(current && current.enabled && (
    channel.milktv_status === "quarantine" ||
    (channel.milktv_status === "offline" && Number(channel.milktv_failed_checks || 0) >= CONFIRMED_FAILURE_CHECKS)
  ));
}
function promoRank(status) { return ({ clean: 0, unknown: 1, suspected: 2, detected: 3 })[status] ?? 1; }
function stableAlternates(current, alternates) {
  return (alternates || []).filter(source => source.enabled === true && Number(source.id) !== 317 && source.status === "online" && Number(source.failed_checks || 0) === 0 && Number(source.consecutive_successful_checks || 0) >= 3 && Number(source.id) !== Number(current.id) && Number(source.provenance_count || 0) > 0 && !['unstable', 'unknown'].includes(String(source.trust_level || '')) && classifyUrl(source.url).public).sort((a, b) => promoRank(a.promo_status) - promoRank(b.promo_status) || Number(a.response_time ?? Number.MAX_SAFE_INTEGER) - Number(b.response_time ?? Number.MAX_SAFE_INTEGER) || Number(a.priority ?? Number.MAX_SAFE_INTEGER) - Number(b.priority ?? Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id));
}
function evaluateChannel(row) {
  const current = row.current;
  if (!current) return { decision: "IGNORE", reason: "current_source_missing", eligible_alternates: [] };
  if (!current.enabled) return { decision: "IGNORE", reason: "current_source_disabled", eligible_alternates: [] };
  if (!isConfirmedFailed(current, row.channel || {})) return { decision: "IGNORE", reason: "current_source_not_confirmed_failed", eligible_alternates: [] };
  const eligible = stableAlternates(current, row.alternates);
  if (!eligible.length) return { decision: "NO_ALTERNATE", reason: "confirmed_failure_no_stable_alternate", eligible_alternates: [] };
  return { decision: "WOULD_SWITCH", reason: "autopilot_current_source_failed", eligible_alternates: eligible, would_switch_to: eligible[0].id };
}
function configuredMax(value = process.env.MILKTV_AUTOPILOT_MAX_SWITCHES_PER_RUN) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, DEFAULT_MAX_SWITCHES) : DEFAULT_MAX_SWITCHES; }
async function readCandidates(db) {
  const channels = (await db.query(`SELECT c.id,c.name,c.url,c.current_source_id,c.milktv_status,c.milktv_failed_checks,s.id AS source_id FROM channels c JOIN milktv_channel_sources s ON s.id=c.current_source_id WHERE s.enabled=TRUE AND (c.milktv_status='quarantine' OR (c.milktv_status='offline' AND c.milktv_failed_checks >= $1)) ORDER BY c.id`, [CONFIRMED_FAILURE_CHECKS])).rows;
  const result = [];
  for (const c of channels) {
    const sources = (await db.query(`SELECT s.id,s.channel_id,s.url,s.enabled,s.status,s.failed_checks,s.consecutive_successful_checks,s.priority,s.promo_status,s.response_time,s.trust_level,s.trust_score,(SELECT COUNT(*)::int FROM milktv_channel_source_provenance p WHERE p.source_id=s.id) AS provenance_count FROM milktv_channel_sources s WHERE s.channel_id=$1 ORDER BY s.priority,s.id`, [c.id])).rows;
    const current = sources.find(s => Number(s.id) === Number(c.source_id));
    result.push({ channel: c, current, alternates: sources.filter(s => Number(s.id) !== Number(c.source_id)) });
  }
  return result;
}
async function inCooldown(db, channelId, currentSourceId) {
  const row = (await db.query(`SELECT to_source_id,created_at FROM milktv_source_switch_history WHERE channel_id=$1 AND automatic=TRUE AND result='success' ORDER BY created_at DESC LIMIT 1`, [channelId])).rows[0];
  if (!row || Date.now() - new Date(row.created_at).getTime() >= COOLDOWN_MS) return false;
  return Number(row.to_source_id) !== Number(currentSourceId); // confirmed failure of the new current source is the exception
}
async function runTargetedReserveAcquisition(db, targetChannelIds, options = {}) {
  const targets = [...new Set((targetChannelIds || []).map(Number).filter(Number.isInteger))];
  const summary = { candidate_matches: 0, auto_eligible: 0, review_required: 0, reserves_ingested: 0, reserves_reaching_stability: 0, no_safe_reserve: targets.length, details: [], stability_results: [] };
  if (!targets.length) return summary;
  const rows = (await db.query(`SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.active=TRUE) AS has_provenance,NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.active=TRUE) AS is_stale FROM milktv_m3u_candidates c WHERE c.state='new' AND c.suggested_channel_id=ANY($1::int[]) ORDER BY c.suggested_channel_id,c.response_time NULLS LAST,c.id`, [targets])).rows;
  summary.candidate_matches = rows.length;
  if (rows.length && typeof options.refreshHealth === 'function') await options.refreshHealth(rows);
  const refreshed = rows.length ? (await db.query(`SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.active=TRUE) AS has_provenance,NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.active=TRUE) AS is_stale FROM milktv_m3u_candidates c WHERE c.id=ANY($1::int[]) ORDER BY c.suggested_channel_id,c.response_time NULLS LAST,c.id`, [rows.map(row => row.id)])).rows : [];
  const safeChannels = new Set();
  for (const row of refreshed) {
    let decision;
    try { if (typeof options.safeUrl === 'function') await options.safeUrl(row.stream_url); decision = await options.classifyCandidate(db, row); }
    catch (_) { decision = { outcome: 'REJECTED', reason: 'reject_unsafe_url' }; }
    if (decision.outcome === 'REVIEW_REQUIRED') { summary.review_required++; summary.details.push({ candidate_id: row.id, channel_id: row.suggested_channel_id, outcome: decision.outcome, reason: decision.reason }); continue; }
    if (decision.outcome !== 'AUTO_ELIGIBLE' || safeChannels.has(decision.channel_id)) { summary.details.push({ candidate_id: row.id, channel_id: row.suggested_channel_id, outcome: decision.outcome, reason: decision.reason }); continue; }
    summary.auto_eligible++; safeChannels.add(decision.channel_id);
    const priority = (await db.query('SELECT COALESCE(MAX(priority),0)+10 AS value FROM milktv_channel_sources WHERE channel_id=$1', [decision.channel_id])).rows[0].value;
    const ingested = await options.ingestCandidate(db, row.id, { reservePriority: Number(priority) });
    summary.details.push({ candidate_id: row.id, channel_id: decision.channel_id, outcome: ingested.outcome, reason: ingested.reason, source_id: ingested.source_id || null });
    if (ingested.outcome === 'AUTO_ELIGIBLE' && ingested.source_id) { summary.reserves_ingested++; }
  }
  const stability = (await db.query(`SELECT channel_id,id,consecutive_successful_checks FROM milktv_channel_sources WHERE channel_id=ANY($1::int[]) AND id <> COALESCE((SELECT current_source_id FROM channels WHERE channels.id=milktv_channel_sources.channel_id),-1) AND enabled=TRUE`, [targets])).rows;
  summary.stability_results = stability.map(row => ({ channel_id: row.channel_id, source_id: row.id, consecutive_successful_checks: Number(row.consecutive_successful_checks || 0) }));
  summary.reserves_reaching_stability = stability.filter(row => Number(row.consecutive_successful_checks || 0) > 0 && Number(row.consecutive_successful_checks || 0) < 3).length;
  const covered = new Set(stability.filter(row => Number(row.consecutive_successful_checks || 0) >= 3).map(row => Number(row.channel_id)));
  summary.no_safe_reserve = targets.filter(id => !covered.has(id) && !safeChannels.has(id)).length;
  return summary;
}
async function runAutopilot(db, options = {}) {
  const dryRun = options.dryRun !== false;
  if (!dryRun && process.env.MILKTV_AUTOPILOT_ENABLED !== "true") throw new Error("autopilot_disabled");
  const maxSwitches = configuredMax(options.maxSwitches), probe = options.finalProbe, postProbe = options.postSwitchProbe || options.finalProbe, switchSource = options.switchSource;
  if (!dryRun && (typeof probe !== "function" || typeof postProbe !== "function" || typeof switchSource !== "function")) throw new Error("autopilot_dependencies_missing");
  const summary = { started_at: new Date().toISOString(), enabled: process.env.MILKTV_AUTOPILOT_ENABLED === "true", mode: "recovery_only", failed_channels_considered: 0, eligible_alternates: 0, final_probes: 0, switches_attempted: 0, switches_executed: 0, recovered_online: 0, switches_failed: 0, skipped_cooldown: 0, skipped_no_alternate: 0, max_switches_per_run: maxSwitches, dry_run: dryRun, mutations: 0, switches: [] }, results = [];
  for (const candidate of await readCandidates(db)) {
    summary.failed_channels_considered++; const decision = evaluateChannel(candidate); const item = { channel_id: candidate.channel.id, from_source_id: candidate.current?.id ?? null, decision: decision.decision, reason: decision.reason, would_switch_to: decision.would_switch_to ?? null, eligible_alternates: decision.eligible_alternates.map(source => ({ id: source.id, url_host: classifyUrl(source.url).host, promo_status: source.promo_status || "unknown", consecutive_successful_checks: source.consecutive_successful_checks })) };
    if (decision.decision === "NO_ALTERNATE") { summary.skipped_no_alternate++; results.push(item); continue; }
    if (decision.decision !== "WOULD_SWITCH") { results.push(item); continue; }
    summary.eligible_alternates += decision.eligible_alternates.length;
    if (await inCooldown(db, candidate.channel.id, candidate.current.id)) { summary.skipped_cooldown++; item.decision = "SKIP_COOLDOWN"; results.push(item); continue; }
    if (summary.switches_attempted >= maxSwitches) { item.decision = "DEFERRED_MAX_SWITCHES"; results.push(item); continue; }
    const alternate = decision.eligible_alternates[0]; item.to_source_id = alternate.id;
    if (dryRun) { results.push(item); continue; }
    summary.switches_attempted++;
    try { const final = await probe(alternate.url); summary.final_probes++; item.final_probe_result = final?.online && !final?.indeterminate ? 'ONLINE_CONFIRMED' : final?.indeterminate ? 'UNKNOWN' : 'OFFLINE'; if (item.final_probe_result !== 'ONLINE_CONFIRMED') throw new Error("final_live_probe_failed"); await switchSource({ channelId: candidate.channel.id, fromSourceId: candidate.current.id, toSourceId: alternate.id, reason: "autopilot_current_source_failed" }); summary.switches_executed++; summary.mutations++; const post = await postProbe(alternate.url); item.post_switch_health_result = post?.online && !post?.indeterminate ? 'ONLINE_CONFIRMED' : post?.indeterminate ? 'UNKNOWN' : 'OFFLINE'; if (item.post_switch_health_result === 'ONLINE_CONFIRMED') summary.recovered_online++; else throw new Error('post_switch_current_not_online'); summary.switches.push({ channel_id: candidate.channel.id, from_source_id: candidate.current.id, to_source_id: alternate.id, final_probe_result: item.final_probe_result, post_switch_health_result: item.post_switch_health_result, reason: "autopilot_current_source_failed" }); item.decision = "SWITCHED"; }
    catch (error) { summary.switches_failed++; item.decision = "SWITCH_FAILED"; item.error = String(error.message || error).slice(0, 160); }
    results.push(item);
  }
  return { ...summary, channels: results };
}
module.exports = { DEFAULT_MAX_SWITCHES, COOLDOWN_MS, classifyUrl, isConfirmedFailed, stableAlternates, evaluateChannel, configuredMax, inCooldown, runTargetedReserveAcquisition, runAutopilot };
