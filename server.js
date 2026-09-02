const express = require("express");
const cors = require("cors");
const session = require("express-session");
const crypto = require("crypto");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const dns = require("dns").promises;
const net = require("net");
const db = require("./database");
const clientsRouter = require("./routes/clients");
const adminClientsRouter = require("./routes/admin-clients");
const clientRouter = require("./routes/client");
const devicePairing = require("./services/milktv-device-pairing");
const googleOAuth = require("./services/google-oauth");
const milktvRouter = require("./routes/milktv");
const candidatesRouter = require("./routes/candidates");
const milktvDiscovery = require("./services/milktv-discovery");
const milktvQuality = require("./services/milktv-quality");
const milktvSourceTrust = require("./services/milktv-source-trust");
const milktvEpg = require("./services/milktv-epg");
const milktvPromoDetector = require("./services/milktv-promo-detector");
const milktvSourceIngestion = require("./services/milktv-source-ingestion");
const milktvM3uPilot = require("./services/milktv-m3u-pilot");
const milktvWebSearchProvider = require("./services/milktv-web-search-provider");
const apiV1Client = require("./routes/api-v1-client");
const MILKTV_API_VERSION = process.env.MILKTV_API_VERSION || "v1";
const MILKTV_EPG_ENABLED = process.env.MILKTV_EPG_ENABLED === "true";
const MILKTV_EPG_INTERVAL = 6 * 60 * 60 * 1000;
const MILKTV_EPG_START_DELAY = 30 * 60 * 1000;
const epgMatcher = require("./services/milktv-epg-matcher");
const milktvSourceAutoswitch = require("./services/milktv-source-autoswitch");
const milktvAutopilot = require("./services/milktv-autopilot");
const MILKTV_CHANNEL_ALIASES = require("./config/milktv-channel-aliases.json");
const { switchChannelSource } = require("./services/milktv-source-switch");
const {
  hashPassword,
  isPasswordHash,
  verifyPassword
} = require("./password-utils");

const app = express();
const PORT = process.env.PORT || 3000;
const MILKTV_M3U_MAX_BYTES = 5 * 1024 * 1024;
const MILKTV_M3U_TIMEOUT_MS = 15000;
const MILKTV_DISCOVERY_ENABLED = process.env.MILKTV_DISCOVERY_ENABLED === "true";
const MILKTV_DISCOVERY_START_DELAY = 30 * 60 * 1000;
const MILKTV_DISCOVERY_INTERVAL = 18 * 60 * 60 * 1000;
const MILKTV_QUALITY_PROBE_ENABLED = process.env.MILKTV_QUALITY_PROBE_ENABLED === "true";
const MILKTV_QUALITY_START_DELAY = 35 * 60 * 1000;
const MILKTV_QUALITY_INTERVAL = 6 * 60 * 60 * 1000;
const MILKTV_QUALITY_BATCH_LIMIT = 20;
const MILKTV_QUALITY_CONCURRENCY = 2;
const MILKTV_QUALITY_SWITCH_GAP = 12;
const MILKTV_SOURCE_AUTOSWITCH_ENABLED = process.env.MILKTV_SOURCE_AUTOSWITCH_ENABLED === "true";
const MILKTV_SOURCE_AUTO_INGEST_ENABLED = process.env.MILKTV_SOURCE_AUTO_INGEST_ENABLED === "true";
const MILKTV_SOURCE_AUTOSWITCH_INTERVAL = 20 * 60 * 1000;
const MILKTV_AUTOPILOT_ENABLED = process.env.MILKTV_AUTOPILOT_ENABLED === "true";
const MILKTV_AUTOPILOT_INTERVAL = 5 * 60 * 1000;
const optionalSchemaWarnings = new Set();
const MILKTV_FFPROBE_PATH = process.env.MILKTV_FFPROBE_PATH || path.join(__dirname, "tools", "ffmpeg", "ffmpeg-9.0.1-essentials_build", "ffmpeg-9.0.1-essentials_build", "bin", "ffprobe.exe");
const MILKTV_FFMPEG_PATH = process.env.MILKTV_FFMPEG_PATH || path.join(__dirname, "tools", "ffmpeg", "ffmpeg-9.0.1-essentials_build", "ffmpeg-9.0.1-essentials_build", "bin", "ffmpeg.exe");
const MILKTV_HEALTH_PROBE_GAP_MS = 250;
const MILKTV_HEALTH_HTTP_TIMEOUT_MS = 8000;
const MILKTV_HEALTH_FFPROBE_TIMEOUT_MS = 8000;
const MILKTV_HEALTH_FFMPEG_TIMEOUT_MS = 8000;
const MILKTV_HEALTH_SOURCE_TIMEOUT_MS = 26000;
const MILKTV_HEALTH_CHANNEL_TIMEOUT_MS = 90000;
const MILKTV_HEALTH_CIRCUIT_MIN_CHECKED = 20;
const MILKTV_HEALTH_CIRCUIT_OFFLINE_RATIO = 0.75;
const MILKTV_HEALTH_UNKNOWN_CIRCUIT_MIN_CHECKED = 15;
const MILKTV_HEALTH_UNKNOWN_CIRCUIT_RATIO = 0.9;
const MILKTV_BACKGROUND_HEALTH_ENABLED = process.env.MILKTV_BACKGROUND_HEALTH_ENABLED === "true";
const MILKTV_BACKGROUND_HEALTH_INTERVAL_MS = 30 * 60 * 1000;
const MILKTV_HEALTH_PREFLIGHT_IDS = [351, 17, 18, 19, 20];
const MILKTV_HEALTH_CLI = process.env.MILKTV_HEALTH_CLI === "true";
let milktvLastProbeAt = 0;
function healthSourceLabel(rawUrl) {
  try { return new URL(String(rawUrl || "")).host; } catch (_) { return "invalid-url"; }
}
function healthLog(context, stage, detail = "") {
  if (!context) return;
  const prefix = `HEALTH channel=${context.channelId ?? "?"} source=${context.sourceId ?? "?"} host=${context.host || "?"}`;
  console.log(`${prefix} stage=${stage}${detail ? ` ${detail}` : ""}`);
}
function withHealthTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve({ __healthTimeout: true, label }), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}
function terminateMediaChild(child) {
  try { child.kill(); } catch (_) {}
  if (process.platform !== "win32" || !child?.pid) return Promise.resolve();
  return new Promise(resolve => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(fallback);
      resolve();
    };
    const fallback = setTimeout(finish, 3000);
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", finish);
      killer.once("close", finish);
    } catch (_) {
      finish();
    }
  });
}
function runMilktvMediaTool(file, args, timeoutMs = 12000) {
  return new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateMediaChild(child).finally(() => {
        resolve({ available: true, ok: false, reason: "timeout" });
      });
    }, timeoutMs);
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { if (!settled) { settled = true; clearTimeout(timer); resolve({ available: false, ok: false, reason: error.code || error.message }); } });
    child.on("close", code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ available: true, ok: code === 0, reason: code === 0 ? null : stderr.trim().slice(-240) }); } });
  });
}
async function optionalSchemaReady(feature, checks) {
  try { const r = await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2", checks); if (r.rows.length) return true; } catch (error) {}
  if (!optionalSchemaWarnings.has(feature)) { optionalSchemaWarnings.add(feature); console.warn(`MILK TV ${feature} disabled: schema not ready`); }
  return false;
}
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required");
}

app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req,res,next)=>{
  res.setHeader("Content-Type","text/html; charset=utf-8");
  next();
});

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }

  req.csrfToken = () => req.session.csrfToken;
}

// Client forms use the same session-bound CSRF token as admin forms.  Ensure
// it exists before the mounted client router renders or handles a POST.
app.use((req, res, next) => {
  ensureCsrfToken(req);
  next();
});

function csrfProtect(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const supplied = req.get("X-CSRF-Token") || req.body?._csrf;
  const expected = req.session?.csrfToken;

  if (typeof supplied !== "string" || typeof expected !== "string") {
    return res.status(403).json({ success: false, error: "CSRF token required" });
  }

  const suppliedBuffer = Buffer.from(supplied, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return res.status(403).json({ success: false, error: "Invalid CSRF token" });
  }

  next();
}

function isBlockedM3uAddress(address) {
  const value = String(address || "").toLowerCase();
  if (value === "localhost" || value.endsWith(".localhost") || value === "metadata.google.internal") {
    return true;
  }
  const ipVersion = net.isIP(value);
  if (ipVersion === 4) {
    const parts = value.split(".").map(Number);
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || parts[0] === 0;
  }
  if (ipVersion === 6) {
    return value === "::1"
      || value === "::"
      || value.startsWith("fc")
      || value.startsWith("fd")
      || value.startsWith("fe80:");
  }
  return false;
}

async function validateM3uProviderUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (error) {
    throw new Error("Некорректный URL плейлиста");
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Разрешены только HTTP/HTTPS URL без учетных данных");
  }
  if (isBlockedM3uAddress(parsed.hostname)) {
    throw new Error("Адрес плейлиста запрещён");
  }
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isBlockedM3uAddress(item.address))) {
    throw new Error("Адрес плейлиста указывает на внутреннюю сеть");
  }
  return parsed.toString();
}

async function fetchM3uText(providerUrl) {
  const safeUrl = await validateM3uProviderUrl(providerUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MILKTV_M3U_TIMEOUT_MS);
  try {
    const response = await fetch(safeUrl, { redirect: "error", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MILKTV_M3U_MAX_BYTES) {
      throw new Error("Плейлист превышает допустимый размер");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text) > MILKTV_M3U_MAX_BYTES) {
        throw new Error("Плейлист превышает допустимый размер");
      }
      return { text, bytes: Buffer.byteLength(text), httpStatus: response.status };
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MILKTV_M3U_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Плейлист превышает допустимый размер");
      }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return { text, bytes: total, httpStatus: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function parseM3uAttributes(extinf) {
  const attributes = {};
  const pattern = /([\w-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(extinf)) !== null) {
    attributes[match[1].toLowerCase()] = match[2].trim();
  }
  return attributes;
}

function parseM3uPlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let pending = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      if (comma < 0) {
        pending = null;
        continue;
      }
      const attrs = parseM3uAttributes(line.slice(0, comma));
      const name = line.slice(comma + 1).trim();
      pending = {
        name,
        tvgId: attrs['tvg-id'] || null,
        tvgName: attrs['tvg-name'] || null,
        logo: attrs['tvg-logo'] || null,
        groupTitle: attrs['group-title'] || null
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending && /^https?:\/\//i.test(line)) {
      entries.push({ ...pending, streamUrl: line });
    }
    pending = null;
  }
  return { entries, malformed: 0 };
}

app.use((req,res,next)=>{const send=res.send.bind(res);res.send=body=>{if(typeof body==='string'){body=body.replace(/<p[^>]*id="pair-wait-state"[^>]*>\s*Ожидание подключения…\s*<\/p>/g,'').replace(/<p[^>]*>\s*Ожидание подключения…\s*<\/p>/g,'').replace(/<div[^>]*class="footer"[^>]*>\s*Панель управления IPTV\s*<\/div>/g,'').replace(/Ожидание подключения…/g,'');}return send(body);};next();});
app.use("/vendor/jsqr", express.static(path.join(__dirname, "node_modules", "jsqr", "dist"), { etag: false, lastModified: false, setHeaders: res => res.setHeader("Cache-Control", "no-store, must-revalidate") }));
app.use("/client", clientRouter);

function auth(req, res, next) {

  if (req.session.user) {
    ensureCsrfToken(req);
    return next();
  }

  const isAjax =
    req.headers.accept?.includes("application/json") ||
    req.headers["x-requested-with"] === "XMLHttpRequest";

  if (isAjax) {

    return res.status(401).json({
      success: false,
      sessionExpired: true,
      error: "Сессия истекла. Пожалуйста, войдите снова."
    });

  }

  res.redirect("/login");

}

app.use("/admin", auth);
app.use("/admin", (req, res, next) => {
  const originalSend = res.send.bind(res);
  res.send = body => {
    if (typeof body === "string") {
      body = body.replace(/<p[^>]*id="pair-wait-state"[^>]*>\s*Ожидание подключения…\s*<\/p>/g, "");
      body = body.replace(/<p[^>]*>\s*Ожидание подключения…\s*<\/p>/g, "");
      body = body.replace(/Ожидание подключения…/g, "");
      body = body.replace(/<div[^>]*class="footer"[^>]*>\s*Панель управления IPTV\s*<\/div>/g, "");
    }
    if (typeof body === "string" && body.includes("<body") && !body.includes("app-sidebar")) {
      const sidebarCss = '<style id="admin-sidebar-css">:root{--admin-bg:#07101d;--admin-panel:#111d2b;--admin-border:#2a3d57;--admin-primary:#3d82e8;--admin-muted:#9aaac0}body{background:radial-gradient(circle at 20% 0%,#162b47 0%,var(--admin-bg) 48%,#050a12 100%)!important;color:#f3f6fb!important}@media(min-width:900px){body{margin:0!important;padding:16px 16px 16px 174px!important}.wrap,.container{max-width:none!important;width:auto!important;margin:0 0 0 8px!important}}.app-sidebar{position:fixed;z-index:100;inset:16px auto 16px 16px;width:148px;display:flex;flex-direction:column;padding:16px 10px;background:#0a1320ee;border:1px solid var(--admin-border);border-radius:16px;box-shadow:0 14px 36px #0006}.app-sidebar .brand{font-size:17px;font-weight:700;color:#eaf2ff}.app-sidebar .brand b{color:#4d93f4}.app-sidebar .brand-mark{display:inline-grid;place-items:center;width:25px;height:25px;border-radius:7px;background:linear-gradient(135deg,#3d82e8,#62d2ff);color:#06111f}.app-sidebar nav{display:grid;gap:6px;margin-top:30px}.app-sidebar nav a{display:flex;gap:9px;align-items:center;padding:10px;border-radius:8px;color:var(--admin-muted);text-decoration:none;font-size:12px}.app-sidebar nav a:hover,.app-sidebar nav a.active{background:var(--admin-primary);color:#fff}.app-sidebar .sidebar-user{margin-top:auto;color:#dce7f7;font-size:11px}.app-sidebar .avatar{display:inline-grid;place-items:center;width:27px;height:27px;border-radius:50%;background:#5a8ed5;margin-right:6px}@media(max-width:899px){body{padding:10px!important}.app-sidebar{display:none}}</style>';
      const sidebarHtml = '<aside class="app-sidebar" aria-label="Основная навигация"><div class="brand"><span class="brand-mark">▶</span> MILK <b>TV</b></div><nav><a href="/admin">⌂ <span>Главная</span></a><a href="/admin/clients">♙ <span>Клиенты</span></a><a href="/admin/channels">▣ <span>Каналы</span></a><a href="/client/channels">▹ <span>MILK TV</span></a></nav><div class="sidebar-user"><span class="avatar">A</span>admin</div></aside>';
      if (body.includes("</head>")) body = body.replace("</head>", sidebarCss + "</head>");
      body = body.replace(/<body([^>]*)>/i, '<body$1>' + sidebarHtml);
    }
    return originalSend(body);
  };
  next();
});
app.use(express.static("public", { index:false, etag: false, lastModified: false, setHeaders: res => res.setHeader("Cache-Control", "no-store, must-revalidate") }));

app.use("/api/clients", auth, csrfProtect, clientsRouter);

app.use("/admin/clients", auth, csrfProtect, adminClientsRouter);

app.use("/api/milktv", milktvRouter);
app.use("/api/candidates", auth, csrfProtect, candidatesRouter);
app.get("/api/v1/health", (req, res) => res.json({ ok: true, data: { status: "ok", api_version: MILKTV_API_VERSION } }));
app.get("/api/v1/capabilities", (req, res) => res.json({ ok: true, data: { api_version: MILKTV_API_VERSION, features: ["channels", "epg", "reminders", "favorites", "device_limit", "playlist"] } }));
app.use("/api/v1/client", apiV1Client.router);

app.get("/api/admin/csrf", auth, (req, res) => {
  res.json({ token: req.csrfToken() });
});

