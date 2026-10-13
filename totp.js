'use strict';
// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) + RFC 4648 base32. No external deps.
const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  s = String(s).toUpperCase().replace(/[\s=]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of s) { const i = A.indexOf(c); if (i < 0) throw new Error('bad base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(key, counter) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const step = (t = Date.now()) => Math.floor(t / 1000 / 30);
/** returns matched step number or -1; window ±1 step */
function verify(secretB32, code, t = Date.now(), win = 1) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return -1;
  const key = b32dec(secretB32), s = step(t);
  for (let d = -win; d <= win; d++) {
    const a = Buffer.from(hotp(key, s + d)), b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return s + d;
  }
  return -1;
}
const generateSecret = () => b32enc(crypto.randomBytes(20));
const uri = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
const now = (secret, t = Date.now()) => hotp(b32dec(secret), step(t));
module.exports = { b32enc, b32dec, hotp, verify, generateSecret, uri, now, step };
