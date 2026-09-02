const dns = require("dns").promises;
const net = require("net");
const crypto = require("crypto");

const DEFAULT_LIMITS = Object.freeze({ maxSources: 8, maxDocuments: 8, maxNewUrls: 100, maxBytes: 2 * 1024 * 1024, timeoutMs: 15000, cycleMs: 60000 });
let cycleRunning = false;

function blockedAddress(value) {
  const host = String(value || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true;
  const version = net.isIP(host);
  if (version === 4) { const p = host.split(".").map(Number); return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168); }
  return version === 6 && (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"));
}

async function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error("Некорректный discovery URL"); }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new Error("Discovery URL должен быть HTTP/HTTPS без credentials");
  if (blockedAddress(u.hostname)) throw new Error("Discovery URL указывает во внутреннюю сеть");
  const addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => blockedAddress(a.address))) throw new Error("Discovery URL заблокирован сетевой политикой");
  return u.toString();
}

async function fetchDocument(url, limits, redirectHops = 0) {
  const safe = await safeUrl(url);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const response = await fetch(safe, { redirect: "manual", signal: controller.signal });
    if ([301,302,303,307,308].includes(response.status)) {
      if (redirectHops >= 3) throw new Error("Превышен лимит редиректов discovery");
      const location = response.headers.get("location"); if (!location) throw new Error("Редирект без Location");
      return await fetchDocument(new URL(location, safe).toString(), limits, redirectHops + 1);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0); if (length > limits.maxBytes) throw new Error("Документ превышает лимит размера");
    const reader = response.body?.getReader(); const chunks = []; let bytes = 0;
    if (reader) { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limits.maxBytes) { await reader.cancel(); throw new Error("Документ превышает лимит размера"); } chunks.push(Buffer.from(part.value)); } }
    else { const text = await response.text(); bytes = Buffer.byteLength(text); if (bytes > limits.maxBytes) throw new Error("Документ превышает лимит размера"); return { text, bytes, status: response.status, contentType: response.headers.get("content-type") || "", finalUrl: safe }; }
    return { text: Buffer.concat(chunks).toString("utf8"), bytes, status: response.status, contentType: response.headers.get("content-type") || "", finalUrl: safe };
  } finally { clearTimeout(timer); }
}