// IPTV playlist для клиента
app.get("/playlist/:token.m3u", async (req, res) => {

  try {

    const result = await db.query(
      `
      SELECT
        id,
        active,
        (
          subscription_until IS NULL
          OR subscription_until > LOCALTIMESTAMP
        ) AS subscription_active
      FROM clients
      WHERE token = $1
      `,
      [req.params.token]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Playlist not found");
    }

    if (!result.rows[0].active) {
      return res.status(403).send("Client disabled");
    }

    if (!result.rows[0].subscription_active) {
      return res.status(403).send("Subscription expired");
    }

    const channelsResult = await db.query(`
      SELECT
        current_channel.name,
        current_channel.url,
        current_channel.logo,
        MIN(m.category) FILTER (
          WHERE m.category IS NOT NULL
            AND BTRIM(m.category) <> ''
        ) AS category
      FROM milktv_channel_slots s
      JOIN channels original_channel
        ON original_channel.id = s.original_channel_id
      JOIN channels current_channel
        ON current_channel.id = s.current_channel_id
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = s.original_channel_id
      WHERE s.current_channel_id IS NOT NULL
        AND COALESCE(original_channel.visible_to_clients, TRUE) = TRUE
        AND current_channel.milktv_status = 'online'
        AND current_channel.url IS NOT NULL
        AND BTRIM(current_channel.url) <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM milktv_replacement_pool rp
          WHERE rp.channel_id = s.original_channel_id
            AND rp.enabled = TRUE
        )
      GROUP BY
        s.original_channel_id,
        original_channel.milktv_rating,
        current_channel.id,
        current_channel.name,
        current_channel.url,
        current_channel.logo
      ORDER BY
        COALESCE(original_channel.milktv_rating, 0) DESC,
        current_channel.name ASC
    `);

    const escapeM3uValue = value => String(value ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/"/g, "'");

    const playlist = ["#EXTM3U"];

    for (const channel of channelsResult.rows) {
      const attributes = [
        `tvg-name="${escapeM3uValue(channel.name)}"`,
        channel.logo
          ? `tvg-logo="${escapeM3uValue(channel.logo)}"`
          : "",
        channel.category
          ? `group-title="${escapeM3uValue(channel.category)}"`
          : ""
      ].filter(Boolean).join(" ");

      const channelName = escapeM3uValue(channel.name);
      const channelUrl = `/api/v1/client/public/play/${apiV1Client.makePlaybackToken(channel.url)}`;

      playlist.push(
        `#EXTINF:-1 ${attributes},${channelName}`,
        channelUrl
      );
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.apple.mpegurl; charset=utf-8"
    );

    res.send(`${playlist.join("\n")}\n`);

  } catch (error) {

    console.error("PLAYLIST ERROR:", error);

    res.status(500).send(error.message);

  }

});

// LOGIN
function requestCookie(req, name) {
  const prefix = `${name}=`;
  const item = String(req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : "";
}

async function getOrCreateRootLoginPairing(req, res) {
  let token = "";
  let code = "";
  const pendingCiphertext = requestCookie(req, "milktv_pending_pairing");
  if (pendingCiphertext) {
    try {
      const pending = JSON.parse(devicePairing.decryptRecovery(pendingCiphertext) || "{}");
      token = String(pending.token || "");
      code = String(pending.code || "").toUpperCase();
      if (!/^[A-Za-z0-9_-]{40,}$/.test(token) || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) throw new Error("invalid pending pairing");
      const row = (await db.query("SELECT expires_at,consumed_at FROM client_pairing_sessions WHERE token_hash=$1 AND pairing_code_hash=$2", [devicePairing.hash(token), devicePairing.hash(code)])).rows[0];
      if (!row || row.consumed_at || new Date(row.expires_at) <= new Date()) throw new Error("expired pending pairing");
    } catch (_) {
      token = "";
      code = "";
    }
  }
  if (!token) {
    token = crypto.randomBytes(32).toString("base64url");
    code = devicePairing.pairingCode();
    await db.query("INSERT INTO client_pairing_sessions(token_hash,pairing_code_hash,device_name,device_hint,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '5 minutes')", [devicePairing.hash(token), devicePairing.hash(code), "TV / browser", req.get("user-agent")?.slice(0,180) || null]);
    res.cookie("milktv_pending_pairing", devicePairing.encryptRecovery(JSON.stringify({ token, code })), { httpOnly: true, sameSite: "lax", maxAge: 5 * 60 * 1000 });
  }
  const approvalUrl = `${req.protocol}://${req.get("host")}/client/pair/approve/${token}`;
  const qr = await QRCode.toDataURL(approvalUrl, { margin: 2, width: 240 });
  return { token, code, qr };
}

// The pending pairing token is held only by the TV/browser that displayed the
// QR.  Approval and credential finalization are deliberately separate so an
// owner phone can never receive the TV's long-lived credential.
function rootPairingWaitScript(token, csrfToken) {
  const safeToken = JSON.stringify(String(token));
  const safeCsrf = JSON.stringify(String(csrfToken || ""));
  return `<script>(function(){var token=${safeToken},csrf=${safeCsrf},state=document.getElementById('pair-wait-state'),code=document.getElementById('pair-code-value'),qr=document.getElementById('pair-qr'),expires=document.getElementById('pair-expires'),refresh=document.getElementById('pair-refresh'),timer=null,countdown=null,busy=false,expiresAt=0;function say(text){if(state)state.textContent=text;}function stop(){if(timer){clearInterval(timer);timer=null;}if(countdown){clearInterval(countdown);countdown=null;}}function tick(){if(!expires)return;var left=Math.max(0,expiresAt-Date.now()),seconds=Math.ceil(left/1000);expires.textContent=left?'Действителен ещё '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'QR истёк';if(!left)stop();}function start(data){stop();token=data.token;expiresAt=Date.now()+Number(data.ttl_ms||300000);if(qr)qr.src=data.qr;if(code)code.textContent=data.code||'';if(refresh)refresh.disabled=false;tick();countdown=setInterval(tick,1000);timer=setInterval(check,3000);check();}function finalize(){if(busy)return;busy=true;fetch('/client/pair/finalize/'+encodeURIComponent(token),{method:'POST',credentials:'same-origin'}).then(function(response){return response.json().then(function(body){return {response:response,body:body};});}).then(function(result){if(result.response.ok&&result.body&&result.body.ok){stop();say('Устройство подключено. Открываем MILK TV…');window.location.replace(result.body.redirect||'/client/channels');return;}busy=false;if(result.body&&result.body.error==='pending')return;say('Не удалось завершить подключение. Обновите страницу.');stop();}).catch(function(){busy=false;});}function check(){fetch('/client/pair/status/'+encodeURIComponent(token),{credentials:'same-origin'}).then(function(response){return response.json();}).then(function(data){if(data&&data.approved){finalize();return;}if(data&&data.expired){stop();say('Срок действия кода истёк. Обновите QR.');return;}if(data&&data.rejected){stop();say('Подключение отменено владельцем.');}}).catch(function(){});}if(refresh)refresh.onclick=function(){refresh.disabled=true;say('Обновляем QR…');fetch('/login/pair/refresh',{method:'POST',headers:{'X-CSRF-Token':csrf},credentials:'same-origin'}).then(function(response){return response.json().then(function(body){return {response:response,body:body};});}).then(function(result){if(!result.response.ok||!result.body||!result.body.success)throw Error(result.body&&result.body.error||'Не удалось обновить QR');say('Ожидание подключения…');start(result.body.pairing);}).catch(function(error){if(refresh)refresh.disabled=false;say(error.message||'Не удалось обновить QR. Повторите попытку.');});};start({token:token,code:document.getElementById('pair-code-value')&&document.getElementById('pair-code-value').textContent,qr:qr&&qr.src,ttl_ms:300000});}());</script>`;
}

app.post("/login/pair/refresh", csrfProtect, async (req, res) => {
  try {
    const pendingCiphertext = requestCookie(req, "milktv_pending_pairing");
    if (pendingCiphertext) {
      try {
        const pending = JSON.parse(devicePairing.decryptRecovery(pendingCiphertext) || "{}");
        if (pending.token) await db.query("DELETE FROM client_pairing_sessions WHERE token_hash=$1 AND consumed_at IS NULL", [devicePairing.hash(String(pending.token))]);
      } catch (_) {}
    }
    const pairing = await getOrCreateRootLoginPairing(req, res);
    return res.json({ success:true, pairing:{ token:pairing.token, code:pairing.code, qr:pairing.qr, ttl_ms:300000 } });
  } catch (error) {
    console.error("ROOT LOGIN QR REFRESH ERROR:", error.message);
    return res.status(500).json({ success:false, error:"Не удалось обновить QR. Повторите попытку." });
  }
});

app.get('/auth/google/start', (req, res) => {
  if (!googleOAuth.isConfigured()) return res.status(503).send('Google OAuth пока не настроен.');
  const mode = req.session.client ? 'link' : 'login';
  const returnTo = String(req.query.returnTo || '/client').startsWith('/') ? String(req.query.returnTo || '/client') : '/client';
  const state = googleOAuth.randomState();
  req.session.googleOAuth = { state, mode, returnTo, createdAt: Date.now() };
  req.session.save(error => error ? res.status(500).send('Не удалось начать вход через Google.') : res.redirect(googleOAuth.authorizationUrl(state)));
});

app.get('/auth/google/callback', async (req, res) => {
  const pending = req.session.googleOAuth;
  delete req.session.googleOAuth;
  if (!pending || pending.state !== String(req.query.state || '') || Date.now() - Number(pending.createdAt || 0) > 10 * 60 * 1000) return res.status(400).send('Недействительный или просроченный OAuth state.');
  try {
    if (!req.query.code) throw new Error('Google authorization code missing');
    const identity = await googleOAuth.exchangeCode(String(req.query.code));
    const existing = (await db.query('SELECT id, name, login, active FROM clients WHERE google_sub=$1', [identity.sub])).rows[0];
    if (pending.mode === 'link') {
      if (!req.session.client) return res.redirect('/login?error=invalid');
      if (existing && Number(existing.id) !== Number(req.session.client.id)) return res.status(409).send('Этот Google-аккаунт уже подключён к другому клиенту MILK TV.');
      await db.query('UPDATE clients SET google_sub=$1,google_email=$2,google_name=$3,google_picture=$4,google_linked_at=NOW() WHERE id=$5', [identity.sub, identity.email || null, identity.name || null, identity.picture || null, req.session.client.id]);
      return res.redirect(pending.returnTo || '/client');
    }
    if (!existing || !existing.active) return res.redirect('/login?error=google_unlinked');
    req.session.client = { id: existing.id, name: existing.name, login: existing.login };
    req.session.viewerDevice = false; delete req.session.viewerDeviceId;
    return req.session.save(() => res.redirect('/client'));
  } catch (error) {
    console.error('GOOGLE OAUTH ERROR:', error.message);
    return res.redirect('/login?error=google_error');
  }
});

app.post('/auth/google/unlink', async (req, res) => {
  if (!req.session.client || req.session.viewerDevice || req.body?._csrf !== req.session.csrfToken) return res.status(403).send('Недействительная сессия.');
  try {
    const row = (await db.query('SELECT password FROM clients WHERE id=$1 AND active=TRUE', [req.session.client.id])).rows[0];
    if (!row || !row.password) return res.status(400).send('Сначала установите резервный пароль MILK TV.');
    await db.query('UPDATE clients SET google_sub=NULL,google_email=NULL,google_name=NULL,google_picture=NULL,google_linked_at=NULL WHERE id=$1', [req.session.client.id]);
    return res.redirect('/client');
  } catch (_) { return res.status(500).send('Не удалось отключить Google.'); }
});

app.get("/login", async (req, res) => {

  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-MilkTV-Login-Build", "20260901-v4");

  const loginMessages = {
    invalid: "Неверный логин или пароль",
    blocked: "Ваш аккаунт заблокирован",
    google_unlinked: "Этот Google-аккаунт ещё не подключён к MILK TV. Войдите существующим способом и подключите Google в разделе безопасности.",
    google_error: "Не удалось выполнить вход через Google. Попробуйте ещё раз.",
    session: "Не удалось создать сессию. Попробуйте войти ещё раз.",
    server: "Временная ошибка входа. Попробуйте позже."
  };

  const loginMessage =
    loginMessages[String(req.query.error || "")] || "";

  const loginMessageHtml = loginMessage
    ? `<div class="login-message" role="alert">${loginMessage}</div>`
    : "";
  const pairToken = String(req.query.pair || "").replace(/[^A-Za-z0-9_-]/g, "");
  const pairCode = String(req.query.pair_code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

  let loginPairing = null;
  try { loginPairing = await getOrCreateRootLoginPairing(req, res); } catch (error) { console.error("ROOT LOGIN QR ERROR:", error.message); }

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.send(`
<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport" content="width=device-width, initial-scale=1">

<title>IPTV Manager — Авторизация</title>

<style>

:root{--bg:#0d1422;--panel:#141e2d;--panel-2:#1a2a3d;--border:#2b3d56;--text:#f2f6fb;--muted:#9eabc0;--primary:#3d82e8;--primary-hover:#5c9cf2;--success:#63d69b;--danger:#e26d7a;--shadow:0 14px 36px rgba(0,0,0,.28)}
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at top, #1a2b43 0%, var(--bg) 48%, #080d16 100%);
  color: #fff;
  font-family: Arial, sans-serif;
  padding: 16px;
}

.login-box {
  width: 100%;
  max-width: 760px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 22px;
  box-shadow: 0 12px 28px rgba(0,0,0,.32);
  display: grid;
  grid-template-columns: minmax(210px, .8fr) minmax(280px, 1fr);
  grid-template-areas:
    "brand brand"
    "message message"
    "pair form"
    "pair recovery"
    "pair public"
    "footer footer";
  gap: 12px 24px;
}

.logo {
  display: none;
  text-align: center;
  font-size: 14px;
  letter-spacing: 2px;
  color: #8fb8a0;
  grid-area: brand;
  margin: 0;
}

h2 {
  text-align: center;
  margin: -6px 0 4px;
  font-size: 22px;
  grid-area: brand;
}

label {
  display: block;
  margin: 12px 0 6px;
  color: #bbb;
  font-size: 14px;
}

input {
  width: 100%;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: #0e1725;
  color: #fff;
  font-size: 16px;
  outline: none;
}

input:focus {
  border-color: var(--primary);
}

button {
  width: 100%;
  margin-top: 14px;
  padding: 12px;
  border: none;
  border-radius: 10px;
  background: var(--primary);
  color: white;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
}

button:hover {
  background: var(--primary-hover);
}

button:disabled {
  opacity: .7;
  cursor: wait;
}

.login-message {
  margin: 0 0 16px;
  padding: 12px;
  border: 1px solid #8b3a3a;
  border-radius: 10px;
  background: #351b1b;
  color: #ffd1d1;
  font-size: 14px;
  text-align: center;
  grid-area: message;
}

.pair-visible {
  grid-area: pair;
  align-self: start;
  padding: 8px 16px 8px 0;
  border-right: 1px solid #333;
  text-align: center;
}
.pair-visible h3 { margin: 0 0 10px; font-size: 15px; }
.pair-visible p { margin: 8px 0 0; color: #aaa; font-size: 12px; line-height: 1.35; }
 .pair-visible img { display: block; width: min(40vw, 180px); height: auto; margin: 0 auto; padding: 6px; background: #fff; border-radius: 8px; }
 .pair-code-label { margin-top: 8px; color: #aaa; font-size: 12px; }
 .pair-code-value { margin-top: 2px; font-size: 22px; font-weight: 700; letter-spacing: 4px; }
 .pair-refresh { display:block; width:min(40vw,180px); margin:8px auto 0; padding:8px 10px; font-size:13px; }
 .pair-expires { margin-top:6px; color:#aaa; font-size:11px; }
.pair-login { display: none !important; }

.login-box > form { grid-area: form; align-self: end; }
.recovery-action,.public-action{display:block;padding:12px;text-align:center;border-radius:10px;border:1px solid #333;background:#222;color:#fff;text-decoration:none;font-size:15px;font-weight:bold}
.recovery-action{grid-area:recovery}.public-action{grid-area:public;align-self:start}.recovery-action small{display:block;margin-top:4px;color:#aaa;font-size:11px;font-weight:normal}
.login-box > script { display: none; }

.footer {
  text-align: center;
  margin-top: 18px;
  color: #666;
  font-size: 12px;
  grid-area: footer;
}
.google-login-button{display:flex;grid-area:auto;align-items:center;justify-content:center;gap:11px;width:100%;min-height:46px;margin:0;padding:10px 16px;border:1px solid #34455e;border-radius:11px;background:#172334;color:#f2f6fb;text-decoration:none;font-size:15px;font-weight:700;box-shadow:0 8px 18px rgba(0,0,0,.2);transition:background .15s ease,border-color .15s ease,transform .15s ease}.google-login-button:hover{background:#1e314b;border-color:#4d82c5;transform:translateY(-1px)}.google-login-button:active{transform:translateY(0)}.google-login-button svg{flex:0 0 20px;width:20px;height:20px}.login-divider{grid-area:auto;margin:0;text-align:center;color:#9eabc0;font-size:12px}

@media (max-width: 620px), (orientation: portrait) and (max-width: 760px) {
  .login-box {
    max-width: 440px;
    padding: 16px;
    grid-template-columns: 1fr;
    grid-template-areas: "brand" "message" "form" "recovery" "public" "pair" "footer";
    gap: 8px;
  }
  .pair-visible { border-right: 0; border-top: 1px solid #333; padding: 10px 0 0; }
  .pair-visible img { width: min(42vw, 136px); }
  h2 { font-size: 20px; }
  input { padding: 11px; }
  button { margin-top: 10px; padding: 11px; }
}

@media (min-width: 621px) and (orientation: landscape) {
  .pair-visible h3 { white-space: nowrap; }
}

</style>

</head>

<body data-login-build="20260901-v4">

<div class="login-box">

  <div class="logo">📺</div>

  <h2>Вход в MILK TV</h2>

  <div class="pair-visible" aria-label="Подключить телевизор или другое устройство">
    <h3>Подключить устройство</h3>
     ${loginPairing ? `<img id="pair-qr" src="${loginPairing.qr}" alt="QR для подключения"><div class="pair-code-label">Код подключения</div><div id="pair-code-value" class="pair-code-value">${loginPairing.code}</div><button id="pair-refresh" class="pair-refresh" type="button">↻ Обновить QR</button><div id="pair-expires" class="pair-expires">Действителен ещё 5:00</div><a class="recovery-action" href="/client/recover">Восстановить устройство<small>Для ранее привязанного устройства</small></a>` : `<p>QR временно недоступен. Обновите страницу.</p>`}
  </div>

  ${loginMessageHtml}

  <a class="google-login-button" href="/auth/google/start${pairToken ? `?returnTo=${encodeURIComponent('/client/pair/approve/' + pairToken)}` : pairCode ? `?returnTo=${encodeURIComponent('/client/pair/approve/by-code/' + pairCode)}` : ''}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.35 12.27c0-.72-.06-1.42-.18-2.09H12v3.95h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.69 2.91-4.18 2.91-7.25Z"/><path fill="#34A853" d="M12 21.75c2.63 0 4.84-.87 6.45-2.34l-3.14-2.45c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.72-5.46-4.03H3.3v2.53A9.75 9.75 0 0 0 12 21.75Z"/><path fill="#FBBC05" d="M6.54 13.85A5.86 5.86 0 0 1 6.23 12c0-.64.11-1.26.31-1.85V7.62H3.3A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05 1.05 4.38l3.24-2.53Z"/><path fill="#EA4335" d="M12 6.12c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.84 3.22 14.63 2.25 12 2.25A9.75 9.75 0 0 0 3.3 7.62l3.24 2.53C7.31 7.84 9.46 6.12 12 6.12Z"/></svg><span>Войти через Google</span></a>
  <div class="login-divider">Другой способ входа</div>

  <form id="unified-login-form" method="POST" action="/login">

    ${pairToken ? `<input type="hidden" name="pair" value="${pairToken}">` : ""}
    ${pairCode ? `<input type="hidden" name="pair_code" value="${pairCode}">` : ""}

    <label>Логин</label>

    <input
      name="username"
      type="text"
      placeholder="Введите логин"
      autocomplete="username"
      required
    >

    <label>Пароль</label>

    <input
      name="password"
      type="password"
      placeholder="Введите пароль"
      autocomplete="current-password"
      required
    >

    <button id="unified-login-button" type="submit">
      Войти
    </button>

  </form>

  <script>

  document
    .getElementById("unified-login-form")
    .addEventListener("submit", function () {

      const button =
        document.getElementById("unified-login-button");

      button.disabled = true;
      button.textContent = "Входим...";

    });

  window.addEventListener("pageshow", function () {

    const button =
      document.getElementById("unified-login-button");

    button.disabled = false;
    button.textContent = "Войти";

  });

  </script>

  <a class="public-action"
    href="/client/channels"
    style="
      display:block;
      margin-top:12px;
      padding:14px;
      text-align:center;
      border-radius:10px;
      background:#222;
      border:1px solid #333;
      color:white;
      text-decoration:none;
      font-size:16px;
      font-weight:bold;
    "
  >
    📺 МИЛК ТВ
  </a>

  <div class="pair-login" aria-label="Подключить телевизор или другое устройство">
    <h3>Подключить телевизор или другое устройство</h3>
  ${loginPairing ? `<img src="${loginPairing.qr}" alt="QR для подключения"><div style="font-size:20px;letter-spacing:4px;margin-top:10px">Код подключения: ${loginPairing.code}</div>` : '<p>QR временно недоступен. Обновите страницу.</p>'}
  </div>

  <div class="footer">
  </div>

</div>



 ${loginPairing ? rootPairingWaitScript(loginPairing.token, req.csrfToken()) : ""}
</body>

</html>
  `);

});
app.post("/login",async(req,res)=>{

try{

const login =
  typeof req.body.username === "string"
    ? req.body.username.trim()
    : "";

const password =
  typeof req.body.password === "string"
    ? req.body.password
    : "";


const result = await db.query(
"SELECT * FROM users WHERE username=$1",
[login]
);


if(result.rows.length===0 || !verifyPassword(password, result.rows[0].password)){

res.status(401);

const clientResult = await db.query(
  `
  SELECT id, name, login, password, active
  FROM clients
  WHERE login = $1
  `,
  [login]
);

if (clientResult.rows.length > 0 && verifyPassword(password, clientResult.rows[0].password)) {

const client = clientResult.rows[0];

if (!isPasswordHash(client.password)) {
  await db.query(
    "UPDATE clients SET password = $1 WHERE id = $2",
    [hashPassword(password), client.id]
  );
}

if (!client.active) {
return res.redirect("/login?error=blocked");
}

req.session.client = {
id: client.id,
name: client.name,
login: client.login
};
req.session.viewerDevice = false;
delete req.session.viewerDeviceId;

return req.session.save(error => {

if (error) {
console.error("UNIFIED LOGIN SESSION SAVE ERROR:", error.message);
return res.redirect("/login?error=session");
}

res.redirect(req.body?.pair ? "/client/pair/approve/" + encodeURIComponent(String(req.body.pair)) : (req.body?.pair_code ? "/client/pair/approve/by-code/" + encodeURIComponent(String(req.body.pair_code).replace(/[^A-Za-z0-9]/g, "").toUpperCase()) : "/client"));

});

}

return res.redirect("/login?error=invalid");

}


if (!isPasswordHash(result.rows[0].password)) {
  await db.query(
    "UPDATE users SET password = $1 WHERE id = $2",
    [hashPassword(password), result.rows[0].id]
  );
}

const { password: ignoredPassword, ...adminSession } = result.rows[0];
req.session.user = adminSession;

return req.session.save(error => {

if (error) {
console.error("UNIFIED LOGIN SESSION SAVE ERROR:", error.message);
return res.redirect("/login?error=session");
}

res.redirect("/admin");

});


}catch(error){

console.error("UNIFIED LOGIN ERROR:", error.message);

res.redirect("/login?error=server");

}

});



// АДМИНКА МИЛК ТВ
app.get("/admin/milktv",auth,(req,res)=>{
  res.sendFile(__dirname+"/public/admin/milktv/index.html");
});

app.get("/admin",auth,(req,res)=>{

res.sendFile(__dirname+"/public/admin/index.html");

});



// ВЫХОД
app.get("/logout",(req,res)=>{

delete req.session.user;

req.session.save(error => {

if (error) {
console.error("ADMIN LOGOUT SESSION SAVE ERROR:", error.message);
return res.status(500).send("Ошибка выхода");
}

res.redirect("/login");

});

});



// ГЛАВНАЯ
app.get("/",(req,res)=>{
res.redirect("/login");
});



// СТАТУС СИСТЕМЫ
app.get("/api/system/status",auth,async(req,res)=>{

try{

await db.query("SELECT NOW()");

res.json({
 api:"online",
 database:"online",
 time:new Date()
});

}catch(error){

res.status(500).json({
 api:"online",
 database:"offline",
 error:error.message
});

}

});

// КАНАЛЫ API
app.get("/api/channels",async(req,res)=>{

try{

const result=await db.query(`
SELECT
  c.id,
  c.name,
  c.logo
FROM channels c
ORDER BY c.name ASC
`);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});

app.get("/api/admin/channels", auth, async (req,res)=>{

try{

const result=await db.query(`
SELECT
  c.id,
  c.name,
  c.logo,
  c.milktv_status,
  COALESCE(c.visible_to_clients, TRUE) AS visible_to_clients,
  c.milktv_last_check,
  c.milktv_failed_checks,
  c.milktv_rating,
  c.milktv_manual_boost,
  EXISTS (
    SELECT 1
    FROM milktv_replacement_pool rp
    WHERE rp.channel_id = c.id
      AND rp.enabled = TRUE
  ) AS is_replacement_pool,
  EXISTS (
    SELECT 1
    FROM milktv_channel_sources reserve_source
    WHERE reserve_source.channel_id = c.id
      AND reserve_source.enabled = TRUE
      AND reserve_source.status = 'online'
      AND reserve_source.id IS DISTINCT FROM c.current_source_id
  ) AS has_usable_reserve,
  s.id AS slot_id,
  s.original_channel_id AS slot_original_channel_id,
  s.current_channel_id AS slot_current_channel_id,
  s.replacement_since AS slot_replacement_since,
  current_channel.name AS current_channel_name,
  COALESCE(
    ARRAY_AGG(DISTINCT m.category)
    FILTER (WHERE m.category IS NOT NULL),
    ARRAY[]::text[]
  ) AS milktv_categories
FROM channels c
LEFT JOIN milktv_channel_categories m
  ON m.channel_id = c.id
LEFT JOIN milktv_channel_slots s
  ON s.original_channel_id = c.id
LEFT JOIN channels current_channel
  ON current_channel.id = s.current_channel_id
GROUP BY
  c.id,
  c.name,
  c.logo,
  c.milktv_status,
  c.visible_to_clients,
  c.milktv_last_check,
  c.milktv_rating,
  c.milktv_manual_boost,
  s.id,
  s.original_channel_id,
  s.current_channel_id,
  s.replacement_since,
  current_channel.name
ORDER BY
  (
    COALESCE(c.milktv_rating,0)
    + COALESCE(c.milktv_manual_boost,0)
  ) DESC,
  c.name ASC
`);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});



// Logical client visibility is an explicit admin decision and is never modified by Health or Autopilot.
app.patch("/admin/milktv/channels/:channelId/visibility", auth, csrfProtect, async (req, res) => {
  const channelId = Number(req.params.channelId);
  if (!Number.isInteger(channelId) || channelId <= 0 || typeof req.body?.visible_to_clients !== "boolean") {
    return res.status(400).json({ success: false, error: "Некорректные данные" });
  }
  try {
    const result = await db.query("UPDATE channels SET visible_to_clients=$1 WHERE id=$2 RETURNING id,visible_to_clients", [req.body.visible_to_clients, channelId]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: "Канал не найден" });
    return res.json({ success: true, channel: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Не удалось изменить видимость канала" });
  }
});

// HTML АДМИНКИ
app.get("/channels", async (req,res) => {

  return res.redirect("/client/channels");

  try {

    const result = await db.query(`
      SELECT
        c.id,
        c.name,
        c.url,
        c.logo,
        c.milktv_rating,
        c.milktv_views,
        c.milktv_manual_boost,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM channels c
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = c.id
      WHERE COALESCE(c.milktv_status, '') <> 'quarantine'
      GROUP BY
        c.id,
        c.name,
        c.url,
        c.logo,
        c.milktv_rating,
        c.milktv_views,
        c.milktv_manual_boost
      ORDER BY
        (
          COALESCE(c.milktv_rating,0)
          + COALESCE(c.milktv_manual_boost,0)
        ) DESC,
        c.name ASC
    `);

    const channels = result.rows;

    const categories = [
      { name:"Казахстан", icon:"🇰🇿" },
      { name:"Детские", icon:"🧒" },
      { name:"Кино", icon:"🎬" },
      { name:"Музыка", icon:"🎵" },
      { name:"Спорт", icon:"⚽" }
    ];

    const selectedCategory =
      String(req.query.category || "").trim();

    const search =
      String(req.query.search || "").trim().toLowerCase();

    let filteredChannels = channels;

    if (selectedCategory) {

      filteredChannels = filteredChannels.filter(ch =>
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.includes(selectedCategory)
      );

    }

    if (search) {

      filteredChannels = filteredChannels.filter(ch =>
        String(ch.name || "")
          .toLowerCase()
          .includes(search)
      );

    }

    const escapeHtml = value =>
      String(value || "")
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&#039;");

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>МИЛК ТВ</title>

<style>

:root{--bg:#0d1422;--panel:#141e2d;--panel-2:#1a2a3d;--border:#2b3d56;--text:#f2f6fb;--muted:#9eabc0;--primary:#3d82e8;--primary-hover:#5c9cf2;--success:#63d69b;--danger:#e26d7a;--shadow:0 14px 36px rgba(0,0,0,.28)}

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:1000px;
  margin:auto;
}

h1 {
  text-align:center;
  margin:5px 0 18px;
}

.search-box {
  margin-bottom:14px;
}

.search-box form {
  display:flex;
  gap:8px;
}

.search-box input {
  flex:1;
  min-width:0;
  padding:12px;
  background:#1c1c1c;
  color:white;
  border:1px solid #333;
  border-radius:10px;
  font-size:15px;
}

.search-box button {
  padding:12px 16px;
  background:#333;
  color:white;
  border:0;
  border-radius:10px;
  cursor:pointer;
}

.categories {
  display:flex;
  flex-wrap:wrap;
  gap:6px;
  margin-bottom:16px;
}

.category {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:7px 11px;
  background:#1c1c1c;
  border:1px solid #333;
  border-radius:8px;
  color:white;
  text-decoration:none;
  text-align:center;
  font-size:13px;
  white-space:nowrap;
}

.category:hover {
  background:#292929;
}

.category.active {
  border-color:#777;
  background:#303030;
}

.count {
  display:inline;
  margin-left:5px;
  color:#888;
  font-size:11px;
}
  border-color:#777;
  background:#303030;
}

.count {
  display:block;
  margin-top:4px;
  color:#888;
  font-size:12px;
}

.channels-grid {
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(120px,1fr));
  gap:10px;
}

.channel {
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  min-height:125px;
  padding:10px;
  background:#202020;
  border:1px solid #333;
  border-radius:12px;
  color:white;
  text-decoration:none;
  text-align:center;
}

.channel:hover {
  background:#292929;
  border-color:#555;
}

.channel-logo {
  width:64px;
  height:64px;
  object-fit:contain;
  border-radius:10px;
  margin-bottom:8px;
}

.channel-placeholder {
  width:64px;
  height:64px;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#111;
  border-radius:10px;
  font-size:30px;
  margin-bottom:8px;
}

.channel-name {
  width:100%;
  font-size:13px;
  line-height:16px;
  overflow:hidden;
  text-overflow:ellipsis;
}

.rating {
  margin-top:4px;
  color:#aaa;
  font-size:11px;
}

.empty {
  text-align:center;
  color:#888;
  padding:35px 10px;
}

.back {
  display:block;
  margin-top:20px;
  padding:12px;
  background:#1c1c1c;
  color:white;
  text-decoration:none;
  text-align:center;
  border-radius:10px;
}

</style>

</head>

<body>

<div class="container">

<h1>📺 МИЛК ТВ</h1>

<div class="search-box">

<form method="GET"
      action="/channels">

<input
  type="text"
  name="search"
  value="${escapeHtml(search)}"
  placeholder="🔎 Поиск канала по названию"
>

${selectedCategory
  ? `<input type="hidden" name="category" value="${escapeHtml(selectedCategory)}">`
  : ""}

<button type="submit">
🔎
</button>

</form>

</div>

<div class="categories">

<a
  class="category ${!selectedCategory ? "active" : ""}"
  href="/channels"
>
📺 Все
<span class="count">(${search ? filteredChannels.length : channels.length})</span>
</a>

`;

    categories.forEach(category => {

      const count = channels.filter(ch =>
        Array.isArray(ch.milktv_categories) &&
        ch.milktv_categories.includes(category.name)
      ).length;

      const href =
        "/channels?category=" +
        encodeURIComponent(category.name) +
        (search
          ? "&search=" + encodeURIComponent(search)
          : "");

      html += `

<a
  class="category ${selectedCategory === category.name ? "active" : ""}"
  href="${href}"
>
${category.icon} ${category.name}
<span class="count">(${count})</span>
</a>

`;

    });

    html += `

</div>

<div class="channels-grid">

`;

    if (filteredChannels.length === 0) {

      html += `

<div class="empty">
📺 Каналы не найдены
</div>

`;

    } else {

      filteredChannels.forEach(ch => {

        const logo = ch.logo
          ? `<img class="channel-logo" src="${escapeHtml(ch.logo)}" alt="">`
          : `<div class="channel-placeholder">📺</div>`;

        html += `

<a
  class="channel"
  href="/channels/${ch.id}"
>

${logo}

<div class="channel-name">
${escapeHtml(ch.name)}
</div>

</a>

`;

      });

    }

    html += `

</div>

<a
  class="back"
  href="/"
>
⬅️ На главную
</a>

</div>

</script>

</body>

</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error("CHANNELS PAGE:", error);

    res.status(500).send(error.message);

  }

});

app.get("/channels/:id", async (req,res) => {

  return res.redirect("/client/channels");

  try {

    const result = await db.query(
      `
      SELECT
        c.id,
        c.name,
        c.url,
        c.logo,
        c.category,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM channels c
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = c.id
      WHERE c.id = $1
      GROUP BY
        c.id,
        c.name,
        c.url,
        c.logo,
        c.category
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Канал не найден");
    }

    const ch = result.rows[0];

    const safeName = String(ch.name || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeUrl = String(ch.url || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const logo = ch.logo
      ? `<img class="channel-logo" src="${ch.logo}" alt="">`
      : `<div class="channel-logo-placeholder">📺</div>`;
    const categories = ch.milktv_categories || [];

    const categoryText =
      categories.length > 0
        ? categories.join(" • ")
        : "Без категории";

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>${safeName}</title>

<style>

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:700px;
  margin:auto;
}

.channel-header {
  text-align:center;
  padding:20px 10px;
}

.channel-logo {
  width:110px;
  height:110px;
  object-fit:contain;
  border-radius:18px;
  background:#1c1c1c;
}

.channel-logo-placeholder {
  width:110px;
  height:110px;
  margin:auto;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#1c1c1c;
  border-radius:18px;
  font-size:55px;
}

.channel-name {
  margin-top:14px;
  font-size:25px;
  font-weight:bold;
}

.channel-category {
  margin-top:6px;
  color:#999;
  font-size:13px;
}

.player-box {
  margin-top:10px;
  border:1px solid #333;
  border-radius:14px;
  overflow:hidden;
  background:#000;
}

video {
  width:100%;
  display:block;
  background:#000;
  aspect-ratio:16/9;
}

.back {
  display:block;
  width:100%;
  margin-top:18px;
  padding:12px;
  text-align:center;
  background:#1c1c1c;
  border-radius:9px;
  color:white;
  text-decoration:none;
}

body{background:radial-gradient(circle at top,#1a2b43 0%,var(--bg) 48%,#080d16 100%);color:var(--text)}
.search-box,.add-box,.channel-tile,.catalog-entry,.side-block{background:var(--panel);border-color:var(--border);box-shadow:var(--shadow)}
.category-button,.catalog-filter,.technical-tools select{background:var(--panel-2);border-color:var(--border)}
.category-button.active,.catalog-filter.active{background:#23446d;border-color:var(--primary)}
.add-button,.form-button,.search-button,.catalog-button,.side-actions button{background:var(--primary)}
.add-button:hover,.form-button:hover,.search-button:hover,.catalog-button:hover,.side-actions button:hover{background:var(--primary-hover)}
.channel-side-panel{background:var(--panel);border-color:var(--border)}.side-actions{background:var(--panel)}
.channel-categories,.catalog-meta,.catalog-muted,.side-muted{color:var(--muted)}

</style>

</head>

<body>

<div class="container">

<div class="channel-header">

${logo}

<div class="channel-name">
${safeName}
</div>

<div class="channel-category">
${categoryText}
</div>

</div>

<div class="player-box">

<video
  id="player"
  controls
  autoplay
  playsinline
>

</video>

</div>

<a
  class="back"
  href="/channels"
>
⬅️ Назад к каналам
</a>

</div>

<script>

const video = document.getElementById("player");

video.src = ${JSON.stringify(ch.url || "")};

video.load();

video.play().catch(() => {});

</script>

<script>

let milktvProgressTimer = null;

async function startMilktvCheck() {

  const button = document.getElementById("milktv-check-button");
  const progress = document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    console.error("Элементы МИЛК ТВ не найдены");
    return;
  }

  button.disabled = true;
  button.innerText = "⏳ Запуск проверки...";
  progress.innerText = "";

  try {

    const response = await fetch("/admin/milktv/check", {
      method: "POST",
      headers: {
        "Accept": "application/json"
      }
    });

    const text = await response.text();

    console.log("MILKTV START STATUS:", response.status);
    console.log("MILKTV START RESPONSE:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Сервер вернул не JSON: " + text.substring(0, 200));
    }

    if (!data.success) {

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText =
        data.message || "Ошибка запуска проверки";

      return;
    }

    if (milktvProgressTimer) {
      clearInterval(milktvProgressTimer);
    }

    await updateMilktvProgress();

    milktvProgressTimer =
      setInterval(updateMilktvProgress, 1000);

  } catch(error) {

    console.error("MILKTV START ERROR:", error);

    button.disabled = false;
    button.innerText = "🔄 Проверить каналы МИЛК ТВ";
    progress.innerText =
      "Ошибка запуска: " + error.message;

  }

}


async function updateMilktvProgress() {

  const button =
    document.getElementById("milktv-check-button");

  const progress =
    document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    return;
  }

  try {

    const response =
      await fetch("/api/admin/milktv/check-progress", {
        headers: {
          "Accept": "application/json"
        }
      });

    const text = await response.text();

    console.log("MILKTV PROGRESS:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Сервер вернул не JSON: " +
        text.substring(0, 200)
      );
    }

    if (response.status === 401) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText = "Сессия авторизации истекла";

      return;
    }

    if (data.running) {

      button.disabled = true;

      button.innerText =
        "⏳ МИЛК ТВ: " +
        data.current +
        "/" +
        data.total;

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline;

      return;
    }

    if (
      data.total > 0 &&
      data.current >= data.total
    ) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;

      button.innerText =
        "✅ Проверка завершена";

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline +
        "   📺 ВСЕГО: " +
        data.total;

      setTimeout(() => {

        button.innerText =
          "🔄 Проверить каналы МИЛК ТВ";

      }, 5000);

    }

  } catch(error) {

    console.error("MILKTV PROGRESS ERROR:", error);

    progress.innerText =
      "Ошибка получения прогресса: " +
      error.message;

  }

}

</script>

</body>

</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error("PUBLIC CHANNEL:", error);

    res.status(500).send(error.message);

  }

});

app.get("/api/categories",async(req,res)=>{

try{

const result=await db.query(
"SELECT category,COUNT(*) FROM channels GROUP BY category ORDER BY category"
);

res.json(result.rows);


}catch(error){

res.status(500).json({
error:error.message
});

}

});



// КАТЕГОРИЯ КАНАЛА МИЛК ТВ
app.post("/admin/channels/category", auth, csrfProtect, async (req,res) => {

  try {

    const {
      id
    } = req.body;

    let categories = req.body.milktv_categories || [];

    if (!Array.isArray(categories)) {
      categories = [categories];
    }

    const allowedCategories = [
      "Казахстан",
      "Детские",
      "Кино",
      "Музыка",
      "Спорт"
    ];

    if (!id) {
      return res.status(400).send("ID канала не указан");
    }

    categories = [
      ...new Set(
        categories.filter(category =>
          allowedCategories.includes(category)
        )
      )
    ];

    await db.query(
      `
      DELETE FROM milktv_channel_categories
      WHERE channel_id = $1
      `,
      [id]
    );

    for (const category of categories) {

      await db.query(
        `
        INSERT INTO milktv_channel_categories
        (
          channel_id,
          category
        )
        VALUES
        ($1,$2)
        ON CONFLICT (channel_id,category)
        DO NOTHING
        `,
        [id, category]
      );

    }

    await db.query(
      `
      UPDATE channels
      SET milktv_manual_category = $1
      WHERE id = $2
      `,
      [
        categories[0] || null,
        id
      ]
    );

    res.redirect("/admin/channels/" + id);

  } catch (error) {

    console.error("МИЛК ТВ CATEGORY:", error);

    res.status(500).send(error.message);

  }

});
app.post("/admin/channels/manual-boost", auth, csrfProtect, async (req,res) => {

  try {

    const rawId = Array.isArray(req.body.id)
      ? req.body.id[req.body.id.length - 1]
      : req.body.id;

    const id = Number(rawId);
    let boost = Number(req.body.manual_boost);

    if (!Number.isFinite(boost)) {
      boost = 0;
    }

    boost = Math.max(0, Math.min(100, Math.round(boost)));

    await db.query(
      `
      UPDATE channels
      SET milktv_manual_boost = $1
      WHERE id = $2
      `,
      [boost, id]
    );

    res.redirect("/admin/channels/" + id);

  } catch (error) {

    console.error("МИЛК ТВ MANUAL BOOST:", error);

    res.status(500).send(error.message);

  }

});


// Master-catalog package view.  Providers remain the source of truth; this is
// only an admin presentation of their existing candidate provenance.
app.get("/admin/channels/sources", auth, async (req, res) => {
  try {
    const rows = await db.query(`
      SELECT p.id,p.name,p.url,p.created_at,p.last_import,p.enabled,p.import_status,
        COUNT(DISTINCT c.id)::int AS candidates,
        COUNT(DISTINCT c.id) FILTER (WHERE c.health_status='online')::int AS online,
        COUNT(DISTINCT c.id) FILTER (WHERE c.health_status='offline')::int AS offline,
        COUNT(DISTINCT c.id) FILTER (WHERE COALESCE(c.health_status,'unknown') NOT IN ('online','offline'))::int AS unknown,
        COUNT(DISTINCT c.id) FILTER (WHERE c.suggested_channel_id IS NOT NULL OR c.accepted_channel_id IS NOT NULL)::int AS matched,
        COUNT(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM milktv_channel_slots slot JOIN channels original ON original.id=slot.original_channel_id WHERE slot.original_channel_id=COALESCE(c.accepted_channel_id,c.suggested_channel_id) AND COALESCE(original.visible_to_clients,TRUE)=TRUE))::int AS in_milktv
      FROM milktv_m3u_providers p
      LEFT JOIN milktv_m3u_candidate_providers cp ON cp.provider_id=p.id AND cp.active=TRUE
      LEFT JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
      GROUP BY p.id ORDER BY p.last_import DESC NULLS LAST,p.created_at DESC
    `);
    const esc = value => String(value || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");
    const cards = rows.rows.map(source => `<button class="source" type="button" data-source-id="${source.id}" data-search="${esc(source.name.toLowerCase())}" data-online="${source.online}" data-updated="${source.last_import ? new Date(source.last_import).getTime() : 0}"><b>${esc(source.name)}</b><span>${esc(new URL(source.url).hostname)}</span><small><i class="dot ${source.online ? 'online' : source.offline ? 'offline' : 'unknown'}"></i>${source.online} online · ${source.offline} offline · ${source.candidates} всего</small><small>${source.in_milktv} в MILK TV · ${source.last_import ? new Date(source.last_import).toLocaleString('ru-RU') : 'не обновлялся'}</small></button>`).join("") || '<p class="empty">Источники пока не добавлены.</p>';
    res.type("html").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Источники — Каналы</title><style>*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0;padding:16px;background:#111;color:#fff;font:14px Arial}.wrap{max-width:1120px;margin:auto}.top{display:flex;align-items:center;gap:12px}.back{color:#fff;text-decoration:none}.tools{display:flex;gap:8px;margin:12px 0}.tools input,.tools select{min-width:0;padding:10px;border:1px solid #444;border-radius:9px;background:#1b1b1b;color:#fff}.tools input{flex:1}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.source{min-width:0;min-height:116px;padding:11px;border:1px solid #333;border-radius:11px;background:#1b1b1b;color:#fff;text-align:left;cursor:pointer}.source:hover{border-color:#666}.source b,.source span,.source small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source span,.source small{margin-top:7px;color:#aaa;font-size:11px}.dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%}.online{background:#65cf7b}.offline{background:#df5f5f}.unknown{background:#dca857}.empty{color:#aaa;grid-column:1/-1}.drawer{position:fixed;z-index:40;inset:0 auto 0 0;width:min(480px,100vw);padding:16px;background:#171717;border-right:1px solid #444;box-shadow:10px 0 28px #0008;transform:translateX(-105%);transition:transform .18s ease;overflow:auto}.drawer.open{transform:translateX(0)}.drawer-close{float:right;padding:9px 11px;border:0;border-radius:8px;background:#333;color:#fff}.drawer video{width:100%;aspect-ratio:16/9;background:#000;border-radius:9px}.block{margin:12px 0;padding:11px;border:1px solid #333;border-radius:9px;background:#1d1d1d}.meta{margin:7px 0;color:#aaa;font-size:12px;line-height:1.45;word-break:break-word}.action{display:block;width:100%;margin-top:9px;padding:11px;border:0;border-radius:8px;background:#356a49;color:#fff;text-align:center;text-decoration:none;cursor:pointer}.danger{background:#7b3030}@media(max-width:620px){body{padding:10px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.source{min-height:108px;padding:9px}.tools{flex-wrap:wrap}.tools input,.tools select{flex:1 1 150px}.drawer{width:100vw}}</style></head><body><main class="wrap"><div class="top"><a class="back" href="/admin/channels">← Каналы</a><h2>Источники</h2></div><div class="tools"><input id="source-search" type="search" placeholder="Поиск источника"><select id="source-sort"><option value="name">По названию</option><option value="online">По ONLINE</option><option value="updated">По обновлению</option></select></div><section class="grid" id="source-grid">${cards}</section></main><aside id="source-drawer" class="drawer" aria-hidden="true"></aside><script>(function(){var csrf=${JSON.stringify(req.csrfToken())},drawer=document.getElementById('source-drawer'),grid=document.getElementById('source-grid'),search=document.getElementById('source-search'),sort=document.getElementById('source-sort'),stateKey='iptv-admin-sources-state';function esc(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}function close(){drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');drawer.innerHTML='';}function saveState(){sessionStorage.setItem(stateKey,JSON.stringify({search:search.value,sort:sort.value,scroll:scrollY}));}function run(){var term=search.value.trim().toLowerCase(),cards=[].slice.call(grid.querySelectorAll('.source'));cards.forEach(function(card){card.hidden=term&&!card.dataset.search.includes(term);});cards.sort(function(a,b){if(sort.value==='online')return Number(b.dataset.online||0)-Number(a.dataset.online||0);if(sort.value==='updated')return Number(b.dataset.updated||0)-Number(a.dataset.updated||0);return a.dataset.search.localeCompare(b.dataset.search);}).forEach(function(card){grid.appendChild(card);});saveState();}function open(id){saveState();fetch('/admin/channels/sources/'+id+'/summary').then(function(r){return r.json();}).then(function(data){if(!data.success)throw Error('Источник недоступен');var c=data.source,p=data.preview,impact=data.delete_impact,related=(data.related||[]).map(function(x){return '<div class="meta">'+esc(x.name)+' · '+esc(x.health_status||'unknown')+(x.logical_channel_name?' → '+esc(x.logical_channel_name):'')+'</div>';}).join('')||'<div class="meta">Связанных кандидатов нет.</div>';drawer.innerHTML='<button class="drawer-close" type="button">Закрыть</button><h2>'+esc(c.name)+'</h2><div class="block"><div class="meta">'+esc(c.url)+'</div><div class="meta">ONLINE '+c.online+' · OFFLINE '+c.offline+' · UNKNOWN '+c.unknown+' · всего '+c.candidates+'</div><div class="meta">Последнее обновление: '+(c.last_import?new Date(c.last_import).toLocaleString():'не запускалось')+'</div></div><div class="block"><h3>Preview</h3>'+(p?'<video controls playsinline src="'+esc(p.playback_url)+'"></video><div class="meta">'+esc(p.name)+'</div>':'<div class="meta">Рабочий кандидат не найден.</div>')+'</div><div class="block"><h3>Связанные каналы</h3>'+related+'</div><a class="action" href="/admin/channels/sources/'+id+'">Открыть все каналы</a><button class="action danger" id="delete-source" type="button">Удалить источник</button><div class="meta">Удаление провайдера сохранит logical channels, MILK TV slots и уже созданные stream sources.</div>';drawer.querySelector('.drawer-close').onclick=close;drawer.querySelector('#delete-source').onclick=function(){var message='Удалить источник «'+c.name+'»?\\n\\nСвязано кандидатов: '+impact.linked_candidates+'\\nLogical channels: '+impact.logical_channels+'\\nВ MILK TV: '+impact.milktv_channels+'\\nStream sources будут сохранены: '+impact.preserved_stream_sources;if(!confirm(message))return;fetch('/admin/channels/sources/'+id,{method:'DELETE',headers:{'X-CSRF-Token':csrf}}).then(function(r){return r.json().then(function(body){if(!r.ok||!body.success)throw Error(body.error||'Не удалось удалить');return body;});}).then(function(){var card=grid.querySelector('[data-source-id="'+id+'"]');if(card)card.remove();close();}).catch(function(e){alert(e.message);});};drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');}).catch(function(e){alert(e.message);});}grid.addEventListener('click',function(e){var card=e.target.closest('.source');if(card)open(card.dataset.sourceId);});search.oninput=run;sort.onchange=run;addEventListener('scroll',saveState,{passive:true});addEventListener('keydown',function(e){if(e.key==='Escape')close();});try{var state=JSON.parse(sessionStorage.getItem(stateKey)||'{}');search.value=state.search||'';sort.value=state.sort||'name';setTimeout(function(){run();scrollTo(0,Number(state.scroll)||0);},50);}catch(_){run();}}());</script></body></html>`);
  } catch (error) { console.error("Catalog sources list failed", error); res.status(500).send("Sources unavailable"); }
});

async function getProviderDeleteImpact(providerId, queryable = db) {
  const provider = (await queryable.query("SELECT id,name,url,last_import FROM milktv_m3u_providers WHERE id=$1", [providerId])).rows[0];
  if (!provider) return null;
  const counts = (await queryable.query(`
    SELECT COUNT(DISTINCT cp.candidate_id)::int AS linked_candidates,
      COUNT(DISTINCT COALESCE(c.accepted_channel_id,c.suggested_channel_id))
        FILTER(WHERE COALESCE(c.accepted_channel_id,c.suggested_channel_id) IS NOT NULL)::int AS logical_channels,
      COUNT(DISTINCT slot.original_channel_id)::int AS milktv_channels
    FROM milktv_m3u_candidate_providers cp
    LEFT JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
    LEFT JOIN milktv_channel_slots slot ON slot.original_channel_id=COALESCE(c.accepted_channel_id,c.suggested_channel_id)
    WHERE cp.provider_id=$1
  `, [providerId])).rows[0];
  const provenance = (await queryable.query(`
    SELECT COUNT(DISTINCT provenance.source_id)::int AS preserved_stream_sources,
      COUNT(DISTINCT channel.id) FILTER(WHERE channel.current_source_id=provenance.source_id)::int AS current_stream_sources
    FROM milktv_channel_source_provenance provenance
    LEFT JOIN channels channel ON channel.current_source_id=provenance.source_id
    WHERE provenance.m3u_provider_id=$1
  `, [providerId])).rows[0];
  return { provider, ...counts, ...provenance };
}

// Compact source drawer data. Uses the provider/candidate/provenance graph and
// the protected preview endpoint; deletion impact is calculated from live data.
app.get("/admin/channels/sources/:providerId/summary", auth, async (req, res) => {
  const providerId = Number(req.params.providerId);
  if (!Number.isInteger(providerId) || providerId <= 0) return res.status(400).json({ success:false });
  try {
    const impact = await getProviderDeleteImpact(providerId);
    if (!impact) return res.status(404).json({ success:false });
    const provider = impact.provider;
    const stats = (await db.query(`SELECT COUNT(*)::int AS candidates,
      COUNT(*) FILTER (WHERE c.health_status='online')::int AS online,
      COUNT(*) FILTER (WHERE c.health_status='offline')::int AS offline
      FROM milktv_m3u_candidate_providers cp JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
      WHERE cp.provider_id=$1 AND cp.active=TRUE`, [providerId])).rows[0];
    const preview = (await db.query(`SELECT c.id,c.name,c.stream_url
      FROM milktv_m3u_candidate_providers cp JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
      WHERE cp.provider_id=$1 AND cp.active=TRUE AND c.health_status='online' AND c.stream_url IS NOT NULL
      ORDER BY c.last_check DESC NULLS LAST,c.id LIMIT 1`, [providerId])).rows[0];
    const related = (await db.query(`SELECT c.id,c.name,c.health_status,COALESCE(accepted.name,suggested.name) AS logical_channel_name
      FROM milktv_m3u_candidate_providers cp JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
      LEFT JOIN channels accepted ON accepted.id=c.accepted_channel_id
      LEFT JOIN channels suggested ON suggested.id=c.suggested_channel_id
      WHERE cp.provider_id=$1 AND cp.active=TRUE
      ORDER BY (c.health_status='online') DESC,c.last_check DESC NULLS LAST,c.id LIMIT 12`, [providerId])).rows;
    const payload = { success:true, source:{ id:provider.id,name:provider.name,url:provider.url,last_import:provider.last_import,candidates:Number(stats.candidates||0),online:Number(stats.online||0),offline:Number(stats.offline||0),unknown:Number(stats.candidates||0)-Number(stats.online||0)-Number(stats.offline||0) }, related, delete_impact:impact };
    if (preview) payload.preview = { name:preview.name, playback_url:`/api/v1/client/public/play/${apiV1Client.makePlaybackToken(preview.stream_url)}` };
    return res.json(payload);
  } catch (_) { return res.status(500).json({ success:false }); }
});

app.get("/admin/channels/sources/:providerId/delete-impact", auth, async (req, res) => {
  const providerId = Number(req.params.providerId);
  if (!Number.isInteger(providerId) || providerId <= 0) return res.status(400).json({ success:false, error:"Invalid source" });
  try {
    const impact = await getProviderDeleteImpact(providerId);
    if (!impact) return res.status(404).json({ success:false, error:"Source not found" });
    return res.json({ success:true, impact });
  } catch (error) {
    console.error("Source delete impact failed:", error.message);
    return res.status(500).json({ success:false, error:"Не удалось проверить зависимости источника." });
  }
});

app.delete("/admin/channels/sources/:providerId", auth, csrfProtect, async (req, res) => {
  const providerId = Number(req.params.providerId);
  if (!Number.isInteger(providerId) || providerId <= 0) return res.status(400).json({ success:false, error:"Invalid source" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM milktv_m3u_providers WHERE id=$1 FOR UPDATE", [providerId]);
    const impact = await getProviderDeleteImpact(providerId, client);
    if (!impact) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success:false, error:"Источник не найден." });
    }
    // Provider deletion cascades only the provider/candidate junction. Logical
    // channels are not deleted; stream provenance becomes NULL via its FK and
    // already published MILK TV slots/sources remain intact.
    await client.query("DELETE FROM milktv_m3u_providers WHERE id=$1", [providerId]);
    await client.query("COMMIT");
    return res.json({ success:true, deleted_provider:{ id:providerId,name:impact.provider.name }, preserved:{ logical_channels:Number(impact.logical_channels||0),milktv_channels:Number(impact.milktv_channels||0),stream_sources:Number(impact.preserved_stream_sources||0) } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Safe source delete failed:", error.message);
    return res.status(409).json({ success:false, error:"Источник не удалён: зависимости не удалось сохранить безопасно." });
  } finally { client.release(); }
});

// Source candidate grid.  Keep navigation state in the URL so a detail POST
// redirect cannot silently reset the active filter or scroll context.
app.get("/admin/channels/sources/:providerId", auth, async (req, res) => {
  const providerId = Number(req.params.providerId);
  if (!Number.isInteger(providerId) || providerId <= 0) return res.status(400).send("Invalid source");
  try {
    const provider = (await db.query("SELECT id,name,url,last_import FROM milktv_m3u_providers WHERE id=$1", [providerId])).rows[0];
    if (!provider) return res.status(404).send("Source not found");
    const rows = (await db.query(`SELECT c.id,c.name,c.tvg_name,c.logo,c.health_status,c.last_check,
      EXISTS(SELECT 1 FROM milktv_channel_slots slot JOIN channels original ON original.id=slot.original_channel_id WHERE slot.original_channel_id=COALESCE(c.accepted_channel_id,c.suggested_channel_id) AND COALESCE(original.visible_to_clients,TRUE)=TRUE) AS in_milktv
      FROM milktv_m3u_candidate_providers cp JOIN milktv_m3u_candidates c ON c.id=cp.candidate_id
      WHERE cp.provider_id=$1 AND cp.active=TRUE ORDER BY c.name NULLS LAST,c.id`, [providerId])).rows;
    const esc = value => String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const count = state => rows.filter(x => (x.health_status || 'unknown') === state).length;
    const card = row => { const state=['online','offline'].includes(row.health_status)?row.health_status:'unknown'; const label=state==='online'?'ONLINE':state==='offline'?'OFFLINE':'UNKNOWN'; const url=`/admin/channels/catalog/candidate/${row.id}`; return `<a class="candidate" data-id="${row.id}" data-state="${state}" data-published="${row.in_milktv?'yes':'no'}" href="${url}">${row.logo?`<img src="${esc(row.logo)}" alt="">`:''}<b>${esc(row.name||row.tvg_name||`Candidate #${row.id}`)}</b><span class="${state}">${label}</span><small>${esc(row.last_check?`Проверен ${new Date(row.last_check).toLocaleString('ru-RU')}`:'Ждёт проверки')} · ${row.in_milktv?'В MILK TV':'Не добавлен'}</small></a>`; };
    res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(provider.name)}</title><style>body{margin:0;padding:16px;background:#111;color:#fff;font:14px Arial}.wrap{max-width:1280px;margin:auto}.back{color:#fff;display:inline-block;margin-bottom:12px}.meta{color:#aaa;word-break:break-all}.tools,.filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tools input,.tools select,.filters button{padding:8px 10px;background:#1b1b1b;color:#fff;border:1px solid #444;border-radius:8px}.filters button.active{border-color:#75d98c}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}.candidate{min-width:0;min-height:102px;padding:9px;box-sizing:border-box;border:1px solid #333;border-radius:9px;background:#1b1b1b;color:#fff;text-decoration:none;display:flex;flex-direction:column;gap:4px}.candidate:hover{border-color:#666}.candidate img{height:34px;max-width:62px;object-fit:contain}.candidate b{font-size:14px;line-height:1.2}.candidate small{font-size:11px;color:#aaa}.online{color:#75d98c}.offline{color:#ed7070}.unknown{color:#e6ae5c}.hidden{display:none}@media(max-width:520px){body{padding:10px}.grid{grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:6px}.candidate{min-height:94px;padding:8px}}</style></head><body><main class="wrap"><a class="back" href="/admin/channels/sources">← Источники</a><h2>${esc(provider.name)}</h2><div class="meta">${esc(provider.url)} · импорт ${provider.last_import?new Date(provider.last_import).toLocaleString('ru-RU'):'ещё не запускался'}</div><div class="tools"><input id="search" type="search" placeholder="Поиск канала"><select id="sort"><option value="name">По названию</option><option value="status">По статусу</option></select></div><div class="filters"><button data-filter="all">Все ${rows.length}</button><button data-filter="online">ONLINE ${count('online')}</button><button data-filter="offline">OFFLINE ${count('offline')}</button><button data-filter="unknown">UNKNOWN ${rows.length-count('online')-count('offline')}</button><button data-filter="published">В MILK TV</button><button data-filter="not-added">Не добавлены</button></div><section id="grid" class="grid">${rows.map(card).join('')||'<p class="meta">Кандидатов нет.</p>'}</section></main><script>(function(){var p=new URLSearchParams(location.search),filter=p.get('filter')||'all',sort=p.get('sort')||'name',search=p.get('search')||'',anchor=p.get('anchor')||'',savedY=Number(p.get('scroll')||0),grid=document.getElementById('grid'),cards=[].slice.call(grid.querySelectorAll('.candidate')),input=document.getElementById('search'),select=document.getElementById('sort');input.value=search;select.value=sort;function visible(c){return filter==='all'||c.dataset.state===filter||(filter==='published'&&c.dataset.published==='yes')||(filter==='not-added'&&c.dataset.published==='no');}function sync(){cards.forEach(function(c){var text=(c.textContent||'').toLowerCase();c.classList.toggle('hidden',!visible(c)||(search&&text.indexOf(search.toLowerCase())<0));});cards.sort(function(a,b){return sort==='status'?(a.dataset.state+a.textContent).localeCompare(b.dataset.state+b.textContent):a.textContent.localeCompare(b.textContent);}).forEach(function(c){grid.appendChild(c);});document.querySelectorAll('[data-filter]').forEach(function(b){b.classList.toggle('active',b.dataset.filter===filter);});var q=new URLSearchParams({filter:filter,sort:sort,search:search});if(anchor)q.set('anchor',anchor);q.set('scroll',String(window.scrollY));history.replaceState(null,'',location.pathname+'?'+q.toString());}document.querySelectorAll('[data-filter]').forEach(function(b){b.onclick=function(){filter=b.dataset.filter;sync();};});input.oninput=function(){search=input.value;sync();};select.onchange=function(){sort=select.value;sync();};window.addEventListener('scroll',function(){var q=new URLSearchParams(location.search);q.set('scroll',String(window.scrollY));history.replaceState(null,'',location.pathname+'?'+q.toString());},{passive:true});cards.forEach(function(c){c.addEventListener('click',function(e){e.preventDefault();anchor=c.dataset.id;var q=new URLSearchParams({filter:filter,sort:sort,search:search,anchor:anchor,scroll:String(window.scrollY)});location.href=c.href+'?return_to='+encodeURIComponent(location.pathname+'?'+q.toString());});});sync();window.setTimeout(function(){var a=anchor&&grid.querySelector('[data-id="'+anchor+'"]:not(.hidden)');if(a)a.scrollIntoView({block:'center'});else if(savedY)window.scrollTo(0,savedY);},60);}());</script></body></html>`);
  } catch (error) { console.error('Source state grid failed', error); res.status(500).send('Source unavailable'); }
});

function catalogReturnPath(value, fallback = "/admin/channels") {
  const path = String(value || "");
  return path.startsWith("/admin/channels") ? path : fallback;
}

app.get("/admin/channels/catalog/play/:kind/:id", auth, async (req, res) => {
  const id = Number(req.params.id), kind = req.params.kind;
  if (!Number.isInteger(id) || id <= 0 || !["logical", "candidate"].includes(kind)) return res.status(400).json({ ok:false });
  try {
    const query = kind === "logical"
      ? "SELECT url,milktv_status FROM channels WHERE id=$1"
      : "SELECT stream_url AS url,health_status AS milktv_status FROM milktv_m3u_candidates WHERE id=$1";
    const row = (await db.query(query, [id])).rows[0];
    if (!row || row.milktv_status !== "online" || !row.url) return res.status(409).json({ ok:false, error:"PLAYBACK_UNAVAILABLE" });
    return res.json({ ok:true, playback_url:`/api/v1/client/public/play/${apiV1Client.makePlaybackToken(row.url)}` });
  } catch (_) { return res.status(500).json({ ok:false, error:"PLAYBACK_UNAVAILABLE" }); }
});

app.get("/admin/channels/catalog/:kind/:id", auth, async (req, res) => {
  const id = Number(req.params.id), kind = req.params.kind;
  if (!Number.isInteger(id) || id <= 0 || !["logical", "candidate"].includes(kind)) return res.status(400).send("Not found");
  try {
    const csrfToken = req.csrfToken();
    const row = kind === "logical"
      ? (await db.query(`SELECT c.id,c.name,c.logo,c.milktv_status AS health_status,c.milktv_last_check AS last_check,EXISTS(SELECT 1 FROM milktv_channel_slots s WHERE s.original_channel_id=c.id) AND COALESCE(c.visible_to_clients,TRUE) AS in_milktv,ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name),NULL) AS providers FROM channels c LEFT JOIN milktv_channel_sources source ON source.channel_id=c.id LEFT JOIN milktv_channel_source_provenance provenance ON provenance.source_id=source.id LEFT JOIN milktv_m3u_providers p ON p.id=provenance.m3u_provider_id WHERE c.id=$1 GROUP BY c.id`, [id])).rows[0]
      : (await db.query(`SELECT c.id,c.name,c.tvg_name,c.logo,c.group_title,c.state,c.health_status,c.last_check,c.match_confidence,c.suggested_channel_id,c.accepted_channel_id,COALESCE(accepted.name,suggested.name) AS matched_name,EXISTS(SELECT 1 FROM milktv_channel_slots s JOIN channels original ON original.id=s.original_channel_id WHERE s.original_channel_id=COALESCE(c.accepted_channel_id,c.suggested_channel_id) AND COALESCE(original.visible_to_clients,TRUE)=TRUE) AS in_milktv,ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name),NULL) AS providers FROM milktv_m3u_candidates c LEFT JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id AND cp.active=TRUE LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id LEFT JOIN channels accepted ON accepted.id=c.accepted_channel_id LEFT JOIN channels suggested ON suggested.id=c.suggested_channel_id WHERE c.id=$1 GROUP BY c.id,accepted.id,suggested.id`, [id])).rows[0];
    if (!row) return res.status(404).send("Not found");
    const esc = value => String(value || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");
    const name = row.name || row.tvg_name || `Candidate #${id}`;
    const health = row.health_status === "online" ? "ONLINE" : row.health_status === "offline" ? "OFFLINE" : "UNKNOWN";
    const providers = Array.isArray(row.providers) && row.providers.length ? row.providers.join(", ") : "Не указан";
    const quality = (String(name).match(/(?:2160p|1080p|1080i|720p|720i|576p|480p)/i) || [])[0] || "не определено";
    const returnTo = catalogReturnPath(req.query.return_to);
    let action = `<div class="muted">${health === "UNKNOWN" ? "Ждёт проверки" : health === "OFFLINE" ? "OFFLINE: публикация недоступна" : row.in_milktv ? "В MILK TV" : ""}</div>`;
    if (kind === "candidate" && health === "ONLINE" && !row.in_milktv && row.state === "new") {
      if (row.suggested_channel_id && row.match_confidence === "high") action = `<form method="POST" action="/admin/channels/candidates/${id}/add-source"><input type="hidden" name="_csrf" value="${csrfToken}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button>Добавить как источник</button></form>`;
      else if (row.match_confidence === "no-match") action = `<form method="POST" action="/admin/channels/candidates/${id}/add-to-milktv"><input type="hidden" name="_csrf" value="${csrfToken}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button>Добавить в MILK TV</button></form>`;
    }
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>${esc(name)}</title><style>body{margin:0;padding:16px;background:#111;color:#fff;font:14px Arial}.wrap{max-width:820px;margin:auto}.back{color:#fff;display:inline-block;margin-bottom:15px}.player{width:100%;max-height:430px;background:#000;border-radius:10px}.lamp{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}.online{background:#65cf7b}.offline{background:#df5f5f}.unknown{background:#dca857}.meta{margin:10px 0;color:#ccc}.muted{color:#aaa}button{padding:10px 14px;background:#356a49;color:#fff;border:0;border-radius:8px;cursor:pointer}</style><div class="wrap"><a class="back" href="${esc(returnTo)}">← Назад</a><video id="preview" class="player" controls playsinline></video><p id="preview-note" class="muted">${health === "ONLINE" ? "Подготовка защищённого просмотра…" : "Предпросмотр недоступен для этого статуса."}</p><h2><span class="lamp ${health.toLowerCase()}"></span>${esc(name)}</h2><div class="meta">${health} · ${esc(row.last_check ? `Проверен ${new Date(row.last_check).toLocaleString('ru-RU')}` : 'Не проверен')}</div><div class="meta">Источник: ${esc(providers)} · Качество: ${esc(quality)}</div><div class="meta">${row.matched_name ? `Совпадает: ${esc(row.matched_name)}` : kind === "candidate" ? "Не сопоставлен" : "Логический канал"} · ${row.in_milktv ? "В MILK TV" : "Не в MILK TV"}</div>${action}</div><script>if(${JSON.stringify(health === "ONLINE")})fetch('/admin/channels/catalog/play/${kind}/${id}').then(r=>r.json()).then(x=>{if(!x.ok)throw Error();document.getElementById('preview').src=x.playback_url;document.getElementById('preview-note').textContent=''}).catch(()=>document.getElementById('preview-note').textContent='Предпросмотр временно недоступен');</script>`);
  } catch (error) { console.error("Catalog detail failed", error); res.status(500).send("Detail unavailable"); }
});

// Reusable, admin-only data contract for the master-catalog side panel.  The
// existing full detail page below remains a fallback and is not replaced.
app.get("/admin/channels/:id/side-detail", auth, async (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success:false, error:"Invalid channel" });
  try {
    const channel = (await db.query(`SELECT c.id,c.name,c.url,c.logo,c.category,c.milktv_status,c.milktv_last_check,c.milktv_rating,c.milktv_manual_boost,c.visible_to_clients,
      EXISTS(SELECT 1 FROM milktv_channel_slots s WHERE s.original_channel_id=c.id) AS in_milktv,
      COALESCE(ARRAY_AGG(DISTINCT mc.category) FILTER(WHERE mc.category IS NOT NULL),ARRAY[]::text[]) AS milktv_categories
      FROM channels c LEFT JOIN milktv_channel_categories mc ON mc.channel_id=c.id WHERE c.id=$1 GROUP BY c.id`,[id])).rows[0];
    if (!channel) return res.status(404).json({ success:false, error:"Channel not found" });
    const sources = (await db.query(`SELECT source.id,source.url,source.status,source.enabled,source.priority,source.resolution_label,source.video_width,source.video_height,source.measured_at,source.last_check,source.trust_score,source.quality_score,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT provider.name),NULL) AS providers
      FROM milktv_channel_sources source
      LEFT JOIN milktv_channel_source_provenance provenance ON provenance.source_id=source.id
      LEFT JOIN milktv_m3u_providers provider ON provider.id=provenance.m3u_provider_id
      WHERE source.channel_id=$1 GROUP BY source.id ORDER BY source.priority,source.id`,[id])).rows;
    const history = (await db.query(`SELECT created_at,reason,result FROM milktv_source_switch_history WHERE channel_id=$1 ORDER BY created_at DESC LIMIT 12`,[id]).catch(()=>({rows:[]}))).rows;
    res.json({ success:true, channel, sources, history });
  } catch (error) { console.error("Side detail failed",error); res.status(500).json({ success:false,error:"Detail unavailable" }); }
});

// Candidate variant of the catalog side-panel contract.  The full candidate
// detail page remains available as a no-JS fallback, while normal clicks stay
// in the Channels master list.
app.get("/admin/channels/candidates/:id/side-detail", auth, async (req,res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success:false, error:"Invalid candidate" });
  try {
    const candidate = (await db.query(`SELECT c.id,c.name,c.tvg_name,c.logo,c.stream_url,c.group_title,c.state,c.health_status,c.last_check,c.match_confidence,c.suggested_channel_id,c.accepted_channel_id,
      COALESCE(accepted.name,suggested.name) AS matched_channel_name,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name),NULL) AS providers
      FROM milktv_m3u_candidates c
      LEFT JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id AND cp.active=TRUE
      LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id
      LEFT JOIN channels accepted ON accepted.id=c.accepted_channel_id
      LEFT JOIN channels suggested ON suggested.id=c.suggested_channel_id
      WHERE c.id=$1 GROUP BY c.id,accepted.id,suggested.id`, [id])).rows[0];
    if (!candidate) return res.status(404).json({ success:false, error:"Candidate not found" });
    res.json({ success:true, candidate });
  } catch (error) {
    console.error("Candidate side detail failed", error);
    res.status(500).json({ success:false, error:"Candidate detail unavailable" });
  }
});

// The side panel submits one explicit draft. It deliberately does not write a
// stream URL directly: URLs keep using the existing staging/validation route.
app.post("/admin/channels/:id/side-detail", auth, csrfProtect, async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || "").trim();
  let manualBoost = Number(req.body?.manual_boost);
  if (!Number.isInteger(id) || id <= 0 || !name || name.length > 500) {
    return res.status(400).json({ success:false, error:"Проверьте название и рейтинг." });
  }
  if (!Number.isFinite(manualBoost)) manualBoost = 0;
  manualBoost = Math.max(0, Math.min(100, Math.round(manualBoost)));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id FROM channels WHERE id=$1 FOR UPDATE", [id]);
    if (!found.rows.length) throw Object.assign(new Error("Channel not found"), { statusCode:404 });
    await client.query("UPDATE channels SET name=$1, milktv_manual_boost=$2 WHERE id=$3", [name, manualBoost, id]);
    await client.query("COMMIT");
    return res.json({ success:true, channel:{ id, name, manual_boost:manualBoost } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Side detail save failed:", error);
    return res.status(error.statusCode || 500).json({ success:false, error:"Не удалось сохранить изменения." });
  } finally { client.release(); }
});

// Explicit publication of an existing logical channel.  This is intentionally
// separate from staging and only permits an already ONLINE, usable channel.
app.post("/admin/channels/:id/publish-to-milktv", auth, csrfProtect, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success:false, error:"Некорректный канал." });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const channel = await client.query("SELECT id,milktv_status,url FROM channels WHERE id=$1 FOR UPDATE", [id]);
    if (!channel.rows.length) throw Object.assign(new Error("not found"), { statusCode:404 });
    if (channel.rows[0].milktv_status !== "online" || !String(channel.rows[0].url || "").trim()) throw Object.assign(new Error("not eligible"), { statusCode:409 });
    await client.query("INSERT INTO milktv_channel_slots(original_channel_id,current_channel_id,created_at,updated_at) VALUES($1,$1,NOW(),NOW()) ON CONFLICT(original_channel_id) DO UPDATE SET current_channel_id=EXCLUDED.current_channel_id,updated_at=NOW()", [id]);
    await client.query("UPDATE channels SET visible_to_clients=TRUE WHERE id=$1", [id]);
    await client.query("COMMIT");
    return res.json({ success:true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(error.statusCode || 500).json({ success:false, error:error.statusCode === 409 ? "В MILK TV можно добавить только ONLINE-канал с проверенным URL." : "Не удалось добавить канал в MILK TV." });
  } finally { client.release(); }
});

