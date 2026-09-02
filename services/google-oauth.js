const crypto = require('crypto');

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
let jwksCache = { expires: 0, keys: [] };

function config() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: String(process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback').trim()
  };
}
function isConfigured() { const c = config(); return Boolean(c.clientId && c.clientSecret && c.redirectUri); }
function b64(value) { return Buffer.from(value).toString('base64url'); }
function randomState() { return crypto.randomBytes(32).toString('base64url'); }
function authorizationUrl(state, returnTo) {
  const c = config();
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', c.clientId); url.searchParams.set('redirect_uri', c.redirectUri);
  url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state); url.searchParams.set('prompt', 'select_account');
  return url.toString();
}
async function fetchJwks() {
  if (jwksCache.expires > Date.now()) return jwksCache.keys;
  const response = await fetch(GOOGLE_JWKS);
  if (!response.ok) throw new Error('Google signing keys unavailable');
  const body = await response.json(); jwksCache = { keys: body.keys || [], expires: Date.now() + 60 * 60 * 1000 }; return jwksCache.keys;
}
async function verifyIdToken(idToken) {
  const parts = String(idToken || '').split('.'); if (parts.length !== 3) throw new Error('Invalid Google ID token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const c = config();
  if (header.alg !== 'RS256' || !header.kid || claims.iss !== 'https://accounts.google.com' || claims.aud !== c.clientId || Number(claims.exp) <= Math.floor(Date.now() / 1000) || claims.email_verified !== true || !claims.sub) throw new Error('Invalid Google identity claims');
  const key = (await fetchJwks()).find(item => item.kid === header.kid); if (!key) throw new Error('Unknown Google signing key');
  const verifier = crypto.createVerify('RSA-SHA256'); verifier.update(parts[0] + '.' + parts[1]); verifier.end();
  if (!verifier.verify(crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Google signature verification failed');
  return claims;
}
async function exchangeCode(code) {
  const c = config();
  const response = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' }) });
  if (!response.ok) throw new Error('Google token exchange failed');
  const body = await response.json(); if (!body.id_token) throw new Error('Google identity token missing'); return verifyIdToken(body.id_token);
}
module.exports = { config, isConfigured, randomState, authorizationUrl, exchangeCode };
