const db = require('../database');
const discovery = require('../services/milktv-discovery');
const epg = require('../services/milktv-epg');
const matcher = require('../services/milktv-epg-matcher');

async function fetchSafe(url) {
  const safe = await discovery.safeUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const started = Date.now();
  try {
    const response = await fetch(safe, { redirect: 'error', signal: controller.signal });
    const chunks = []; let bytes = 0;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.body) { const reader = response.body.getReader(); for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 10 * 1024 * 1024) { await reader.cancel().catch(() => {}); throw new Error('XMLTV too large'); } chunks.push(Buffer.from(part.value)); } }
    else { const text = await response.text(); bytes = Buffer.byteLength(text); chunks.push(Buffer.from(text)); }
    return { status: response.status, bytes, duration_ms: Date.now() - started, text: Buffer.concat(chunks, bytes).toString('utf8') };
  } finally { clearTimeout(timer); }
}

(async () => {
  const channels = (await db.query('SELECT id,name FROM channels ORDER BY id')).rows;
  for (const [name, url] of [['IPTV-EPG Russia','https://iptv-epg.org/files/epg-ru.xml'],['iptvX EPG','https://iptvx.one/EPG']]) {
    try {
      const fetched = await fetchSafe(url); const parsed = epg.parseXmltv(fetched.text);
      const stats = { provider: name, url, fetch: { status: fetched.status, bytes: fetched.bytes, duration_ms: fetched.duration_ms }, channels: parsed.channels.length, programmes: parsed.programmes.length, invalid: parsed.invalid, exact: 0, ambiguous: 0, unmatched: 0, matched_examples: [], unmatched_examples: [] };
      for (const e of parsed.channels) { const m = matcher.matchEpgChannel(e, channels); if (m.confidence === 'high') { stats.exact++; if (stats.matched_examples.length < 20) stats.matched_examples.push({ epg_id: e.id, name: e.displayName, channel_id: m.channelId }); } else if (m.confidence === 'ambiguous') { stats.ambiguous++; if (stats.unmatched_examples.length < 20) stats.unmatched_examples.push({ epg_id: e.id, name: e.displayName, status: 'ambiguous' }); } else { stats.unmatched++; if (stats.unmatched_examples.length < 20) stats.unmatched_examples.push({ epg_id: e.id, name: e.displayName, status: 'unmatched' }); } }
      const dates = parsed.programmes.flatMap(p => [p.start, p.stop]).sort((a,b) => a-b); stats.earliest = dates[0] || null; stats.latest = dates.at(-1) || null; console.log(JSON.stringify(stats, null, 2));
    } catch (error) { console.log(JSON.stringify({ provider: name, url, error: String(error.message), cause: error.cause ? String(error.cause.code || error.cause.message || error.cause) : null }, null, 2)); }
  }
  await db.end();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