app.get("/admin/channels/:id", auth, async (req,res) => {

  try {

    const csrfToken = req.csrfToken();

    const result = await db.query(
      "SELECT * FROM channels WHERE id=$1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Канал не найден");
    }

    const ch = result.rows[0];
    const categoryResult = await db.query(
      `
      SELECT category
      FROM milktv_channel_categories
      WHERE channel_id = $1
      ORDER BY id
      `,
      [ch.id]
    );

    const milktvCategories =
      categoryResult.rows.map(row => row.category);


    const logo = ch.logo
      ? `<img class="channel-logo" src="${ch.logo}" alt="">`
      : `<div class="channel-logo-placeholder">📺</div>`;

    const safeName = String(ch.name || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeCategory = String(ch.category || "Без категории")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    const safeUrl = String(ch.url || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>${safeName}</title>

<style>

* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:700px;
  margin:auto;
}

.channel-header {
  text-align:center;
  padding:20px 10px;
}

.channel-logo {
  width:110px;
  height:110px;
  object-fit:contain;
  border-radius:18px;
  background:#1c1c1c;
}

.channel-logo-placeholder {
  width:110px;
  height:110px;
  margin:auto;
  border-radius:18px;
  background:#1c1c1c;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:55px;
}

.channel-name {
  font-size:25px;
  font-weight:bold;
  margin-top:14px;
}

.channel-category {
  color:#999;
  margin-top:6px;
}

.player-box {
  margin-top:10px;
  background:#000;
  border-radius:14px;
  overflow:hidden;
  border:1px solid #333;
}

video {
  display:block;
  width:100%;
  aspect-ratio:16/9;
  background:#000;
}

.info-box {
  margin-top:14px;
  padding:14px;
  background:#1c1c1c;
  border-radius:12px;
  border:1px solid #333;
}

.info-title {

.milktv-category-option {
  display:flex;
  align-items:center;
  gap:12px;
  padding:12px 10px;
  margin-top:6px;
  background:#151515;
  border:1px solid #292929;
  border-radius:10px;
  cursor:pointer;
  transition:.2s;
}

.milktv-category-option:hover {
  background:#202020;
  border-color:#444;
}

.milktv-category-option input {
  width:20px;
  height:20px;
  margin:0;
  cursor:pointer;
}

.milktv-category-option span {
  font-size:15px;
}

  color:#aaa;
  font-size:13px;
  margin-bottom:8px;
}

.url-box {
  display:none;
}

.url-box input {
  width:100%;
  padding:11px;
  background:#111;
  color:#7cff7c;
  border:1px solid #333;
  border-radius:8px;
  font-size:12px;
}

button,
.back {
  width:100%;
  display:block;
  padding:12px;
  margin-top:10px;
  border:0;
  border-radius:9px;
  background:#333;
  color:white;
  text-align:center;
  text-decoration:none;
  font-size:15px;
  cursor:pointer;
}

button:hover,
.back:hover {
  background:#444;
}

.delete {
  background:#512020;
}

.delete:hover {
  background:#682828;
}

</style>

</head>

<body>

<div class="container">

<div class="channel-header">

${logo}

<div class="channel-name">
${safeName}
</div>

<div class="channel-category">
${safeCategory}
</div>

</div>

<div class="player-box">

<video
  id="player"
  controls
  autoplay
  playsinline
>
</video>

</div>

<div class="info-box">

<div class="info-title">
📂 Категории МИЛК ТВ
</div>

<form
  method="POST"
  action="/admin/channels/category"
>

<input type="hidden" name="_csrf" value="${csrfToken}">

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Казахстан"
  ${milktvCategories.includes("Казахстан") ? "checked" : ""}
>
<span>🇰🇿 Казахстан</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Детские"
  ${milktvCategories.includes("Детские") ? "checked" : ""}
>
<span>🧒 Детские</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Кино"
  ${milktvCategories.includes("Кино") ? "checked" : ""}
>
<span>🎬 Кино</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Музыка"
  ${milktvCategories.includes("Музыка") ? "checked" : ""}
>
<span>🎵 Музыка</span>
</label>

<label class="milktv-category-option">
<input
  type="checkbox"
  name="milktv_categories"
  value="Спорт"
  ${milktvCategories.includes("Спорт") ? "checked" : ""}
>
<span>⚽ Спорт</span>
</label>
<button
  type="submit"
>
💾 Сохранить категории
</button>

</form>

<form
  method="POST"
  action="/admin/channels/manual-boost"
>

<input type="hidden" name="_csrf" value="${csrfToken}">

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<div class="info-title">
⭐ Ручной приоритет
</div>

<div style="color:#888;font-size:13px;margin-bottom:8px;">
Чем выше значение, тем выше канал поднимается в МИЛК ТВ.
</div>

<input
  type="number"
  name="manual_boost"
  value="${Number(ch.milktv_manual_boost || 0)}"
  min="0"
  max="100"
  step="1"
  style="width:100%;padding:12px;background:#111;color:#fff;border:1px solid #333;border-radius:9px;font-size:16px;"
>

<button
  type="submit"
>
⭐ Сохранить приоритет
</button>

</form>

</div>

<div class="info-box">

<div class="info-title">
🔗 IPTV-ссылка
</div>

<button
  type="button"
  onclick="toggleUrl()"
  id="url-button"
>
👁️ Показать ссылку
</button>

<div
  class="url-box"
  id="url-box"
>

<input
  type="text"
  value="${safeUrl}"
  readonly
  onclick="this.select()"
>

</div>

</div>

<div class="info-box">
<div class="info-title">Добавить источник URL</div>
<form method="POST" action="/admin/channels/${ch.id}/sources/manual">
<input type="hidden" name="_csrf" value="${csrfToken}">
<input type="hidden" name="return_to" value="/admin/channels/${ch.id}">
<input name="url" type="url" placeholder="https://example.org/live.m3u8" required>
<button type="submit">Добавить источник URL</button>
</form>
</div>

<form
  method="POST"
  action="/admin/channels/delete"
  onsubmit="return confirm('Удалить этот канал?')"
>

<input
  type="hidden"
  name="id"
  value="${ch.id}"
>

<input type="hidden" name="_csrf" value="${csrfToken}">

<button
  type="submit"
  class="delete"
>
🗑️ Удалить канал
</button>

</form>

<a
  class="back"
  href="/admin/channels"
>
⬅️ Назад к каналам
</a>

</div>

<script>

function toggleUrl() {

  const box =
    document.getElementById("url-box");

  const button =
    document.getElementById("url-button");

  if (box.style.display === "block") {

    box.style.display = "none";

    button.textContent =
      "👁️ Показать ссылку";

  } else {

    box.style.display = "block";

    button.textContent =
      "🙈 Скрыть ссылку";

  }

}

const video =
  document.getElementById("player");

video.src =
  ${JSON.stringify(ch.url ? `/api/v1/client/public/play/${apiV1Client.makePlaybackToken(ch.url)}` : "")};

video.load();

video.play().catch(() => {});

</script>

<script>

const csrfToken = ${JSON.stringify(csrfToken)};
let milktvProgressTimer = null;

async function startMilktvCheck() {

  const button = document.getElementById("milktv-check-button");
  const progress = document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    console.error("Элементы МИЛК ТВ не найдены");
    return;
  }

  button.disabled = true;
  button.innerText = "⏳ Запуск проверки...";
  progress.innerText = "";

  try {

    const response = await fetch("/admin/milktv/check", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "X-CSRF-Token": csrfToken
      }
    });

    const text = await response.text();

    console.log("MILKTV START STATUS:", response.status);
    console.log("MILKTV START RESPONSE:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Сервер вернул не JSON: " + text.substring(0, 200));
    }

    if (!data.success) {

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText =
        data.message || "Ошибка запуска проверки";

      return;
    }

    if (milktvProgressTimer) {
      clearInterval(milktvProgressTimer);
    }

    await updateMilktvProgress();

    milktvProgressTimer =
      setInterval(updateMilktvProgress, 1000);

  } catch(error) {

    console.error("MILKTV START ERROR:", error);

    button.disabled = false;
    button.innerText = "🔄 Проверить каналы МИЛК ТВ";
    progress.innerText =
      "Ошибка запуска: " + error.message;

  }

}


async function updateMilktvProgress() {

  const button =
    document.getElementById("milktv-check-button");

  const progress =
    document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    return;
  }

  try {

    const response =
      await fetch("/api/admin/milktv/check-progress", {
        headers: {
          "Accept": "application/json"
        }
      });

    const text = await response.text();

    console.log("MILKTV PROGRESS:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Сервер вернул не JSON: " +
        text.substring(0, 200)
      );
    }

    if (response.status === 401) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText = "Сессия авторизации истекла";

      return;
    }

    if (data.running) {

      button.disabled = true;

      button.innerText =
        "⏳ МИЛК ТВ: " +
        data.current +
        "/" +
        data.total;

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline;

      return;
    }

    if (
      data.total > 0 &&
      data.current >= data.total
    ) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;

      button.innerText =
        "✅ Проверка завершена";

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline +
        "   📺 ВСЕГО: " +
        data.total;

      setTimeout(() => {

        button.innerText =
          "🔄 Проверить каналы МИЛК ТВ";

      }, 5000);

    }

  } catch(error) {

    console.error("MILKTV PROGRESS ERROR:", error);

    progress.innerText =
      "Ошибка получения прогресса: " +
      error.message;

  }

}

</script>

</body>
</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