function extractUrls(text, origin, max) {
  const found = new Map();
  for (const match of String(text || "").matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    let value = match[0].replace(/[),.;]+$/, "");
    try { value = new URL(value, origin).toString(); } catch { continue; }
    const lower = value.toLowerCase();
    const type = /\.(m3u8?|m3u)(?:[?#]|$)/.test(lower) ? "m3u" : (/\.(ts|mp4|aac|mp3)(?:[?#]|$)|\/stream(?:[/?#]|$)/.test(lower) ? "stream" : null);
    if (type && !found.has(value)) found.set(value, type);
    if (found.size >= max) break;
  }
  return [...found].map(([url, type]) => ({ url, type }));
}

function manifestKind(text, contentType = "") {
  const body = String(text || "").trim(); const ct = String(contentType || "").toLowerCase();
  if (ct.includes("mpegurl") || /^#EXTM3U(?:\s|$)/i.test(body) || body.includes("#EXT-X-")) return "hls";
  if (ct.includes("dash+xml") || /<MPD(?:\s|>)/i.test(body)) return "dash";
  return null;
}
function isTemporaryUrl(raw) { try { const u = new URL(String(raw)); return ["token","access_token","sig","signature","expires","exp","x-amz-signature","x-amz-expires"].some(k => u.searchParams.has(k)); } catch { return false; } }
function looksLikeConfigUrl(value) { const l = String(value || "").toLowerCase(); return /\.(json|config)(?:[?#]|$)/.test(l) || /\/(?:api|config|configuration|bootstrap|player|live|manifest|stream)(?:[/?#]|$)/.test(l); }
function extractConfigReferences(text, origin, max = 8) {
  const found = new Set(); const add = raw => { try { const u = new URL(String(raw), origin); if (["http:","https:"].includes(u.protocol) && looksLikeConfigUrl(u)) found.add(u.toString()); } catch {} };
  for (const m of String(text || "").matchAll(/https?:\/\/[^\s"'<>]+/gi)) add(m[0].replace(/[),.;]+$/, ""));
  for (const m of String(text || "").matchAll(/(?:config|playerConfig|manifest|streamUrl|source|src)[\"'\s:=]+[\"']([^\"']+)[\"']/gi)) add(m[1]);
  return [...found].slice(0, max);
}
function extractManifestReferences(text, origin, max = 100) {
  const found = new Set(); const add = raw => { try { const u = new URL(String(raw), origin); if (["http:","https:"].includes(u.protocol)) found.add(u.toString().replace(/[),.;]+$/, "")); } catch {} };
  for (const m of String(text || "").matchAll(/https?:\/\/[^\s"'<>]+/gi)) add(m[0]);
  return [...found].slice(0, max);
}
async function validateManifest(url, limits) { try { const doc = await fetchDocument(url, { ...limits, maxBytes: Math.min(limits.maxBytes, 512 * 1024) }); const kind = manifestKind(doc.text, doc.contentType); return kind ? { ...doc, url: doc.finalUrl || url, kind, temporary: isTemporaryUrl(doc.finalUrl || url) } : null; } catch { return null; } }
async function discoverOfficialManifests(pageUrl, html, limits) {
  const configDocs = []; const manifests = [];
  for (const ref of extractConfigReferences(html, pageUrl, 8)) { try { const doc = await fetchDocument(ref, limits); const ct = String(doc.contentType || "").toLowerCase(); if (!(ct.includes("json") || /^[\[{]/.test(String(doc.text || "").trim()))) continue; configDocs.push(ref); for (const candidate of extractManifestReferences(doc.text, doc.finalUrl || ref, limits.maxNewUrls)) { const checked = await validateManifest(candidate, limits); if (checked) manifests.push({ url: checked.url, type: "stream", manifest_kind: checked.kind, temporary: checked.temporary, config_url: ref }); } } catch {} }
  return { configDocs, manifests };
}

function lockKey(id) { return 930000 + Number(id); }

async function runSource(db, source, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }; const dryRun = options.dryRun === true; const client = await db.connect();
  const started = Date.now(); const stats = { source_id: source.id, name: source.name, found: 0, new: 0, existing: 0, unsafe: 0, errors: 0, dry_run: dryRun, results: [], classifications: {} };
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey(source.id)]); if (!lock.rows[0].locked) return { ...stats, skipped: true };
    try {
      const configured = source.configuration?.url;
      const directPlaylist = /\.(m3u8?|m3u)(?:[?#]|$)/i.test(String(configured || ""));
      const doc = directPlaylist ? { text: "", bytes: 0, status: 200, finalUrl: configured } : await fetchDocument(configured, limits);
      let urls = directPlaylist ? [{ url: configured, type: "m3u" }] : extractUrls(doc.text, configured, limits.maxNewUrls);
      let configStats = { configDocs: [], manifests: [] };
      if (source.type === "official_broadcaster" && !directPlaylist) {
        configStats = await discoverOfficialManifests(configured, doc.text, limits);
        urls = urls.filter(item => /\.(?:m3u8?|mpd)(?:[?#]|$)/i.test(item.url)).concat(configStats.manifests);
      }
      const filteredUrls = source.type === "official_broadcaster" ? urls.filter(item => item.type === "m3u" || item.manifest_kind) : urls;
      stats.found = filteredUrls.length;
      stats.config_documents = configStats.configDocs.length;
      stats.manifests = filteredUrls.filter(item => item.manifest_kind || item.type === "m3u").length;
      const seenInRun = new Set();
      if (!dryRun) await client.query("BEGIN");
      for (const item of filteredUrls) {
        let canonical; try { canonical = await safeUrl(item.url); } catch (e) { stats.unsafe++; stats.results.push({ ...item, status: "unsafe", error: e.message }); continue; }
        const temporary = Boolean(item.temporary || isTemporaryUrl(canonical));
        const classification = temporary ? "VERIFIED_TEMPORARY" : "VERIFIED_STATIC";
        stats.classifications[classification] = (stats.classifications[classification] || 0) + 1;
        let resultId; let isNew = false;
        if (!dryRun) {
          const prior = await client.query("SELECT id FROM milktv_discovery_results WHERE url=$1", [canonical]); isNew = !prior.rows.length;
          const result = await client.query(`INSERT INTO milktv_discovery_results(source_id,url,origin_url,result_type,status,last_seen) VALUES($1,$2,$3,$4,'seen',NOW()) ON CONFLICT(url) DO UPDATE SET origin_url=EXCLUDED.origin_url,result_type=EXCLUDED.result_type,last_seen=NOW(),status='seen' RETURNING id`, [source.id, canonical, configured, item.type]);
          resultId = result.rows[0].id;
          await client.query(`INSERT INTO milktv_discovery_result_sources(result_id,source_id) VALUES($1,$2) ON CONFLICT(result_id,source_id) DO UPDATE SET last_seen=NOW()`, [resultId, source.id]);
          if (temporary && source.type === "official_broadcaster") {
            await client.query("UPDATE milktv_discovery_results SET classification=$1,temporary=TRUE,config_url=$2,manifest_observed_at=NOW() WHERE id=$3", [classification, item.config_url || configured, resultId]);
          } else if (item.type === "m3u") {
            const providerName = `Discovery: ${source.name} ${crypto.createHash("sha1").update(canonical).digest("hex").slice(0,8)}`;
            const provider = await client.query(`INSERT INTO milktv_m3u_providers(name,url,enabled) VALUES($1,$2,FALSE) ON CONFLICT(url) DO UPDATE SET updated_at=NOW() RETURNING id`, [providerName, canonical]);
            await client.query("UPDATE milktv_discovery_results SET provider_id=$1 WHERE id=$2", [provider.rows[0].id, resultId]);
          } else {
            const officialChannelId = source.type === "official_broadcaster" && Number.isInteger(Number(source.configuration?.channel_id)) ? Number(source.configuration.channel_id) : null;
            let officialProviderId = null;
            if (officialChannelId) {
              const provider = await client.query(`INSERT INTO milktv_m3u_providers(name,url,enabled) VALUES($1,$2,FALSE) ON CONFLICT(url) DO UPDATE SET updated_at=NOW() RETURNING id`, [`Official: ${source.name}`, configured]);
              officialProviderId = provider.rows[0].id;
            }
            const candidate = await client.query(`INSERT INTO milktv_m3u_candidates(stream_url,name,suggested_channel_id,match_confidence,match_method,last_seen,updated_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW()) ON CONFLICT(stream_url) DO UPDATE SET suggested_channel_id=COALESCE(milktv_m3u_candidates.suggested_channel_id,EXCLUDED.suggested_channel_id),match_confidence=CASE WHEN EXCLUDED.match_confidence='high' THEN EXCLUDED.match_confidence ELSE milktv_m3u_candidates.match_confidence END,match_method=CASE WHEN EXCLUDED.match_method='official' THEN EXCLUDED.match_method ELSE milktv_m3u_candidates.match_method END,last_seen=NOW(),updated_at=NOW() RETURNING id`, [canonical, canonical, officialChannelId, officialChannelId ? 'high' : 'no-match', officialChannelId ? 'official' : 'unmatched']);
            await client.query("UPDATE milktv_discovery_results SET candidate_id=$1 WHERE id=$2", [candidate.rows[0].id, resultId]);
            if (officialProviderId) await client.query("INSERT INTO milktv_m3u_candidate_providers(candidate_id,provider_id,active,last_seen) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(candidate_id,provider_id) DO UPDATE SET active=TRUE,last_seen=NOW()", [candidate.rows[0].id, officialProviderId]);
          }
        } else {
          isNew = !seenInRun.has(canonical); seenInRun.add(canonical);
        }
        stats[isNew ? "new" : "existing"]++; stats.results.push({ ...item, url: temporary ? "[temporary-manifest-not-persisted]" : canonical, status: isNew ? "new" : "existing", result_id: resultId, classification });
      }
      if (!dryRun && source.type === "official_broadcaster" && configStats.manifests.length) {
        const refresh = { ...(source.configuration || {}), official_refresh: { last_manifest_at: new Date().toISOString(), temporary: configStats.manifests.some(x => x.temporary), config_url: configStats.manifests.find(x => x.config_url)?.config_url || null, classification: configStats.manifests.some(x => x.temporary) ? "VERIFIED_TEMPORARY" : "VERIFIED_STATIC" } };
        await client.query("UPDATE milktv_discovery_sources SET configuration=$1 WHERE id=$2", [refresh, source.id]);
      }
      if (!dryRun) { await client.query("UPDATE milktv_discovery_sources SET last_run=NOW(),status='ok',error=NULL,updated_at=NOW() WHERE id=$1", [source.id]); await client.query("COMMIT"); }
      if (source.type === "official_broadcaster" && !stats.found) { const key = stats.config_documents ? "NO_MANIFEST" : "NO_CONFIG"; stats.classifications[key] = (stats.classifications[key] || 0) + 1; }
      stats.duration_ms = Date.now() - started; return stats;
    } finally { await client.query("SELECT pg_advisory_unlock($1)", [lockKey(source.id)]); }
  } catch (error) { try { await client.query("ROLLBACK"); } catch {} stats.errors++; stats.classification = "HTTP_ERROR"; stats.classifications.HTTP_ERROR = (stats.classifications.HTTP_ERROR || 0) + 1; stats.error = String(error.message || "Discovery error").slice(0, 500); if (!options.dryRun) await db.query("UPDATE milktv_discovery_sources SET last_run=NOW(),status='error',error=$2,updated_at=NOW() WHERE id=$1", [source.id, stats.error]).catch(() => {}); return stats; }
  finally { client.release(); }
}

async function runCycle(db, options = {}) {
  if (cycleRunning) return { skipped: true, sources: [] }; cycleRunning = true;
  const global = await db.connect(); const lock = await global.query("SELECT pg_try_advisory_lock($1) AS locked", [929999]);
  if (!lock.rows[0].locked) { global.release(); cycleRunning = false; return { skipped: true, sources: [] }; }
  try { const rows = await db.query("SELECT id,type,name,enabled,configuration FROM milktv_discovery_sources WHERE enabled=TRUE AND type IN ('index','github','public_index','official_broadcaster') ORDER BY id LIMIT 8"); const sources = []; for (const source of rows.rows) sources.push(await runSource(db, source, options)); return { skipped: false, sources }; }
  finally { await global.query("SELECT pg_advisory_unlock($1)", [929999]).catch(() => {}); global.release(); cycleRunning = false; }
}

module.exports = { DEFAULT_LIMITS, safeUrl, fetchDocument, extractUrls, extractConfigReferences, manifestKind, isTemporaryUrl, validateManifest, runSource, runCycle, get running() { return cycleRunning; } };
