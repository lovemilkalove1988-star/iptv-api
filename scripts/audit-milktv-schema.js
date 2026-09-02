const db = require("../database");

const requirements = {
  QUARANTINE: { tables: ["channels"], columns: [["channels", "milktv_status"], ["channels", "milktv_failed_checks"]] },
  SLOTS: { tables: ["milktv_channel_slots"] },
  REPLACEMENT: { tables: ["milktv_replacement_pool"] },
  MULTI_SOURCE: { tables: ["milktv_channel_sources"], columns: [["milktv_channel_sources", "url"], ["milktv_channel_sources", "enabled"]] },
  M3U: { tables: ["milktv_m3u_providers", "milktv_m3u_candidates", "milktv_m3u_candidate_providers"] },
  DISCOVERY: { tables: ["milktv_discovery_sources", "milktv_discovery_results", "milktv_discovery_result_sources"] },
  QUALITY: { columns: [["milktv_channel_sources", "video_width"], ["milktv_channel_sources", "quality_score"], ["milktv_channel_sources", "probe_status"]] },
  SOURCE_SWITCHING: { tables: ["milktv_source_switch_history"], columns: [["channels", "current_source_id"]] },
  SOURCE_STABILITY: { columns: [["milktv_channel_sources", "successful_checks"], ["milktv_channel_sources", "consecutive_successful_checks"], ["milktv_channel_sources", "last_success_at"]] },
  SOURCE_TRUST: { columns: [["milktv_channel_sources", "trust_score"], ["milktv_channel_sources", "trust_level"], ["milktv_channel_sources", "trust_updated_at"]] }
};

async function main() {
  const tables = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  const columns = await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'");
  const tableSet = new Set(tables.rows.map(r => r.table_name));
  const columnSet = new Set(columns.rows.map(r => `${r.table_name}.${r.column_name}`));
  console.log("MILK TV schema audit");
  for (const [name, need] of Object.entries(requirements)) {
    const missing = [...(need.tables || []).filter(t => !tableSet.has(t)), ...(need.columns || []).filter(([t, c]) => !columnSet.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`)];
    console.log(`${name.padEnd(18)} ${missing.length ? "MISSING" : "OK"}${missing.length ? `: ${missing.join(", ")}` : ""}`);
  }
  if (process.argv.includes("--verify-trust-write")) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const source = (await client.query("SELECT id FROM milktv_channel_sources ORDER BY id LIMIT 1 FOR UPDATE")).rows[0];
      if (!source) throw new Error("No source exists for trust compatibility test");
      await client.query("UPDATE milktv_channel_sources SET trust_score=trust_score,trust_level=trust_level,trust_updated_at=trust_updated_at WHERE id=$1", [source.id]);
      await client.query("ROLLBACK");
      console.log("SOURCE_TRUST_WRITE  OK (rolled back; DB mutations = 0)");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  await db.end();
}
main().catch(error => { console.error(`DB audit/apply NOT EXECUTED: ${error.message}`); process.exitCode = 2; });