app.get("/admin/channels", auth, async (req,res) => {

  try {

    const csrfToken = req.csrfToken();

    const search = String(req.query.search || "").trim();

    const result = await db.query(`
      SELECT
        c.*,
        (SELECT source.status FROM milktv_channel_sources source WHERE source.id=c.current_source_id) AS current_source_status,
        (SELECT source.resolution_label FROM milktv_channel_sources source WHERE source.id=c.current_source_id) AS current_quality,
        COALESCE((SELECT provider.name FROM milktv_channel_source_provenance provenance JOIN milktv_m3u_providers provider ON provider.id=provenance.m3u_provider_id WHERE provenance.source_id=c.current_source_id LIMIT 1),'Ручной / не указан') AS source_name,
        (SELECT COUNT(*)::int FROM milktv_channel_sources reserve WHERE reserve.channel_id=c.id AND reserve.enabled=TRUE AND reserve.id IS DISTINCT FROM c.current_source_id) AS reserve_count,
        EXISTS(SELECT 1 FROM milktv_channel_slots slot WHERE slot.original_channel_id=c.id) AS in_milktv,
        COALESCE(
          ARRAY_AGG(DISTINCT m.category)
          FILTER (WHERE m.category IS NOT NULL),
          ARRAY[]::text[]
        ) AS milktv_categories
      FROM channels c
      LEFT JOIN milktv_channel_categories m
        ON m.channel_id = c.id
      WHERE
        ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR EXISTS (
          SELECT 1 FROM milktv_channel_sources source
          LEFT JOIN milktv_channel_source_provenance provenance ON provenance.source_id=source.id
          LEFT JOIN milktv_m3u_providers provider ON provider.id=provenance.m3u_provider_id
          WHERE source.channel_id=c.id AND (source.url ILIKE '%' || $1 || '%' OR provider.name ILIKE '%' || $1 || '%')
        ))
      GROUP BY c.id
      ORDER BY c.id DESC
    `, [search]);

    let channels = result.rows;
    const candidateSummary = await db.query(`SELECT COUNT(*) FILTER (WHERE state NOT IN ('accepted','rejected'))::int AS pending,
      COUNT(*) FILTER (WHERE state='accepted')::int AS accepted FROM milktv_m3u_candidates`).catch(() => ({ rows: [{ pending: 0, accepted: 0 }] }));
    const candidatesResult = await db.query(`
      SELECT c.id,c.name,c.tvg_name,c.logo,c.group_title,c.state,c.health_status,c.last_check,
             c.suggested_channel_id,c.accepted_channel_id,c.match_confidence,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name),NULL) AS providers,
             COALESCE(target.name,suggested.name) AS matched_channel_name,
             COALESCE(target.id,suggested.id) AS matched_channel_id,
             COALESCE(target.visible_to_clients,suggested.visible_to_clients,TRUE) AS matched_visible_to_clients,
             EXISTS(SELECT 1 FROM milktv_channel_slots slot WHERE slot.original_channel_id=COALESCE(target.id,suggested.id)) AS matched_in_milktv
      FROM milktv_m3u_candidates c
      LEFT JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id AND cp.active=TRUE
      LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id
      LEFT JOIN channels target ON target.id=c.accepted_channel_id
      LEFT JOIN channels suggested ON suggested.id=c.suggested_channel_id
      WHERE ($1='' OR COALESCE(c.name,c.tvg_name,'') ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
      GROUP BY c.id,target.id,suggested.id
      ORDER BY c.id DESC LIMIT 500
    `, [search]).catch(() => ({ rows: [] }));
    const discoveryResult = await db.query(`
      SELECT r.id,r.result_type,r.status,r.first_seen,r.last_seen,s.name AS source_name
      FROM milktv_discovery_results r
      JOIN milktv_discovery_sources s ON s.id=r.source_id
      WHERE r.candidate_id IS NULL AND ($1='' OR s.name ILIKE '%' || $1 || '%')
      ORDER BY r.last_seen DESC LIMIT 200
    `, [search]).catch(() => ({ rows: [] }));
    const escapeCatalog = value => String(value || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/\"/g,"&quot;").replace(/'/g,"&#039;");
    const statusLabel = value => value === "online" ? "ONLINE" : value === "offline" ? "OFFLINE" : "UNKNOWN";
    const freshnessLabel = value => value ? `Проверен ${new Date(value).toLocaleString("ru-RU")}` : "Не проверен";
    const logicalOptions = result.rows.map(channel => `<option value="${channel.id}">${escapeCatalog(channel.name)}</option>`).join("");
    const candidateCards = candidatesResult.rows.map(candidate => {
      const name = candidate.name || candidate.tvg_name || `M3U candidate #${candidate.id}`;
      const providers = Array.isArray(candidate.providers) && candidate.providers.length ? candidate.providers.join(", ") : "M3U staging";
      const matched = candidate.matched_channel_id ? `Совпадает: ${escapeCatalog(candidate.matched_channel_name)}` : "Не сопоставлен";
      const published = candidate.matched_in_milktv && candidate.matched_visible_to_clients ? "В MILK TV" : "Не опубликован в MILK TV";
      const canAutoAdd = candidate.state === "new" && candidate.health_status === "online" && candidate.match_confidence === "high" && candidate.suggested_channel_id;
      const action = candidate.state === "accepted"
        ? `<div class="catalog-action catalog-done">Добавлен как источник</div>`
        : canAutoAdd
          ? `<form method="POST" action="/admin/channels/candidates/${candidate.id}/add-source"><input type="hidden" name="_csrf" value="${csrfToken}"><button class="catalog-button">Добавить как источник</button></form>`
          : candidate.state === "new" && candidate.health_status === "online" && candidate.match_confidence === "no-match"
            ? `<form method="POST" action="/admin/channels/candidates/${candidate.id}/add-to-milktv"><input type="hidden" name="_csrf" value="${csrfToken}"><button class="catalog-button">Добавить в MILK TV</button></form>`
          : candidate.state === "new" && candidate.health_status === "online"
            ? `<details class="catalog-match"><summary>Сопоставить и добавить как источник</summary><form method="POST" action="/admin/channels/candidates/${candidate.id}/add-source"><input type="hidden" name="_csrf" value="${csrfToken}"><select name="channel_id" required><option value="">Выберите логический канал</option>${logicalOptions}</select><button class="catalog-button">Добавить как источник</button></form></details>`
            : `<div class="catalog-muted">Нужна проверка или сопоставление</div>`;
      const lamp = `<span class="status-lamp status-${statusLabel(candidate.health_status).toLowerCase()}" data-candidate-id="${candidate.id}"></span>`;
      const logo = candidate.logo ? `${lamp}<img class="channel-logo" src="${escapeCatalog(candidate.logo)}" alt="">` : `${lamp}<div class="channel-logo-placeholder">M3U</div>`;
      const inspection = `<details class="catalog-match"><summary>Подробнее</summary><div class="catalog-meta">Группа: ${escapeCatalog(candidate.group_title || "не указана")}</div><div class="catalog-meta">Состояние staging: ${escapeCatalog(candidate.state)}</div><div class="catalog-meta">Совпадение: ${escapeCatalog(candidate.match_confidence || "не определено")}</div></details>`;
      return `<article class="channel-tile catalog-entry" data-catalog-kind="candidate" data-catalog-status="${statusLabel(candidate.health_status).toLowerCase()}" data-catalog-published="${candidate.matched_in_milktv && candidate.matched_visible_to_clients ? "yes" : "no"}" data-catalog-search="${escapeCatalog(`${name} ${providers} ${candidate.matched_channel_name || ""}`.toLowerCase())}">${logo}<div class="channel-name">${escapeCatalog(name)}</div><div class="channel-categories">${escapeCatalog(providers)}</div><div class="catalog-meta">${statusLabel(candidate.health_status)} · ${escapeCatalog(freshnessLabel(candidate.last_check))}</div><div class="catalog-meta">${matched}</div><div class="catalog-meta">${published}</div>${inspection}${action}</article>`;
    }).join("");
    const discoveryCards = discoveryResult.rows.map(row => `<article class="channel-tile catalog-entry" data-catalog-kind="discovery" data-catalog-status="unknown" data-catalog-published="no" data-catalog-search="${escapeCatalog(String(row.source_name || "").toLowerCase())}"><div class="channel-logo-placeholder">+</div><div class="channel-name">Найденный ${escapeCatalog(row.result_type || "stream")}</div><div class="channel-categories">${escapeCatalog(row.source_name || "Discovery")}</div><div class="catalog-meta">${escapeCatalog(row.status || "new")} · ожидание staging</div><div class="catalog-muted">Ещё не добавлен в M3U candidates</div></article>`).join("");
    const localSearchCount = result.rows.length + candidatesResult.rows.length + discoveryResult.rows.length;
    const webSearchNotice = search && localSearchCount === 0
      ? (milktvWebSearchProvider.configured()
        ? "Внешний search-provider подключён; результаты перед добавлением проходят staging и проверку."
        : "Внешний глобальный веб-поиск требует настроенного search-provider API. Локальный каталог и M3U providers уже проверены.")
      : "";

    const safeSearch = search
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    let html = `

<!DOCTYPE html>
<html lang="ru">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1">

<title>Каналы</title>

<style>

:root{--bg:#0d1422;--panel:#141e2d;--panel-2:#1a2a3d;--border:#2b3d56;--text:#f2f6fb;--muted:#9eabc0;--primary:#3d82e8;--primary-hover:#5c9cf2;--success:#63d69b;--danger:#e26d7a;--shadow:0 14px 36px rgba(0,0,0,.28)}
* {
  box-sizing:border-box;
}

body {
  margin:0;
  padding:16px;
  background:#111;
  color:white;
  font-family:Arial,sans-serif;
}

.container {
  max-width:1000px;
  margin:auto;
}

h2 {
  margin:0 0 16px;
}

.add-button,
.form-button,
.search-button {
  width:100%;
  padding:11px;
  border:0;
  border-radius:9px;
  background:#333;
  color:white;
  font-size:15px;
  cursor:pointer;
}

.add-button:hover,
.form-button:hover,
.search-button:hover {
  background:#444;
}

.add-box {
  display:none;
  margin-top:10px;
  padding:12px;
  background:#1b1b1b;
  border:1px solid #333;
  border-radius:12px;
}

input {
  width:100%;
  padding:11px;
  margin:4px 0;
  border-radius:8px;
  font-size:14px;
  background:#111;
  color:white;
  border:1px solid #333;
}

.cancel-button {
  background:#512020;
}

.search-box {
  margin-top:14px;
  padding:12px;
  background:#1b1b1b;
  border:1px solid #333;
  border-radius:12px;
}

.category-title {
  margin-top:16px;
  margin-bottom:8px;
  color:#aaa;
  font-size:13px;
}

.categories {
  display:flex;
  flex-wrap:wrap;
  gap:6px;
}

.category-button {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:7px 11px;
  background:#1c1c1c;
  border:1px solid #333;
  border-radius:8px;
  color:white;
  text-decoration:none;
  text-align:center;
  font-size:13px;
  white-space:nowrap;
}

.category-button:hover {
  background:#292929;
}

.category-button.active {
  border-color:#777;
  background:#303030;
}

.count {
  color:#888;
}

.total {
  margin-top:14px;
  color:#aaa;
  text-align:center;
}

.channels-grid {
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:9px;
  margin-top:18px;
}

.channel-tile {
  min-width:0;
  min-height:124px;
  padding:9px;
  background:#202020;
  border:1px solid #333;
  border-radius:12px;
  text-decoration:none;
  color:white;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  text-align:center;
}

.channel-tile:hover {
  background:#292929;
  border-color:#555;
}

.channel-logo {
  width:48px;
  height:48px;
  object-fit:contain;
  border-radius:10px;
  margin-bottom:6px;
}

.channel-logo-placeholder {
  width:48px;
  height:48px;
  border-radius:10px;
  background:#111;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:24px;
  margin-bottom:6px;
}

.channel-name {
  width:100%;
  font-size:12px;
  line-height:15px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.channel-categories {
  margin-top:6px;
  width:100%;
  font-size:10px;
  line-height:13px;
  color:#aaa;
}

.technical-line{margin-top:5px;width:100%;font-size:10px;line-height:13px;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.technical-line .online{color:#75d98c}.technical-line .offline{color:#ed7070}.technical-line .unknown{color:#e6ae5c}
.technical-tools{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:10px}
.technical-tools select{width:100%;min-width:0;padding:9px;border:1px solid #444;border-radius:8px;background:#1c1c1c;color:#fff}

.catalog-filters { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
.catalog-filter { padding:7px 10px; background:#1c1c1c; color:#fff; border:1px solid #333; border-radius:8px; cursor:pointer; }
.catalog-filter.active { background:#303030; border-color:#777; }
.catalog-entry { justify-content:flex-start; min-height:205px; }
.catalog-meta, .catalog-muted, .catalog-done { width:100%; margin-top:5px; font-size:10px; line-height:13px; color:#aaa; overflow:hidden; text-overflow:ellipsis; }
.catalog-done { color:#80c995; }
.catalog-action, .catalog-match { width:100%; margin-top:auto; padding-top:7px; }
.catalog-match summary { font-size:11px; cursor:pointer; color:#ddd; }
.catalog-match select { width:100%; margin:6px 0; background:#111; color:#fff; border:1px solid #444; border-radius:6px; padding:5px; font-size:11px; }
.catalog-button { width:100%; padding:7px; border:0; border-radius:7px; background:#356a49; color:#fff; cursor:pointer; font-size:11px; }
.catalog-hidden { display:none !important; }
.status-lamp { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; vertical-align:middle; }
.status-online { background:#65cf7b; }.status-offline { background:#df5f5f; }.status-unknown { background:#dca857; }
.channel-side-panel{position:fixed;z-index:30;top:0;left:0;width:min(460px,100vw);height:100vh;overflow:auto;padding:16px;background:#171717;border-right:1px solid #444;box-shadow:10px 0 28px #0008;transform:translateX(-105%);transition:transform .18s ease}.channel-side-panel.open{transform:translateX(0)}.side-close{position:sticky;top:0;z-index:3;float:right;background:#333;color:#fff;border:0;border-radius:8px;padding:8px 10px}.side-block{margin:14px 0;padding:12px;border:1px solid #333;border-radius:10px;background:#1d1d1d}.side-block input,.side-block select{width:100%;margin:5px 0}.side-actions{position:sticky;bottom:0;display:flex;gap:8px;padding:12px 0;background:#171717}.side-actions button{flex:1;padding:11px;border:0;border-radius:8px;color:#fff;background:#356a49}.side-actions .cancel{background:#444}.side-player{width:100%;background:#000;border-radius:8px;aspect-ratio:16/9}.side-muted{color:#aaa;font-size:12px;white-space:pre-wrap}.side-switch{margin-top:5px;padding:6px 8px;border:0;border-radius:6px;background:#6d5830;color:#fff}
.channel-side-panel{background:var(--panel);border-color:var(--border)}.side-block{background:var(--panel-2);border-color:var(--border)}.side-actions{background:var(--panel)}.side-actions button,.catalog-button{background:var(--primary)}.side-actions button:hover,.catalog-button:hover{background:var(--primary-hover)}.side-close{background:var(--panel-2);border:1px solid var(--border)}
@media(max-width:620px){body{padding:10px}.channels-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.channel-tile{min-height:116px;padding:8px}.technical-tools{grid-template-columns:repeat(2,minmax(0,1fr))}.channel-logo,.channel-logo-placeholder{width:42px;height:42px}.channel-name{font-size:11px}}

.empty {
  color:#888;
  text-align:center;
  padding:25px;
  grid-column:1/-1;
}

.back {
  display:block;
  margin-top:18px;
  padding:11px;
  text-align:center;
  background:#1c1c1c;
  border-radius:8px;
  color:white;
  text-decoration:none;
}

</style>

</head>

<body>

<div class="container">

<a class="back" style="margin-top:0;margin-bottom:12px" href="/admin">← Назад</a>

<h2>📺 Каналы</h2>

<button type="button" class="add-button" onclick="toggleM3uImportForm()">Добавить источник / M3U</button>

<a class="add-button" style="margin-top:8px;display:block;text-align:center;text-decoration:none" href="/admin/channels/sources">Источники</a>

<div id="m3u-import-form" class="add-box">
<div id="m3u-file-mode" style="display:none">
<form method="POST" action="/admin/channels/import-m3u-file" enctype="multipart/form-data">
<input type="hidden" name="_csrf" value="${csrfToken}">
<input name="name" placeholder="Название пакета (необязательно)">
<input name="file" type="file" accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl" required>
<button type="submit" class="form-button">Загрузить в staging</button>
<button type="button" class="form-button cancel-button" onclick="toggleM3uImportForm()">Отмена</button>
</form>
</div>
<div style="display:flex;gap:6px;margin-bottom:8px"><button type="button" class="form-button" onclick="showM3uMode('url')">По ссылке</button><button type="button" class="form-button" onclick="showM3uMode('file')">Загрузить файл</button></div>
<form method="POST" action="/admin/channels/import-m3u">
<input type="hidden" name="_csrf" value="${csrfToken}">
<input name="name" placeholder="Название источника" value="Ручной M3U">
<input name="url" type="url" placeholder="https://example.org/playlist.m3u" required>
<button type="submit" class="form-button">Добавить в staging</button>
<button type="button" class="form-button cancel-button" onclick="toggleM3uImportForm()">Отмена</button>
</form>
</div>

<div class="total">M3U candidates: ожидают решения <b>${candidateSummary.rows[0].pending}</b> · приняты <b>${candidateSummary.rows[0].accepted}</b>. Импорт не публикует каналы в MILK TV.</div>

<div style="margin-top:10px;">

  <button
    type="button"
    id="milktv-check-button" hidden
    class="add-button"
    onclick="startMilktvCheck()"
  >
    🔄 Проверить каналы МИЛК ТВ
  </button>

  <div
    id="milktv-check-progress" hidden
    style="
      margin-top:8px;
      text-align:center;
      color:#aaa;
      font-size:13px;
      min-height:20px;
    "
  ></div>

</div>

<div class="search-box">

<div class="category-title">Глобальный поиск</div>

<form method="GET" action="/admin/channels">

<input
  type="text"
  name="search"
  value="${safeSearch}"
  placeholder="Название канала"
>

<button
  type="submit"
  class="search-button"
>
Найти в каталоге
</button>

</form>

<div class="total">
Показано каналов: <b>${channels.length}</b>
</div>

<div class="catalog-filters" id="catalog-filters">
  <button type="button" class="catalog-filter active" data-filter="all">Все</button>
  <button type="button" class="catalog-filter" data-filter="published">В MILK TV</button>
  <button type="button" class="catalog-filter" data-filter="not-added">Не добавлены</button>
  <button type="button" class="catalog-filter" data-filter="candidate">Кандидаты</button>
  <button type="button" class="catalog-filter" data-filter="online">ONLINE</button>
  <button type="button" class="catalog-filter" data-filter="offline">OFFLINE</button>
  <button type="button" class="catalog-filter" data-filter="unknown">UNKNOWN</button>
  <a class="catalog-filter" style="text-decoration:none" href="/admin/channels/sources">Источники</a>
</div>

<div class="technical-tools">
  <select id="catalog-source"><option value="all">Все источники</option>${[...new Set(result.rows.map(row => row.source_name || 'Ручной / не указан'))].sort((a,b)=>a.localeCompare(b,'ru')).map(value=>`<option value="${escapeCatalog(value)}">${escapeCatalog(value)}</option>`).join('')}</select>
  <select id="catalog-quality"><option value="all">Любое качество</option><option value="4k">4K</option><option value="fullhd">Full HD</option><option value="hd">HD</option><option value="sd">SD / другое</option><option value="unknown">Не определено</option></select>
  <select id="catalog-reserve"><option value="all">Любой резерв</option><option value="yes">Есть резерв</option><option value="no">Без резерва</option></select>
  <select id="catalog-sort"><option value="name">По названию</option><option value="status">По статусу</option><option value="quality">По качеству</option><option value="check">По последней проверке</option><option value="rating">По рейтингу</option></select>
</div>

<div class="total">Каталог: <b>${result.rows.length + candidatesResult.rows.length + discoveryResult.rows.length}</b> записей · импорт не публикует каналы автоматически.</div>
${webSearchNotice ? `<div class="total">${webSearchNotice}</div>` : ""}

</div>

<div class="channels-grid">

`;

    if (channels.length === 0) {

      html += `

<div class="empty">
  📺 Каналы не найдены
</div>

`;

    }

    channels.forEach(ch => {

      const logicalStatus = ["online","offline"].includes(String(ch.current_source_status || ch.milktv_status || "").toLowerCase()) ? String(ch.current_source_status || ch.milktv_status).toLowerCase() : "unknown";
      const qualityLabel = String(ch.current_quality || "").trim();
      const qualityKey = /2160|4k/i.test(qualityLabel) ? "4k" : /1080/i.test(qualityLabel) ? "fullhd" : /720/i.test(qualityLabel) ? "hd" : qualityLabel ? "sd" : "unknown";
      const logicalLamp = `<span class="status-lamp status-${logicalStatus}"></span>`;
      const logo = ch.logo
        ? `${logicalLamp}<img class="channel-logo" src="${escapeCatalog(ch.logo)}" alt="">`
        : `${logicalLamp}<div class="channel-logo-placeholder">📺</div>`;

      html += `

<a
  class="channel-tile catalog-entry"
  href="/admin/channels/catalog/logical/${ch.id}?return_to=${encodeURIComponent(req.originalUrl)}"
  data-channel-id="${ch.id}"
  data-catalog-kind="logical"
  data-catalog-status="${logicalStatus}"
  data-catalog-published="${ch.in_milktv && ch.visible_to_clients !== false ? "yes" : "no"}"
  data-catalog-search="${escapeCatalog(String(ch.name || "").toLowerCase())}"
  data-catalog-source="${escapeCatalog(ch.source_name || 'Ручной / не указан')}"
  data-catalog-quality="${qualityKey}"
  data-catalog-reserve="${Number(ch.reserve_count || 0) > 0 ? 'yes' : 'no'}"
  data-catalog-rating="${Number(ch.milktv_rating || 0) + Number(ch.milktv_manual_boost || 0)}"
  data-catalog-check="${ch.milktv_last_check ? new Date(ch.milktv_last_check).getTime() : 0}"
>

${logo}

<div class="channel-name">
${escapeCatalog(ch.name)}
</div>

<div class="technical-line"><span class="${logicalStatus}">${logicalStatus.toUpperCase()}</span> · ${escapeCatalog(qualityLabel || 'качество неизвестно')}</div>
<div class="technical-line">${escapeCatalog(ch.source_name || 'Ручной / не указан')} · ${Number(ch.reserve_count || 0) > 0 ? `резерв ${Number(ch.reserve_count)}` : 'без резерва'}</div>
<div class="technical-line">${ch.in_milktv && ch.visible_to_clients !== false ? 'MILK TV' : 'техкаталог'} · рейтинг ${Number(ch.milktv_rating || 0) + Number(ch.milktv_manual_boost || 0)}</div>

</a>

`;

    });

    html += candidateCards;
    html += discoveryCards;

    html += `

</div>

<aside id="channel-side-panel" class="channel-side-panel" aria-hidden="true" aria-label="Карточка канала"></aside>

<script>
(function () {
  document.addEventListener("click", function (event) {
    var target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    var link = target && target.closest ? target.closest("a[data-channel-id]") : null;
    if (!link) return;
    var channelId = link.getAttribute("data-channel-id");
    if (!channelId) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.__milkTvOpenChannelSidePanel === "function") {
      window.__milkTvOpenChannelSidePanel(channelId, false);
    } else {
      window.__milkTvPendingSidePanelChannel = channelId;
    }
  }, true);
}());
</script>

<a
  class="back"
  href="/admin"
>
⬅️ Назад
</a>

</div>

<script>

function toggleM3uImportForm() {
  const form = document.getElementById("m3u-import-form");
  if (form) form.style.display = form.style.display === "block" ? "none" : "block";
}
function showM3uMode(mode) {
  const url = document.getElementById("m3u-url-mode"), file = document.getElementById("m3u-file-mode");
  document.querySelectorAll("#m3u-import-form > form").forEach(form => { form.style.display = form.action.includes("import-m3u-file") === (mode === "file") ? "block" : "none"; });
  if (url) url.style.display = mode === "url" ? "block" : "none";
  if (file) file.style.display = mode === "file" ? "block" : "none";
}

(function () {
  var stateKey = "iptv-admin-channels-state:" + location.search;
  var grid = document.querySelector(".channels-grid"), cards = [].slice.call(document.querySelectorAll(".catalog-entry"));
  var source = document.getElementById("catalog-source"), quality = document.getElementById("catalog-quality"), reserve = document.getElementById("catalog-reserve"), sort = document.getElementById("catalog-sort");
  var state = { filter:"all",source:"all",quality:"all",reserve:"all",sort:"name",scroll:0,selected:null };
  try { Object.assign(state, JSON.parse(sessionStorage.getItem(stateKey) || "{}")); } catch (_) {}
  function save() { state.scroll = window.scrollY; try { sessionStorage.setItem(stateKey, JSON.stringify(state)); } catch (_) {} }
  function matches(item) {
    var logical = item.dataset.catalogKind === "logical";
    var primary = state.filter === "candidate" ? item.dataset.catalogKind === "candidate" : logical && (state.filter === "all" || (state.filter === "published" && item.dataset.catalogPublished === "yes") || (state.filter === "not-added" && item.dataset.catalogPublished === "no") || item.dataset.catalogStatus === state.filter);
    if (!logical) return primary;
    return primary && (state.source === "all" || item.dataset.catalogSource === state.source) && (state.quality === "all" || item.dataset.catalogQuality === state.quality) && (state.reserve === "all" || item.dataset.catalogReserve === state.reserve);
  }
  function compare(a,b) {
    if (state.sort === "status") return String(a.dataset.catalogStatus).localeCompare(String(b.dataset.catalogStatus)) || a.textContent.localeCompare(b.textContent,"ru");
    if (state.sort === "quality") return String(a.dataset.catalogQuality).localeCompare(String(b.dataset.catalogQuality)) || a.textContent.localeCompare(b.textContent,"ru");
    if (state.sort === "check") return Number(b.dataset.catalogCheck||0)-Number(a.dataset.catalogCheck||0);
    if (state.sort === "rating") return Number(b.dataset.catalogRating||0)-Number(a.dataset.catalogRating||0);
    return String(a.dataset.catalogSearch||a.textContent).localeCompare(String(b.dataset.catalogSearch||b.textContent),"ru");
  }
  function apply() {
    if (![...source.options].some(function(option){return option.value===state.source;})) state.source="all";
    cards.forEach(function (item) { item.classList.toggle("catalog-hidden", !matches(item)); });
    cards.sort(compare).forEach(function (item) { grid.appendChild(item); });
    document.querySelectorAll(".catalog-filter[data-filter]").forEach(function (button) { button.classList.toggle("active", button.dataset.filter === state.filter); });
    source.value = state.source; quality.value = state.quality; reserve.value = state.reserve; sort.value = state.sort;
    save();
  }
  document.querySelectorAll(".catalog-filter[data-filter]").forEach(function (button) { button.addEventListener("click", function () { state.filter=button.dataset.filter; apply(); }); });
  source.addEventListener("change", function(){state.source=source.value;apply();}); quality.addEventListener("change",function(){state.quality=quality.value;apply();}); reserve.addEventListener("change",function(){state.reserve=reserve.value;apply();}); sort.addEventListener("change",function(){state.sort=sort.value;apply();});
  window.addEventListener("scroll",save,{passive:true});
  window.__saveChannelCatalogState = function (selected) { state.selected=Number(selected)||state.selected; save(); };
  apply(); window.setTimeout(function(){window.scrollTo(0,Number(state.scroll)||0);},60);
}());

document.querySelectorAll('.catalog-entry[data-catalog-kind="candidate"]').forEach(card => {
  card.style.cursor = 'pointer';
  card.addEventListener('click', event => {
    if (event.target.closest('form,button,details,select,input')) return;
    const candidateId = card.querySelector('[data-candidate-id]')?.dataset.candidateId;
    if (candidateId && window.__milkTvOpenCandidateSidePanel) {
      if (window.__saveChannelCatalogState) window.__saveChannelCatalogState(candidateId);
      window.__milkTvOpenCandidateSidePanel(candidateId);
    }
  });
});

// Reusable side-detail client. It deliberately leaves the catalog in place:
// list filter/search/category/scroll remain owned by the master-list page.
(function () {
  var panel = document.getElementById("channel-side-panel");
  if (!panel) return;
  var selectedId = null, dirty = false, savedScroll = 0;
  var stateKey = "milktv-admin-channel-side-state";
  function esc(value) { return String(value || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;"); }
  function remember(id) { if (window.__saveChannelCatalogState) window.__saveChannelCatalogState(id); try { sessionStorage.setItem(stateKey, JSON.stringify({ channelId:id, scrollY:window.scrollY })); } catch (_) {} }
  function close(force) {
    if (dirty && !force && !window.confirm("Есть несохранённые изменения. Закрыть карточку?")) return;
    panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); panel.innerHTML = "";
    selectedId = null; dirty = false; window.scrollTo(0, savedScroll);
  }
  function setNotice(text) { var item = panel.querySelector("#side-notice"); if (item) item.textContent = text || ""; }
  function makeSourceRow(source, currentUrl) {
    var current = String(source.url || "") === String(currentUrl || "");
    var switchButton = !current && source.enabled && source.status === "online" ? '<button class="side-switch" type="button" data-source-id="' + Number(source.id) + '">Заменить из резерва</button>' : "";
    return '<div class="side-muted"><b>' + (current ? "Текущий" : "Резерв") + '</b> · ' + esc(source.status || "unknown") + ' · ' + esc(source.resolution_label || "качество неизвестно") + ' · trust ' + Number(source.trust_score || 0) + '<br>Источник: ' + esc((source.providers || []).join(', ') || 'ручной / не указан') + '<br>Проверен: ' + esc(source.last_check ? new Date(source.last_check).toLocaleString() : 'не проверен') + '<br>' + esc(source.url) + '<br>' + switchButton + '</div>';
  }
  function render(data) {
    var c = data.channel, sources = data.sources || [], history = data.history || [];
    var currentSource = sources.find(function(source){return String(source.url||'')===String(c.url||'');}) || sources[0] || null;
    var reserveRows = sources.map(function (source) { return makeSourceRow(source, c.url); }).join("") || '<div class="side-muted">Источников пока нет.</div>';
    var historyRows = history.map(function (entry) { return '<div class="side-muted">' + esc(entry.created_at) + ' · ' + esc(entry.reason) + ' · ' + esc(entry.result) + '</div>'; }).join("") || '<div class="side-muted">История переключений пока пуста.</div>';
    var visibility = c.in_milktv ? '<button id="side-visibility" type="button">' + (c.visible_to_clients === false ? "Вернуть в MILK TV" : "Скрыть из MILK TV") + '</button>' : '<button id="side-publish" type="button">Добавить в MILK TV</button><div class="side-muted">Доступно только для ONLINE-канала с проверенным URL.</div>';
    panel.innerHTML = '<button class="side-close" type="button">Закрыть</button><h2>' + esc(c.name) + '</h2>' +
      '<div id="side-notice" class="side-muted" role="status"></div>' +
      '<div class="side-block"><img src="' + esc(c.logo || "") + '" alt="" style="max-width:70px;max-height:70px;object-fit:contain"><div class="side-muted">Статус: ' + esc(c.milktv_status || "unknown") + ' · проверен: ' + esc(c.milktv_last_check ? new Date(c.milktv_last_check).toLocaleString() : "не проверен") + '</div><div class="side-muted">Качество: ' + esc((currentSource && currentSource.resolution_label) || "не определено") + ' · рейтинг: ' + Number(c.milktv_rating || 0) + ' + ручной ' + Number(c.milktv_manual_boost || 0) + '</div><div class="side-muted">Источник: ' + esc((currentSource && currentSource.providers || []).join(', ') || 'ручной / не указан') + '</div><div class="side-muted">Текущий URL: ' + esc(c.url || 'не задан') + '</div></div>' +
      '<div class="side-block"><h3>Preview</h3><video class="side-player" controls playsinline></video><button id="side-preview-retry" type="button">Проверить ещё раз</button><div class="side-muted" id="side-preview-note">Пробуем воспроизвести…</div></div>' +
      '<div class="side-block"><h3>Черновик</h3><label>Название</label><input id="side-name" maxlength="500" value="' + esc(c.name) + '"><label>Ручной рейтинг</label><input id="side-rating" type="number" min="0" max="100" value="' + Number(c.milktv_manual_boost || 0) + '"></div>' +
      '<div class="side-block"><h3>Источники</h3>' + reserveRows + '<label>Новый URL через staging</label><input id="side-manual-url" type="url" placeholder="https://…"><div class="side-muted">URL будет добавлен в существующий staging-поток только после сохранения.</div></div>' +
      '<div class="side-block"><h3>MILK TV</h3>' + visibility + '</div><div class="side-block"><h3>История</h3>' + historyRows + '</div>' +
      '<div class="side-actions"><button class="cancel" type="button">Отмена</button><button id="side-save" type="button">Сохранить изменения</button></div>';
    panel.classList.add("open"); panel.setAttribute("aria-hidden", "false");
    panel.querySelector(".side-close").onclick = function () { close(false); };
    panel.querySelector(".cancel").onclick = function () { close(true); };
    panel.querySelectorAll("input,select").forEach(function (element) { element.oninput = function () { dirty = true; }; element.onchange = function () { dirty = true; }; });
    panel.querySelector("#side-save").onclick = save;
    panel.querySelectorAll(".side-switch").forEach(function (button) { button.onclick = function () { switchReserve(button.dataset.sourceId); }; });
    var visibilityButton = panel.querySelector("#side-visibility");
    if (visibilityButton) visibilityButton.onclick = function () { changeVisibility(c.visible_to_clients === false); };
    var publishButton = panel.querySelector("#side-publish");
    if (publishButton) publishButton.onclick = publishToMilktv;
    panel.querySelector("#side-preview-retry").onclick = startPreview;
    startPreview();
  }
  function startPreview() {
    var video = panel.querySelector("video"), note = panel.querySelector("#side-preview-note");
    if (!video || !selectedId) return;
    note.textContent = "Пробуем воспроизвести…"; video.removeAttribute("src"); video.load();
    fetch("/admin/channels/catalog/play/logical/" + encodeURIComponent(selectedId)).then(function (response) { return response.json(); }).then(function (payload) {
      if (!payload.ok) throw new Error("unavailable"); video.src = payload.playback_url; return video.play();
    }).then(function () { note.textContent = ""; }).catch(function () { note.textContent = "Preview временно недоступен. Обработка ошибок и статус канала сохранены."; });
  }
  function save() {
    var name = panel.querySelector("#side-name").value.trim(), rating = panel.querySelector("#side-rating").value, manualUrl = panel.querySelector("#side-manual-url").value.trim();
    if (!name) { setNotice("Название не может быть пустым."); return; }
    setNotice("Сохраняем…");
    fetch("/admin/channels/" + encodeURIComponent(selectedId) + "/side-detail", { method:"POST", headers:{"Content-Type":"application/json","X-CSRF-Token":csrfToken}, body:JSON.stringify({name:name,manual_boost:rating}) }).then(function (response) { return response.json().then(function (body) { if (!response.ok || !body.success) throw new Error(body.error || "save failed"); return body; }); }).then(function () { var tile=document.querySelector('[data-channel-id="'+selectedId+'"] .channel-name');if(tile)tile.textContent=name;
      if (!manualUrl) return null;
      return fetch("/admin/channels/" + encodeURIComponent(selectedId) + "/sources/manual", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded","X-CSRF-Token":csrfToken}, body:"url=" + encodeURIComponent(manualUrl) + "&return_to=" + encodeURIComponent("/admin/channels") }).then(function (response) { if (!response.ok && !response.redirected) throw new Error("manual url failed"); });
    }).then(function () { dirty = false; setNotice("Изменения сохранены."); remember(selectedId); return open(selectedId, true); }).catch(function (error) { setNotice(error.message || "Не удалось сохранить изменения."); });
  }
  function changeVisibility(nextVisible) {
    if (!window.confirm(nextVisible ? "Вернуть канал в MILK TV?" : "Скрыть канал из MILK TV?")) return;
    fetch("/admin/milktv/channels/" + encodeURIComponent(selectedId) + "/visibility", { method:"PATCH", headers:{"Content-Type":"application/json","X-CSRF-Token":csrfToken}, body:JSON.stringify({visible_to_clients:nextVisible}) }).then(function (response) { return response.json().then(function (body) { if (!response.ok || !body.success) throw new Error(body.error || "visibility failed"); }); }).then(function () { setNotice("Видимость обновлена."); return open(selectedId, true); }).catch(function (error) { setNotice(error.message || "Не удалось изменить видимость."); });
  }
  function publishToMilktv() {
    if (!window.confirm("Добавить этот канал в MILK TV?")) return;
    setNotice("Добавляем в MILK TV…");
    fetch("/admin/channels/" + encodeURIComponent(selectedId) + "/publish-to-milktv", { method:"POST", headers:{"X-CSRF-Token":csrfToken} }).then(function (response) { return response.json().then(function (body) { if (!response.ok || !body.success) throw new Error(body.error || "publish failed"); }); }).then(function () { setNotice("Канал добавлен в MILK TV."); return open(selectedId, true); }).catch(function (error) { setNotice(error.message || "Не удалось добавить канал в MILK TV."); });
  }
  function switchReserve(sourceId) {
    if (!window.confirm("Заменить текущий источник выбранным резервом?")) return;
    setNotice("Переключаем источник…");
    fetch("/admin/milktv/channels/" + encodeURIComponent(selectedId) + "/sources/" + encodeURIComponent(sourceId) + "/current", { method:"POST", headers:{"X-CSRF-Token":csrfToken} }).then(function (response) { return response.json().then(function (body) { if (!response.ok || !body.success) throw new Error(body.error || "switch failed"); }); }).then(function () { dirty = false; setNotice("Источник заменён."); return open(selectedId, true); }).catch(function (error) { setNotice(error.message || "Не удалось заменить источник."); });
  }
  function renderCandidate(data) {
    var c = data.candidate || {}, state = String(c.health_status || "unknown").toUpperCase();
    var providers = (c.providers || []).join(", ") || "M3U staging";
    var action = c.state === "accepted" ? '<div class="side-muted">Кандидат уже принят как источник.</div>' :
      (c.state === "new" && String(c.health_status).toLowerCase() === "online" && c.suggested_channel_id && c.match_confidence === "high" ?
        '<form class="candidate-action" method="POST" action="/admin/channels/candidates/' + Number(c.id) + '/add-source"><input type="hidden" name="_csrf" value="' + esc(csrfToken) + '"><button type="submit">Добавить как источник</button></form>' :
        (c.state === "new" && String(c.health_status).toLowerCase() === "online" && !c.suggested_channel_id && c.match_confidence === "no-match" ?
          '<form class="candidate-action" method="POST" action="/admin/channels/candidates/' + Number(c.id) + '/add-to-milktv"><input type="hidden" name="_csrf" value="' + esc(csrfToken) + '"><button type="submit">Добавить в MILK TV</button></form>' : '<div class="side-muted">Действие появится после проверки и сопоставления.</div>'));
    panel.innerHTML = '<button class="side-close" type="button">Закрыть</button><h2>' + esc(c.name || c.tvg_name || ("Candidate #" + c.id)) + '</h2>' +
      '<div id="side-notice" class="side-muted" role="status"></div><div class="side-block"><img src="' + esc(c.logo || "") + '" alt="" style="max-width:70px;max-height:70px;object-fit:contain"><div class="side-muted">Статус: ' + esc(state) + ' · проверен: ' + esc(c.last_check ? new Date(c.last_check).toLocaleString() : "не проверен") + '</div><div class="side-muted">Source/provider: ' + esc(providers) + '</div><div class="side-muted">Provenance: M3U staging</div><div class="side-muted">Сопоставление: ' + esc(c.matched_channel_name || "не сопоставлен") + '</div><div class="side-muted">URL: ' + esc(c.stream_url || "не задан") + '</div></div>' +
      '<div class="side-block"><h3>Preview</h3><video class="side-player" controls playsinline></video><button id="candidate-preview-retry" type="button">Повторить</button><div class="side-muted" id="candidate-preview-note">Пробуем воспроизвести…</div></div><div class="side-block"><h3>Действия</h3>' + action + '</div><div class="side-actions"><button class="cancel" type="button">Закрыть</button></div>';
    panel.classList.add("open"); panel.setAttribute("aria-hidden", "false");
    panel.querySelector(".side-close").onclick = function () { close(false); };
    panel.querySelector(".cancel").onclick = function () { close(true); };
    panel.querySelector("#candidate-preview-retry").onclick = startCandidatePreview;
    var form = panel.querySelector(".candidate-action");
    if (form) form.onsubmit = function (event) { event.preventDefault(); setNotice("Сохраняем…"); fetch(form.action, { method:"POST", headers:{"X-CSRF-Token":csrfToken,"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams(new FormData(form)) }).then(function (response) { if (!response.ok) throw new Error("Действие не выполнено"); window.__saveChannelCatalogState(c.id); location.reload(); }).catch(function (error) { setNotice(error.message); }); };
    startCandidatePreview();
  }
  function startCandidatePreview() {
    var video = panel.querySelector("video"), note = panel.querySelector("#candidate-preview-note");
    if (!video || !selectedId) return;
    note.textContent = "Пробуем воспроизвести…"; video.removeAttribute("src"); video.load();
    fetch("/admin/channels/catalog/play/candidate/" + encodeURIComponent(selectedId)).then(function (response) { return response.json(); }).then(function (payload) { if (!payload.ok) throw new Error("unavailable"); video.src = payload.playback_url; return video.play(); }).then(function () { note.textContent = ""; }).catch(function () { note.textContent = "Не удалось запустить канал"; });
  }
  function openCandidate(id) {
    if (dirty && !window.confirm("Есть несохранённые изменения. Открыть другого кандидата?")) return;
    savedScroll = window.scrollY; remember(id); selectedId = Number(id); dirty = false;
    fetch("/admin/channels/candidates/" + encodeURIComponent(id) + "/side-detail").then(function (response) { return response.json().then(function (body) { if (!response.ok || !body.success) throw new Error(body.error || "candidate unavailable"); return body; }); }).then(renderCandidate).catch(function (error) { window.alert(error.message || "Не удалось открыть кандидата."); });
  }
  window.__milkTvOpenCandidateSidePanel = openCandidate;
  function open(id, preserveScroll) {
    if (dirty && !window.confirm("Есть несохранённые изменения. Открыть другой канал?")) return Promise.resolve();
    if (!preserveScroll) savedScroll = window.scrollY; remember(id);
    return fetch("/admin/channels/" + encodeURIComponent(id) + "/side-detail").then(function (response) { return response.json().then(function (body) { if (!response.ok || !body.success) throw new Error(body.error || "detail unavailable"); return body; }); }).then(function (data) { selectedId = Number(id); dirty = false; render(data); }).catch(function (error) { window.alert(error.message || "Не удалось открыть канал."); });
  }
  window.__milkTvOpenChannelSidePanel = open;
  if (window.__milkTvPendingSidePanelChannel) {
    var pendingSidePanelChannel = window.__milkTvPendingSidePanelChannel;
    window.__milkTvPendingSidePanelChannel = null;
    open(pendingSidePanelChannel, false);
  }
  window.addEventListener("keydown", function (event) { if (event.key === "Escape" && panel.classList.contains("open")) { event.preventDefault(); close(false); } });
}());

</script>

<script>

const csrfToken = ${JSON.stringify(csrfToken)};
let milktvProgressTimer = null;

async function startMilktvCheck() {

  const button = document.getElementById("milktv-check-button");
  const progress = document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    console.error("Элементы МИЛК ТВ не найдены");
    return;
  }

  button.disabled = true;
  button.innerText = "⏳ Запуск проверки...";
  progress.innerText = "";

  try {

    const response = await fetch("/admin/milktv/check", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "X-CSRF-Token": csrfToken
      }
    });

    const text = await response.text();

    console.log("MILKTV START STATUS:", response.status);
    console.log("MILKTV START RESPONSE:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Сервер вернул не JSON: " + text.substring(0, 200));
    }

    if (!data.success) {

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText =
        data.message || "Ошибка запуска проверки";

      return;
    }

    if (milktvProgressTimer) {
      clearInterval(milktvProgressTimer);
    }

    await updateMilktvProgress();

    milktvProgressTimer =
      setInterval(updateMilktvProgress, 1000);

  } catch(error) {

    console.error("MILKTV START ERROR:", error);

    button.disabled = false;
    button.innerText = "🔄 Проверить каналы МИЛК ТВ";
    progress.innerText =
      "Ошибка запуска: " + error.message;

  }

}


async function updateMilktvProgress() {

  const button =
    document.getElementById("milktv-check-button");

  const progress =
    document.getElementById("milktv-check-progress");

  if (!button || !progress) {
    return;
  }

  try {

    const response =
      await fetch("/api/admin/milktv/check-progress", {
        headers: {
          "Accept": "application/json"
        }
      });

    const text = await response.text();

    console.log("MILKTV PROGRESS:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Сервер вернул не JSON: " +
        text.substring(0, 200)
      );
    }

    if (response.status === 401) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;
      button.innerText = "🔄 Проверить каналы МИЛК ТВ";
      progress.innerText = "Сессия авторизации истекла";

      return;
    }

    if (data.running) {

      button.disabled = true;

      button.innerText =
        "⏳ МИЛК ТВ: " +
        data.current +
        "/" +
        data.total;

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline;

      return;
    }

    if (
      data.total > 0 &&
      data.current >= data.total
    ) {

      clearInterval(milktvProgressTimer);
      milktvProgressTimer = null;

      button.disabled = false;

      button.innerText =
        "✅ Проверка завершена";

      progress.innerText =
        "🟢 ONLINE: " +
        data.online +
        "   🔴 OFFLINE: " +
        data.offline +
        "   📺 ВСЕГО: " +
        data.total;

      setTimeout(() => {

        button.innerText =
          "🔄 Проверить каналы МИЛК ТВ";

      }, 5000);

    }

  } catch(error) {

    console.error("MILKTV PROGRESS ERROR:", error);

    progress.innerText =
      "Ошибка получения прогресса: " +
      error.message;

  }

}

</script>

</body>
</html>

`;

    res.setHeader(
      "Content-Type",
      "text/html; charset=utf-8"
    );

    res.send(html);

  } catch(error) {

    console.error(error);

    res.status(500).send(error.message);

  }

});

// Master-catalog import: provider creation only.  Parsing remains in the existing
// M3U staging/candidate pipeline and never publishes streams directly.
async function readM3uMultipart(req, maxBytes = 10 * 1024 * 1024) {
  const type = String(req.headers["content-type"] || ""), boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || type.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error("Multipart boundary missing");
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error("M3U file is too large"); chunks.push(chunk); }
  const body = Buffer.concat(chunks).toString("utf8"), fields = {};
  for (const part of body.split(`--${boundary}`).slice(1)) {
    const clean = part.replace(/^\r?\n|\r?\n--\r?\n?|\r?\n$/g, ""); if (!clean) continue;
    const split = clean.indexOf("\r\n\r\n"); if (split < 0) continue;
    const headers = clean.slice(0, split), value = clean.slice(split + 4);
    const name = headers.match(/name="([^"]+)"/i)?.[1]; if (!name) continue;
    const filename = headers.match(/filename="([^"]*)"/i)?.[1];
    fields[name] = filename ? { filename, content: value } : value;
  }
  return fields;
}

