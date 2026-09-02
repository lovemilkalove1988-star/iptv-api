const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { verifyPassword } = require('../password-utils');
const devicePairing = require('../services/milktv-device-pairing');

const router = express.Router();
const DEVICE_LIMIT = 4;
const VERSION = 'v1';
const PLAYBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYBACK_SECRET = process.env.SESSION_SECRET || process.env.PLAYBACK_TOKEN_SECRET || 'milktv-playback-secret-change-me';
const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const fail = (res, status, error, message) => res.status(status).json({ ok: false, error, message });
function simpleHealth(status) { return status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'unknown'; }
function csrf(req) { if (!req.session.clientCsrfToken) req.session.clientCsrfToken = crypto.randomBytes(32).toString('hex'); return req.session.clientCsrfToken; }
function same(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function makePlaybackToken(url, kind = 'manifest', binding = null) {
  const exp = Date.now() + PLAYBACK_TOKEN_TTL_MS;
  const iv = crypto.randomBytes(12), key = crypto.createHash('sha256').update(PLAYBACK_SECRET).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const claims = { u: String(url), e: exp, k: kind };
  if (binding && Number.isInteger(Number(binding.device_id)) && Number.isInteger(Number(binding.generation))) {
    claims.d = Number(binding.device_id); claims.g = Number(binding.generation);
  }
  if (binding && typeof binding.guest_hash === 'string' && binding.guest_hash) claims.x = binding.guest_hash;
  const body = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function readPlaybackToken(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url'); if (raw.length < 28) return null;
    const key = crypto.createHash('sha256').update(PLAYBACK_SECRET).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    return value.e > Date.now() && /^https?:\/\//i.test(value.u) ? value : null;
  } catch (_) { return null; }
}
function isManifest(contentType, url) { return /mpegurl|dash\+xml|\.m3u8(?:$|\?)|\.mpd(?:$|\?)/i.test(String(contentType || '') + ' ' + String(url || '')); }

async function validateClient(req, res, next) {
  let clientId = Number(req.session?.client?.id);
  let persistedDevice = null;
  if (!clientId) {
    const credential = String(req.get('X-MILKTV-CREDENTIAL') || req.headers.cookie?.match(/(?:^|;\s*)milktv_device_credential=([^;]+)/)?.[1] || '').trim();
    if (credential) {
      persistedDevice = (await db.query('SELECT d.id,d.client_id,d.device_id,d.device_name,d.last_seen,d.status,d.playback_generation,c.name,c.login,c.active,(c.subscription_until IS NULL OR c.subscription_until > LOCALTIMESTAMP) AS subscription_active FROM devices d JOIN clients c ON c.id=d.client_id WHERE d.credential_hash=$1', [devicePairing.hash(decodeURIComponent(credential))])).rows[0];
      if (persistedDevice?.status === 'active' && persistedDevice.active && persistedDevice.subscription_active) {
        clientId = Number(persistedDevice.client_id);
        req.session.client = { id: clientId, name: persistedDevice.name, login: persistedDevice.login };
      }
    }
  }
  if (!Number.isInteger(clientId) || clientId <= 0) return fail(res, 401, 'UNAUTHORIZED', 'Client authentication is required');
  const client = (await db.query(`SELECT id,name,login,active,(subscription_until IS NULL OR subscription_until > LOCALTIMESTAMP) AS subscription_active FROM clients WHERE id=$1`, [clientId])).rows[0];
  if (!client) return fail(res, 401, 'UNAUTHORIZED', 'Session is invalid');
  if (!client.active || !client.subscription_active) return fail(res, 403, 'ACCESS_DENIED', 'Client access is disabled or expired');
  const deviceId = String(req.get('X-MILKTV-DEVICE') || '').trim();
  const sessionDeviceId = Number(req.session?.viewerDeviceId);
  const device = persistedDevice || (Number.isInteger(sessionDeviceId) && sessionDeviceId > 0
    ? (await db.query('SELECT id,device_id,device_name,last_seen,status,playback_generation FROM devices WHERE client_id=$1 AND id=$2', [clientId, sessionDeviceId])).rows[0]
    : (await db.query('SELECT id,device_id,device_name,last_seen,status,playback_generation FROM devices WHERE client_id=$1 AND device_id=$2', [clientId, deviceId])).rows[0]);
  if (!device) return fail(res, 401, 'UNAUTHORIZED', 'Device is not registered for this client');
  if (device.status !== 'active') return fail(res, 403, 'DEVICE_NOT_ACTIVE', 'Device is paused or revoked');
  await db.query('UPDATE devices SET last_seen=NOW() WHERE id=$1', [device.id]);
  req.v1client = client; req.v1device = device; next();
}
async function validatePlaybackBinding(resource, req) {
  if (resource?.x) {
    const raw = String(req?.get('X-MILKTV-GUEST') || req?.headers?.cookie?.match(/(?:^|;\s*)milktv_guest_credential=([^;]+)/)?.[1] || '').trim();
    if (!raw) return false;
    const actual = devicePairing.hash(decodeURIComponent(raw));
    return same(actual, resource.x);
  }
  if (!Number.isInteger(Number(resource?.d))) return true;
  const row = (await db.query('SELECT status,playback_generation FROM devices WHERE id=$1', [Number(resource.d)])).rows[0];
  return !!row && row.status === 'active' && Number(row.playback_generation || 0) === Number(resource.g);
}
async function requestPlaybackBinding(req, res) {
  // 1. Registered device credential.
  const rawDevice = String(
    req.get('X-MILKTV-CREDENTIAL') ||
    req.headers.cookie?.match(/(?:^|;\s*)milktv_device_credential=([^;]+)/)?.[1] ||
    ''
  ).trim();

  if (rawDevice) {
    const credential = decodeURIComponent(rawDevice);

    const row = (
      await db.query(
        `SELECT
           d.id,
           d.playback_generation,
           d.status,
           c.active,
           (c.subscription_until IS NULL OR c.subscription_until > LOCALTIMESTAMP)
             AS subscription_active
         FROM devices d
         JOIN clients c ON c.id = d.client_id
         WHERE d.credential_hash = $1`,
        [devicePairing.hash(credential)]
      )
    ).rows[0];

    if (
      row &&
      row.status === 'active' &&
      row.active &&
      row.subscription_active
    ) {
      return {
        device_id: Number(row.id),
        generation: Number(row.playback_generation || 0)
      };
    }

    // Stale/revoked credential must not permanently block public playback.
    res.clearCookie('milktv_device_credential', {
      path: '/',
      sameSite: 'lax'
    });
  }

  // 2. Reuse an existing guest credential.
  const rawGuest = String(
    req.get('X-MILKTV-GUEST') ||
    req.headers.cookie?.match(/(?:^|;\s*)milktv_guest_credential=([^;]+)/)?.[1] ||
    ''
  ).trim();

  if (rawGuest) {
    return {
      guest_hash: devicePairing.hash(decodeURIComponent(rawGuest))
    };
  }

  // 3. Create a guest credential once for 24 hours.
  const guest = crypto.randomBytes(32).toString('base64url');

  res.cookie('milktv_guest_credential', guest, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000
  });

  return {
    guest_hash: devicePairing.hash(guest)
  };
}
function csrfProtect(req, res, next) { if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next(); if (!same(req.get('X-CSRF-Token'), csrf(req))) return fail(res, 403, 'CSRF_REQUIRED', 'Valid X-CSRF-Token is required'); next(); }
async function registerDevice(clientId, deviceId, deviceName) {
  const client = await db.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [clientId]);
    const own = (await client.query('SELECT id,device_id,device_name,last_seen,status,credential_hash,recovery_code_hash FROM devices WHERE client_id=$1 AND device_id=$2 FOR UPDATE', [clientId, deviceId])).rows[0];
    if (own && own.status !== 'active') { await client.query('ROLLBACK'); return { error: own.status === 'paused' ? 'DEVICE_PAUSED' : 'DEVICE_REVOKED' }; }
    if (own) { let credential = null; if (!own.credential_hash || !own.recovery_code_hash) { credential = devicePairing.randomCredential(); const recovery = devicePairing.recoveryCode(); await client.query('UPDATE devices SET device_name=$1,credential_hash=$2,recovery_code_hash=$3,recovery_code_ciphertext=$4,last_seen=NOW(),status=\'active\' WHERE id=$5', [deviceName || own.device_name, devicePairing.hash(credential), devicePairing.hash(recovery), devicePairing.encryptRecovery(recovery), own.id]); } else await client.query('UPDATE devices SET device_name=$1,last_seen=NOW() WHERE id=$2', [deviceName || own.device_name, own.id]); await client.query('COMMIT'); return { device: { ...own, device_name: deviceName || own.device_name }, created: false, credential }; }
    const foreign = await client.query('SELECT 1 FROM devices WHERE device_id=$1 AND client_id<>$2 LIMIT 1', [deviceId, clientId]);
    if (foreign.rows.length) { await client.query('ROLLBACK'); return { error: 'DEVICE_OWNED_BY_OTHER_CLIENT' }; }
    const count = Number((await client.query('SELECT COUNT(*)::int AS count FROM devices WHERE client_id=$1', [clientId])).rows[0].count);
    if (count >= DEVICE_LIMIT) { await client.query('ROLLBACK'); return { error: 'DEVICE_LIMIT_REACHED' }; }
    const credential = devicePairing.randomCredential(), recovery = devicePairing.recoveryCode();
    const device = (await client.query('INSERT INTO devices(client_id,device_name,device_id,last_seen,paired_at,credential_hash,recovery_code_hash,recovery_code_ciphertext,status,is_primary) VALUES($1,$2,$3,NOW(),NOW(),$4,$5,$6,\'active\',NOT EXISTS(SELECT 1 FROM devices WHERE client_id=$1 AND is_primary=TRUE)) RETURNING id,device_id,device_name,last_seen,status', [clientId, deviceName || 'Device', deviceId, devicePairing.hash(credential), devicePairing.hash(recovery), devicePairing.encryptRecovery(recovery)])).rows[0];
    await client.query('COMMIT'); return { device, created: true, credential, recovery_code: recovery };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}

