const db = require('../database');
const { calculateProviderReputation } = require('../services/milktv-provider-reputation');
(async () => {
  const ready = await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='milktv_channel_sources' AND column_name='trust_level'");
  const trustJoin = ready.rows.length ? "LEFT JOIN milktv_channel_sources s ON s.id=sp.source_id" : "LEFT JOIN milktv_channel_sources s ON FALSE";
  const trustedExpr = ready.rows.length ? "COUNT(DISTINCT sp.source_id) FILTER (WHERE s.trust_level='trusted')::int" : "0::int";
  const unstableExpr = ready.rows.length ? "COUNT(DISTINCT sp.source_id) FILTER (WHERE s.trust_level='unstable')::int" : "0::int";
  const result = await db.query(`
    SELECT p.id, p.name,
      COUNT(DISTINCT c.id)::int AS candidate_count,
      COUNT(DISTINCT c.id) FILTER (WHERE c.health_status='online')::int AS online_count,
      COUNT(DISTINCT c.id) FILTER (WHERE c.state='accepted')::int AS accepted_count,
      COUNT(DISTINCT sp.source_id)::int AS real_source_count,
      ${trustedExpr} AS trusted_count,
      ${unstableExpr} AS unstable_count
    FROM milktv_m3u_providers p
    LEFT JOIN milktv_m3u_candidate_providers cp ON cp.provider_id=p.id
    LEFT JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
    LEFT JOIN milktv_channel_source_provenance sp ON sp.m3u_provider_id=p.id
    ${trustJoin}
    GROUP BY p.id ORDER BY p.id
  `);
  for (const row of result.rows) { const r = calculateProviderReputation(row); console.log(`${row.name}\treal sources=${row.real_source_count}\ttrusted=${row.trusted_count}\tunstable=${row.unstable_count}\tcandidates=${row.candidate_count}\tscore=${r.score}\t${r.level}`); }
  await db.end();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