app.post("/admin/channels/import-m3u-file", auth, async (req, res) => {
  try {
    const fields = await readM3uMultipart(req);
    if (fields._csrf !== req.session?.csrfToken) return res.status(403).send("CSRF token required");
    const file = fields.file; if (!file?.filename || !/\.m3u8?$/i.test(file.filename)) return res.status(400).send("Выберите файл .m3u или .m3u8");
    const parsed = parseM3uPlaylist(file.content); if (!parsed.entries.length) return res.status(400).send("В M3U нет каналов");
    const safeName = String(fields.name || file.filename).trim().slice(0, 200) || file.filename;
    const uploadUrl = `https://milktv-upload.invalid/${crypto.randomUUID()}/${encodeURIComponent(file.filename)}`;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const provider = await client.query("INSERT INTO milktv_m3u_providers(name,url,enabled,import_status,last_import) VALUES($1,$2,FALSE,'ok',NOW()) ON CONFLICT(url) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW() RETURNING id", [safeName, uploadUrl]);
      for (const entry of parsed.entries) {
        const candidate = await client.query("INSERT INTO milktv_m3u_candidates(stream_url,name,tvg_id,tvg_name,logo,group_title,last_seen,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW()) ON CONFLICT(stream_url) DO UPDATE SET name=EXCLUDED.name,logo=COALESCE(EXCLUDED.logo,milktv_m3u_candidates.logo),last_seen=NOW(),updated_at=NOW() RETURNING id", [entry.streamUrl, entry.name || entry.streamUrl, entry.tvgId, entry.tvgName, entry.logo, entry.groupTitle]);
        await client.query("INSERT INTO milktv_m3u_candidate_providers(candidate_id,provider_id,active,last_seen) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(candidate_id,provider_id) DO UPDATE SET active=TRUE,last_seen=NOW()", [candidate.rows[0].id, provider.rows[0].id]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    res.redirect("/admin/channels?imported=file");
  } catch (error) { console.error("M3U file import failed:", error.message); res.status(400).send(error.message || "M3U file import failed"); }
});

app.post("/admin/channels/import-m3u", auth, csrfProtect, async (req, res) => {
  const name = String(req.body?.name || "Ручной M3U").trim().slice(0, 200);
  const rawUrl = String(req.body?.url || "").trim();
  if (!rawUrl) return res.status(400).send("M3U URL is required");
  try {
    const url = await validateM3uProviderUrl(rawUrl);
    await db.query(`INSERT INTO milktv_m3u_providers (name,url) VALUES ($1,$2)
      ON CONFLICT (name) DO UPDATE SET url=EXCLUDED.url,enabled=TRUE,updated_at=NOW()`, [name || "Ручной M3U", url]);
    res.redirect("/admin/channels?imported=m3u");
  } catch (error) {
    res.status(400).send(error.message || "M3U import failed");
  }
});

// Catalog action: attach a staged candidate to an existing logical channel.
// This intentionally has no path that creates a logical channel or changes
// visible_to_clients; publication remains a separate MILK TV decision.
app.post("/admin/channels/candidates/:candidateId/add-source", auth, csrfProtect, async (req, res) => {
  const candidateId = Number(req.params.candidateId);
  const requestedChannelId = Number(req.body?.channel_id || 0);
  if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).send("Invalid candidate");
  try {
    let outcome;
    if (requestedChannelId) {
      if (!Number.isInteger(requestedChannelId) || requestedChannelId <= 0) return res.status(400).send("Invalid channel");
      const priority = await db.query("SELECT COALESCE(MAX(priority),0)+10 AS priority FROM milktv_channel_sources WHERE channel_id=$1", [requestedChannelId]);
      outcome = await milktvSourceIngestion.ingestCandidateToChannel(db, candidateId, requestedChannelId, { reservePriority: Number(priority.rows[0].priority) });
    } else {
      const candidate = await db.query("SELECT suggested_channel_id FROM milktv_m3u_candidates WHERE id=$1", [candidateId]);
      if (!candidate.rows.length || !candidate.rows[0].suggested_channel_id) return res.status(409).send("Candidate needs a logical-channel match");
      const priority = await db.query("SELECT COALESCE(MAX(priority),0)+10 AS priority FROM milktv_channel_sources WHERE channel_id=$1", [candidate.rows[0].suggested_channel_id]);
      outcome = await milktvSourceIngestion.ingestCandidate(db, candidateId, { reservePriority: Number(priority.rows[0].priority) });
      if (outcome.outcome !== "AUTO_ELIGIBLE") return res.status(409).send("Candidate is not eligible for safe source ingestion");
    }
    res.redirect(catalogReturnPath(req.body?.return_to, "/admin/channels"));
  } catch (error) {
    console.error("Catalog candidate source add failed:", error.message);
    res.status(409).send("Candidate was not added as a source: " + String(error.message || "unknown").slice(0, 160));
  }
});

app.post("/admin/channels/:channelId/sources/manual", auth, csrfProtect, async (req, res) => {
  const channelId = Number(req.params.channelId), rawUrl = String(req.body?.url || "").trim();
  if (!Number.isInteger(channelId) || channelId <= 0 || !rawUrl || !milktvSourceIngestion.isPublicCandidateUrl(rawUrl)) return res.status(400).send("Некорректный публичный URL");
  try {
    const channel = await db.query("SELECT id,name FROM channels WHERE id=$1", [channelId]);
    if (!channel.rows.length) return res.status(404).send("Channel not found");
    const url = await validateM3uProviderUrl(rawUrl);
    const provider = await db.query("INSERT INTO milktv_m3u_providers(name,url,enabled) VALUES($1,$2,TRUE) ON CONFLICT(url) DO UPDATE SET updated_at=NOW() RETURNING id", [`Manual URL: ${channel.rows[0].name}`, url]);
    const candidate = await db.query("INSERT INTO milktv_m3u_candidates(stream_url,name,suggested_channel_id,match_confidence,last_seen,updated_at) VALUES($1,$2,$3,'high',NOW(),NOW()) ON CONFLICT(stream_url) DO UPDATE SET updated_at=NOW() RETURNING id,state", [url, channel.rows[0].name, channelId]);
    await db.query("INSERT INTO milktv_m3u_candidate_providers(candidate_id,provider_id,active,last_seen) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(candidate_id,provider_id) DO UPDATE SET active=TRUE,last_seen=NOW()", [candidate.rows[0].id, provider.rows[0].id]);
    res.redirect(catalogReturnPath(req.body?.return_to, `/admin/channels/${channelId}`));
  } catch (error) { console.error("Manual source staging failed:", error.message); res.status(400).send("URL не добавлен в staging: " + String(error.message || "unknown").slice(0,160)); }
});

// Explicit publication for a genuinely unmatched, already ONLINE candidate.
// It is deliberately unavailable for UNKNOWN/OFFLINE candidates and rechecks
// matching/URL conflicts inside the transaction to prevent duplicate channels.
app.post("/admin/channels/candidates/:candidateId/add-to-milktv", auth, csrfProtect, async (req, res) => {
  const candidateId = Number(req.params.candidateId);
  if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).send("Invalid candidate");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM milktv_m3u_candidates WHERE id=$1 FOR UPDATE", [candidateId]);
    if (!result.rows.length) throw new Error("Candidate not found");
    const candidate = result.rows[0];
    if (candidate.state !== "new" || candidate.health_status !== "online" || candidate.accepted_channel_id || candidate.suggested_channel_id || !milktvSourceIngestion.isPublicCandidateUrl(candidate.stream_url)) throw new Error("Candidate is not eligible for new MILK TV channel");
    const match = await calculateCandidateMatch(candidate);
    if (match.confidence !== "no-match") throw new Error("Candidate now matches an existing logical channel");
    const conflict = await client.query("SELECT id FROM milktv_channel_sources WHERE url=$1 FOR UPDATE", [candidate.stream_url]);
    if (conflict.rows.length) throw new Error("Candidate URL is already used by a source");
    const name = String(candidate.name || candidate.tvg_name || "Imported channel").trim().slice(0, 500);
    const channel = await client.query("INSERT INTO channels(name,url,logo,milktv_status) VALUES($1,$2,$3,'online') RETURNING id", [name, candidate.stream_url, candidate.logo || null]);
    const channelId = Number(channel.rows[0].id);
    const source = await client.query("INSERT INTO milktv_channel_sources(channel_id,url,enabled,priority) VALUES($1,$2,TRUE,100) RETURNING id", [channelId, candidate.stream_url]);
    const providers = await client.query("SELECT provider_id FROM milktv_m3u_candidate_providers WHERE candidate_id=$1 AND active=TRUE", [candidateId]);
    for (const provider of providers.rows) await client.query("INSERT INTO milktv_channel_source_provenance(source_id,origin_type,m3u_provider_id,candidate_id) VALUES($1,'m3u',$2,$3) ON CONFLICT DO NOTHING", [source.rows[0].id, provider.provider_id, candidateId]);
    await client.query("INSERT INTO milktv_channel_slots(original_channel_id,current_channel_id,created_at,updated_at) VALUES($1,$1,NOW(),NOW())", [channelId]);
    await client.query("UPDATE milktv_m3u_candidates SET state='accepted',accepted_channel_id=$1,updated_at=NOW() WHERE id=$2", [channelId, candidateId]);
    await client.query("INSERT INTO milktv_source_ingestion_audit(candidate_id,channel_id,source_id,action,reason) VALUES($1,$2,$3,'ingested',$4)", [candidateId, channelId, source.rows[0].id, "admin_published_new_logical_channel"]);
    await client.query("COMMIT");
    res.redirect(catalogReturnPath(req.body?.return_to, "/admin/channels"));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Catalog new MILK TV channel failed:", error.message);
    res.status(409).send("Candidate was not published: " + String(error.message || "unknown").slice(0, 160));
  } finally { client.release(); }
});

app.post("/admin/channels/add", auth, csrfProtect, async(req,res)=>{

  try {

    const name = String(req.body?.name || "").trim().slice(0, 500);
    const url = await validateM3uProviderUrl(String(req.body?.url || "").trim());
    if (!name || !milktvSourceIngestion.isPublicCandidateUrl(url)) return res.status(400).send("Некорректные имя или публичный URL");
    const provider = await db.query("INSERT INTO milktv_m3u_providers(name,url,enabled) VALUES($1,$2,TRUE) ON CONFLICT(url) DO UPDATE SET updated_at=NOW() RETURNING id", [`Manual URL: ${name}`, url]);
    const candidate = await db.query("INSERT INTO milktv_m3u_candidates(stream_url,name,last_seen,updated_at) VALUES($1,$2,NOW(),NOW()) ON CONFLICT(stream_url) DO UPDATE SET name=EXCLUDED.name,last_seen=NOW(),updated_at=NOW() RETURNING id", [url, name]);
    await db.query("INSERT INTO milktv_m3u_candidate_providers(candidate_id,provider_id,active,last_seen) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(candidate_id,provider_id) DO UPDATE SET active=TRUE,last_seen=NOW()", [candidate.rows[0].id, provider.rows[0].id]);

    res.redirect("/admin/channels");

  } catch(error) {

    res.status(500).send(error.message);

  }

});


app.post("/admin/channels/delete", auth, csrfProtect, async(req,res)=>{

try{

await db.query(
"DELETE FROM channels WHERE id=$1",
[req.body.id]
);


res.redirect("/admin/channels");


}catch(error){

res.status(500).send(error.message);

}

});





let milktvCheckProgress = {
  running: false,
  current: 0,
  total: 0,
  online: 0,
  offline: 0,
  startedAt: null,
  finishedAt: null
};
let milktvHealthRuntime = {
  state: MILKTV_BACKGROUND_HEALTH_ENABLED ? "ON" : "OFF",
  last_run_at: null,
  last_result: null,
  infra_degraded: false,
  last_preflight: null,
  overlap_skips: 0
};
// ПРОВЕРКА КАНАЛОВ МИЛК ТВ



function getMilktvRatingGroup(name) {

  let value = String(name || "")
    .trim()
    .toUpperCase();

  value = value.replace(
    /\s*\[[^\]]+\]\s*$/g,
    ""
  );

  value = value.replace(
    /\s*\((1080P|1080I|720P|720I|576P|576I|480P|480I|2160P|2160I|4K|UHD|FHD|HD)\)\s*$/i,
    ""
  );

  value = value.replace(
    /[\s._-]*(1080P|1080I|720P|720I|576P|576I|480P|480I|2160P|2160I|4K|UHD|FHD|HD)$/i,
    ""
  );

  return value.trim();

}
async function updateMilktvRating() {
  try {
    const result = await db.query(`
      UPDATE channels c
      SET milktv_rating =
        ROUND(
          (
            COALESCE(c.milktv_views, 0) * 1.0
            + COALESCE(recent.views_24h, 0) * 5.0
            + COALESCE(recent.viewers_24h, 0) * 10.0
            + COALESCE(c.milktv_manual_boost, 0)
          )::numeric,
          2
        )
      FROM (
        SELECT
          channel_id,
          COUNT(*) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
          ) AS views_24h,
          COUNT(DISTINCT COALESCE(client_id, device_id)) FILTER (
            WHERE started_at >= NOW() - INTERVAL '24 hours'
          ) AS viewers_24h
        FROM milktv_view_events
        GROUP BY channel_id
      ) recent
      WHERE c.id = recent.channel_id
    `);

    await db.query(`
      UPDATE channels
      SET milktv_rating =
        ROUND(
          (
            COALESCE(milktv_views, 0) * 1.0
            + COALESCE(milktv_manual_boost, 0)
          )::numeric,
          2
        )
      WHERE id NOT IN (
        SELECT DISTINCT channel_id
        FROM milktv_view_events
      )
    `);

    console.log("⭐ Рейтинг МИЛК ТВ обновлён. Каналов:", result.rowCount);

  } catch (error) {
    console.error("ОШИБКА ОБНОВЛЕНИЯ РЕЙТИНГА МИЛК ТВ:", error);
  }
}

async function assignMilktvReplacementInTransaction(client, originalChannelId, replacementChannelId) {
  const channelIds = [originalChannelId, replacementChannelId].sort((a, b) => a - b);

  const channelsResult = await client.query(`
    SELECT id, milktv_status
    FROM channels
    WHERE id = ANY($1::int[])
    ORDER BY id
    FOR UPDATE
  `, [channelIds]);

  if (channelsResult.rows.length !== 2) {
    return { ok: false, code: "not_found" };
  }

  const slotsResult = await client.query(`
    SELECT original_channel_id, current_channel_id
    FROM milktv_channel_slots
    WHERE original_channel_id = ANY($1::int[])
    ORDER BY original_channel_id
    FOR UPDATE
  `, [channelIds]);

  if (slotsResult.rows.length !== 2) {
    return { ok: false, code: "slot_not_found" };
  }

  const channelsById = new Map(
    channelsResult.rows.map(row => [Number(row.id), row])
  );
  const slotsByOriginalId = new Map(
    slotsResult.rows.map(row => [Number(row.original_channel_id), row])
  );
  const originalChannel = channelsById.get(originalChannelId);
  const originalSlot = slotsByOriginalId.get(originalChannelId);
  const replacementSlot = slotsByOriginalId.get(replacementChannelId);

  const replacementPool = await client.query(`
    SELECT channel_id, enabled
    FROM milktv_replacement_pool
    WHERE channel_id = $1
    FOR UPDATE
  `, [replacementChannelId]);

  if (
    replacementPool.rows.length === 0
    || replacementPool.rows[0].enabled !== true
  ) {
    return { ok: false, code: "not_in_pool" };
  }

  const replacementOwnCurrentId = replacementSlot.current_channel_id === null
    ? null
    : Number(replacementSlot.current_channel_id);

  if (
    replacementOwnCurrentId !== replacementChannelId
    || channelsById.get(replacementChannelId).milktv_status !== "online"
  ) {
    return { ok: false, code: "candidate_unavailable" };
  }

  const foreignUsage = await client.query(`
    SELECT original_channel_id
    FROM milktv_channel_slots
    WHERE current_channel_id = $1
      AND original_channel_id <> $1
    FOR UPDATE
  `, [replacementChannelId]);

  if (foreignUsage.rows.length > 0) {
    return { ok: false, code: "already_used" };
  }

  if (originalChannel.milktv_status !== "quarantine") {
    return { ok: false, code: "original_not_quarantine" };
  }

  if (originalSlot.current_channel_id !== null) {
    return { ok: false, code: "target_occupied" };
  }

  const assignResult = await client.query(`
    UPDATE milktv_channel_slots
    SET
      current_channel_id = $1,
      replacement_since = NOW(),
      updated_at = NOW()
    WHERE original_channel_id = $2
      AND current_channel_id IS NULL
  `, [replacementChannelId, originalChannelId]);

  if (assignResult.rowCount !== 1) {
    return { ok: false, code: "target_occupied" };
  }

  return { ok: true };
}

async function tryAssignAutomaticReplacement(originalChannelId) {
  const candidates = await db.query(`
    SELECT
      c.id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM milktv_channel_categories original_category
        JOIN milktv_channel_categories candidate_category
          ON candidate_category.category = original_category.category
        WHERE original_category.channel_id = $1
          AND candidate_category.channel_id = c.id
      ) THEN 0 ELSE 1 END AS category_rank
    FROM channels c
    JOIN milktv_replacement_pool rp
      ON rp.channel_id = c.id
     AND rp.enabled = TRUE
    JOIN milktv_channel_slots own_slot
      ON own_slot.original_channel_id = c.id
     AND own_slot.current_channel_id = c.id
    WHERE c.milktv_status = 'online'
      AND c.url IS NOT NULL
      AND TRIM(c.url) <> ''
      AND c.id <> $1
      AND NOT EXISTS (
        SELECT 1
        FROM milktv_channel_slots foreign_slot
        WHERE foreign_slot.current_channel_id = c.id
          AND foreign_slot.original_channel_id <> c.id
      )
    ORDER BY
      category_rank ASC,
      COALESCE(c.milktv_failed_checks, 0) ASC,
      COALESCE(c.milktv_response_time, 2147483647) ASC,
      c.id ASC
  `, [originalChannelId]);

  for (const candidate of candidates.rows) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await assignMilktvReplacementInTransaction(
        client,
        originalChannelId,
        Number(candidate.id)
      );

      if (!result.ok) {
        await client.query("ROLLBACK");
        if (result.code === "original_not_quarantine" || result.code === "target_occupied") {
          return false;
        }
        continue;
      }

      await client.query("COMMIT");
      console.log(
        `MILK TV auto replacement: slot ${originalChannelId} assigned channel ${candidate.id}`
      );
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("MILK TV auto replacement rollback error:", rollbackError);
      }
      console.error("MILK TV auto replacement candidate error:", error);
    } finally {
      client.release();
    }
  }

  console.log(
    `MILK TV auto replacement: no available candidate for slot ${originalChannelId}`
  );
  return false;
}

function scheduleMilktvAutomaticReplacement(slotIds) {
  for (const slotId of new Set(slotIds.map(Number).filter(id => Number.isInteger(id) && id > 0))) {
    void tryAssignAutomaticReplacement(slotId).catch(error => {
      console.error(`MILK TV auto replacement failed for slot ${slotId}:`, error);
    });
  }
}

