const { fetchDocument, safeUrl } = require('./milktv-discovery');

function parseM3u(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      const attrs = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      meta = { name: comma >= 0 ? line.slice(comma + 1).trim() : '', tvgId: attrs['tvg-id'] || null, tvgName: attrs['tvg-name'] || null, logo: attrs['tvg-logo'] || null, groupTitle: attrs['group-title'] || null };
    } else if (!line.startsWith('#') && meta) {
      entries.push({ streamUrl: line, ...meta }); meta = null;
    }
  }
  return entries;
}

function normalizeName(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[\[\](){}.,!?_:;|/\\-]+/g, ' ').replace(/\s+/g, ' ').trim(); }

async function healthCheckCandidate(db, candidate, channels, options = {}) {
  const started = Date.now(); let online = false; let error = null;
  try {
    const url = await safeUrl(candidate.stream_url);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
    try { const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1023' }, redirect: 'error', signal: controller.signal }); online = response.ok; if (!online) error = `HTTP ${response.status}`; await response.body?.cancel(); }
    finally { clearTimeout(timer); }
  } catch (e) { error = e.name === 'AbortError' ? 'timeout' : String(e.message || e); }
  const names = [candidate.name, candidate.tvg_name].map(normalizeName).filter(Boolean);
  const matches = channels.filter(c => names.includes(normalizeName(c.name)));
  const match = matches.length === 1 ? { id: matches[0].id, confidence: 'high' } : matches.length > 1 ? { id: null, confidence: 'possible' } : { id: null, confidence: 'no-match' };
  await db.query(`UPDATE milktv_m3u_candidates SET health_status=$1,failed_checks=$2,response_time=$3,last_check=NOW(),health_error=$4,suggested_channel_id=$5,match_confidence=$6,updated_at=NOW() WHERE id=$7`, [online ? 'online' : 'offline', online ? 0 : Number(candidate.failed_checks || 0) + 1, Date.now() - started, error, match.id, match.confidence, candidate.id]);
  return { candidate_id: candidate.id, online, response_time: Date.now() - started, error, match };
}

async function healthCheckBatch(db, candidates, options = {}) {
  const channels = (await db.query('SELECT id,name FROM channels ORDER BY id')).rows;
  const results = []; let cursor = 0; const workers = Math.min(options.concurrency || 4, candidates.length || 1);
  async function worker() { while (cursor < candidates.length) { const candidate = candidates[cursor++]; try { results.push(await healthCheckCandidate(db, candidate, channels, options)); } catch (e) { results.push({ candidate_id: candidate.id, online: false, error: String(e.message || e) }); } } }
  await Promise.all(Array.from({ length: workers }, worker)); return results;
}

async function stageProvider(db, provider, options = {}) {
  const doc = await fetchDocument(provider.url, { maxBytes: options.maxBytes || 50 * 1024 * 1024, timeoutMs: options.timeoutMs || 30000 });
  const entries = parseM3u(doc.text);
  const client = await db.connect();
  let inserted = 0, existing = 0;
  try {
    await client.query('BEGIN');
    const seen = new Set();
    for (const entry of entries) {
      let url; try { url = await safeUrl(entry.streamUrl); } catch { continue; }
      seen.add(url);
      const prior = await client.query('SELECT id FROM milktv_m3u_candidates WHERE stream_url=$1', [url]);
      const c = await client.query(`INSERT INTO milktv_m3u_candidates(stream_url,name,tvg_id,tvg_name,logo,group_title,last_seen,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW()) ON CONFLICT(stream_url) DO UPDATE SET name=EXCLUDED.name,tvg_id=COALESCE(EXCLUDED.tvg_id,milktv_m3u_candidates.tvg_id),tvg_name=COALESCE(EXCLUDED.tvg_name,milktv_m3u_candidates.tvg_name),logo=COALESCE(EXCLUDED.logo,milktv_m3u_candidates.logo),group_title=COALESCE(EXCLUDED.group_title,milktv_m3u_candidates.group_title),last_seen=NOW(),updated_at=NOW() RETURNING id`, [url, entry.name || url, entry.tvgId, entry.tvgName, entry.logo, entry.groupTitle]);
      await client.query(`INSERT INTO milktv_m3u_candidate_providers(candidate_id,provider_id,active,last_seen) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(candidate_id,provider_id) DO UPDATE SET active=TRUE,last_seen=NOW()`, [c.rows[0].id, provider.id]);
      prior.rows.length ? existing++ : inserted++;
    }
    await client.query(`UPDATE milktv_m3u_candidate_providers SET active=FALSE WHERE provider_id=$1 AND active=TRUE AND candidate_id IN (SELECT candidate_id FROM milktv_m3u_candidate_providers WHERE provider_id=$1) AND candidate_id NOT IN (SELECT c.id FROM milktv_m3u_candidates c WHERE c.stream_url = ANY($2::text[]))`, [provider.id, [...seen]]);
    await client.query(`UPDATE milktv_m3u_providers SET last_import=NOW(),import_status='ok',import_error=NULL,last_import_diagnostic=$2::jsonb,updated_at=NOW() WHERE id=$1`, [provider.id, JSON.stringify({ provider_id: provider.id, downloaded_bytes: doc.bytes, parsed_entries: entries.length, new_candidates: inserted, existing_candidates: existing, import_status: 'ok' })]);
    await client.query('COMMIT');
    return { fetched: true, bytes: doc.bytes, parsed: entries.length, inserted, existing };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}

module.exports = { parseM3u, stageProvider, healthCheckBatch };
