const DEFAULTS = Object.freeze({ batchLimit: 100, freshnessMs: 12 * 60 * 60 * 1000, cooldownMs: 6 * 60 * 60 * 1000, gap: 12, lockKey: 947777, stability: 3 });

async function evaluateChannel(db, channel, deps, config = DEFAULTS) {
  const rows = await db.query("SELECT id,url,quality_score,quality_confidence,measured_at,failed_checks,probe_status,consecutive_successful_checks FROM milktv_channel_sources WHERE channel_id=$1 AND enabled=TRUE ORDER BY quality_score DESC NULLS LAST,id", [channel.id]);
  const current = rows.rows.find(s => s.id === channel.current_source_id) || rows.rows.find(s => s.url === channel.url);
  const best = rows.rows[0];
  if (!current || !best || best.id === current.id) return { status: "skipped", reason: "keep_current" };
  const fresh = s => s.measured_at && Date.now() - new Date(s.measured_at).getTime() <= config.freshnessMs;
  if (!fresh(current) || !fresh(best)) return { status: "skipped", reason: "stale_quality" };
  if (best.probe_status !== "online" || Number(best.failed_checks || 0) > 0) return { status: "skipped", reason: "candidate_unhealthy" };
  if (best.quality_confidence !== "measured") return { status: "skipped", reason: "insufficient_confidence" };
  if (Number(best.consecutive_successful_checks || 0) < config.stability) return { status: "skipped", reason: "insufficient_stability" };
  if (Number(best.quality_score) - Number(current.quality_score) < config.gap) return { status: "skipped", reason: "small_score_gap" };
  const recent = await db.query("SELECT 1 FROM milktv_source_switch_history WHERE channel_id=$1 AND automatic=TRUE AND reason='quality_upgrade' AND created_at>NOW()-INTERVAL '6 hours' LIMIT 1", [channel.id]);
  if (recent.rows.length) return { status: "cooldown", reason: "cooldown" };
  try { await deps.switchSource(channel.id, best.id, "quality_upgrade", true); return { status: "switched", from: current.id, to: best.id }; }
  catch (error) { return { status: "error", reason: error.message }; }
}

async function runCycle(db, deps, options = {}) {
  const config = { ...DEFAULTS, ...(options || {}) };
  const lockClient = await db.connect();
  const summary = { evaluated: 0, considered: 0, switched: 0, skipped: 0, cooldown: 0, insufficient_data: 0, errors: 0 };
  try {
    const lock = await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [config.lockKey]);
    if (!lock.rows[0].locked) return { skipped: true, ...summary };
    try {
      const channels = await lockClient.query("SELECT id,url,current_source_id FROM channels WHERE (SELECT COUNT(*) FROM milktv_channel_sources s WHERE s.channel_id=channels.id AND s.enabled)=2 ORDER BY id LIMIT $1", [config.batchLimit]);
      for (const channel of channels.rows) {
        summary.evaluated++;
        try { const result = await evaluateChannel(db, channel, deps, config); if (result.status === "switched") summary.switched++; else if (result.status === "cooldown") summary.cooldown++; else if (result.status === "error") summary.errors++; else { summary.skipped++; if (result.reason === "insufficient_stability" || result.reason === "stale_quality" || result.reason === "insufficient_confidence") summary.insufficient_data++; } } catch (error) { summary.errors++; }
      }
      return { skipped: false, ...summary };
    } finally { await lockClient.query("SELECT pg_advisory_unlock($1)", [config.lockKey]).catch(() => {}); }
  } finally { lockClient.release(); }
}

module.exports = { DEFAULTS, evaluateChannel, runCycle };