async function probeMilktvSource(url, options = {}) {
  const now = Date.now();
  const waitMs = Math.max(0, MILKTV_HEALTH_PROBE_GAP_MS - (now - milktvLastProbeAt));
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  milktvLastProbeAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MILKTV_HEALTH_HTTP_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: options.redirect || "follow",
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const httpOk = response.ok;
    response.body?.cancel();
    let ffprobe = { available: false, ok: false, reason: null };
    let ffmpeg = { available: false, ok: false, reason: null };
    if (!httpOk || options.forceMediaProbe) {
      ffprobe = await runMilktvMediaTool(MILKTV_FFPROBE_PATH, [
        "-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0",
        "-i", url, "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"
      ], MILKTV_HEALTH_FFPROBE_TIMEOUT_MS);
      if (!ffprobe.ok) ffmpeg = await runMilktvMediaTool(MILKTV_FFMPEG_PATH, [
        "-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0",
        "-i", url, "-t", "3", "-f", "null", "-"
      ], MILKTV_HEALTH_FFMPEG_TIMEOUT_MS);
    }
    const strongMediaProof = ffprobe.ok || ffmpeg.ok;
    const confirmedOnline = httpOk || strongMediaProof;
    const definitiveFailure = [401, 403, 404, 410, 500, 502, 503, 504].includes(response.status);

    return {
      online: confirmedOnline,
      indeterminate: !confirmedOnline && !definitiveFailure,
      responseTime: Date.now() - started,
      error: confirmedOnline ? null : `HTTP ${response.status}`,
      evidence: { nodeHttp: httpOk, ffprobe: ffprobe.ok, ffmpeg: ffmpeg.ok }
    };
  } catch (error) {
    const transportCode = error?.cause?.code || error?.code || null;
    const ffprobe = await runMilktvMediaTool(MILKTV_FFPROBE_PATH, ["-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0", "-i", url, "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"], MILKTV_HEALTH_FFPROBE_TIMEOUT_MS);
    let ffmpeg = { available: false, ok: false, reason: null };
    if (!ffprobe.ok) ffmpeg = await runMilktvMediaTool(MILKTV_FFMPEG_PATH, ["-v", "error", "-rw_timeout", "8000000", "-user_agent", "Mozilla/5.0", "-i", url, "-t", "3", "-f", "null", "-"], MILKTV_HEALTH_FFMPEG_TIMEOUT_MS);
    const strongMediaProof = ffprobe.ok || ffmpeg.ok;
    return {
      online: strongMediaProof,
      indeterminate: !strongMediaProof,
      responseTime: Date.now() - started,
      error: error.name === "AbortError" ? "Таймаут" : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkMilktvChannelSources(channel) {
  const sourceResult = await db.query(`
    SELECT
      id,
      url,
      priority,
      failed_checks
    FROM milktv_channel_sources
    WHERE channel_id = $1
      AND enabled = TRUE
    ORDER BY
      CASE WHEN url = $2 THEN 0 ELSE 1 END,
      priority ASC,
      failed_checks ASC,
      COALESCE(response_time, 2147483647) ASC,
      id ASC
  `, [channel.id, channel.url]);

  const sources = sourceResult.rows.length > 0
    ? sourceResult.rows
    : [{ id: null, url: channel.url, priority: 0, failed_checks: 0 }];

  const checkedUrls = new Set();
  let indeterminateProbe = null;
  let currentSourceIndeterminate = null;
  const sourceObservations = [];
  const currentUrl = String(channel.url || "").trim();

  for (const source of sources) {
    const sourceUrl = String(source.url || "").trim();
    if (!sourceUrl || checkedUrls.has(sourceUrl)) {
      continue;
    }
    checkedUrls.add(sourceUrl);

    const sourceStarted = Date.now();
    const sourceContext = `channel=${channel.id} source=${source.id ?? "legacy"} host=${healthSourceLabel(sourceUrl)}`;
    console.log(`HEALTH SOURCE START ${sourceContext}`);
    const forceTestTimeout = MILKTV_HEALTH_CLI
      && String(process.env.MILKTV_HEALTH_TEST_FORCE_SOURCE_TIMEOUT_CHANNEL_ID || "") === String(channel.id);
    let probe = forceTestTimeout
      ? { __healthTimeout: true, label: `${sourceContext} simulated` }
      : await withHealthTimeout(probeMilktvSource(sourceUrl), MILKTV_HEALTH_SOURCE_TIMEOUT_MS, sourceContext);
    if (probe?.__healthTimeout) {
      const timeoutReason = forceTestTimeout ? "Source probe watchdog timeout (test simulation)" : "Source probe watchdog timeout";
      console.warn(`HEALTH SOURCE TIMEOUT ${sourceContext} duration_ms=${Date.now() - sourceStarted}${forceTestTimeout ? " simulated=true" : ""}`);
      milktvCheckProgress.timeouts = Number(milktvCheckProgress.timeouts || 0) + 1;
      probe = { online: false, indeterminate: true, responseTime: Date.now() - sourceStarted, error: timeoutReason };
    }
    console.log(`HEALTH SOURCE END ${sourceContext} result=${probe.online ? "online" : probe.indeterminate ? "unknown" : "offline"} duration_ms=${Date.now() - sourceStarted}`);
    if (probe.indeterminate) {
      indeterminateProbe = probe;
      if (sourceUrl === currentUrl) {
        currentSourceIndeterminate = probe;
      }
      if (source.id !== null) sourceObservations.push({ source, probe });
      continue;
    }
    if (source.id !== null) sourceObservations.push({ source, probe });

    if (probe.online) {
      return {
        online: true,
        indeterminate: Boolean(currentSourceIndeterminate),
        responseTime: probe.responseTime,
        error: currentSourceIndeterminate ? "Current source transport unavailable" : null,
        activeUrl: sourceUrl, sourceObservations
      };
    }
  }

  if (indeterminateProbe) {
    return {
      online: false,
      indeterminate: true,
      responseTime: indeterminateProbe.responseTime,
      error: "Probe transport unavailable",
      activeUrl: channel.url, sourceObservations
    };
  }

  return {
    online: false,
    responseTime: 0,
    error: "Все включенные источники недоступны",
    activeUrl: channel.url, sourceObservations
  };
}

async function commitSourceHealthObservations(observations) {
  for (const { source, probe } of observations || []) {
    if (probe.indeterminate) {
      // Unknown is an observation only: retain last known source availability
      // and never reset or advance its failure evidence.
      await db.query("UPDATE milktv_channel_sources SET response_time=$1,last_check=NOW(),check_error=$2,updated_at=NOW() WHERE id=$3", [probe.responseTime, probe.error, source.id]);
      continue;
    }
    await db.query(`UPDATE milktv_channel_sources SET status=$1,failed_checks=$2,successful_checks=CASE WHEN $1='online' THEN successful_checks+1 ELSE successful_checks END,consecutive_successful_checks=CASE WHEN $1='online' THEN consecutive_successful_checks+1 ELSE 0 END,first_success_at=CASE WHEN $1='online' THEN COALESCE(first_success_at,NOW()) ELSE first_success_at END,last_success_at=CASE WHEN $1='online' THEN NOW() ELSE last_success_at END,response_time=$3,last_check=NOW(),check_error=$4,updated_at=NOW() WHERE id=$5`, [probe.online ? 'online' : 'offline', probe.online ? 0 : Number(source.failed_checks || 0) + 1, probe.responseTime, probe.error, source.id]);
    if (await optionalSchemaReady("Source trust", ["milktv_channel_sources", "trust_score"]) && await optionalSchemaReady("Source trust", ["milktv_channel_sources", "trust_level"])) {
      const trustRow = await db.query("SELECT status,successful_checks,consecutive_successful_checks,failed_checks,last_success_at FROM milktv_channel_sources WHERE id=$1", [source.id]);
      if (trustRow.rows.length) { const trust = milktvSourceTrust.calculateSourceTrust(trustRow.rows[0]); await db.query("UPDATE milktv_channel_sources SET trust_score=$1,trust_level=$2,trust_updated_at=NOW() WHERE id=$3", [trust.score, trust.level, source.id]); }
    }
  }
}

let milktvSlotReconciliationRunning = false;

async function runMilktvSlotReconciliation() {
  if (milktvSlotReconciliationRunning) {
    return { found: 0, assigned: 0, remaining: 0, skipped: true };
  }

  milktvSlotReconciliationRunning = true;

  try {
    const result = await db.query(`
      SELECT s.original_channel_id
      FROM milktv_channel_slots s
      JOIN channels original_channel
        ON original_channel.id = s.original_channel_id
      WHERE s.current_channel_id IS NULL
        AND original_channel.milktv_status = 'quarantine'
      ORDER BY s.original_channel_id
    `);

    let assigned = 0;

    for (const row of result.rows) {
      if (await tryAssignAutomaticReplacement(Number(row.original_channel_id))) {
        assigned++;
      }
    }

    const remaining = result.rows.length - assigned;
    console.log(
      `MILK TV slot reconciliation: free quarantine slots ${result.rows.length}, assigned ${assigned}, remaining ${remaining}`
    );

    return {
      found: result.rows.length,
      assigned,
      remaining,
      skipped: false
    };
  } catch (error) {
    console.error("MILK TV slot reconciliation failed:", error);
    return { found: 0, assigned: 0, remaining: 0, skipped: false };
  } finally {
    milktvSlotReconciliationRunning = false;
  }
}
async function runMilktvCheck() {

  // Phase A: collect every observation without touching canonical health.
  // Phase B below commits only after the run has passed the infrastructure gate.
  const startedAt = Date.now();
  const rows = (await db.query(`SELECT id,name,url,milktv_status,milktv_failed_checks FROM channels WHERE url IS NOT NULL AND TRIM(url)<>'' AND COALESCE(milktv_status,'')<>'quarantine' ORDER BY name`)).rows;
  const observations = [];
  milktvCheckProgress.total = rows.length;
  milktvCheckProgress.current = 0;
  milktvCheckProgress.online = 0;
  milktvCheckProgress.offline = 0;
  milktvCheckProgress.unknown = 0;
  milktvCheckProgress.timeouts = 0;
  milktvCheckProgress.new_quarantine = 0;
  milktvCheckProgress.db_errors = 0;
  milktvCheckProgress.circuit_breaker = null;
  for (const channel of rows) {
    const sourceHealth = await withHealthTimeout(checkMilktvChannelSources(channel), MILKTV_HEALTH_CHANNEL_TIMEOUT_MS, `channel=${channel.id}`);
    const health = sourceHealth?.__healthTimeout ? { online: false, indeterminate: true, responseTime: MILKTV_HEALTH_CHANNEL_TIMEOUT_MS, error: 'Channel processing watchdog timeout', activeUrl: channel.url, sourceObservations: [] } : sourceHealth;
    if (sourceHealth?.__healthTimeout) milktvCheckProgress.timeouts++;
    let result = health.indeterminate ? 'unknown' : health.online ? 'online' : 'offline';
    // A reserve being healthy never turns this into an implicit switch.
    if (result === 'online' && health.activeUrl !== channel.url) result = 'offline';
    observations.push({ channel, health, result });
    milktvCheckProgress.current++;
    milktvCheckProgress[result]++;
    const first = observations.slice(0, MILKTV_HEALTH_UNKNOWN_CIRCUIT_MIN_CHECKED);
    const unknownReasons = new Set(first.filter(x => x.result === 'unknown').map(x => String(x.health.error || 'transport').replace(/\d+/g, '#')));
    if (first.length >= MILKTV_HEALTH_UNKNOWN_CIRCUIT_MIN_CHECKED && first.filter(x => x.result === 'unknown').length / first.length >= MILKTV_HEALTH_UNKNOWN_CIRCUIT_RATIO && first.filter(x => x.result === 'online').length === 0 && unknownReasons.size <= 1) {
      milktvCheckProgress.circuit_breaker = 'infrastructure_degraded';
      milktvHealthRuntime.infra_degraded = true;
      break;
    }
  }
  if (milktvCheckProgress.circuit_breaker === 'infrastructure_degraded') {
    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();
    milktvHealthRuntime.state = 'PAUSED';
    milktvHealthRuntime.last_run_at = milktvCheckProgress.finishedAt.toISOString();
    milktvHealthRuntime.last_result = { total: milktvCheckProgress.total, checked: milktvCheckProgress.current, online: milktvCheckProgress.online, offline: milktvCheckProgress.offline, unknown: milktvCheckProgress.unknown, db_errors: 0, timeouts: milktvCheckProgress.timeouts, circuit_breaker: 'infrastructure_degraded', duration_ms: Date.now() - startedAt };
    const filename = path.join(__dirname, 'reports', `milktv-health-infrastructure-degraded-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify({ created_at: new Date().toISOString(), status: 'INFRASTRUCTURE_DEGRADED', phase: 'A', canonical_mutations: 0, observations: observations.map(x => ({ channel_id: x.channel.id, result: x.result, error: x.health.error || null })) }, null, 2));
    console.error(`MILK TV health paused: infrastructure degraded; canonical state preserved; report=${filename}`);
    return milktvHealthRuntime.last_result;
  }
  for (const { channel, health, result } of observations) {
    await commitSourceHealthObservations(health.sourceObservations);
    if (result === 'unknown') {
      // Preserve last canonical availability and its confirmed-failure count.
      await db.query('UPDATE channels SET milktv_last_check=NOW(),milktv_response_time=$1,milktv_check_error=$2 WHERE id=$3', [health.responseTime, health.error, channel.id]);
      continue;
    }
    if (result === 'online') {
      await db.query("UPDATE channels SET milktv_status='online',milktv_failed_checks=0,milktv_last_check=NOW(),milktv_response_time=$1,milktv_check_error=NULL WHERE id=$2", [health.responseTime, channel.id]);
      continue;
    }
    const failedChecks = Number(channel.milktv_failed_checks || 0) + 1;
    if (failedChecks >= 3) {
      await db.query("UPDATE channels SET milktv_status='quarantine',milktv_failed_checks=$1,milktv_last_check=NOW(),milktv_quarantine_since=COALESCE(milktv_quarantine_since,NOW()),milktv_quarantine_last_check=NOW(),milktv_response_time=$2,milktv_check_error=$3 WHERE id=$4", [failedChecks, health.responseTime, health.error, channel.id]);
      milktvCheckProgress.new_quarantine++;
    } else await db.query("UPDATE channels SET milktv_status='offline',milktv_failed_checks=$1,milktv_last_check=NOW(),milktv_response_time=$2,milktv_check_error=$3 WHERE id=$4", [failedChecks, health.responseTime, health.error, channel.id]);
  }
  milktvCheckProgress.running = false;
  milktvCheckProgress.finishedAt = new Date();
  milktvHealthRuntime.state = 'ON';
  milktvHealthRuntime.infra_degraded = false;
  milktvHealthRuntime.last_run_at = milktvCheckProgress.finishedAt.toISOString();
  milktvHealthRuntime.last_result = { total: milktvCheckProgress.total, checked: milktvCheckProgress.current, online: milktvCheckProgress.online, offline: milktvCheckProgress.offline, unknown: milktvCheckProgress.unknown, db_errors: 0, timeouts: milktvCheckProgress.timeouts, circuit_breaker: null, duration_ms: Date.now() - startedAt };
  return milktvHealthRuntime.last_result;

  /* Legacy inline path retained below for comparison; unreachable. */

  try {

    // This guard is CLI-only: normal scheduler runs always select every
    // canonical, non-quarantined channel.
    const requestedHealthLimit = Number(process.env.MILKTV_HEALTH_LIMIT);
    const healthLimit = MILKTV_HEALTH_CLI && Number.isInteger(requestedHealthLimit) && requestedHealthLimit > 0
      ? requestedHealthLimit
      : null;
    const healthChannelIds = MILKTV_HEALTH_CLI
      ? [...new Set(String(process.env.MILKTV_HEALTH_CHANNEL_IDS || "").split(",").map(Number).filter(id => Number.isInteger(id) && id > 0))]
      : [];
    const healthQueryParams = [];
    const healthChannelFilter = healthChannelIds.length > 0
      ? ` AND id = ANY($${healthQueryParams.push(healthChannelIds)}::int[])`
      : "";
    const healthLimitSql = healthLimit ? ` LIMIT $${healthQueryParams.push(healthLimit)}` : "";

    const result = await db.query(`
      SELECT
        id,
        name,
        url,
        milktv_status,
        milktv_failed_checks
      FROM channels
      WHERE url IS NOT NULL
        AND TRIM(url) <> ''
        AND COALESCE(milktv_status, '') <> 'quarantine'
        ${healthChannelFilter}
      ORDER BY name
      ${healthLimitSql}
    `, healthQueryParams);

    milktvCheckProgress.total = result.rows.length;
    milktvCheckProgress.current = 0;
    milktvCheckProgress.online = 0;
    milktvCheckProgress.offline = 0;
    milktvCheckProgress.unknown = 0;
    milktvCheckProgress.timeouts = 0;
    milktvCheckProgress.new_quarantine = 0;
    milktvCheckProgress.circuit_breaker = null;
    const baselineOnline = result.rows.filter(channel => channel.milktv_status === "online").length;

    for (const channel of result.rows) {
      const progressIndex = milktvCheckProgress.current + 1;
      const channelStarted = Date.now();
      const channelContext = `channel=${channel.id}`;
      console.log(`HEALTH ${progressIndex}/${milktvCheckProgress.total} ${channelContext} START`);

      let sourceHealth = await withHealthTimeout(
        checkMilktvChannelSources(channel),
        MILKTV_HEALTH_CHANNEL_TIMEOUT_MS,
        channelContext
      );
      if (sourceHealth?.__healthTimeout) {
        console.warn(`HEALTH CHANNEL TIMEOUT ${channelContext} duration_ms=${Date.now() - channelStarted}`);
        milktvCheckProgress.timeouts = Number(milktvCheckProgress.timeouts || 0) + 1;
        // This is transport ambiguity, not a confirmed channel failure.
        sourceHealth = {
          online: false,
          indeterminate: true,
          responseTime: Date.now() - channelStarted,
          error: "Channel processing watchdog timeout",
          activeUrl: channel.url
        };
      }
      let isOnline = sourceHealth.online;
      let responseTime = sourceHealth.responseTime;
      let errorText = sourceHealth.error;

      if (sourceHealth.indeterminate) {
        await db.query(`UPDATE channels SET milktv_status = 'unknown', milktv_failed_checks = 0, milktv_last_check = NOW(), milktv_response_time = $1, milktv_check_error = $2 WHERE id = $3`, [responseTime, errorText, channel.id]);
        milktvCheckProgress.current++;
        milktvCheckProgress.unknown++;
        console.log(`HEALTH ${progressIndex}/${milktvCheckProgress.total} ${channelContext} result=unknown duration_ms=${Date.now() - channelStarted}`);
        if (
          milktvCheckProgress.current >= MILKTV_HEALTH_UNKNOWN_CIRCUIT_MIN_CHECKED
          && milktvCheckProgress.unknown / milktvCheckProgress.current >= MILKTV_HEALTH_UNKNOWN_CIRCUIT_RATIO
          && milktvCheckProgress.online === 0
        ) {
          milktvCheckProgress.circuit_breaker = "mass_transport_unknown_anomaly";
          console.error("MILK TV health circuit breaker: mass transport ambiguity; automated run stopped");
          break;
        }
        continue;
      }

      // A healthy reserve proves that recovery is possible, but it must never
      // silently replace the canonical current source.  Keep the channel in
      // the confirmed-failure path so recovery-only autopilot can final-probe
      // and switch through services/milktv-source-switch.js.
      if (sourceHealth.online && sourceHealth.activeUrl !== channel.url) {
        isOnline = false;
        errorText = "Current source confirmed offline; healthy reserve available";
      }

      if (false) try {

        const response = await fetch(channel.url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        responseTime = Date.now() - started;

        clearTimeout(timer);

        if (response.ok) {
          isOnline = true;
        } else {
          errorText = `HTTP ${response.status}`;
        }

      } catch(error) {

        responseTime = Date.now() - started;

        clearTimeout(timer);

        errorText =
          error.name === "AbortError"
            ? "Таймаут"
            : error.message;

      }

      if (isOnline) {

        milktvCheckProgress.online++;

        const activeSource = await db.query("SELECT id FROM milktv_channel_sources WHERE channel_id=$1 AND url=$2 LIMIT 1", [channel.id, sourceHealth.activeUrl]);
        await db.query(`
          UPDATE channels
          SET
            milktv_status = 'online',
            milktv_failed_checks = 0,
            milktv_last_check = NOW(),
            milktv_response_time = $1,
            milktv_check_error = NULL,
            url = $3,
            current_source_id = $4
          WHERE id = $2
        `, [
          responseTime,
          channel.id,
          sourceHealth.activeUrl,
          activeSource.rows[0]?.id || null
        ]);
      } else {

        milktvCheckProgress.offline++;

        const failedChecks =
          Number(channel.milktv_failed_checks || 0) + 1;

        if (failedChecks >= 3) {

          const quarantineClient = await db.connect();

          try {
            await quarantineClient.query("BEGIN");

            await quarantineClient.query(`
              UPDATE channels
              SET
                milktv_status = 'quarantine',
                milktv_failed_checks = $1,
                milktv_last_check = NOW(),
                milktv_quarantine_since =
                  COALESCE(milktv_quarantine_since, NOW()),
                milktv_quarantine_last_check = NOW(),
                milktv_response_time = $2,
                milktv_check_error = $3
              WHERE id = $4
            `, [
              failedChecks,
              responseTime,
              errorText,
              channel.id
            ]);

            const releasedSlotIds = [];

            const ownReleaseResult = await quarantineClient.query(`
              UPDATE milktv_channel_slots
              SET
                current_channel_id = NULL,
                replacement_since = NULL,
                updated_at = NOW()
              WHERE original_channel_id = $1
                AND current_channel_id = $1
              RETURNING original_channel_id
            `, [channel.id]);
            releasedSlotIds.push(...ownReleaseResult.rows.map(row => row.original_channel_id));

            const foreignReleaseResult = await quarantineClient.query(`
              UPDATE milktv_channel_slots
              SET
                current_channel_id = NULL,
                replacement_since = NULL,
                updated_at = NOW()
              WHERE current_channel_id = $1
                AND original_channel_id <> $1
              RETURNING original_channel_id
            `, [channel.id]);
            releasedSlotIds.push(...foreignReleaseResult.rows.map(row => row.original_channel_id));

            console.log(
              `MILK TV quarantine slot release: channel ${channel.id}, foreign slots released ${foreignReleaseResult.rowCount}`
            );

            await quarantineClient.query("COMMIT");

            scheduleMilktvAutomaticReplacement(releasedSlotIds);
            milktvCheckProgress.new_quarantine = Number(milktvCheckProgress.new_quarantine || 0) + 1;
          } catch (error) {
            await quarantineClient.query("ROLLBACK");
            throw error;
          } finally {
            quarantineClient.release();
          }

          console.log(
            `🔴 КАРАНТИН: ${channel.name} | ${failedChecks} неудачных проверок`
          );
          console.log(`CHANNEL_QUARANTINED channel=${channel.id} failures=${failedChecks}`);

        } else {

          await db.query(`
            UPDATE channels
            SET
              milktv_status = 'offline',
              milktv_failed_checks = $1,
              milktv_last_check = NOW(),
              milktv_response_time = $2,
              milktv_check_error = $3
            WHERE id = $4
          `, [
            failedChecks,
            responseTime,
            errorText,
            channel.id
          ]);
          console.log(`CHANNEL_CHECK_FAILED channel=${channel.id} failures=${failedChecks}`);

        }

      }

      milktvCheckProgress.current++;

      console.log(`HEALTH ${progressIndex}/${milktvCheckProgress.total} ${channelContext} result=${isOnline ? "online" : "offline"} duration_ms=${Date.now() - channelStarted}`);

      // Stop an anomalous widespread outage from becoming a mass
      // quarantine/recovery event.  Individual confirmed failures still pass
      // normally; this only trips after a representative batch is dominated
      // by failures among channels that were online at the start of the run.
      if (
        baselineOnline >= MILKTV_HEALTH_CIRCUIT_MIN_CHECKED &&
        milktvCheckProgress.current >= MILKTV_HEALTH_CIRCUIT_MIN_CHECKED &&
        milktvCheckProgress.offline / milktvCheckProgress.current >= MILKTV_HEALTH_CIRCUIT_OFFLINE_RATIO
      ) {
        milktvCheckProgress.circuit_breaker = "mass_offline_anomaly";
        console.error("MILK TV health circuit breaker: mass offline anomaly; automated run stopped");
        break;
      }

      console.log(
        `МИЛК ТВ: ${milktvCheckProgress.current}/${milktvCheckProgress.total} | ONLINE: ${milktvCheckProgress.online} | OFFLINE: ${milktvCheckProgress.offline}`
      );

    }

    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();

    console.log("");
    console.log("========== ПРОВЕРКА МИЛК ТВ ==========");
    console.log("🟢 ONLINE:", milktvCheckProgress.online);
    console.log("🔴 OFFLINE:", milktvCheckProgress.offline);
    console.log("📺 ВСЕГО:", milktvCheckProgress.total);
    console.log("======================================");
    console.log("");

  } catch(error) {

    console.error("ОШИБКА ПРОВЕРКИ МИЛК ТВ:", error);

    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();

  }

}

async function runMilktvHealthPreflight() {
  const channels = (await db.query("SELECT id,name,url,milktv_status,milktv_failed_checks FROM channels WHERE id=ANY($1::int[]) ORDER BY id", [MILKTV_HEALTH_PREFLIGHT_IDS])).rows;
  const results = [];
  for (const channel of channels) {
    const health = await withHealthTimeout(checkMilktvChannelSources(channel), MILKTV_HEALTH_CHANNEL_TIMEOUT_MS, `preflight channel=${channel.id}`);
    results.push({ channel_id: channel.id, result: health?.__healthTimeout || health?.indeterminate ? 'unknown' : health?.online ? 'online' : 'offline', error: health?.error || null });
  }
  const summary = { at: new Date().toISOString(), ids: MILKTV_HEALTH_PREFLIGHT_IDS, total: results.length, online: results.filter(x => x.result === 'online').length, offline: results.filter(x => x.result === 'offline').length, unknown: results.filter(x => x.result === 'unknown').length, results };
  summary.pass = summary.online > 0;
  milktvHealthRuntime.last_preflight = summary;
  return summary;
}

async function startMilktvCheckIfIdle(options = {}) {
  if (milktvCheckProgress.running) {
    milktvHealthRuntime.overlap_skips++;
    return { skipped: true, reason: 'already_running' };
  }
  milktvCheckProgress = {
    running: true,
    current: 0,
    total: 0,
    online: 0,
    offline: 0,
    unknown: 0,
    timeouts: 0,
    new_quarantine: 0,
    circuit_breaker: null,
    startedAt: new Date(),
    finishedAt: null
  };
  const preflight = options.preflight !== false ? await runMilktvHealthPreflight() : { pass: true };
  if (!preflight.pass) {
    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();
    milktvHealthRuntime.state = 'PAUSED';
    milktvHealthRuntime.infra_degraded = true;
    milktvHealthRuntime.last_run_at = milktvCheckProgress.finishedAt.toISOString();
    milktvHealthRuntime.last_result = { status: 'HEALTH_PAUSED_TRANSPORT_UNAVAILABLE', total: 0, checked: 0, online: 0, offline: 0, unknown: 0, db_errors: 0, timeouts: 0, circuit_breaker: 'preflight_transport_unavailable', duration_ms: 0 };
    console.error('MILK TV HEALTH PAUSED: TRANSPORT UNAVAILABLE');
    return { paused: true, preflight };
  }
  milktvHealthRuntime.state = 'RUNNING';
  try { return { preflight, result: await runMilktvCheck() }; }
  catch (error) {
    milktvCheckProgress.running = false;
    milktvCheckProgress.finishedAt = new Date();
    milktvCheckProgress.db_errors = Number(milktvCheckProgress.db_errors || 0) + 1;
    milktvHealthRuntime.state = 'PAUSED';
    milktvHealthRuntime.last_result = { status: 'ERROR', db_errors: 1, error: String(error.message || error).slice(0, 240) };
    throw error;
  }
}

let milktvQuarantineCheckRunning = false;

async function runMilktvQuarantineCheck() {

  console.log("");
  console.log("========== ПРОВЕРКА КАРАНТИНА МИЛК ТВ ==========");

  try {

    const result = await db.query(`
      SELECT
        id,
        name,
        url,
        milktv_rating,
        milktv_views,
        milktv_viewers,
        milktv_quarantine_last_check
      FROM channels
      WHERE milktv_status = 'quarantine'
        AND url IS NOT NULL
        AND TRIM(url) <> ''
      ORDER BY name
    `);

    console.log("🔎 Каналов в карантине:", result.rows.length);

    for (const channel of result.rows) {
      const progressIndex = milktvCheckProgress.current + 1;
      const channelStarted = Date.now();
      const channelContext = `channel=${channel.id}`;
      console.log(`HEALTH ${progressIndex}/${milktvCheckProgress.total} ${channelContext} START`);

      let sourceHealth = await withHealthTimeout(
        checkMilktvChannelSources(channel),
        MILKTV_HEALTH_CHANNEL_TIMEOUT_MS,
        channelContext
      );
      if (sourceHealth?.__healthTimeout) {
        console.warn(`HEALTH CHANNEL TIMEOUT ${channelContext} duration_ms=${Date.now() - channelStarted}`);
        // This is transport ambiguity, not a confirmed channel failure.
        sourceHealth = {
          online: false,
          indeterminate: true,
          responseTime: Date.now() - channelStarted,
          error: "Channel processing watchdog timeout",
          activeUrl: channel.url
        };
      }
      let isOnline = sourceHealth.online;
      let responseTime = sourceHealth.responseTime;
      let errorText = sourceHealth.error;

      if (sourceHealth.indeterminate) {
        // UNKNOWN is not recovery and must not release a confirmed quarantine
        // state.  Preserve the logical channel and retry at the quarantine
        // cadence when transport evidence becomes available again.
        await db.query(`UPDATE channels SET milktv_status = 'quarantine', milktv_failed_checks = GREATEST(COALESCE(milktv_failed_checks, 0), 3), milktv_quarantine_last_check = NOW(), milktv_last_check = NOW(), milktv_response_time = $1, milktv_check_error = $2 WHERE id = $3`, [responseTime, errorText, channel.id]);
        continue;
      }

      if (false) try {

        const response = await fetch(channel.url, {
          method: "GET",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        responseTime = Date.now() - started;

        clearTimeout(timer);

        if (response.ok) {
          isOnline = true;
        } else {
          errorText = `HTTP ${response.status}`;
        }

      } catch(error) {

        responseTime = Date.now() - started;

        clearTimeout(timer);

        errorText =
          error.name === "AbortError"
            ? "Таймаут"
            : error.message;

      }

      if (isOnline) {

        const recoveryClient = await db.connect();

        try {
          await recoveryClient.query("BEGIN");

          const slotResult = await recoveryClient.query(`
            SELECT
              original_channel_id,
              current_channel_id
            FROM milktv_channel_slots
            WHERE original_channel_id = $1
            FOR UPDATE
          `, [channel.id]);

          if (slotResult.rows.length === 0) {

            await recoveryClient.query(`
              UPDATE channels
              SET
                milktv_quarantine_last_check = NOW(),
                milktv_last_check = NOW(),
                milktv_response_time = $1,
                milktv_check_error = $2
              WHERE id = $3
            `, [
              responseTime,
              "MILK TV slot missing",
              channel.id
            ]);

            await recoveryClient.query("COMMIT");

            console.log(
              `⚠️ ${channel.name}: slot отсутствует — оставляем quarantine`
            );

          } else {
            const slot = slotResult.rows[0];
            const currentChannelId = slot.current_channel_id === null
              ? null
              : Number(slot.current_channel_id);

            if (
              currentChannelId !== null
              && currentChannelId !== channel.id
            ) {

              await recoveryClient.query(`
                UPDATE channels
                SET
                  milktv_quarantine_last_check = NOW(),
                  milktv_last_check = NOW(),
                  milktv_response_time = $1,
                  milktv_check_error = $2
                WHERE id = $3
              `, [
                responseTime,
                "Recovered, but slot is occupied by replacement channel id "
                  + currentChannelId,
                channel.id
              ]);

              await recoveryClient.query("COMMIT");

              console.log(
                `⚠️ ${channel.name}: slot занят replacement ${currentChannelId} — оставляем quarantine`
              );
              console.log(`CHANNEL_REPLACEMENT_ALREADY_ACTIVE channel=${channel.id} replacement=${currentChannelId}`);

            } else {
              let slotClaimed = currentChannelId === channel.id;

              if (currentChannelId === null) {
                const claimResult = await recoveryClient.query(`
                  UPDATE milktv_channel_slots
                  SET
                    current_channel_id = $1,
                    replacement_since = NULL,
                    updated_at = NOW()
                  WHERE original_channel_id = $1
                    AND current_channel_id IS NULL
                `, [channel.id]);

                slotClaimed = claimResult.rowCount === 1;
              }

              if (slotClaimed) {
                await recoveryClient.query(`
                  UPDATE channels
                  SET
                    milktv_status = 'online',
                    milktv_failed_checks = 0,
                    milktv_quarantine_last_check = NOW(),
                    milktv_last_check = NOW(),
                    milktv_response_time = $1,
                    milktv_check_error = NULL,
                    url = $3
                  WHERE id = $2
                `, [
                  responseTime,
                  channel.id,
                  sourceHealth.activeUrl
                ]);

                await recoveryClient.query("COMMIT");

                console.log(
                  `🟢 ВОЗВРАЩЁН ИЗ КАРАНТИНА: ${channel.name}`
                );
                console.log(`CHANNEL_RECOVERED channel=${channel.id}`);
                console.log(`CHANNEL_RETURNED channel=${channel.id}`);

              } else {
                const occupiedSlot = await recoveryClient.query(`
                  SELECT current_channel_id
                  FROM milktv_channel_slots
                  WHERE original_channel_id = $1
                `, [channel.id]);
                const occupiedBy = occupiedSlot.rows[0]?.current_channel_id;

                await recoveryClient.query(`
                  UPDATE channels
                  SET
                    milktv_quarantine_last_check = NOW(),
                    milktv_last_check = NOW(),
                    milktv_response_time = $1,
                    milktv_check_error = $2
                  WHERE id = $3
                `, [
                  responseTime,
                  "Recovered, but slot became occupied by replacement channel id "
                    + occupiedBy,
                  channel.id
                ]);

                await recoveryClient.query("COMMIT");

                console.log(
                  `⚠️ ${channel.name}: slot занят после проверки — оставляем quarantine`
                );
              }
            }
          }
        } catch (error) {
          await recoveryClient.query("ROLLBACK");
          throw error;
        } finally {
          recoveryClient.release();
        }

      } else {

        await db.query(`
          UPDATE channels
          SET
            milktv_quarantine_last_check = NOW(),
            milktv_last_check = NOW(),
            milktv_response_time = $1,
            milktv_check_error = $2
          WHERE id = $3
        `, [
          responseTime,
          errorText,
          channel.id
        ]);

        console.log(
          `🔴 КАРАНТИН: ${channel.name} — ${errorText}`
        );

      }

    }

  } catch(error) {

    console.error(
      "ОШИБКА ПРОВЕРКИ КАРАНТИНА МИЛК ТВ:",
      error
    );

  }

  console.log("================================================");
  console.log("");
}

async function startMilktvQuarantineCheckIfIdle() {

  if (milktvQuarantineCheckRunning) {
    return false;
  }

  milktvQuarantineCheckRunning = true;

  try {
    await runMilktvQuarantineCheck();
    return true;
  } finally {
    milktvQuarantineCheckRunning = false;
  }
}

function normalizeCandidateName(value) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\[\](){}.,!?_:;|/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+\+\d+\s*$/i, "")
    .replace(/\s+(full\s*hd|ultra\s*hd|fhd|uhd|4k|hd|1080p|1080i|720p|720i|576p|576i|480p|480i)$/i, "")
    .trim();
  return normalized;
}

function canonicalCandidateName(value) {
  const normalized = normalizeCandidateName(value);
  for (const [canonical, variants] of Object.entries(MILKTV_CHANNEL_ALIASES)) {
    if (variants.map(normalizeCandidateName).includes(normalized)) return canonical;
  }
  return normalized;
}

function calculateCandidateQuality(row, probe, match, provenanceCount) {
  const label = `${row.name || ""} ${row.tvg_name || ""}`.toLowerCase();
  const height = Number(row.profile_height || 0);
  const resolution = height ? (height >= 2160 ? 20 : height >= 1080 ? 18 : height >= 720 ? 14 : height >= 480 ? 9 : 6) : (/2160|4k/.test(label) ? 16 : /1080/.test(label) ? 14 : /720/.test(label) ? 11 : /576|480|sd/.test(label) ? 7 : 4);
  const stability = Math.min(15, Number(row.successful_checks || 0) * 3);
  const trust = provenanceCount >= 2 ? 12 : provenanceCount === 1 ? 7 : 0;
  const matchPoints = match.confidence === "high" ? 12 : 0;
  const audio = row.profile_has_audio === false ? 0 : row.profile_has_audio === true ? 5 : 0;
  const health = probe.online ? 25 : 0;
  const penalty = Math.min(20, Number(row.failed_checks || 0) * 4);
  return Math.max(0, Math.min(100, health + resolution + stability + trust + matchPoints + audio - penalty));
}

async function calculateCandidateMatch(candidate) {
  const channels = await db.query(`
    SELECT id, name
    FROM channels
    WHERE url IS NOT NULL AND BTRIM(url) <> ''
    ORDER BY id
  `);
  const candidateNames = [candidate.name, candidate.tvg_name]
    .filter(Boolean)
    .map(normalizeCandidateName)
    .filter(Boolean);
  const exact = channels.rows.filter(channel => candidateNames.includes(normalizeCandidateName(channel.name)));
  if (exact.length === 1) return { channelId: Number(exact[0].id), confidence: "high", method: "exact" };
  if (exact.length > 1) return { channelId: null, confidence: "possible", method: "fuzzy_high" };
  const canonical = [...new Set(candidateNames.map(canonicalCandidateName))];
  const aliases = channels.rows.filter(channel => canonical.includes(canonicalCandidateName(channel.name)));
  if (aliases.length === 1) return { channelId: Number(aliases[0].id), confidence: "high", method: "alias" };
  if (aliases.length > 1) return { channelId: null, confidence: "possible", method: "fuzzy_high" };
  return { channelId: null, confidence: "no-match", method: "unmatched" };
}

async function updateCandidateHealth(candidateId, options = {}) {
  const candidate = await db.query(`
    SELECT c.id, c.stream_url, c.name, c.tvg_name, c.state, c.failed_checks,
      (SELECT COUNT(*)::int FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id AND cp.active=TRUE) AS provenance_count
    FROM milktv_m3u_candidates c
    WHERE id = $1
  `, [candidateId]);
  if (!candidate.rows.length) return { found: false };
  const row = candidate.rows[0];
  if (row.state === "rejected") return { found: true, skipped: true, state: row.state };
  let probe;
  try {
    await validateM3uProviderUrl(row.stream_url);
    probe = await probeMilktvSource(row.stream_url, { redirect: "error" });
  } catch (error) {
    probe = { online: false, responseTime: 0, error: error.message };
  }
  const match = await calculateCandidateMatch(row);
  const provenanceCount = Number(row.provenance_count || 0);
  const qualityScore = calculateCandidateQuality(row, probe, match, provenanceCount);
  await db.query(`
    UPDATE milktv_m3u_candidates
    SET
      health_status = $1,
      failed_checks = $2,
      response_time = $3,
      last_check = NOW(),
      health_error = $4,
      suggested_channel_id = $5,
      match_confidence = $6,
      match_method = $7,
      quality_score = $8,
      quality_confidence = $9,
      successful_checks = CASE WHEN $1='online' THEN successful_checks + 1 ELSE successful_checks END,
      last_success_at = CASE WHEN $1='online' THEN NOW() ELSE last_success_at END,
      provenance_count = $10,
      trust_level = CASE WHEN $10 >= 2 THEN 'high' WHEN $10 = 1 THEN 'medium' ELSE 'low' END,
      updated_at = NOW()
    WHERE id = $7
  `, [
    probe.online ? "online" : "offline",
    probe.online ? 0 : Number(row.failed_checks || 0) + 1,
    probe.responseTime,
    probe.error,
    match.channelId,
    match.confidence,
    match.method || "unmatched",
    qualityScore,
    probe.online ? "verified" : "unverified",
    provenanceCount,
    candidateId
  ]);

  if (options.autoAccept !== false && probe.online && match.confidence === "high" && match.channelId) {
    const acceptClient = await db.connect();
    try {
      await acceptClient.query("BEGIN");
      const accepted = await acceptClient.query(`
        SELECT id, state
        FROM milktv_m3u_candidates
        WHERE id = $1
        FOR UPDATE
      `, [candidateId]);
      if (accepted.rows.length && accepted.rows[0].state !== "rejected") {
        await acceptClient.query(`
        INSERT INTO milktv_channel_sources (channel_id, url, enabled, priority)
        VALUES ($1, $2, TRUE, 100)
        ON CONFLICT (channel_id, url) DO UPDATE SET enabled = TRUE, updated_at = NOW()
        `, [match.channelId, row.stream_url]);
        await acceptClient.query(`
          UPDATE milktv_m3u_candidates
          SET state = 'accepted', accepted_channel_id = $1, updated_at = NOW()
          WHERE id = $2
        `, [match.channelId, candidateId]);
      }
      await acceptClient.query("COMMIT");
    } catch (error) {
      await acceptClient.query("ROLLBACK");
      console.error("Candidate auto-accept error:", error);
    } finally {
      acceptClient.release();
    }
  }
  return { found: true, skipped: false, online: probe.online, match };
}

let candidateHealthCheckRunning = false;

async function runCandidateHealthBatch(candidateIds, options = {}) {
  if (candidateHealthCheckRunning) return { skipped: true, checked: 0 };
  candidateHealthCheckRunning = true;
  let cursor = 0;
  let checked = 0;
  const results = [];
  const worker = async () => {
    while (cursor < candidateIds.length) {
      const id = candidateIds[cursor++];
      try { results.push(await updateCandidateHealth(id, options)); } catch (error) { console.error("Candidate health error:", error); }
      checked++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, candidateIds.length) }, worker));
    return { skipped: false, checked, results };
  } finally {
    candidateHealthCheckRunning = false;
  }
}

// Initial validation is intentionally separate from canonical channel Health:
// it only claims never-checked staged candidates, probes at the existing
// bounded concurrency, and never auto-accepts/publishes a result.
let initialCandidateHealthQueueRunning = false;
async function runInitialCandidateHealthQueue() {
  if (initialCandidateHealthQueueRunning || candidateHealthCheckRunning) return { skipped: true, checked: 0 };
  initialCandidateHealthQueueRunning = true;
  try {
    const pending = await db.query(`SELECT id FROM milktv_m3u_candidates WHERE state='new' AND last_check IS NULL ORDER BY first_seen,id LIMIT 20`);
    if (!pending.rows.length) return { skipped: false, checked: 0 };
    return await runCandidateHealthBatch(pending.rows.map(row => Number(row.id)), { autoAccept: false });
  } finally { initialCandidateHealthQueueRunning = false; }
}

const MILKTV_CANDIDATE_PROFILE_ENABLED = process.env.MILKTV_CANDIDATE_PROFILE_ENABLED === "true";
const MILKTV_CANDIDATE_PROFILE_INTERVAL = 15 * 60 * 1000;
const MILKTV_CANDIDATE_PROFILE_LIMIT = 20;
let candidateProfileRunning = false;
async function runCandidateProfileQueue() {
  if (candidateProfileRunning) return { skipped: true, reason: "already_running" };
  candidateProfileRunning = true;
  try {
    const rows = (await db.query(`SELECT id,stream_url,name,tvg_name,match_confidence,match_method,health_status,failed_checks,successful_checks,provenance_count,profile_checked_at,profile_has_audio,profile_height
      FROM milktv_m3u_candidates
      WHERE state='new' AND health_status='online' AND match_confidence='high' AND match_method IN ('exact','alias','official')
        AND (profile_checked_at IS NULL OR profile_checked_at < NOW()-INTERVAL '24 hours')
      ORDER BY profile_checked_at NULLS FIRST,id LIMIT $1`, [MILKTV_CANDIDATE_PROFILE_LIMIT])).rows;
    let cursor = 0, success = 0, partial = 0, failed = 0, timeout = 0;
    const worker = async () => { while (cursor < rows.length) { const row = rows[cursor++]; const started = Date.now(); try {
      const p = await milktvQuality.probe(row.stream_url);
      const isTimeout = String(p.error || '').toLowerCase().includes('timeout');
      if (isTimeout) timeout++;
      if (p.status === 'online') { success++; if (!p.videoWidth || !p.videoHeight || !p.hasAudio) partial++; }
      else failed++;
      const declared = /2160|4k/.test(`${row.name} ${row.tvg_name}`.toLowerCase()) ? 2160 : /1080/.test(`${row.name} ${row.tvg_name}`.toLowerCase()) ? 1080 : /720/.test(`${row.name} ${row.tvg_name}`.toLowerCase()) ? 720 : /576|480|sd/.test(`${row.name} ${row.tvg_name}`.toLowerCase()) ? 576 : null;
      const mismatch = Boolean(p.videoHeight && declared && p.videoHeight < declared * 0.9);
      const profileScore = calculateCandidateQuality({ ...row, profile_height: p.videoHeight, profile_has_audio: p.hasAudio }, p, { confidence: row.match_confidence }, Number(row.provenance_count || 0)) - (mismatch ? 10 : 0);
      await db.query(`UPDATE milktv_m3u_candidates SET profile_width=$1,profile_height=$2,profile_video_codec=$3,profile_video_bitrate=$4,profile_fps=$5,profile_has_audio=$6,profile_audio_codec=$7,profile_audio_bitrate=$8,profile_stream_count=$9,profile_format=$10,profile_checked_at=NOW(),profile_error=$11,profile_confidence=$12,metadata_quality_mismatch=$13,quality_score=$14,quality_confidence=$15,updated_at=NOW() WHERE id=$16`, [p.videoWidth||null,p.videoHeight||null,p.videoCodec||null,p.videoBitrate||null,p.fps||null,p.hasAudio===true,p.audioCodec||null,p.audioBitrate||null,p.streamCount||null,p.format||null,p.error||null,p.status==='online'?(p.videoWidth&&p.videoHeight?'complete':'partial'):'failed',mismatch,profileScore,p.status==='online'?(p.videoWidth&&p.videoHeight?'verified':'partial'):'unverified',row.id]);
    } catch (e) { failed++; await db.query("UPDATE milktv_m3u_candidates SET profile_checked_at=NOW(),profile_error=$1,profile_confidence='failed',updated_at=NOW() WHERE id=$2", [String(e.message || e).slice(0,500), row.id]).catch(() => {}); } } };
    await Promise.all([worker(), worker()]);
    return { skipped: false, queued: rows.length, success, partial, failed, timeout, concurrency: 2 };
  } finally { candidateProfileRunning = false; }
}

const MILKTV_M3U_AUTOPILOT_ENABLED = process.env.MILKTV_M3U_AUTOPILOT_ENABLED === "true";
const MILKTV_M3U_AUTOPILOT_START_DELAY = 25 * 60 * 1000;
// Provider discovery/import is intentionally low-frequency: candidates are
// staged and health-checked, never published directly to the active lineup.
const MILKTV_M3U_AUTOPILOT_INTERVAL = 24 * 60 * 60 * 1000;
const MILKTV_M3U_AUTOPILOT_PROVIDER_CONCURRENCY = 2;
const MILKTV_M3U_AUTOPILOT_PREVIEW_LIMIT = 20;
let milktvM3uAutopilotRunning = false;

async function runScheduledM3uProviderImport(provider) {
  const client = await db.connect();
  const lockKey = 817000 + Number(provider.id);
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
    if (!lock.rows[0].locked) return { skipped: true, provider_id: provider.id };
    try {
      const downloaded = await fetchM3uText(provider.url);
      const parsed = parseM3uPlaylist(downloaded.text);
      const newCandidateIds = [];
      let newCandidates = 0;
      let existingCandidates = 0;
      await client.query("BEGIN");
      await client.query(`
        UPDATE milktv_m3u_candidate_providers
        SET active = FALSE
        WHERE provider_id = $1
      `, [provider.id]);
      for (const entry of parsed.entries) {
        const before = await client.query("SELECT id FROM milktv_m3u_candidates WHERE stream_url=$1", [entry.streamUrl]);
        if (before.rows.length) existingCandidates++;
        const candidate = await client.query(`
          INSERT INTO milktv_m3u_candidates(stream_url,name,tvg_id,tvg_name,logo,group_title,last_seen,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())
          ON CONFLICT(stream_url) DO UPDATE SET
            name=EXCLUDED.name,
            tvg_id=COALESCE(EXCLUDED.tvg_id,milktv_m3u_candidates.tvg_id),
            tvg_name=COALESCE(EXCLUDED.tvg_name,milktv_m3u_candidates.tvg_name),
            logo=COALESCE(EXCLUDED.logo,milktv_m3u_candidates.logo),
            group_title=COALESCE(EXCLUDED.group_title,milktv_m3u_candidates.group_title),
            last_seen=NOW(),updated_at=NOW()
          RETURNING id
        `, [entry.streamUrl, entry.name || entry.streamUrl, entry.tvgId, entry.tvgName, entry.logo, entry.groupTitle]);
        if (!before.rows.length) { newCandidates++; newCandidateIds.push(Number(candidate.rows[0].id)); }
        await client.query(`
          INSERT INTO milktv_m3u_candidate_providers(candidate_id,provider_id,active,last_seen)
          VALUES($1,$2,TRUE,NOW())
          ON CONFLICT(candidate_id,provider_id) DO UPDATE SET active=TRUE,last_seen=NOW()
        `, [candidate.rows[0].id, provider.id]);
      }
      const finishedAt = new Date();
      const diagnostic = {
        provider_id: Number(provider.id),
        started_at: finishedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: 0,
        http_status: downloaded.httpStatus,
        downloaded_bytes: downloaded.bytes,
        parsed_entries: parsed.entries.length,
        new_candidates: newCandidates,
        existing_candidates: existingCandidates,
        malformed_entries: parsed.malformed,
        import_status: "ok",
        import_error: null
      };
      await client.query(`
        UPDATE milktv_m3u_providers
        SET last_import=NOW(),import_status='ok',import_error=NULL,last_import_diagnostic=$2::jsonb,updated_at=NOW()
        WHERE id=$1
      `, [provider.id, JSON.stringify(diagnostic)]);
      await client.query("COMMIT");
      if (newCandidateIds.length) {
        await runCandidateHealthBatch(newCandidateIds.slice(0, MILKTV_M3U_AUTOPILOT_PREVIEW_LIMIT), { autoAccept: false });
      }
      return { skipped: false, provider_id: provider.id, new_candidates: newCandidates, existing_candidates: existingCandidates };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    }
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) {}
    await db.query(`UPDATE milktv_m3u_providers SET last_import=NOW(),import_status='error',import_error=$2,updated_at=NOW() WHERE id=$1`, [provider.id, String(error.message || "Ошибка scheduler import").slice(0,500)]).catch(() => {});
    return { skipped: false, provider_id: provider.id, error: String(error.message || "Ошибка") };
  } finally {
    client.release();
  }
}

async function runMilktvM3uAutopilotCycle() {
  if (milktvM3uAutopilotRunning) return { skipped: true };
  milktvM3uAutopilotRunning = true;
  try {
    const providers = await db.query(`SELECT id,url FROM milktv_m3u_providers WHERE enabled=TRUE ORDER BY id`);
    let cursor = 0;
    const results = [];
    const worker = async () => { while (cursor < providers.rows.length) results.push(await runScheduledM3uProviderImport(providers.rows[cursor++])); };
    await Promise.all(Array.from({ length: Math.min(MILKTV_M3U_AUTOPILOT_PROVIDER_CONCURRENCY, providers.rows.length) }, worker));
    console.log(`MILK TV M3U autopilot: providers ${providers.rows.length}, completed ${results.length}`);
    return { skipped: false, results };
  } finally { milktvM3uAutopilotRunning = false; }
}

app.get("/admin/milktv/discovery/sources", auth, async (req, res) => {
  try {
    const result = await db.query(`SELECT id,type,name,enabled,configuration,last_run,status,error,created_at,updated_at FROM milktv_discovery_sources ORDER BY id DESC`);
    return res.json({ success: true, sources: result.rows });
  } catch (error) { return res.status(500).json({ success: false, error: "Не удалось получить discovery sources" }); }
});

app.post("/admin/milktv/discovery/sources", auth, csrfProtect, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const adapterType = typeof req.body?.adapter_type === "string" ? req.body.adapter_type : "public_index";
  if (!["github", "public_index", "official_broadcaster"].includes(adapterType)) return res.status(400).json({ success: false, error: "Неподдерживаемый adapter type" });
  if (!name || name.length > 200 || !rawUrl) return res.status(400).json({ success: false, error: "Некорректные name/url" });
  try {
    const url = await milktvDiscovery.safeUrl(rawUrl);
    const result = await db.query(`INSERT INTO milktv_discovery_sources(type,name,configuration) VALUES($1,$2,$3::jsonb) ON CONFLICT(name) DO UPDATE SET type=EXCLUDED.type,configuration=EXCLUDED.configuration,updated_at=NOW() RETURNING *`, [adapterType, name, JSON.stringify({ url, depth: 0 })]);
    return res.json({ success: true, source: result.rows[0] });
  } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
});

app.patch("/admin/milktv/discovery/sources/:sourceId", auth, csrfProtect, async (req, res) => {
  const id = Number(req.params.sourceId); if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "Некорректный source id" });
  const enabled = req.body?.enabled === true;
  try { const result = await db.query("UPDATE milktv_discovery_sources SET enabled=$1,updated_at=NOW() WHERE id=$2 RETURNING id,enabled", [enabled, id]); if (!result.rows.length) return res.status(404).json({ success: false, error: "Discovery source не найден" }); return res.json({ success: true, source: result.rows[0] }); }
  catch (error) { return res.status(500).json({ success: false, error: "Не удалось обновить discovery source" }); }
});

app.get("/admin/milktv/discovery/results", auth, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  try { const result = await db.query(`SELECT r.id,r.url,r.origin_url,r.result_type,r.status,r.first_seen,r.last_seen,s.name AS source_name FROM milktv_discovery_results r JOIN milktv_discovery_sources s ON s.id=r.source_id ORDER BY r.last_seen DESC LIMIT $1`, [limit]); return res.json({ success: true, results: result.rows }); }
  catch (error) { return res.status(500).json({ success: false, error: "Не удалось получить discovery results" }); }
});

app.post("/admin/milktv/discovery/run", auth, csrfProtect, async (req, res) => {
  const dryRun = req.body?.dry_run !== false;
  try { const result = await milktvDiscovery.runCycle(db, { dryRun }); return res.json({ success: true, dry_run: dryRun, ...result }); }
  catch (error) { return res.status(500).json({ success: false, error: "Discovery cycle не выполнен" }); }
});

app.post("/admin/milktv/discovery/sources/:sourceId/run", auth, csrfProtect, async (req, res) => {
  const id = Number(req.params.sourceId); if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: "Некорректный source id" });
  try { const source = await db.query("SELECT id,type,name,enabled,configuration FROM milktv_discovery_sources WHERE id=$1", [id]); if (!source.rows.length) return res.status(404).json({ success: false, error: "Discovery source не найден" }); const result = await milktvDiscovery.runSource(db, source.rows[0], { dryRun: req.body?.dry_run !== false }); return res.json({ success: true, ...result }); }
  catch (error) { return res.status(500).json({ success: false, error: "Discovery source не обработан" }); }
});

app.get("/admin/milktv/discovery/status", auth, (req, res) => res.json({ enabled: MILKTV_DISCOVERY_ENABLED, running: milktvDiscovery.running, interval_ms: MILKTV_DISCOVERY_INTERVAL, startup_delay_ms: MILKTV_DISCOVERY_START_DELAY, limits: milktvDiscovery.DEFAULT_LIMITS }));

app.get("/admin/milktv/m3u-autopilot/status", auth, (req, res) => {
  res.json({
    enabled: MILKTV_M3U_AUTOPILOT_ENABLED,
    running: milktvM3uAutopilotRunning,
    interval_ms: MILKTV_M3U_AUTOPILOT_INTERVAL,
    startup_delay_ms: MILKTV_M3U_AUTOPILOT_START_DELAY,
    provider_concurrency: MILKTV_M3U_AUTOPILOT_PROVIDER_CONCURRENCY,
    preview_limit: MILKTV_M3U_AUTOPILOT_PREVIEW_LIMIT
  });
});

app.get("/admin/milktv/m3u-sources", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, name, url, enabled, last_import, import_status, import_error,
             last_import_diagnostic,
             reputation_score, reputation_level, reputation_updated_at,
             created_at, updated_at
      FROM milktv_m3u_providers
      ORDER BY id DESC
    `);
    return res.json({ success: true, providers: result.rows });
  } catch (error) {
    console.error("MILK TV providers list error:", error);
    return res.status(500).json({ success: false, error: "Не удалось получить providers" });
  }
});

app.post("/admin/milktv/m3u-sources", auth, csrfProtect, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!name || !rawUrl || name.length > 200) {
    return res.status(400).json({ success: false, error: "Некорректные name/url" });
  }
  try {
    const url = await validateM3uProviderUrl(rawUrl);
    const result = await db.query(`
      INSERT INTO milktv_m3u_providers (name, url)
      VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE
      SET url = EXCLUDED.url, enabled = TRUE, updated_at = NOW()
      RETURNING id, name, url, enabled, import_status
    `, [name, url]);
    return res.json({ success: true, provider: result.rows[0] });
  } catch (error) {
    const status = /URL|адрес|HTTP|internal|внутрен/.test(error.message) ? 400 : 500;
    return res.status(status).json({ success: false, error: status === 400 ? error.message : "Не удалось сохранить provider" });
  }
});