router.post('/login', async (req, res) => {
  const login = String(req.body?.login || '').trim(), password = String(req.body?.password || ''), deviceId = String(req.body?.device_id || '').trim(), deviceName = String(req.body?.device_name || '').trim();
  if (!login || !password || !deviceId) return fail(res, 400, 'INVALID_REQUEST', 'login, password and device_id are required');
  try {
    const client = (await db.query('SELECT id,name,login,password,active,(subscription_until IS NULL OR subscription_until > LOCALTIMESTAMP) AS subscription_active FROM clients WHERE login=$1', [login])).rows[0];
    if (!client || !verifyPassword(password, client.password)) return fail(res, 401, 'UNAUTHORIZED', 'Invalid login or password');
    if (!client.active || !client.subscription_active) return fail(res, 403, 'ACCESS_DENIED', 'Client access is disabled or expired');
    const registration = await registerDevice(client.id, deviceId, deviceName);
    if (registration.error) return fail(res, 409, registration.error, registration.error === 'DEVICE_LIMIT_REACHED' ? 'Maximum of 4 devices reached' : 'Device belongs to another client');
    req.session.client = { id: client.id, name: client.name, login: client.login };
    if (registration.credential) res.cookie('milktv_device_credential', registration.credential, { httpOnly:true, sameSite:'lax', maxAge: 10*365*24*60*60*1000 });
    req.session.save(error => error ? fail(res, 500, 'SESSION_ERROR', 'Session could not be saved') : ok(res, { profile: { id: client.id, name: client.name, login: client.login }, device: registration.device, device_limit: DEVICE_LIMIT, csrf_token: csrf(req) }));
  } catch (_) { fail(res, 500, 'LOGIN_FAILED', 'Login could not be completed'); }
});

