const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROMO_KEYWORDS = [/скачайте/i, /приложени[ея]/i, /подписк/i, /тариф/i, /оплат/i, /купит/i, /telegram|whatsapp/i, /visit|сайт/i, /\bIPTV\b/i];
const FFMPEG_TIMEOUT_MS = 20_000;

function findProjectBinary(name) {
  const root = path.join(__dirname, '..', 'tools', 'ffmpeg');
  if (!fs.existsSync(root)) return null;
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { const hit = walk(full); if (hit) return hit; } else if (entry.name.toLowerCase() === `${name}.exe`) return full; } return null; };
  return walk(root);
}
function resolveFfmpegPath() { return process.env.MILKTV_FFMPEG_PATH || process.env.FFMPEG_PATH || findProjectBinary('ffmpeg') || 'ffmpeg'; }
function resolveFfprobePath() { return process.env.MILKTV_FFPROBE_PATH || process.env.FFPROBE_PATH || findProjectBinary('ffprobe') || 'ffprobe'; }
function checkFfmpegAvailability(options = {}) {
  const executable = options.path || resolveFfmpegPath();
  return new Promise(resolve => {
    let settled = false; const finish = result => { if (!settled) { settled = true; resolve({ path: executable, ...result }); } };
    let child; try { child = spawn(executable, ['-version'], { windowsHide: true }); } catch (_) { return finish({ status: 'ERROR' }); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ status: 'TIMEOUT' }); }, options.timeoutMs || 3000);
    child.once('error', error => { clearTimeout(timer); finish({ status: error.code === 'ENOENT' ? 'NOT_FOUND' : 'ERROR' }); });
    child.once('close', code => { clearTimeout(timer); finish({ status: code === 0 ? 'AVAILABLE' : 'ERROR' }); });
  });
}

function calculatePromoSignal(observations = []) {
  const list = observations.map(x => ({ text: String(x.text || ''), qr_detected: Boolean(x.qr_detected) }));
  let detections = 0; const snippets = [];
  for (const o of list) { const hits = PROMO_KEYWORDS.filter(re => re.test(o.text)).length; const contextual = hits >= 2 || (hits >= 1 && o.qr_detected); if (contextual) { detections++; if (snippets.length < 5) snippets.push(o.text.slice(0, 160)); } }
  const count = list.length; let score = count ? Math.min(100, detections * 30 + Math.max(0, detections - 1) * 10) : 0;
  let status = 'unknown', confidence = 'none'; if (detections >= 2) { status = 'detected'; confidence = count >= 3 ? 'high' : 'medium'; } else if (detections === 1) { status = 'suspected'; confidence = 'low'; } else if (count >= 3) { status = 'clean'; confidence = 'medium'; }
  return { promo_status: status, promo_score: score, promo_confidence: confidence, observations: count, detections, snippets };
}

module.exports = { resolveFfmpegPath, resolveFfprobePath, checkFfmpegAvailability, calculatePromoSignal, FFMPEG_TIMEOUT_MS };