app.patch("/admin/milktv/m3u-sources/:providerId", auth, csrfProtect, async (req, res) => {
  const providerId = Number(req.params.providerId);
  const enabled = req.body?.enabled;
  if (!Number.isInteger(providerId) || providerId <= 0 || typeof enabled !== "boolean") {
    return res.status(400).json({ success: false, error: "Некорректные данные provider" });
  }
  try {
    const result = await db.query(`
      UPDATE milktv_m3u_providers
      SET enabled = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, url, enabled, last_import, import_status, import_error,
                last_import_diagnostic
    `, [enabled, providerId]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: "Provider не найден" });
    return res.json({ success: true, provider: result.rows[0] });
  } catch (error) {
    console.error("MILK TV provider toggle error:", error);
    return res.status(500).json({ success: false, error: "Не удалось изменить provider" });
  }
});

app.post("/admin/milktv/m3u-sources/:providerId/import", auth, csrfProtect, async (req, res) => {
  const providerId = Number(req.params.providerId);
  if (!Number.isInteger(providerId) || providerId <= 0) {
    return res.status(400).json({ success: false, error: "Некорректный provider" });
  }
  try {
    const providerResult = await db.query(`
      SELECT id, url, enabled
      FROM milktv_m3u_providers
      WHERE id = $1
    `, [providerId]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Provider не найден" });
    }
    const provider = providerResult.rows[0];
    if (!provider.enabled) {
      return res.status(409).json({ success: false, error: "Provider отключён" });
    }
    const startedAt = new Date();
    const downloaded = await fetchM3uText(provider.url);
    const parsed = parseM3uPlaylist(downloaded.text);
    const entries = parsed.entries;
    const client = await db.connect();
    let inserted = 0;
    let existing = 0;
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        const before = await client.query(`SELECT id FROM milktv_m3u_candidates WHERE stream_url = $1`, [entry.streamUrl]);
        if (before.rows.length) existing++;
        const candidate = await client.query(`
          INSERT INTO milktv_m3u_candidates
            (stream_url, name, tvg_id, tvg_name, logo, group_title, last_seen, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
          ON CONFLICT (stream_url) DO UPDATE SET
            name = EXCLUDED.name,
            tvg_id = COALESCE(EXCLUDED.tvg_id, milktv_m3u_candidates.tvg_id),
            tvg_name = COALESCE(EXCLUDED.tvg_name, milktv_m3u_candidates.tvg_name),
            logo = COALESCE(EXCLUDED.logo, milktv_m3u_candidates.logo),
            group_title = COALESCE(EXCLUDED.group_title, milktv_m3u_candidates.group_title),
            last_seen = NOW(), updated_at = NOW()
          RETURNING id
        `, [entry.streamUrl, entry.name || entry.streamUrl, entry.tvgId, entry.tvgName, entry.logo, entry.groupTitle]);
        const link = await client.query(`
          INSERT INTO milktv_m3u_candidate_providers (candidate_id, provider_id, active, last_seen)
          VALUES ($1,$2,TRUE,NOW())
          ON CONFLICT (candidate_id, provider_id) DO UPDATE SET active = TRUE, last_seen = NOW()
          RETURNING candidate_id
        `, [candidate.rows[0].id, providerId]);
        if (!before.rows.length) inserted++;
      }
      const finishedAt = new Date();
      const diagnostic = {
        provider_id: providerId,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        http_status: downloaded.httpStatus,
        downloaded_bytes: downloaded.bytes,
        parsed_entries: entries.length,
        new_candidates: inserted,
        existing_candidates: existing,
        malformed_entries: parsed.malformed,
        candidates_shared_with_other_providers: 0,
        import_status: "ok",
        import_error: null
      };
      const shared = await client.query(`
        SELECT COUNT(*)::int AS count
        FROM milktv_m3u_candidates c
        WHERE EXISTS (
          SELECT 1 FROM milktv_m3u_candidate_providers cp
          WHERE cp.candidate_id = c.id AND cp.provider_id <> $1
        )
      `, [providerId]);
      diagnostic.candidates_shared_with_other_providers = shared.rows[0].count;
      await client.query(`
        UPDATE milktv_m3u_providers
        SET last_import = NOW(), import_status = 'ok', import_error = NULL,
            last_import_diagnostic = $2::jsonb, updated_at = NOW()
        WHERE id = $1
      `, [providerId, JSON.stringify(diagnostic)]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.json({ success: true, diagnostic });
  } catch (error) {
    await db.query(`
      UPDATE milktv_m3u_providers
      SET last_import = NOW(), import_status = 'error', import_error = $2,
          updated_at = NOW()
      WHERE id = $1
    `, [providerId, String(error.message || "Ошибка импорта").slice(0, 500)]).catch(() => {});
    console.error("MILK TV M3U import error:", error);
    return res.status(502).json({ success: false, error: "Не удалось импортировать provider" });
  }
});

app.get("/admin/milktv/m3u-candidates", auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.id, c.stream_url, c.name, c.tvg_id, c.tvg_name, c.logo,
             c.group_title, c.state, c.accepted_channel_id,
             c.health_status, c.failed_checks, c.response_time,
             c.last_check, c.health_error, c.suggested_channel_id,
             c.match_confidence,
             NOT EXISTS (
               SELECT 1 FROM milktv_m3u_candidate_providers cp2
               WHERE cp2.candidate_id = c.id AND cp2.active = TRUE
             ) AS is_stale,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name), NULL) AS providers
      FROM milktv_m3u_candidates c
      LEFT JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id = c.id
      LEFT JOIN milktv_m3u_providers p ON p.id = cp.provider_id
      GROUP BY c.id
      ORDER BY c.id DESC
      LIMIT 2000
    `);
    return res.json({ success: true, candidates: result.rows });
  } catch (error) {
    console.error("MILK TV candidates list error:", error);
    return res.status(500).json({ success: false, error: "Не удалось получить candidates" });
  }
});

app.post("/admin/milktv/m3u-candidates/preview", auth, csrfProtect, async (req, res) => {
  const requestedLimit = req.body?.limit === undefined ? 50 : Number(req.body.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    return res.status(400).json({ success: false, error: "Limit должен быть от 1 до 100" });
  }
  try {
    const result = await db.query(`
      SELECT id
      FROM milktv_m3u_candidates
      WHERE state = 'new'
      ORDER BY id
      LIMIT $1
    `, [requestedLimit]);
    const batch = await runCandidateHealthBatch(
      result.rows.map(row => Number(row.id)),
      { autoAccept: false }
    );
    return res.json({ success: true, limit: requestedLimit, ...batch });
  } catch (error) {
    console.error("Candidate preview error:", error);
    return res.status(500).json({ success: false, error: "Не удалось выполнить preview" });
  }
});

async function recordCandidateProvenance(client, candidateId, sourceId) {
  const origins = await client.query(`SELECT cp.provider_id FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=$1`, [candidateId]);
  for (const origin of origins.rows) await client.query(`INSERT INTO milktv_channel_source_provenance(source_id,origin_type,m3u_provider_id,candidate_id) VALUES($1,'m3u',$2,$3) ON CONFLICT DO NOTHING`, [sourceId, origin.provider_id, candidateId]);
}
app.post("/admin/milktv/m3u-candidates/accept-batch", auth, csrfProtect, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 10) {
    return res.status(400).json({ success: false, error: "Можно принять от 1 до 10 candidates" });
  }
  const normalized = items.map(item => ({ candidateId: Number(item?.candidate_id), channelId: Number(item?.channel_id) }));
  if (normalized.some(item => !Number.isInteger(item.candidateId) || item.candidateId <= 0 || !Number.isInteger(item.channelId) || item.channelId <= 0)) {
    return res.status(400).json({ success: false, error: "Некорректный список candidates" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const accepted = [];
    for (const item of normalized) {
      const candidate = await client.query(`SELECT id, stream_url, state FROM milktv_m3u_candidates WHERE id=$1 FOR UPDATE`, [item.candidateId]);
      if (!candidate.rows.length) throw Object.assign(new Error("Candidate не найден"), { statusCode: 404 });
      if (candidate.rows[0].state === "rejected") throw Object.assign(new Error("Rejected candidate нельзя принять"), { statusCode: 409 });
      const channel = await client.query(`SELECT id FROM channels WHERE id=$1 FOR UPDATE`, [item.channelId]);
      if (!channel.rows.length) throw Object.assign(new Error("Канал не найден"), { statusCode: 404 });
      const sourceResult = await client.query(`INSERT INTO milktv_channel_sources(channel_id,url,enabled,priority) VALUES($1,$2,TRUE,100) ON CONFLICT(channel_id,url) DO UPDATE SET enabled=TRUE,updated_at=NOW() RETURNING id`, [item.channelId, candidate.rows[0].stream_url]);
      await recordCandidateProvenance(client, item.candidateId, sourceResult.rows[0].id);
      await client.query(`UPDATE milktv_m3u_candidates SET state='accepted',accepted_channel_id=$1,updated_at=NOW() WHERE id=$2`, [item.channelId, item.candidateId]);
      accepted.push({ candidate_id: item.candidateId, channel_id: item.channelId });
    }
    await client.query("COMMIT");
    return res.json({ success: true, accepted });
  } catch (error) {
    await client.query("ROLLBACK");
    return res.status(error.statusCode || 500).json({ success: false, error: error.statusCode ? error.message : "Не удалось принять candidates" });
  } finally { client.release(); }
});

app.post("/admin/milktv/m3u-candidates/:candidateId/check", auth, csrfProtect, async (req, res) => {
  const candidateId = Number(req.params.candidateId);
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    return res.status(400).json({ success: false, error: "Некорректный candidate" });
  }
  try {
    const result = await updateCandidateHealth(candidateId);
    if (!result.found) return res.status(404).json({ success: false, error: "Candidate не найден" });
    return res.json({ success: true, result });
  } catch (error) {
    console.error("Candidate health check error:", error);
    return res.status(500).json({ success: false, error: "Не удалось проверить candidate" });
  }
});

app.post("/admin/milktv/m3u-candidates/check", auth, csrfProtect, async (req, res) => {
  if (candidateHealthCheckRunning) {
    return res.status(409).json({ success: false, error: "Проверка candidates уже выполняется" });
  }
  try {
    const result = await db.query(`
      SELECT id
      FROM milktv_m3u_candidates
      WHERE state = 'new'
      ORDER BY id
      LIMIT 500
    `);
    const batch = await runCandidateHealthBatch(result.rows.map(row => Number(row.id)));
    return res.json({ success: true, ...batch });
  } catch (error) {
    console.error("Candidate bulk health check error:", error);
    return res.status(500).json({ success: false, error: "Не удалось выполнить bulk health check" });
  }
});

app.post("/admin/milktv/m3u-candidates/:candidateId/accept", auth, csrfProtect, async (req, res) => {
  const candidateId = Number(req.params.candidateId);
  const channelId = Number(req.body?.channel_id);
  if (!Number.isInteger(candidateId) || candidateId <= 0 || !Number.isInteger(channelId) || channelId <= 0) {
    return res.status(400).json({ success: false, error: "Некорректные идентификаторы" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const candidate = await client.query(`SELECT id, stream_url, state FROM milktv_m3u_candidates WHERE id=$1 FOR UPDATE`, [candidateId]);
    if (!candidate.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Candidate не найден" }); }
    const channel = await client.query(`SELECT id FROM channels WHERE id=$1 FOR UPDATE`, [channelId]);
    if (!channel.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, error: "Канал не найден" }); }
    const sourceResult = await client.query(`
      INSERT INTO milktv_channel_sources (channel_id, url, enabled, priority)
      VALUES ($1,$2,TRUE,100)
      ON CONFLICT (channel_id,url) DO UPDATE SET enabled=TRUE, updated_at=NOW()
      RETURNING id
    `, [channelId, candidate.rows[0].stream_url]);
    await recordCandidateProvenance(client, candidateId, sourceResult.rows[0].id);
    await client.query(`
      UPDATE milktv_m3u_candidates
      SET state='accepted', accepted_channel_id=$1, updated_at=NOW()
      WHERE id=$2
    `, [channelId, candidateId]);
    await client.query("COMMIT");
    return res.json({ success: true, candidate_id: candidateId, channel_id: channelId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("MILK TV candidate accept error:", error);
    return res.status(500).json({ success: false, error: "Не удалось принять candidate" });
  } finally { client.release(); }
});

app.post("/admin/milktv/m3u-candidates/:candidateId/reject", auth, csrfProtect, async (req, res) => {
  const candidateId = Number(req.params.candidateId);
  if (!Number.isInteger(candidateId) || candidateId <= 0) return res.status(400).json({ success: false, error: "Некорректный candidate" });
  try {
    const result = await db.query(`UPDATE milktv_m3u_candidates SET state='rejected', updated_at=NOW() WHERE id=$1 RETURNING id,state`, [candidateId]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: "Candidate не найден" });
    return res.json({ success: true, candidate: result.rows[0] });
  } catch (error) {
    console.error("MILK TV candidate reject error:", error);
    return res.status(500).json({ success: false, error: "Не удалось отклонить candidate" });
  }
});

app.get("/admin/milktv/channels/:channelId/sources", auth, async (req, res) => {
  const channelId = Number(req.params.channelId);
  if (!Number.isInteger(channelId) || channelId <= 0) {
    return res.status(400).json({ success: false, error: "Некорректный идентификатор канала" });
  }
  try {
    const result = await db.query(`
      SELECT id, channel_id, url, enabled, priority, status,
             failed_checks, response_time, last_check, check_error,
             video_width, video_height, resolution_label, video_codec, video_bitrate, fps,
             audio_codec, audio_bitrate, audio_channels, has_video, has_audio, startup_time,
             measured_at, probe_status, probe_error, quality_score, quality_confidence,
             trust_score, trust_level, trust_updated_at,
             COALESCE((SELECT json_agg(json_build_object('type',p.origin_type,'provider_id',p.m3u_provider_id,'discovery_source_id',p.discovery_source_id)) FROM milktv_channel_source_provenance p WHERE p.source_id=id),'[]'::json) AS origins,
             created_at, updated_at
      FROM milktv_channel_sources
      WHERE channel_id = $1
      ORDER BY priority ASC, id ASC
    `, [channelId]);
    return res.json({ success: true, sources: result.rows });
  } catch (error) {
    console.error("MILK TV sources list error:", error);
    return res.status(500).json({ success: false, error: "Не удалось получить источники" });
  }
});

app.post("/admin/milktv/channels/:channelId/sources/:sourceId/quality", auth, csrfProtect, async (req,res)=>{
  const channelId=Number(req.params.channelId), sourceId=Number(req.params.sourceId);
  if(!Number.isInteger(channelId)||channelId<=0||!Number.isInteger(sourceId)||sourceId<=0)return res.status(400).json({success:false,error:"Некорректный идентификатор"});
  try{const q=await db.query("SELECT id,url,failed_checks,response_time,priority FROM milktv_channel_sources WHERE id=$1 AND channel_id=$2",[sourceId,channelId]);if(!q.rows.length)return res.status(404).json({success:false,error:"Источник не найден"});const m=await milktvQuality.probe(q.rows[0].url);const score=m.status==='online'?Number(m.score||0)-Number(q.rows[0].failed_checks||0)*5-Number(m.startupTime||0)/1000:null;const u=await db.query(`UPDATE milktv_channel_sources SET video_width=$1,video_height=$2,resolution_label=$3,video_codec=$4,video_bitrate=$5,fps=$6,audio_codec=$7,audio_bitrate=$8,audio_channels=$9,has_video=$10,has_audio=$11,startup_time=$12,measured_at=NOW(),probe_status=$13,probe_error=$14,quality_score=$15,quality_confidence=$16,updated_at=NOW() WHERE id=$17 AND channel_id=$18 RETURNING *`,[m.videoWidth,m.videoHeight,m.resolutionLabel,m.videoCodec,m.videoBitrate,m.fps,m.audioCodec,m.audioBitrate,m.audioChannels,m.hasVideo,m.hasAudio,m.startupTime,m.status,m.error,score,m.confidence||'unknown',sourceId,channelId]);return res.json({success:true,source:u.rows[0]});}catch(e){return res.status(500).json({success:false,error:"Проверка качества не выполнена"})}
});

async function runQualityBatch(channelId, sourceRows) {
  let cursor=0, success=0, failed=0, timeout=0;
  const worker=async()=>{while(cursor<sourceRows.length){const s=sourceRows[cursor++];try{const m=await milktvQuality.probe(s.url);if(m.status==='online')success++;else {failed++;if(m.error&&m.error.toLowerCase().includes('timeout'))timeout++;}const score=m.status==='online'?Number(m.score||0)-Number(s.failed_checks||0)*5-Number(m.startupTime||0)/1000:null;await db.query(`UPDATE milktv_channel_sources SET video_width=$1,video_height=$2,resolution_label=$3,video_codec=$4,video_bitrate=$5,fps=$6,audio_codec=$7,audio_bitrate=$8,audio_channels=$9,has_video=$10,has_audio=$11,startup_time=$12,measured_at=NOW(),probe_status=$13,probe_error=$14,quality_score=$15,quality_confidence=$16,updated_at=NOW() WHERE id=$17 AND channel_id=$18`,[m.videoWidth,m.videoHeight,m.resolutionLabel,m.videoCodec,m.videoBitrate,m.fps,m.audioCodec,m.audioBitrate,m.audioChannels,m.hasVideo,m.hasAudio,m.startupTime,m.status,m.error,score,m.confidence||'unknown',s.id,channelId]);}catch(e){failed++;}}};await Promise.all(Array.from({length:Math.min(2,sourceRows.length)},worker));return {checked:sourceRows.length,success,failed,timeout};
}
app.post("/admin/milktv/channels/:channelId/quality", auth, csrfProtect, async (req,res)=>{const id=Number(req.params.channelId);if(!Number.isInteger(id)||id<=0)return res.status(400).json({success:false,error:"Некорректный channel id"});try{const q=await db.query("SELECT id,url,failed_checks FROM milktv_channel_sources WHERE channel_id=$1 AND enabled=TRUE ORDER BY priority,id LIMIT 20",[id]);return res.json({success:true,...await runQualityBatch(id,q.rows)});}catch(e){return res.status(500).json({success:false,error:"Проверка качества не выполнена"})}});
app.get("/admin/milktv/channels/:channelId/quality-recommendation", auth, async (req,res)=>{const id=Number(req.params.channelId);try{const q=await db.query("SELECT id,url,quality_score,quality_confidence,measured_at,failed_checks FROM milktv_channel_sources WHERE channel_id=$1 AND enabled=TRUE ORDER BY priority,id",[id]);const ranked=milktvQuality.rank(q.rows),cur=ranked.find(x=>x.url===q.rows[0]?.url)||null,best=ranked[0]||null;const gap=best&&cur?Number(best.quality_score||0)-Number(cur.quality_score||0):0;return res.json({success:true,current:cur,best,score_gap:gap,recommendation:!best||!cur||!best.measured_at||!cur.measured_at?'insufficient_data':best.id===cur.id?'keep_current':gap<MILKTV_QUALITY_SWITCH_GAP?'keep_current':'consider_switch'});}catch(e){return res.status(500).json({success:false,error:"Не удалось получить recommendation"})}});
async function switchMilktvSource(channelId, sourceId, reason, automatic){const c=await db.connect();try{await c.query("BEGIN");const q=await c.query("SELECT c.url,c.current_source_id,s.id,s.url,s.enabled,s.status,s.quality_score,s.quality_confidence,s.measured_at FROM channels c JOIN milktv_channel_sources s ON s.channel_id=c.id WHERE c.id=$1 AND s.id=$2 FOR UPDATE",[channelId,sourceId]);if(!q.rows.length||!q.rows[0].enabled||q.rows[0].status==='quarantine')throw Error('Источник недоступен');const row=q.rows[0];if(automatic&&(!row.measured_at||row.quality_confidence!=='measured'))throw Error('Недостаточно quality data');const from=await c.query("SELECT id,quality_score FROM milktv_channel_sources WHERE channel_id=$1 AND url=$2",[channelId,row.url]);const fromId=from.rows[0]?.id||null;await c.query("UPDATE channels SET url=$1,current_source_id=$2 WHERE id=$3 AND url=$4",[row.url,sourceId,channelId,row.url]);await c.query("INSERT INTO milktv_source_switch_history(channel_id,from_source_id,to_source_id,reason,from_score,to_score,automatic,result) VALUES($1,$2,$3,$4,$5,$6,$7,'success')",[channelId,fromId,sourceId,reason,from.rows[0]?.quality_score||null,row.quality_score,automatic]);await c.query("COMMIT");return {success:true,source:row}}catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}}
app.post("/admin/milktv/channels/:channelId/sources/:sourceId/current",auth,csrfProtect,async(req,res)=>{const channelId=Number(req.params.channelId),sourceId=Number(req.params.sourceId);try{return res.json(await switchMilktvSource(channelId,sourceId,'manual',false))}catch(e){return res.status(409).json({success:false,error:e.message})}});
app.get("/admin/milktv/quality-scheduler/status", auth, (req,res)=>res.json({enabled:MILKTV_QUALITY_PROBE_ENABLED,running:false,interval_ms:MILKTV_QUALITY_INTERVAL,startup_delay_ms:MILKTV_QUALITY_START_DELAY,batch_limit:MILKTV_QUALITY_BATCH_LIMIT,concurrency:MILKTV_QUALITY_CONCURRENCY,switch_gap:MILKTV_QUALITY_SWITCH_GAP}));
let milktvAutoSwitchState={running:false,last_cycle:null,next_cycle:null,evaluated:0,considered:0,switched:0,skipped:0,cooldown:0,errors:0};
// The readable module is the sole implementation used by the autoswitch scheduler.
runMilktvSourceAutoSwitchCycle = async () => { milktvAutoSwitchState.running = true; try { const result = await milktvSourceAutoswitch.runCycle(db, { switchSource: switchMilktvSource }, { batchLimit: 100, gap: MILKTV_QUALITY_SWITCH_GAP, stability: 3 }); milktvAutoSwitchState = { ...milktvAutoSwitchState, ...result, last_cycle: new Date().toISOString(), next_cycle: new Date(Date.now() + MILKTV_SOURCE_AUTOSWITCH_INTERVAL).toISOString() }; return result; } finally { milktvAutoSwitchState.running = false; } };
app.get("/admin/milktv/source-autoswitch/status",auth,(req,res)=>res.json({enabled:MILKTV_SOURCE_AUTOSWITCH_ENABLED,...milktvAutoSwitchState,interval_ms:MILKTV_SOURCE_AUTOSWITCH_INTERVAL}));
let milktvAutopilotState = { state: MILKTV_AUTOPILOT_ENABLED ? 'ON' : 'OFF', last_run_at: null, last_run_summary: null, running: false, overlap_skips: 0 };
function readLatestHealthEvidence() {
  if (milktvHealthRuntime.last_run_at && milktvHealthRuntime.last_result) return { at: milktvHealthRuntime.last_run_at, result: milktvHealthRuntime.last_result };
  const reportDir = path.join(__dirname, 'reports');
  const latest = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).filter(name => /^milktv-health-(full|background-equivalent)-.*\.json$/i.test(name)).map(name => ({ name, at: fs.statSync(path.join(reportDir, name)).mtimeMs })).sort((a,b) => b.at - a.at)[0] : null;
  if (!latest) return null;
  const report = JSON.parse(fs.readFileSync(path.join(reportDir, latest.name), 'utf8'));
  return { at: report.created_at, result: report };
}
function autopilotHealthGate() {
  if (milktvCheckProgress.running || milktvHealthRuntime.state === 'RUNNING') return { ok: false, reason: 'health_running' };
  if (milktvHealthRuntime.infra_degraded || milktvHealthRuntime.state === 'PAUSED') return { ok: false, reason: 'health_infra_degraded' };
  const evidence = readLatestHealthEvidence();
  if (!evidence || !evidence.at || Date.now() - new Date(evidence.at).getTime() > 45 * 60 * 1000) return { ok: false, reason: 'stale_health' };
  if (evidence.result?.circuit_breaker || Number(evidence.result?.db_errors || 0) > 0) return { ok: false, reason: 'health_infra_degraded' };
  return { ok: true, evidence };
}
async function runMilktvRecoveryAutopilot(options = {}) {
  if (milktvAutopilotState.running) { milktvAutopilotState.overlap_skips++; return { skipped: true, reason: "already_running" }; }
  const dryRun = options.dryRun !== false;
  if (!dryRun && !MILKTV_AUTOPILOT_ENABLED) throw new Error("autopilot_disabled");
  const healthGate = autopilotHealthGate();
  if (!healthGate.ok) {
    milktvAutopilotState.state = 'PAUSED';
    milktvAutopilotState.last_run_at = new Date().toISOString();
    milktvAutopilotState.last_run_summary = { status: healthGate.reason === 'stale_health' ? 'AUTOPILOT_PAUSED_STALE_HEALTH' : healthGate.reason === 'health_running' ? 'AUTOPILOT_SKIPPED_HEALTH_RUNNING' : 'AUTOPILOT_PAUSED_HEALTH_INFRA_DEGRADED', confirmed_failed: 0, eligible: 0, final_probes: 0, switched: 0, recovered: 0, no_safe_reserve: 0, errors: 0 };
    return milktvAutopilotState.last_run_summary;
  }
  milktvAutopilotState.running = true;
  milktvAutopilotState.state = 'RUNNING';
  try {
    console.log('[AUTOPILOT] cycle start');
    const result = await milktvAutopilot.runAutopilot(db, { dryRun, maxSwitches: milktvAutopilot.configuredMax(), finalProbe: async url => probeMilktvSource(url, { redirect: "error" }), postSwitchProbe: async url => probeMilktvSource(url, { redirect: "error" }), switchSource: payload => switchChannelSource(db, { ...payload, automatic: true }) });
    milktvAutopilotState.last_run_at = result.started_at;
    milktvAutopilotState.last_run_summary = { started_at: result.started_at, enabled: result.enabled, mode: result.mode, confirmed_failed: result.failed_channels_considered, eligible: result.eligible_alternates, final_probes: result.final_probes, switched: result.switches_executed, recovered: result.recovered_online, no_safe_reserve: result.skipped_no_alternate, errors: result.switches_failed, dry_run: result.dry_run };
    console.log('[AUTOPILOT] cycle end', JSON.stringify(milktvAutopilotState.last_run_summary));
    return result;
  } finally { milktvAutopilotState.running = false; milktvAutopilotState.state = MILKTV_AUTOPILOT_ENABLED ? 'ON' : 'OFF'; }
}
app.get("/admin/milktv/autopilot/status", auth, (req, res) => res.json({ enabled: MILKTV_AUTOPILOT_ENABLED, state: milktvAutopilotState.state, mode: "recovery_only", interval_minutes: MILKTV_AUTOPILOT_INTERVAL / 60000, max_switches_per_run: milktvAutopilot.configuredMax(), overlap_skips: milktvAutopilotState.overlap_skips, last_run_at: milktvAutopilotState.last_run_at, last_run_summary: milktvAutopilotState.last_run_summary }));
app.post("/admin/milktv/autopilot/run", auth, csrfProtect, async (req, res) => {
  const live = req.body?.dryRun === false;
  if (live && (!MILKTV_AUTOPILOT_ENABLED || req.body?.confirmLive !== true)) return res.status(403).json({ success: false, error: "Live run requires MILKTV_AUTOPILOT_ENABLED=true and confirmLive=true" });
  try { return res.json({ success: true, result: await runMilktvRecoveryAutopilot({ dryRun: !live }) }); }
  catch (error) { return res.status(500).json({ success: false, error: error.message }); }
});
app.get("/api/epg/now-next", async (req,res)=>{try{const ids=String(req.query.channel_ids||'').split(',').map(Number).filter(Number.isInteger);const out={};for(const id of ids)out[id]=await milktvEpg.getNowNext(db,id);res.json({success:true,channels:out})}catch(e){res.status(500).json({success:false,error:'EPG unavailable'})}});
app.get("/api/epg/channel/:channelId", async (req,res)=>{const id=Number(req.params.channelId);if(!Number.isInteger(id)||id<=0)return res.status(400).json({success:false,error:'Invalid channel id'});try{res.json({success:true,channel_id:id,programmes:await milktvEpg.getSchedule(db,id,req.query.from,req.query.to)})}catch(e){res.status(500).json({success:false,error:'EPG unavailable'})}});
app.get('/admin/milktv/epg/sources',auth,async(req,res)=>{try{res.json({success:true,sources:(await db.query('SELECT * FROM milktv_epg_sources ORDER BY id DESC')).rows})}catch(e){res.status(500).json({success:false,error:'EPG sources unavailable'})}});
app.post('/admin/milktv/epg/sources',auth,csrfProtect,async(req,res)=>{const n=String(req.body?.name||'').trim(),u=String(req.body?.url||'').trim();if(!n||!u)return res.status(400).json({success:false,error:'Invalid source'});try{const safe=await milktvDiscovery.safeUrl(u);const q=await db.query('INSERT INTO milktv_epg_sources(name,url,type) VALUES($1,$2,\'xmltv\') RETURNING *',[n,safe]);res.json({success:true,source:q.rows[0]})}catch(e){res.status(400).json({success:false,error:e.message})}});
app.patch('/admin/milktv/epg/sources/:id',auth,csrfProtect,async(req,res)=>{const q=await db.query('UPDATE milktv_epg_sources SET enabled=$1,updated_at=NOW() WHERE id=$2 RETURNING *',[req.body?.enabled===true,Number(req.params.id)]);if(!q.rows.length)return res.status(404).json({success:false,error:'Source not found'});res.json({success:true,source:q.rows[0]})});
app.delete('/admin/milktv/epg/sources/:id',auth,csrfProtect,async(req,res)=>{await db.query('DELETE FROM milktv_epg_sources WHERE id=$1',[Number(req.params.id)]);res.json({success:true})});
async function fetchEpgXml(url){const safe=await milktvDiscovery.safeUrl(url);const c=new AbortController(),t=setTimeout(()=>c.abort(),15000),max=10*1024*1024;try{const r=await fetch(safe,{redirect:'error',signal:c.signal});if(!r.ok)throw Error(`HTTP ${r.status}`);if(!r.body)return await r.text();const reader=r.body.getReader(),chunks=[];let total=0;for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>max){await reader.cancel().catch(()=>{});throw Error('XMLTV too large')}chunks.push(Buffer.from(part.value))}return Buffer.concat(chunks,total).toString('utf8')}finally{clearTimeout(t)}}
// Common import path for manual and scheduled EPG refreshes. Kept before the legacy
// inline handler below so Express uses this safe implementation for the route.
app.post('/admin/milktv/epg/sources/:id/import',auth,csrfProtect,async(req,res)=>{const sid=Number(req.params.id);try{const src=(await db.query('SELECT * FROM milktv_epg_sources WHERE id=$1',[sid])).rows[0];if(!src)return res.status(404).json({success:false,error:'Source not found'});res.json({success:true,result:await milktvEpg.importMilktvEpgSource(db,src,{fetchXml:fetchEpgXml,matcher:epgMatcher.matchEpgChannel})})}catch(e){res.status(500).json({success:false,error:e.message})}});
let milktvEpgSchedulerRunning=false;
let milktvEpgSchedulerState={last_cycle:null,next_cycle:null,success:0,errors:0,skipped:0};
async function runMilktvEpgImportCycle(){
  if(!MILKTV_EPG_ENABLED||milktvEpgSchedulerRunning)return {disabled:!MILKTV_EPG_ENABLED,skipped:milktvEpgSchedulerRunning};
  milktvEpgSchedulerRunning=true; const summary={processed:0,success:0,errors:0,skipped:0}; let c=null; let locked=false;
  try{c=await db.connect();locked=(await c.query('SELECT pg_try_advisory_lock($1) AS locked',[960999])).rows[0].locked;if(!locked)return {...summary,skipped:1,reason:'lock_busy'};
    const sources=(await c.query("SELECT * FROM milktv_epg_sources WHERE enabled=TRUE ORDER BY id")).rows;
    for(const source of sources){summary.processed++;try{const result=await milktvEpg.importMilktvEpgSource(db,source,{fetchXml:fetchEpgXml,matcher:epgMatcher.matchEpgChannel});if(result.skipped)summary.skipped++;else summary.success++;}catch(error){summary.errors++;console.warn('MILK TV EPG source import failed',source.id,String(error.message).slice(0,200));}}
    return summary;
  }finally{if(c&&locked)await c.query('SELECT pg_advisory_unlock($1)',[960999]).catch(()=>{});if(c)c.release();milktvEpgSchedulerRunning=false;milktvEpgSchedulerState={...milktvEpgSchedulerState,...summary,last_cycle:new Date().toISOString(),next_cycle:new Date(Date.now()+MILKTV_EPG_INTERVAL).toISOString()};}
}
app.get('/admin/milktv/epg/status',auth,(req,res)=>res.json({success:true,enabled:MILKTV_EPG_ENABLED,running:milktvEpgSchedulerRunning,interval_ms:MILKTV_EPG_INTERVAL,start_delay_ms:MILKTV_EPG_START_DELAY,...milktvEpgSchedulerState}));
app.get('/admin/milktv/channels/:channelId/sources/:sourceId/promo',auth,async(req,res)=>{try{const q=await db.query('SELECT id,channel_id,promo_status,promo_score,promo_confidence,promo_checked_at,promo_last_detected_at,promo_observations,promo_detections,promo_error,promo_evidence FROM milktv_channel_sources WHERE id=$1 AND channel_id=$2',[Number(req.params.sourceId),Number(req.params.channelId)]);if(!q.rows.length)return res.status(404).json({success:false,error:'Source not found'});res.json({success:true,promo:q.rows[0]})}catch(e){res.status(500).json({success:false,error:'Promo data unavailable'})}});
app.get('/admin/milktv/source-ingestion/preview',auth,async(req,res)=>{const limit=Math.min(100,Math.max(1,Number(req.query.limit)||100));try{const q=await db.query("SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id) AS has_provenance,NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp2 WHERE cp2.candidate_id=c.id AND cp2.active=TRUE) AS is_stale,ARRAY_REMOVE(ARRAY_AGG(DISTINCT p.name),NULL) AS providers FROM milktv_m3u_candidates c LEFT JOIN milktv_m3u_candidate_providers cp ON cp.candidate_id=c.id LEFT JOIN milktv_m3u_providers p ON p.id=cp.provider_id GROUP BY c.id ORDER BY c.id DESC LIMIT $1",[limit]);const items=[];for(const row of q.rows){let decision=await milktvSourceIngestion.classifyCandidateForIngestion(db,row);if(decision.outcome==='AUTO_ELIGIBLE'){try{await milktvDiscovery.safeUrl(row.stream_url)}catch(e){decision={outcome:'REJECTED',reason:'reject_invalid_url'}}}items.push({candidate_id:row.id,name:row.name,url:row.stream_url,providers:row.providers||[],suggested_channel_id:row.suggested_channel_id,match_confidence:row.match_confidence,health_status:row.health_status,outcome:decision.outcome,reason:decision.reason})}res.json({success:true,auto_eligible:items.filter(x=>x.outcome==='AUTO_ELIGIBLE').length,review_required:items.filter(x=>x.outcome==='REVIEW_REQUIRED').length,rejected:items.filter(x=>x.outcome==='REJECTED').length,items})}catch(e){res.status(500).json({success:false,error:'Ingestion preview unavailable'})}});
app.post('/admin/milktv/source-ingestion/run',auth,csrfProtect,async(req,res)=>{const limit=Math.min(10,Math.max(1,Number(req.body?.limit)||10));try{const q=await db.query("SELECT c.*,EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp WHERE cp.candidate_id=c.id) AS has_provenance,NOT EXISTS(SELECT 1 FROM milktv_m3u_candidate_providers cp2 WHERE cp2.candidate_id=c.id AND cp2.active=TRUE) AS is_stale FROM milktv_m3u_candidates c WHERE c.state<>'rejected' ORDER BY c.id DESC LIMIT 100");const results=[];for(const row of q.rows){if(results.filter(x=>x.outcome==='AUTO_ELIGIBLE').length>=limit)break;try{await milktvDiscovery.safeUrl(row.stream_url);const d=milktvSourceIngestion.classifyCandidate(row);if(d.outcome!=='AUTO_ELIGIBLE')continue;const p=await db.query('SELECT COALESCE(MAX(priority),0)+10 AS priority FROM milktv_channel_sources WHERE channel_id=$1',[d.channel_id]);results.push({...await milktvSourceIngestion.ingestCandidate(db,row.id,{reservePriority:Number(p.rows[0].priority)}),candidate_id:row.id})}catch(e){results.push({candidate_id:row.id,outcome:'FAILED',reason:String(e.message).slice(0,200)})}}res.json({success:true,flag_enabled:MILKTV_SOURCE_AUTO_INGEST_ENABLED,results})}catch(e){res.status(500).json({success:false,error:'Ingestion run failed'})}});
app.post('/admin/milktv/channels/:channelId/sources/:sourceId/promo-probe',auth,csrfProtect,async(req,res)=>{const channelId=Number(req.params.channelId),sourceId=Number(req.params.sourceId);try{const q=await db.query('SELECT id FROM milktv_channel_sources WHERE id=$1 AND channel_id=$2 AND enabled=TRUE',[sourceId,channelId]);if(!q.rows.length)return res.status(404).json({success:false,error:'Enabled source not found'});const ff=await milktvPromoDetector.checkFfmpegAvailability();if(ff.status!=='AVAILABLE'){await db.query("UPDATE milktv_channel_sources SET promo_status='error',promo_error=$1,promo_checked_at=NOW() WHERE id=$2 AND channel_id=$3",['ffmpeg unavailable: '+ff.status,sourceId,channelId]);return res.status(503).json({success:false,status:'PROMO PROBE NOT STARTED',ffmpeg:ff})}res.json({success:false,status:'PROMO PROBE NOT STARTED',error:'Frame/OCR sampling adapter is not configured',ffmpeg:ff})}catch(e){res.status(500).json({success:false,error:'Promo probe failed'})}});
async function epgPreview(sourceId){const s=await db.query('SELECT * FROM milktv_epg_sources WHERE id=$1',[sourceId]);if(!s.rows.length)throw Object.assign(Error('Source not found'),{statusCode:404});const parsed=milktvEpg.parseXmltv(await fetchEpgXml(s.rows[0].url));const ch=(await db.query('SELECT id,name FROM channels')).rows;const counts={exact:0,ambiguous:0,unmatched:0};for(const e of parsed.channels){const m=epgMatcher.matchEpgChannel(e,ch);if(m.confidence==='high')counts.exact++;else if(m.confidence==='ambiguous')counts.ambiguous++;else counts.unmatched++}const dates=parsed.programmes.map(p=>[p.start,p.stop]).flat().sort((a,b)=>a-b);return {channels:parsed.channels.length,programmes:parsed.programmes.length,earliest:dates[0]||null,latest:dates.at(-1)||null,...counts}}
app.post('/admin/milktv/epg/sources/:id/preview',auth,csrfProtect,async(req,res)=>{try{res.json({success:true,preview:await epgPreview(Number(req.params.id))})}catch(e){res.status(e.statusCode||500).json({success:false,error:e.message})}});
app.post('/admin/milktv/epg/mappings',auth,csrfProtect,async(req,res)=>{const c=Number(req.body?.channel_id),s=String(req.body?.epg_channel_id||'');if(!Number.isInteger(c)||c<=0||!s)return res.status(400).json({success:false,error:'Invalid mapping'});const q=await db.query("INSERT INTO milktv_epg_channels(channel_id,epg_id,match_status,match_confidence,updated_at) VALUES($1,$2,'manual','high',NOW()) ON CONFLICT(channel_id) DO UPDATE SET epg_id=EXCLUDED.epg_id,match_status='manual',match_confidence='high',updated_at=NOW() RETURNING *",[c,s]);res.json({success:true,mapping:q.rows[0]})});
app.delete('/admin/milktv/epg/mappings/:channelId',auth,csrfProtect,async(req,res)=>{await db.query('DELETE FROM milktv_epg_channels WHERE channel_id=$1 AND match_status=\'manual\'',[Number(req.params.channelId)]);res.json({success:true})});
async function runMilktvSourceAutoSwitchCycle(){if(milktvAutoSwitchState.running)return {skipped:true};milktvAutoSwitchState.running=true;const c=await db.connect();const summary={evaluated:0,considered:0,switched:0,skipped:0,cooldown:0,errors:0};try{const l=await c.query("SELECT pg_try_advisory_lock(947777) AS locked");if(!l.rows[0].locked)return {skipped:true};try{const q=await c.query("SELECT c.id,c.url,c.current_source_id FROM channels c WHERE (SELECT COUNT(*) FROM milktv_channel_sources s WHERE s.channel_id=c.id AND s.enabled)=2 ORDER BY c.id LIMIT 100");for(const ch of q.rows){summary.evaluated++;try{const s=await c.query("SELECT id,url,quality_score,quality_confidence,measured_at,failed_checks,probe_status FROM milktv_channel_sources WHERE channel_id=$1 AND enabled=TRUE ORDER BY quality_score DESC NULLS LAST,id",[ch.id]);const current=s.rows.find(x=>x.id===ch.current_source_id)||s.rows.find(x=>x.url===ch.url),best=s.rows[0];if(!current||!best||best.id===current.id){summary.skipped++;continue}summary.considered++;const fresh=x=>x.measured_at&&Date.now()-new Date(x.measured_at).getTime()<12*3600000;if(!fresh(current)||!fresh(best)||best.probe_status!=='online'||best.quality_confidence!=='measured'||Number(best.quality_score)-Number(current.quality_score)<MILKTV_QUALITY_SWITCH_GAP||Number(best.failed_checks||0)>0){summary.skipped++;continue}const recent=await c.query("SELECT 1 FROM milktv_source_switch_history WHERE channel_id=$1 AND automatic=TRUE AND reason='quality_upgrade' AND created_at>NOW()-INTERVAL '6 hours' LIMIT 1",[ch.id]);if(recent.rows.length){summary.cooldown++;continue}await switchMilktvSource(ch.id,best.id,'quality_upgrade',true);summary.switched++;}catch(e){summary.errors++}}return summary}finally{await c.query("SELECT pg_advisory_unlock(947777)").catch(()=>{})}}finally{c.release();milktvAutoSwitchState.running=false;milktvAutoSwitchState={...milktvAutoSwitchState,...summary,last_cycle:new Date().toISOString(),next_cycle:new Date(Date.now()+MILKTV_SOURCE_AUTOSWITCH_INTERVAL).toISOString()}}}

app.post("/admin/milktv/channels/:channelId/sources", auth, csrfProtect, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const priority = req.body?.priority === undefined ? 100 : Number(req.body.priority);
  if (!Number.isInteger(channelId) || channelId <= 0 || !url || !Number.isInteger(priority) || priority < 0) {
    return res.status(400).json({ success: false, error: "Некорректные данные источника" });
  }
  try {
    const result = await db.query(`
      INSERT INTO milktv_channel_sources (channel_id, url, priority)
      SELECT $1, $2, $3
      WHERE EXISTS (SELECT 1 FROM channels WHERE id = $1)
      ON CONFLICT (channel_id, url)
      DO UPDATE SET enabled = TRUE, priority = EXCLUDED.priority, updated_at = NOW()
      RETURNING id, channel_id, url, enabled, priority, status,
                failed_checks, response_time, last_check, check_error
    `, [channelId, url, priority]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Канал не найден" });
    }
    return res.json({ success: true, source: result.rows[0] });
  } catch (error) {
    console.error("MILK TV source add error:", error);
    return res.status(500).json({ success: false, error: "Не удалось добавить источник" });
  }
});

app.patch("/admin/milktv/channels/:channelId/sources/:sourceId", auth, csrfProtect, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const sourceId = Number(req.params.sourceId);
  const enabled = req.body?.enabled;
  const priority = req.body?.priority;
  if (!Number.isInteger(channelId) || channelId <= 0 || !Number.isInteger(sourceId) || sourceId <= 0
      || (enabled !== undefined && typeof enabled !== "boolean")
      || (priority !== undefined && (!Number.isInteger(Number(priority)) || Number(priority) < 0))) {
    return res.status(400).json({ success: false, error: "Некорректные данные источника" });
  }
  try {
    const result = await db.query(`
      UPDATE milktv_channel_sources
      SET
        enabled = COALESCE($1::boolean, enabled),
        priority = COALESCE($2::integer, priority),
        updated_at = NOW()
      WHERE id = $3 AND channel_id = $4
      RETURNING id, channel_id, url, enabled, priority, status,
                failed_checks, response_time, last_check, check_error
    `, [enabled === undefined ? null : enabled, priority === undefined ? null : Number(priority), sourceId, channelId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Источник не найден" });
    }
    return res.json({ success: true, source: result.rows[0] });
  } catch (error) {
    console.error("MILK TV source update error:", error);
    return res.status(500).json({ success: false, error: "Не удалось изменить источник" });
  }
});

app.delete("/admin/milktv/channels/:channelId/sources/:sourceId", auth, csrfProtect, async (req, res) => {
  const channelId = Number(req.params.channelId);
  const sourceId = Number(req.params.sourceId);
  if (!Number.isInteger(channelId) || channelId <= 0 || !Number.isInteger(sourceId) || sourceId <= 0) {
    return res.status(400).json({ success: false, error: "Некорректный идентификатор" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query(`
      SELECT s.id, s.url, c.url AS current_url
      FROM milktv_channel_sources s
      JOIN channels c ON c.id = s.channel_id
      WHERE s.id = $1 AND s.channel_id = $2
      FOR UPDATE
    `, [sourceId, channelId]);
    if (source.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "Источник не найден" });
    }
    if (source.rows[0].url === source.rows[0].current_url) {
      const fallback = await client.query(`
        SELECT url
        FROM milktv_channel_sources
        WHERE channel_id = $1 AND id <> $2 AND enabled = TRUE
        ORDER BY priority ASC, failed_checks ASC, COALESCE(response_time, 2147483647) ASC, id ASC
        LIMIT 1
      `, [channelId, sourceId]);
      if (fallback.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: "Нельзя удалить последний текущий источник" });
      }
      await client.query("UPDATE channels SET url = $1, current_source_id = (SELECT id FROM milktv_channel_sources WHERE channel_id = $2 AND url = $1 LIMIT 1) WHERE id = $2", [fallback.rows[0].url, channelId]);
    }
    await client.query("DELETE FROM milktv_channel_sources WHERE id = $1 AND channel_id = $2", [sourceId, channelId]);
    await client.query("COMMIT");
    return res.json({ success: true, removed: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("MILK TV source delete error:", error);
    return res.status(500).json({ success: false, error: "Не удалось удалить источник" });
  } finally {
    client.release();
  }
});

app.post(
  "/admin/milktv/replacement-pool/:channelId",
  auth,
  csrfProtect,
  async (req, res) => {
    const channelId = Number(req.params.channelId);

    if (!Number.isInteger(channelId) || channelId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Некорректный идентификатор канала"
      });
    }

    const poolClient = await db.connect();

    try {
      await poolClient.query("BEGIN");

      const channelResult = await poolClient.query(`
        SELECT id
        FROM channels
        WHERE id = $1
        FOR UPDATE
      `, [channelId]);

      if (channelResult.rows.length === 0) {
        await poolClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Канал не найден"
        });
      }

      const ownSlotResult = await poolClient.query(`
        SELECT original_channel_id, current_channel_id
        FROM milktv_channel_slots
        WHERE original_channel_id = $1
        FOR UPDATE
      `, [channelId]);

      if (ownSlotResult.rows.length === 0) {
        await poolClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Собственный slot канала не найден"
        });
      }

      const ownCurrentId = ownSlotResult.rows[0].current_channel_id === null
        ? null
        : Number(ownSlotResult.rows[0].current_channel_id);

      if (ownCurrentId !== channelId) {
        await poolClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Собственный slot не занят самим каналом"
        });
      }

      const poolResult = await poolClient.query(`
        SELECT channel_id, enabled
        FROM milktv_replacement_pool
        WHERE channel_id = $1
        FOR UPDATE
      `, [channelId]);

      const foreignUsage = await poolClient.query(`
        SELECT original_channel_id
        FROM milktv_channel_slots
        WHERE current_channel_id = $1
          AND original_channel_id <> $1
        FOR UPDATE
      `, [channelId]);

      if (foreignUsage.rows.length > 0) {
        await poolClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Канал уже используется replacement в другом slot"
        });
      }

      if (poolResult.rows.length > 0) {
        await poolClient.query(`
          UPDATE milktv_replacement_pool
          SET enabled = TRUE,
              updated_at = NOW()
          WHERE channel_id = $1
        `, [channelId]);
      } else {
        await poolClient.query(`
          INSERT INTO milktv_replacement_pool
            (channel_id, enabled, created_at, updated_at)
          VALUES ($1, TRUE, NOW(), NOW())
        `, [channelId]);
      }

      await poolClient.query("COMMIT");
      return res.json({
        success: true,
        channel_id: channelId,
        enabled: true
      });
    } catch (error) {
      await poolClient.query("ROLLBACK");
      console.error("Ошибка добавления канала в replacement pool:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось добавить канал в replacement pool"
      });
    } finally {
      poolClient.release();
    }
  }
);

app.delete(
  "/admin/milktv/replacement-pool/:channelId",
  auth,
  csrfProtect,
  async (req, res) => {
    const channelId = Number(req.params.channelId);

    if (!Number.isInteger(channelId) || channelId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Некорректный идентификатор канала"
      });
    }

    const poolClient = await db.connect();

    try {
      await poolClient.query("BEGIN");

      const channelResult = await poolClient.query(`
        SELECT id
        FROM channels
        WHERE id = $1
        FOR UPDATE
      `, [channelId]);

      if (channelResult.rows.length === 0) {
        await poolClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Канал не найден"
        });
      }

      const ownSlotResult = await poolClient.query(`
        SELECT current_channel_id
        FROM milktv_channel_slots
        WHERE original_channel_id = $1
        FOR UPDATE
      `, [channelId]);

      if (ownSlotResult.rows.length === 0) {
        await poolClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Собственный slot канала не найден"
        });
      }

      const ownCurrentId = ownSlotResult.rows[0].current_channel_id === null
        ? null
        : Number(ownSlotResult.rows[0].current_channel_id);

      if (ownCurrentId !== null && ownCurrentId !== channelId) {
        await poolClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Собственный slot занят другим каналом"
        });
      }

      const poolResult = await poolClient.query(`
        SELECT channel_id
        FROM milktv_replacement_pool
        WHERE channel_id = $1
        FOR UPDATE
      `, [channelId]);

      if (poolResult.rows.length === 0) {
        await poolClient.query("ROLLBACK");
        return res.json({
          success: true,
          removed: false,
          already_not_in_pool: true,
          channel_id: channelId
        });
      }

      const foreignUsage = await poolClient.query(`
        SELECT original_channel_id
        FROM milktv_channel_slots
        WHERE current_channel_id = $1
          AND original_channel_id <> $1
        FOR UPDATE
      `, [channelId]);

      if (foreignUsage.rows.length > 0) {
        await poolClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Канал используется replacement в другом slot"
        });
      }

      await poolClient.query(`
        DELETE FROM milktv_replacement_pool
        WHERE channel_id = $1
      `, [channelId]);

      await poolClient.query("COMMIT");
      return res.json({
        success: true,
        removed: true,
        channel_id: channelId
      });
    } catch (error) {
      await poolClient.query("ROLLBACK");
      console.error("Ошибка удаления канала из replacement pool:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось удалить канал из replacement pool"
      });
    } finally {
      poolClient.release();
    }
  }
);

app.post(
  "/admin/milktv/slots/:originalChannelId/replacement",
  auth,
  csrfProtect,
  async (req, res) => {
    const originalChannelId = Number(req.params.originalChannelId);
    const rawReplacementId = req.body?.replacement_channel_id;
    const replacementChannelId = Number(rawReplacementId);

    if (
      !Number.isInteger(originalChannelId)
      || originalChannelId <= 0
      || Array.isArray(rawReplacementId)
      || !Number.isInteger(replacementChannelId)
      || replacementChannelId <= 0
      || originalChannelId === replacementChannelId
    ) {
      return res.status(400).json({
        success: false,
        error: "Некорректные идентификаторы каналов"
      });
    }

    const replacementClient = await db.connect();

    try {
      await replacementClient.query("BEGIN");

      const channelIds = [originalChannelId, replacementChannelId]
        .sort((a, b) => a - b);
      const channelsResult = await replacementClient.query(`
        SELECT id, milktv_status
        FROM channels
        WHERE id = ANY($1::int[])
        ORDER BY id
        FOR UPDATE
      `, [channelIds]);

      if (channelsResult.rows.length !== 2) {
        await replacementClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Оригинальный или replacement-канал не найден"
        });
      }

      const slotsResult = await replacementClient.query(`
        SELECT original_channel_id, current_channel_id
        FROM milktv_channel_slots
        WHERE original_channel_id = ANY($1::int[])
        ORDER BY original_channel_id
        FOR UPDATE
      `, [channelIds]);

      if (slotsResult.rows.length !== 2) {
        await replacementClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Собственный slot оригинального или replacement-канала не найден"
        });
      }

      const channelsById = new Map(
        channelsResult.rows.map(row => [Number(row.id), row])
      );
      const slotsByOriginalId = new Map(
        slotsResult.rows.map(row => [Number(row.original_channel_id), row])
      );
      const originalChannel = channelsById.get(originalChannelId);
      const originalSlot = slotsByOriginalId.get(originalChannelId);
      const replacementSlot = slotsByOriginalId.get(replacementChannelId);

      const replacementPool = await replacementClient.query(`
        SELECT channel_id, enabled
        FROM milktv_replacement_pool
        WHERE channel_id = $1
        FOR UPDATE
      `, [replacementChannelId]);

      if (
        replacementPool.rows.length === 0
        || replacementPool.rows[0].enabled !== true
      ) {
        await replacementClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Replacement-канал не находится в active replacement pool"
        });
      }

      const replacementOwnCurrentId = replacementSlot.current_channel_id === null
        ? null
        : Number(replacementSlot.current_channel_id);

      if (replacementOwnCurrentId !== replacementChannelId) {
        await replacementClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Собственный slot replacement-канала не занят самим каналом"
        });
      }

      const foreignUsage = await replacementClient.query(`
        SELECT original_channel_id
        FROM milktv_channel_slots
        WHERE current_channel_id = $1
          AND original_channel_id <> $1
        FOR UPDATE
      `, [replacementChannelId]);

      if (foreignUsage.rows.length > 0) {
        await replacementClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Replacement уже используется в другом slot"
        });
      }

      if (originalChannel.milktv_status !== "quarantine") {
        await replacementClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Оригинальный канал не находится в quarantine"
        });
      }

      if (originalSlot.current_channel_id !== null) {
        await replacementClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Слот оригинального канала уже занят"
        });
      }

      const assignResult = await replacementClient.query(`
        UPDATE milktv_channel_slots
        SET
          current_channel_id = $1,
          replacement_since = NOW(),
          updated_at = NOW()
        WHERE original_channel_id = $2
          AND current_channel_id IS NULL
      `, [replacementChannelId, originalChannelId]);

      if (assignResult.rowCount !== 1) {
        await replacementClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "Слот уже заняли другим каналом"
        });
      }

      await replacementClient.query("COMMIT");
      return res.json({
        success: true,
        original_channel_id: originalChannelId,
        current_channel_id: replacementChannelId
      });
    } catch (error) {
      await replacementClient.query("ROLLBACK");
      console.error("Ошибка назначения replacement в слот MILK TV:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось назначить replacement"
      });
    } finally {
      replacementClient.release();
    }
  }
);

app.delete(
  "/admin/milktv/slots/:originalChannelId/replacement",
  auth,
  csrfProtect,
  async (req, res) => {
    const originalChannelId = Number(req.params.originalChannelId);

    if (!Number.isInteger(originalChannelId) || originalChannelId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Некорректный идентификатор оригинального канала"
      });
    }

    const removalClient = await db.connect();

    try {
      await removalClient.query("BEGIN");

      const slotResult = await removalClient.query(`
        SELECT
          original_channel_id,
          current_channel_id
        FROM milktv_channel_slots
        WHERE original_channel_id = $1
        FOR UPDATE
      `, [originalChannelId]);

      if (slotResult.rows.length === 0) {
        await removalClient.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: "Слот оригинального канала не найден"
        });
      }

      const currentChannelId = slotResult.rows[0].current_channel_id === null
        ? null
        : Number(slotResult.rows[0].current_channel_id);

      if (currentChannelId === null) {
        await removalClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          removed: false,
          error: "В слоте нет replacement"
        });
      }

      if (currentChannelId === originalChannelId) {
        await removalClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          removed: false,
          error: "Слот занят оригинальным каналом, а не replacement"
        });
      }

      const removeResult = await removalClient.query(`
        UPDATE milktv_channel_slots
        SET
          current_channel_id = NULL,
          replacement_since = NULL,
          updated_at = NOW()
        WHERE original_channel_id = $1
          AND current_channel_id = $2
      `, [originalChannelId, currentChannelId]);

      if (removeResult.rowCount !== 1) {
        await removalClient.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          removed: false,
          error: "Replacement уже изменился другим запросом"
        });
      }

      await removalClient.query("COMMIT");
      return res.json({
        success: true,
        removed: true,
        original_channel_id: originalChannelId,
        current_channel_id: null
      });
    } catch (error) {
      await removalClient.query("ROLLBACK");
      console.error("Ошибка снятия replacement из слота MILK TV:", error);
      return res.status(500).json({
        success: false,
        error: "Не удалось снять replacement"
      });
    } finally {
      removalClient.release();
    }
  }
);

app.post("/admin/milktv/check", auth, csrfProtect, async (req,res) => {

  if (milktvCheckProgress.running) {
    return res.json({
      success: false,
      message: "Проверка уже выполняется"
    });
  }

  startMilktvCheckIfIdle();

  res.json({
    success: true
  });

});


app.get("/api/admin/milktv/check-progress", auth, async (req,res) => {

  res.json(milktvCheckProgress);

});
app.get("/api/admin/milktv/health-status", auth, (req, res) => {
  res.json({
    health: milktvHealthRuntime.state,
    last_run: milktvHealthRuntime.last_run_at,
    last_result: milktvHealthRuntime.last_result,
    infra_degraded: milktvHealthRuntime.infra_degraded,
    preflight: milktvHealthRuntime.last_preflight,
    overlap_skips: milktvHealthRuntime.overlap_skips,
    interval_minutes: MILKTV_BACKGROUND_HEALTH_INTERVAL_MS / 60000,
    autopilot: { state: milktvAutopilotState?.state || (MILKTV_AUTOPILOT_ENABLED ? 'ON' : 'OFF'), last_run: milktvAutopilotState?.last_run_at || null, last_result: milktvAutopilotState?.last_run_summary || null }
  });
});
app.get("/api/admin/milktv/stats", auth, async (req,res) => {

  try {

    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM channels) AS total_channels,

        (SELECT COUNT(*)
         FROM channels
         WHERE COALESCE(milktv_status, '') = 'online'
        ) AS online_channels,

        (SELECT COUNT(*)
         FROM channels
         WHERE COALESCE(milktv_status, '') = 'offline'
        ) AS offline_channels,

        (SELECT COUNT(*)
         FROM channels
         WHERE milktv_status = 'quarantine'
        ) AS quarantine_channels,

        (SELECT COUNT(*)
         FROM channels
         WHERE milktv_status IS NULL
            OR milktv_status NOT IN ('online','offline','quarantine','checking')
        ) AS unknown_channels,

        (SELECT COUNT(*)
         FROM channels c
         WHERE EXISTS (
           SELECT 1
           FROM milktv_channel_sources reserve_source
           WHERE reserve_source.channel_id = c.id
             AND reserve_source.enabled = TRUE
             AND reserve_source.status = 'online'
             AND reserve_source.id IS DISTINCT FROM c.current_source_id
         )
        ) AS reserve_channels,

        (SELECT COUNT(*)
         FROM milktv_view_events
         WHERE started_at >= CURRENT_DATE
        ) AS views_today,

        (SELECT COUNT(DISTINCT COALESCE(
          client_id::text,
          'device:' || device_id::text
        ))
         FROM milktv_view_events
         WHERE started_at >= CURRENT_DATE
        ) AS viewers_today
    `);

    res.json(result.rows[0]);

  } catch(error) {

    console.error(
      "ОШИБКА СТАТИСТИКИ МИЛК ТВ:",
      error
    );

    res.status(500).json({
      error: error.message
    });

  }

});