// Public viewing contract. It intentionally exposes only the current permitted
// playback URL, never alternate sources or operational source diagnostics.
router.get('/public/channels', async (req, res) => {
  try {
    const q = await db.query(`SELECT s.original_channel_id AS id, original.name, original.logo,
      MIN(cat.category) FILTER(WHERE cat.category IS NOT NULL AND BTRIM(cat.category)<>'') AS category,
      current.milktv_status, current.url, source.status AS source_status
      FROM milktv_channel_slots s
      JOIN channels original ON original.id=s.original_channel_id
      JOIN channels current ON current.id=s.current_channel_id
      LEFT JOIN milktv_channel_sources source ON source.id=current.current_source_id
      LEFT JOIN milktv_channel_categories cat ON cat.channel_id=s.original_channel_id
      WHERE s.current_channel_id IS NOT NULL
        AND COALESCE(original.visible_to_clients, TRUE)=TRUE
        AND COALESCE(current.milktv_status,'') <> 'quarantine'
        AND NOT EXISTS (SELECT 1 FROM milktv_replacement_pool rp WHERE rp.channel_id=s.original_channel_id AND rp.enabled=TRUE)
      GROUP BY s.original_channel_id,original.name,original.logo,current.milktv_status,current.url,source.status,original.milktv_rating
      ORDER BY COALESCE(original.milktv_rating,0) DESC, original.name`);
    ok(res, q.rows.map(row => ({ id: row.id, name: row.name, logo: row.logo || null, category: row.category || null, available: Boolean(row.url) && simpleHealth(row.source_status || row.milktv_status) === 'online', current_source_health: simpleHealth(row.source_status || row.milktv_status) })));
  } catch (_) { fail(res, 500, 'CHANNELS_UNAVAILABLE', 'Channels are unavailable'); }
});
router.get('/public/channels/:channelId/play', async (req, res) => {
  const id = Number(req.params.channelId);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'INVALID_CHANNEL', 'Invalid channel id');
  try {
    const row = (await db.query(`SELECT current.url,current.milktv_status,source.status AS source_status
      FROM milktv_channel_slots s JOIN channels original ON original.id=s.original_channel_id JOIN channels current ON current.id=s.current_channel_id
      LEFT JOIN milktv_channel_sources source ON source.id=current.current_source_id
      WHERE s.original_channel_id=$1 AND s.current_channel_id IS NOT NULL
        AND COALESCE(original.visible_to_clients, TRUE)=TRUE
        AND COALESCE(current.milktv_status,'') <> 'quarantine'
        AND NOT EXISTS (SELECT 1 FROM milktv_replacement_pool rp WHERE rp.channel_id=s.original_channel_id AND rp.enabled=TRUE)`, [id])).rows[0];
    if (!row) return fail(res, 404, 'CHANNEL_NOT_FOUND', 'Channel is unavailable');
    const health = simpleHealth(row.source_status || row.milktv_status);
    if (!row.url || health === 'offline') return fail(res, 409, 'PLAYBACK_UNAVAILABLE', 'Playback is currently unavailable');
    const binding = await requestPlaybackBinding(req, res);
    if (binding?.invalid) return fail(res, 403, 'DEVICE_PLAYBACK_REVOKED', 'Device playback authorization is no longer valid');
    ok(res, { channel_id: id, playback_url: `/api/v1/client/public/play/${makePlaybackToken(row.url, 'manifest', binding)}`, expires_at: new Date(Date.now() + PLAYBACK_TOKEN_TTL_MS).toISOString(), health_status: health });
  } catch (_) { fail(res, 500, 'PLAYBACK_UNAVAILABLE', 'Playback is currently unavailable'); }
});
router.get('/public/play/:token', async (req, res) => {
  const resource = readPlaybackToken(req.params.token);
  if (!resource) return fail(res, 403, 'PLAYBACK_TOKEN_INVALID', 'Playback token is invalid or expired');
  try { if (!(await validatePlaybackBinding(resource, req))) return fail(res, 403, 'DEVICE_PLAYBACK_REVOKED', 'Device playback authorization is no longer valid'); }
  catch (_) { return fail(res, 503, 'PLAYBACK_AUTH_UNAVAILABLE', 'Playback authorization is unavailable'); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const abort = () => controller.abort();
  req.on('close', abort);
  try {
    const upstream = await fetch(resource.u, { redirect: 'follow', signal: controller.signal });
    if (!upstream.ok || !upstream.body) return fail(res, 502, 'PLAYBACK_UNAVAILABLE', 'Playback is unavailable');
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    if (isManifest(type, resource.u)) {
      const text = await upstream.text();
      const base = new URL(resource.u);
      const rewrite = raw => {
        const value = String(raw || '').trim(); if (!value || value.startsWith('#')) return raw;
        let absolute; try { absolute = new URL(value, base).toString(); } catch (_) { return raw; }
        return `/api/v1/client/public/play/${makePlaybackToken(absolute, 'resource', resource.x ? { guest_hash: resource.x } : (Number.isInteger(Number(resource.d)) ? { device_id: Number(resource.d), generation: Number(resource.g) } : null))}`;
      };
      const rewritten = text.split(/\r?\n/).map(line => {
        if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`);
        return rewrite(line);
      }).join('\n');
      res.status(200).type('application/vnd.apple.mpegurl').send(rewritten);
    } else {
      res.status(200).set('Content-Type', type).set('Cache-Control', 'no-store');
      const { Readable } = require('stream');
      Readable.fromWeb(upstream.body).pipe(res);
    }
  } catch (_) { if (!res.headersSent) fail(res, 502, 'PLAYBACK_UNAVAILABLE', 'Playback is unavailable'); }
  finally { clearTimeout(timer); req.off('close', abort); }
});
router.get('/public/epg/now-next', async (req, res) => {
  const ids = String(req.query.channel_ids || '').split(',').map(Number).filter(Number.isInteger);
  if (!ids.length) return ok(res, { channels: {} });
  try {
    const q = await db.query(`SELECT channel_id,title,start_at,stop_at,CASE WHEN NOW() BETWEEN start_at AND stop_at THEN 'now' ELSE 'next' END AS position FROM milktv_epg_programmes WHERE channel_id=ANY($1::int[]) AND stop_at>NOW() AND start_at<=NOW()+INTERVAL '24 hours' ORDER BY channel_id,start_at`, [ids]);
    const out = Object.fromEntries(ids.map(id => [id, { channel_id:id, now:null, next:null }]));
    for (const row of q.rows) { const target=out[row.channel_id]; if (target && !target[row.position]) target[row.position]={ title:row.title,start:row.start_at,stop:row.stop_at,progress:row.position==='now'?Math.max(0,Math.min(1,(Date.now()-new Date(row.start_at).getTime())/(new Date(row.stop_at).getTime()-new Date(row.start_at).getTime()))):null }; }
    ok(res, { channels: out });
  } catch (_) { fail(res, 500, 'EPG_UNAVAILABLE', 'EPG is unavailable'); }
});
router.use(validateClient);
router.get('/session', (req, res) => ok(res, { valid: true, profile: { id: req.v1client.id, name: req.v1client.name, login: req.v1client.login }, device: req.v1device, device_limit: DEVICE_LIMIT, csrf_token: csrf(req) }));
router.post('/logout', csrfProtect, (req, res) => req.session.destroy(() => ok(res, { logged_out: true })));
router.get('/profile', (req, res) => ok(res, { id: req.v1client.id, name: req.v1client.name, login: req.v1client.login }));
router.get('/devices', async (req, res) => ok(res, { limit: DEVICE_LIMIT, devices: (await db.query('SELECT id,device_id,device_name,last_seen FROM devices WHERE client_id=$1 ORDER BY id', [req.v1client.id])).rows }));

router.get('/channels', async (req, res) => {
  try { const q = await db.query(`SELECT s.original_channel_id AS id,original.name,original.logo,MIN(cat.category) FILTER(WHERE cat.category IS NOT NULL AND BTRIM(cat.category)<>'') AS category,current.milktv_status,current.url,source.status AS source_status FROM milktv_channel_slots s JOIN channels original ON original.id=s.original_channel_id LEFT JOIN channels current ON current.id=s.current_channel_id LEFT JOIN milktv_channel_sources source ON source.id=current.current_source_id LEFT JOIN milktv_channel_categories cat ON cat.channel_id=original.id LEFT JOIN milktv_client_channel_preferences pref ON pref.client_id=$1 AND pref.channel_id=original.id WHERE s.current_channel_id IS NOT NULL AND COALESCE(original.visible_to_clients,TRUE)=TRUE AND COALESCE(pref.hidden,FALSE)=FALSE GROUP BY s.original_channel_id,original.name,original.logo,current.milktv_status,current.url,source.status,pref.favorite,pref.custom_name ORDER BY COALESCE(pref.favorite,FALSE) DESC,original.name`, [req.v1client.id]); ok(res, q.rows.map(row => ({ id: row.id, name: row.custom_name || row.name, logo: row.logo || null, category: row.category || null, available: Boolean(row.url) && simpleHealth(row.source_status || row.milktv_status) === 'online', current_source_health: simpleHealth(row.source_status || row.milktv_status) }))); }
  catch (_) { fail(res, 500, 'CHANNELS_UNAVAILABLE', 'Channels are unavailable'); }
});
router.get('/channels/:channelId/play', async (req, res) => {
  const id = Number(req.params.channelId); if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'INVALID_CHANNEL', 'Invalid channel id');
  try { const row = (await db.query(`SELECT s.original_channel_id,current.url,current.milktv_status,source.status AS source_status FROM milktv_channel_slots s JOIN channels original ON original.id=s.original_channel_id JOIN channels current ON current.id=s.current_channel_id LEFT JOIN milktv_channel_sources source ON source.id=current.current_source_id LEFT JOIN milktv_client_channel_preferences pref ON pref.client_id=$1 AND pref.channel_id=s.original_channel_id WHERE s.original_channel_id=$2 AND s.current_channel_id IS NOT NULL AND COALESCE(original.visible_to_clients,TRUE)=TRUE AND COALESCE(pref.hidden,FALSE)=FALSE`, [req.v1client.id, id])).rows[0]; if (!row) return fail(res, 404, 'CHANNEL_NOT_FOUND', 'Channel is unavailable'); const health = simpleHealth(row.source_status || row.milktv_status); if (!row.url || health !== 'online') return fail(res, 409, 'PLAYBACK_UNAVAILABLE', 'Playback is currently unavailable'); ok(res, { channel_id: id, playback_url: `/api/v1/client/public/play/${makePlaybackToken(row.url, 'manifest', { device_id: req.v1device.id, generation: Number(req.v1device.playback_generation || 0) })}`, expires_at: new Date(Date.now() + PLAYBACK_TOKEN_TTL_MS).toISOString(), health_status: health }); }
  catch (_) { fail(res, 500, 'PLAYBACK_UNAVAILABLE', 'Playback is currently unavailable'); }
});
router.get('/epg/now-next', async (req, res) => {
  const ids = String(req.query.channel_ids || '').split(',').map(Number).filter(Number.isInteger); if (!ids.length) return ok(res, { channels: {} });
  try { const q = await db.query(`SELECT channel_id,title,start_at,stop_at,CASE WHEN NOW() BETWEEN start_at AND stop_at THEN 'now' ELSE 'next' END AS position FROM milktv_epg_programmes WHERE channel_id=ANY($1::int[]) AND stop_at>NOW() AND start_at<=NOW()+INTERVAL '24 hours' ORDER BY channel_id,start_at`, [ids]); const out = Object.fromEntries(ids.map(id => [id, { channel_id: id, now: null, next: null }])); for (const row of q.rows) { const target = out[row.channel_id]; if (target && !target[row.position]) target[row.position] = { title: row.title, start: row.start_at, stop: row.stop_at, progress: row.position === 'now' ? Math.max(0, Math.min(1, (Date.now()-new Date(row.start_at).getTime())/(new Date(row.stop_at).getTime()-new Date(row.start_at).getTime()))) : null }; } ok(res, { channels: out }); }
  catch (_) { fail(res, 500, 'EPG_UNAVAILABLE', 'EPG is unavailable'); }
});
router.get('/reminders', async (req, res) => { try { ok(res, { reminders: (await db.query('SELECT id,channel_id,programme_key,programme_start_at,programme_title,status,created_at FROM milktv_epg_reminders WHERE client_id=$1 ORDER BY programme_start_at', [req.v1client.id])).rows }); } catch (_) { fail(res, 500, 'REMINDERS_UNAVAILABLE', 'Reminders are unavailable'); } });
router.post('/reminders', csrfProtect, async (req, res) => { const channelId=Number(req.body?.channel_id), key=String(req.body?.programme_key || '').trim(); if(!Number.isInteger(channelId)||!key)return fail(res,400,'INVALID_REQUEST','channel_id and programme_key are required'); try { const p=(await db.query('SELECT programme_key,start_at,title FROM milktv_epg_programmes WHERE channel_id=$1 AND programme_key=$2 AND start_at>NOW()', [channelId,key])).rows[0]; if(!p)return fail(res,400,'PROGRAMME_UNAVAILABLE','Programme is unavailable or already started'); const row=(await db.query("INSERT INTO milktv_epg_reminders(client_id,channel_id,programme_key,programme_start_at,programme_title) VALUES($1,$2,$3,$4,$5) ON CONFLICT(client_id,channel_id,programme_key) DO UPDATE SET status='active',cancelled_at=NULL RETURNING id,channel_id,programme_key,programme_start_at,programme_title,status",[req.v1client.id,channelId,key,p.start_at,p.title])).rows[0]; ok(res,{reminder:row},201); } catch(_){fail(res,500,'REMINDER_CREATE_FAILED','Reminder could not be created');} });
router.delete('/reminders/:id', csrfProtect, async (req,res)=>{try{const q=await db.query("UPDATE milktv_epg_reminders SET status='cancelled',cancelled_at=NOW() WHERE id=$1 AND client_id=$2 RETURNING id",[Number(req.params.id),req.v1client.id]);if(!q.rows.length)return fail(res,404,'REMINDER_NOT_FOUND','Reminder not found');ok(res,{deleted:true});}catch(_){fail(res,500,'REMINDER_DELETE_FAILED','Reminder could not be deleted');}});
router.get('/preferences', async (req,res)=>{try{ok(res,{preferences:(await db.query('SELECT channel_id,favorite,hidden,custom_name,updated_at FROM milktv_client_channel_preferences WHERE client_id=$1 ORDER BY channel_id',[req.v1client.id])).rows});}catch(_){fail(res,500,'PREFERENCES_UNAVAILABLE','Preferences are unavailable');}});
router.put('/preferences/:channelId', csrfProtect, async (req,res)=>{const id=Number(req.params.channelId);if(!Number.isInteger(id)||id<=0)return fail(res,400,'INVALID_CHANNEL','Invalid channel id');const favorite=req.body?.favorite===true,hidden=req.body?.hidden===true,customName=req.body?.custom_name==null?null:String(req.body.custom_name).trim().slice(0,120)||null;try{const exists=await db.query('SELECT 1 FROM channels WHERE id=$1',[id]);if(!exists.rows.length)return fail(res,404,'CHANNEL_NOT_FOUND','Channel not found');const row=(await db.query('INSERT INTO milktv_client_channel_preferences(client_id,channel_id,favorite,hidden,custom_name,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(client_id,channel_id) DO UPDATE SET favorite=EXCLUDED.favorite,hidden=EXCLUDED.hidden,custom_name=EXCLUDED.custom_name,updated_at=NOW() RETURNING channel_id,favorite,hidden,custom_name,updated_at',[req.v1client.id,id,favorite,hidden,customName])).rows[0];ok(res,{preference:row});}catch(_){fail(res,500,'PREFERENCE_SAVE_FAILED','Preference could not be saved');}});
module.exports = { router, DEVICE_LIMIT, VERSION, makePlaybackToken };
