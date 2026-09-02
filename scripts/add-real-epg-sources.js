const db = require('../database');
(async () => {
  for (const [name, url] of [['IPTV-EPG Russia','https://iptv-epg.org/files/epg-ru.xml'],['iptvX EPG','https://iptvx.one/EPG']]) {
    const q = await db.query('INSERT INTO milktv_epg_sources(name,url,type,enabled) SELECT $1,$2,\'xmltv\',FALSE WHERE NOT EXISTS (SELECT 1 FROM milktv_epg_sources WHERE url=$2) RETURNING id', [name, url]);
    console.log(q.rows.length ? `added ${name}` : `exists ${name}`);
  }
  await db.end();
})().catch(e => { console.error(e.message); process.exitCode = 1; });
