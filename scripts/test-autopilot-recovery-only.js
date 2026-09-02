const assert = require("assert");
const fs = require("fs");
const autopilot = require("../services/milktv-autopilot");
const ingestion = require("../services/milktv-source-ingestion");

// Keep fixtures aligned with the production source-selection policy: an
// alternate must have provenance and an explicitly acceptable trust level.
const current = { id: 10, enabled: true, status: "offline", failed_checks: 3, provenance_count: 1, trust_level: "trusted" };
const stable = { id: 11, enabled: true, status: "online", consecutive_successful_checks: 3, provenance_count: 1, trust_level: "trusted", url: "https://8.8.8.8/live.m3u8", priority: 20, promo_status: "unknown" };
const decide = (source, alternates, channel) => autopilot.evaluateChannel({ current: source, alternates, channel });
assert.equal(decide({ ...current, status: "online", failed_checks: 0 }, [stable], { milktv_status: "online", milktv_failed_checks: 0 }).decision, "IGNORE"); // B
assert.equal(decide({ ...current, failed_checks: 2 }, [stable], { milktv_status: "offline", milktv_failed_checks: 2 }).decision, "IGNORE"); // C
assert.equal(decide(current, [stable], { milktv_status: "offline", milktv_failed_checks: 3 }).decision, "WOULD_SWITCH"); // D
assert.equal(decide(current, [{ ...stable, consecutive_successful_checks: 2 }], { milktv_status: "offline", milktv_failed_checks: 3 }).decision, "NO_ALTERNATE"); // E
assert.equal(decide(current, [{ ...stable, url: "http://127.0.0.1/x" }, { ...stable, id: 317, url: "https://test.example.org/x" }], { milktv_status: "offline", milktv_failed_checks: 3 }).decision, "NO_ALTERNATE"); // F
assert.equal(decide(current, [{ ...stable, id: 317 }], { milktv_status: "offline", milktv_failed_checks: 3 }).decision, "NO_ALTERNATE"); // source 317 is never eligible
assert.equal(decide(current, [], { milktv_status: "offline", milktv_failed_checks: 3 }).decision, "NO_ALTERNATE"); // I: no alternate has no quarantine action in this service
assert.equal(decide(current, [{ ...stable, promo_status: "detected" }], { milktv_status: "offline", milktv_failed_checks: 3 }).decision, "WOULD_SWITCH"); // J
assert.equal(autopilot.configuredMax(9), 3); // G bound
assert.equal(autopilot.configuredMax(undefined), 3);
assert.equal(fs.readFileSync(require.resolve("../services/milktv-source-switch"), "utf8").includes("switchChannelSource"), true); // L
assert.equal(ingestion.classifyCandidate({ state: 'new', stream_url: 'http://127.0.0.1/x', health_status: 'online', suggested_channel_id: 1, match_confidence: 'high', has_provenance: true }).outcome, 'REJECTED'); // C/D safety
assert.equal(ingestion.classifyCandidate({ state: 'new', stream_url: 'https://8.8.8.8/x', health_status: 'online', suggested_channel_id: 1, match_confidence: 'possible', has_provenance: true }).outcome, 'REVIEW_REQUIRED'); // D
const recent = new Date().toISOString();
const cooldownDb = { query: async () => ({ rows: [{ to_source_id: 99, created_at: recent }] }) };
(async () => {
  assert.equal(await autopilot.inCooldown(cooldownDb, 1, 10), true); // H
  assert.equal(await autopilot.inCooldown(cooldownDb, 1, 99), false); // confirmed-failed new-current exception
  const previous = process.env.MILKTV_AUTOPILOT_ENABLED;
  process.env.MILKTV_AUTOPILOT_ENABLED = "false";
  await assert.rejects(() => autopilot.runAutopilot({}, { dryRun: false, finalProbe: async () => ({ online: true }), switchSource: async () => {} }), /autopilot_disabled/); // K flag
  process.env.MILKTV_AUTOPILOT_ENABLED = previous;
  console.log("autopilot recovery-only tests: PASS");
})().catch(error => { console.error(error); process.exitCode = 1; });