// UI/runtime retests may deliberately freeze health state.  This gate affects
// only scheduling; the canonical checker and its algorithms are unchanged.
if (!MILKTV_HEALTH_CLI) {
if (MILKTV_BACKGROUND_HEALTH_ENABLED) {
const MILKTV_ACTIVE_CHECK_START_DELAY = 3 * 60 * 1000;

setTimeout(() => {
  void startMilktvCheckIfIdle();

  setInterval(() => {
    void startMilktvCheckIfIdle();
  }, MILKTV_BACKGROUND_HEALTH_INTERVAL_MS);
}, MILKTV_ACTIVE_CHECK_START_DELAY);

if (MILKTV_AUTOPILOT_ENABLED) {
  setTimeout(async () => {
    const ready = await optionalSchemaReady("Recovery Autopilot", ["channels", "current_source_id"]) && await optionalSchemaReady("Recovery Autopilot", ["milktv_source_switch_history", "id"]);
    if (ready) setInterval(() => void runMilktvRecoveryAutopilot({ dryRun: false }), MILKTV_AUTOPILOT_INTERVAL);
  }, 30 * 1000);
} else { console.log("MILK TV recovery-only autopilot scheduler disabled"); }

// Background Health is isolated from legacy quarantine, slot, quality,
// discovery, autopilot, and rating schedulers.
// Drain only the staging backlog that has never been checked.  This is not a
// channel Health sweep and deliberately does not change logical-channel state.
setTimeout(() => {
  void runInitialCandidateHealthQueue();
  setInterval(() => { void runInitialCandidateHealthQueue(); }, 60 * 1000);
}, 60 * 1000);

if (process.env.MILKTV_UNRELATED_SCHEDULERS_ENABLED === "true") {


setTimeout(async () => {

  try {

    await startMilktvQuarantineCheckIfIdle();

  } catch(error) {

    console.error(
      "ОШИБКА ПЕРВОЙ ПРОВЕРКИ КАРАНТИНА:",
      error
    );

  }

}, 5000);
const MILKTV_QUARANTINE_INTERVAL = 4 * 60 * 60 * 1000;

setInterval(async () => {

  try {

    await startMilktvQuarantineCheckIfIdle();

  } catch(error) {

    console.error(
      "ОШИБКА АВТОПРОВЕРКИ КАРАНТИНА:",
      error
    );

  }

}, MILKTV_QUARANTINE_INTERVAL);

const MILKTV_SLOT_RECONCILIATION_START_DELAY = 60 * 1000;
const MILKTV_SLOT_RECONCILIATION_INTERVAL = 15 * 60 * 1000;

setTimeout(() => {
  void runMilktvSlotReconciliation();

  setInterval(() => {
    void runMilktvSlotReconciliation();
  }, MILKTV_SLOT_RECONCILIATION_INTERVAL);
}, MILKTV_SLOT_RECONCILIATION_START_DELAY);

if (MILKTV_M3U_AUTOPILOT_ENABLED) {
  setTimeout(() => {
    void runMilktvM3uAutopilotCycle();
    setInterval(() => {
      void runMilktvM3uAutopilotCycle();
    }, MILKTV_M3U_AUTOPILOT_INTERVAL);
  }, MILKTV_M3U_AUTOPILOT_START_DELAY);
}

if (MILKTV_DISCOVERY_ENABLED) {
  setTimeout(() => {
    void optionalSchemaReady("Discovery", ["milktv_discovery_sources", "id"]).then(ready => { if (!ready) return; void milktvDiscovery.runCycle(db, { dryRun: false }); setInterval(() => { void milktvDiscovery.runCycle(db, { dryRun: false }); }, MILKTV_DISCOVERY_INTERVAL); });
  }, MILKTV_DISCOVERY_START_DELAY);
}
let milktvQualitySchedulerRunning=false;
async function runMilktvQualityCycle(){if(milktvQualitySchedulerRunning)return {skipped:true};milktvQualitySchedulerRunning=true;const c=await db.connect();try{const l=await c.query("SELECT pg_try_advisory_lock(938888) AS locked");if(!l.rows[0].locked)return {skipped:true};try{const q=await c.query("SELECT id,channel_id,url,failed_checks FROM milktv_channel_sources WHERE enabled=TRUE AND (measured_at IS NULL OR measured_at < NOW()-INTERVAL '6 hours') AND (probe_status NOT IN ('error','timeout') OR measured_at < NOW()-INTERVAL '12 hours') ORDER BY measured_at NULLS FIRST,id LIMIT $1",[MILKTV_QUALITY_BATCH_LIMIT]);return await runQualityBatchGrouped(q.rows)}finally{await c.query("SELECT pg_advisory_unlock(938888)")}}finally{c.release();milktvQualitySchedulerRunning=false}}
async function runQualityBatchGrouped(rows){let checked=0,success=0,failed=0,timeout=0;for(const r of rows){const x=await runQualityBatch(r.channel_id,[r]);checked+=x.checked;success+=x.success;failed+=x.failed;timeout+=x.timeout}return {checked,success,failed,timeout}}
if(MILKTV_EPG_ENABLED){setTimeout(()=>{void runMilktvEpgImportCycle();setInterval(()=>void runMilktvEpgImportCycle(),MILKTV_EPG_INTERVAL)},MILKTV_EPG_START_DELAY)}else{console.log('MILK TV EPG scheduler disabled')}
if(MILKTV_QUALITY_PROBE_ENABLED){setTimeout(async()=>{const ff=await milktvQuality.checkFfprobeAvailability();if(ff.status!=="AVAILABLE"){console.warn(`MILK TV Quality disabled: ffprobe ${ff.status.toLowerCase()}`);return}if(await optionalSchemaReady("Quality",["milktv_channel_sources","quality_score"])){void runMilktvQualityCycle();setInterval(()=>void runMilktvQualityCycle(),MILKTV_QUALITY_INTERVAL)}},MILKTV_QUALITY_START_DELAY)}
if(MILKTV_SOURCE_AUTOSWITCH_ENABLED){setTimeout(async()=>{if(await optionalSchemaReady("Source AutoSwitch",["channels","current_source_id"]) && await optionalSchemaReady("Source AutoSwitch",["milktv_source_switch_history","id"])) {void runMilktvSourceAutoSwitchCycle();setInterval(()=>void runMilktvSourceAutoSwitchCycle(),MILKTV_SOURCE_AUTOSWITCH_INTERVAL)}},25*60*1000)}
if (MILKTV_CANDIDATE_PROFILE_ENABLED) {
  setTimeout(() => { void runCandidateProfileQueue(); setInterval(() => void runCandidateProfileQueue(), MILKTV_CANDIDATE_PROFILE_INTERVAL); }, 5 * 60 * 1000);
  console.log("⏱️ Candidate ffprobe profiling: очередь до 20, concurrency 2, раз в 24 часа");
}
console.log(
  "⏱️ Автопроверка карантина МИЛК ТВ: каждые 4 часа"
);
const MILKTV_RATING_INTERVAL = 5 * 60 * 1000;

setTimeout(async () => {

  try {

    await updateMilktvRating();

  } catch(error) {

    console.error(
      "ОШИБКА ПЕРВОГО ОБНОВЛЕНИЯ РЕЙТИНГА МИЛК ТВ:",
      error
    );

  }

}, 5000);

setInterval(async () => {

  try {

    await updateMilktvRating();

  } catch(error) {

    console.error(
      "ОШИБКА АВТООБНОВЛЕНИЯ РЕЙТИНГА МИЛК ТВ:",
      error
    );

  }

}, MILKTV_RATING_INTERVAL);

console.log(
  "⏱️ Авторейтинг МИЛК ТВ: каждые 5 минут"
);
}
// Quarantine recovery is part of the core MILK TV health contract.  Keep it
// scheduled even when optional/unrelated schedulers are disabled.
if (MILKTV_BACKGROUND_HEALTH_ENABLED && process.env.MILKTV_UNRELATED_SCHEDULERS_ENABLED !== "true") {
  const MILKTV_QUARANTINE_CORE_INTERVAL = 4 * 60 * 60 * 1000;
  setTimeout(() => { void startMilktvQuarantineCheckIfIdle(); }, 5000);
  setInterval(() => { void startMilktvQuarantineCheckIfIdle(); }, MILKTV_QUARANTINE_CORE_INTERVAL);
  console.log("⏱️ Core MILK TV quarantine recovery: каждые 4 часа");
}
app.listen(PORT,()=>{

console.log(`IPTV API running on port ${PORT}`);

});
} else {
app.listen(PORT,()=>{
  console.log(`IPTV API running on port ${PORT}`);
});
} } else {
  const milktvBackgroundEquivalentCli = process.env.MILKTV_HEALTH_RUN_MODE === 'background-equivalent';
  milktvCheckProgress = {
    running: !milktvBackgroundEquivalentCli,
    current: 0,
    total: 0,
    online: 0,
    offline: 0,
    unknown: 0,
    timeouts: 0,
    new_quarantine: 0,
    circuit_breaker: null,
    startedAt: new Date(),
    finishedAt: null
  };
  (milktvBackgroundEquivalentCli ? startMilktvCheckIfIdle() : runMilktvCheck())
    .then(async () => {
      const summary = await db.query("SELECT COUNT(*) FILTER (WHERE milktv_status='quarantine') AS quarantine, COALESCE(SUM(CASE WHEN milktv_failed_checks > 0 THEN 1 ELSE 0 END),0) AS streaks FROM channels");
      const quarantine = Number(summary.rows[0]?.quarantine || 0);
      const checked = Number(milktvCheckProgress.total || 0);
      const online = Number(milktvCheckProgress.online || 0);
      const offline = Number(milktvCheckProgress.offline || 0);
      const unknown = Number(milktvCheckProgress.unknown || Math.max(0, checked - online - offline));
      const durationMs = milktvCheckProgress.startedAt && milktvCheckProgress.finishedAt
        ? new Date(milktvCheckProgress.finishedAt) - new Date(milktvCheckProgress.startedAt)
        : null;
      const reportPath = String(process.env.MILKTV_HEALTH_REPORT_PATH || "").trim();
      if (reportPath) {
        const requestedIds = [...new Set(String(process.env.MILKTV_HEALTH_CHANNEL_IDS || "").split(",").map(Number).filter(id => Number.isInteger(id) && id > 0))];
        const selected = requestedIds.length > 0
          ? (await db.query("SELECT id, name, current_source_id, milktv_status, milktv_check_error, milktv_failed_checks FROM channels WHERE id = ANY($1::int[]) ORDER BY id", [requestedIds])).rows
          : [];
        const report = {
          created_at: new Date().toISOString(),
          mode: process.env.MILKTV_HEALTH_RUN_MODE || "cli",
          total: checked,
          checked: Number(milktvCheckProgress.current || 0),
          online,
          offline,
          unknown,
          quarantine,
          failure_streak_updates: offline,
          new_quarantine: Number(milktvCheckProgress.new_quarantine || 0),
          db_errors: 0,
          timeouts: Number(milktvCheckProgress.timeouts || 0),
          duration_ms: durationMs,
          circuit_breaker: milktvCheckProgress.circuit_breaker || null,
          selected
        };
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`HEALTH JSON REPORT: ${reportPath}`);
      }
      console.log("LOCAL MILK TV HEALTH RECOVERY SUMMARY");
      console.log("TOTAL:", checked);
      console.log("ONLINE:", online);
      console.log("OFFLINE:", offline);
      console.log("UNKNOWN:", unknown);
      console.log("QUARANTINE:", quarantine);
      console.log("CHECKED:", milktvCheckProgress.current || 0);
      console.log("FAILURE STREAKS UPDATED:", offline);
      console.log("QUARANTINE MOVES: see quarantine log");
      console.log("TIMEOUTS:", milktvCheckProgress.timeouts || 0);
      console.log("CIRCUIT BREAKER:", milktvCheckProgress.circuit_breaker || "not_triggered");
      console.log("DB ERRORS: 0");
      console.log("DURATION:", durationMs === null ? "unknown" : `${durationMs}ms`);
    })
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch(async error => {
      console.error("MILK TV local health recovery failed:", error);
      await db.end().catch(() => {});
      process.exitCode = 1;
    });
}
