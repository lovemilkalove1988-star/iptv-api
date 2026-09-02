const crypto = require('crypto');

const secret = () => String(process.env.SESSION_SECRET || process.env.PLAYBACK_TOKEN_SECRET || 'milktv-device-secret-change-me');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function randomCredential() { return crypto.randomBytes(32).toString('base64url'); }
function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < 6) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}
function recoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  while (out.length < 6) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}
function encryptRecovery(value) {
  const key = crypto.createHash('sha256').update(secret()).digest(), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function decryptRecovery(value) {
  try { const raw=Buffer.from(String(value),'base64url'), decipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(secret()).digest(),raw.subarray(0,12)); decipher.setAuthTag(raw.subarray(12,28)); return Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8'); } catch (_) { return null; }
}
function same(a,b) { const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||'')); return x.length===y.length&&crypto.timingSafeEqual(x,y); }
module.exports = { hash, same, randomCredential, recoveryCode, pairingCode, encryptRecovery, decryptRecovery };
