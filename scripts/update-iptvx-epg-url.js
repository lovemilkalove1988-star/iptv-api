const db = require('../database');
(async () => {
  const target = 'https://iptvx.one/epg/epg.xml.gz';
  const old = 'https://iptvx.one/EPG';
  const dup = await db.query('SELECT COUNT(*)::int AS n FROM milktv_epg_sources WHERE url=$1', [target]);
  if (dup.rows[0].n > 0) throw new Error('Target URL already exists; refusing duplicate/merge');
  await db.query('BEGIN');
  try {
    const q = await db.query("UPDATE milktv_epg_sources SET url=$1,enabled=FALSE,updated_at=NOW() WHERE (name=$2 OR url=$3) AND name='iptvX EPG' RETURNING id,name,url,enabled", [target, 'iptvX EPG', old]);
    if (!q.rows.length) throw new Error('iptvX EPG source not found');
    await db.query('COMMIT');
    console.log(q.rows[0]);
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  await db.end();
})().catch(e => { console.error(e.message); process.exitCode = 1; });
