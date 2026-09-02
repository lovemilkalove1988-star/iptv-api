const fs = require('fs');
const db = require('../database');

async function count(table) {
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return result.rows[0].count;
}

(async () => {
  try {
    const snapshot = {
      created_at: new Date().toISOString(),
      counts: {
        channels: await count('channels'),
        sources: await count('milktv_channel_sources'),
        m3u_providers: await count('milktv_m3u_providers'),
        m3u_candidates: await count('milktv_m3u_candidates'),
        candidate_provenance: await count('milktv_m3u_candidate_providers'),
        discovery_sources: await count('milktv_discovery_sources'),
        discovery_results: await count('milktv_discovery_results'),
        ingestion_audit: await count('milktv_source_ingestion_audit')
      },
      providers: (await db.query('SELECT id,name,url,enabled,last_import,import_status,import_error,last_import_diagnostic FROM milktv_m3u_providers ORDER BY id')).rows,
      discovery: (await db.query('SELECT * FROM milktv_discovery_sources ORDER BY id')).rows
    };
    fs.writeFileSync('milktv-candidate-pilot-before-20260831.json', JSON.stringify(snapshot, null, 2));
    console.log('SNAPSHOT_WRITTEN milktv-candidate-pilot-before-20260831.json');
    console.log(JSON.stringify(snapshot.counts));
  } catch (error) {
    console.error(`SNAPSHOT_FAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
