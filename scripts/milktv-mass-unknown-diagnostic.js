/* Read-only Windows diagnostic: SELECTs only; never imports server.js or calls a scheduler. */
require("dotenv").config();

const path = require("path");
const { spawn } = require("child_process");
const db = require("../database");

const ffprobePath = process.env.MILKTV_FFPROBE_PATH || path.join(__dirname, "..", "tools", "ffmpeg", "ffmpeg-9.0.1-essentials_build", "ffmpeg-9.0.1-essentials_build", "bin", "ffprobe.exe");
const ffmpegPath = process.env.MILKTV_FFMPEG_PATH || path.join(__dirname, "..", "tools", "ffmpeg", "ffmpeg-9.0.1-essentials_build", "ffmpeg-9.0.1-essentials_build", "bin", "ffmpeg.exe");
const requestedChannelIds = [...new Set(String(process.env.MILKTV_DIAGNOSTIC_CHANNEL_IDS || "").split(",").map(Number).filter(id => Number.isInteger(id) && id > 0))];

function terminateChild(child) {
  try { child.kill(); } catch (_) {}
  if (process.platform !== "win32" || !child?.pid) return Promise.resolve();
  return new Promise(resolve => {
    const fallback = setTimeout(resolve, 3000);
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const finish = () => { clearTimeout(fallback); resolve(); };
      killer.once("error", finish);
      killer.once("close", finish);
    } catch (_) { clearTimeout(fallback); resolve(); }
  });
}

function mediaTool(file, args, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true });
    let stderr = "", settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateChild(child).finally(() => resolve({ available: true, ok: false, reason: "timeout" }));
    }, timeoutMs);
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => finish({ available: false, ok: false, reason: error.code || error.message }));
    child.on("close", code => finish({ available: true, ok: code === 0, reason: code === 0 ? null : stderr.trim().slice(-240) }));
  });
}

async function httpProbe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } });
    response.body?.cancel();
    return { ok: response.ok, status: response.status, response_ms: Date.now() - started, error: null };
  } catch (error) {
    return { ok: false, status: null, response_ms: Date.now() - started, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally { clearTimeout(timer); }
}

// Exact production decision logic from server.js probeMilktvSource, isolated from DB writes.
async function canonicalProbeDryRun(url) {
  const http = await httpProbe(url);
  let ffprobe = { available: false, ok: false, reason: null };
  let ffmpeg = { available: false, ok: false, reason: null };
  if (!http.ok) {
    ffprobe = await mediaTool(ffprobePath, ["-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0", "-i", url, "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"], 10000);
    if (!ffprobe.ok) ffmpeg = await mediaTool(ffmpegPath, ["-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0", "-i", url, "-t", "3", "-f", "null", "-"], 12000);
  }
  const strongMediaProof = ffprobe.ok || ffmpeg.ok;
  const definitiveFailure = [401, 403, 404, 410, 500, 502, 503, 504].includes(http.status);
  return {
    http, ffprobe, ffmpeg,
    classification: http.ok || strongMediaProof ? "ONLINE_CONFIRMED" : definitiveFailure ? "OFFLINE_CONFIRMED" : "UNKNOWN"
  };
}

async function standaloneProbe(url) {
  const http = await httpProbe(url);
  const ffprobe = await mediaTool(ffprobePath, ["-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0", "-i", url, "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"], 10000);
  const ffmpeg = ffprobe.ok ? { available: true, ok: true, reason: "not_needed" } : await mediaTool(ffmpegPath, ["-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0", "-i", url, "-t", "3", "-f", "null", "-"], 12000);
  const strongMediaProof = ffprobe.ok || ffmpeg.ok;
  const definitiveFailure = [401, 403, 404, 410, 500, 502, 503, 504].includes(http.status);
  return { http, ffprobe, ffmpeg, classification: http.ok || strongMediaProof ? "ONLINE_CONFIRMED" : definitiveFailure ? "OFFLINE_CONFIRMED" : "UNKNOWN" };
}

(async () => {
  const origin = await db.query(`
    SELECT milktv_status, COUNT(*)::int AS count,
           MIN(milktv_last_check) AS oldest_last_check, MAX(milktv_last_check) AS newest_last_check,
           MIN(milktv_check_error) AS sample_error, MAX(milktv_check_error) AS max_error
    FROM channels GROUP BY milktv_status ORDER BY milktv_status
  `);
  const timeline = await db.query(`
    SELECT date_trunc('minute', milktv_last_check) AS minute, milktv_check_error, COUNT(*)::int AS count
    FROM channels WHERE milktv_status='unknown'
    GROUP BY 1,2 ORDER BY minute DESC NULLS LAST, count DESC LIMIT 30
  `);
  const samples = await db.query(`
    WITH chosen AS (
      SELECT c.id,c.name,c.url,c.milktv_status,c.milktv_last_check,c.milktv_check_error,
             CASE WHEN c.url ~* '\\.mpd($|[?])' THEN 'dash' ELSE 'standard' END AS kind,
             ROW_NUMBER() OVER (PARTITION BY CASE WHEN c.url ~* '\\.mpd($|[?])' THEN 'dash' ELSE 'standard' END ORDER BY c.milktv_last_check DESC NULLS LAST,c.id) AS rn
      FROM channels c
      WHERE c.url IS NOT NULL
        AND BTRIM(c.url)<>''
        AND ($1::int[] = '{}'::int[] OR c.id = ANY($1::int[]))
    )
    SELECT * FROM chosen
    WHERE $1::int[] <> '{}'::int[] OR (kind='standard' AND rn<=13) OR (kind='dash' AND rn<=2)
    ORDER BY kind,rn
  `, [requestedChannelIds]);
  const report = { db_mutations: 0, executable_paths: { ffprobe: ffprobePath, ffmpeg: ffmpegPath }, origin: origin.rows, unknown_timeline: timeline.rows, sample: [] };
  for (const channel of samples.rows) {
    const standalone = await standaloneProbe(channel.url);
    const canonical = await canonicalProbeDryRun(channel.url);
    report.sample.push({
      id: channel.id, name: channel.name, kind: channel.kind, stored_status: channel.milktv_status,
      stored_last_check: channel.milktv_last_check, stored_reason: channel.milktv_check_error,
      standalone, canonical, match: standalone.classification === canonical.classification
    });
  }
  const totals = key => report.sample.reduce((acc, item) => { acc[item[key].classification] = (acc[item[key].classification] || 0) + 1; return acc; }, {});
  report.summary = { sample_size: report.sample.length, standalone: totals("standalone"), canonical: totals("canonical"), match: report.sample.every(item => item.match) };
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.end());
