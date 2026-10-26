'use strict';
/**
 * Strict public receive-address validation per network (no keys, no network calls).
 * validate(network, address, memo) -> { ok:true, address, memo } | { ok:false, error:'<slovenská chyba>' }
 */
const crypto = require('crypto');

/* ---------- keccak-256 (Ethereum / Monero; NOT NIST sha3) ---------- */
const RC = [
  [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
  [0x0000808b, 0x00000000], [0x80000001, 0x00000000], [0x80008081, 0x80000000], [0x00008009, 0x80000000],
  [0x0000008a, 0x00000000], [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
  [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000], [0x00008003, 0x80000000],
  [0x00008002, 0x80000000], [0x00000080, 0x80000000], [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
  [0x80008081, 0x80000000], [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000],
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
function keccakF(s) { // s: array of 25 BigInt
  const M = (1n << 64n) - 1n;
  const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M);
  for (let r = 0; r < 24; r++) {
    const C = []; for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[y + x] ^= D; }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[y + x] = B[y + x] ^ (~B[y + (x + 1) % 5] & M & B[y + (x + 2) % 5]);
    s[0] ^= (BigInt(RC[r][1]) << 32n) | BigInt(RC[r][0]);
  }
}
function keccak256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const rate = 136; const padLen = rate - (buf.length % rate);
  const p = Buffer.concat([buf, Buffer.alloc(padLen)]); p[buf.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= p.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

/* ---------- base58 ---------- */
const B58_BTC = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_XRP = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
function b58decode(str, alpha = B58_BTC) {
  if (!str) return null;
  let n = 0n;
  for (const ch of str) { const i = alpha.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex; if (n === 0n) hex = '';
  let lead = 0; for (const ch of str) { if (ch === alpha[0]) lead++; else break; }
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}
const sha256d = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
function b58check(str, alpha) {
  const b = b58decode(str, alpha); if (!b || b.length < 5) return null;
  const payload = b.subarray(0, -4); const ck = b.subarray(-4);
  return sha256d(payload).subarray(0, 4).equals(ck) ? payload : null;
}

/* ---------- bech32 / bech32m (BIP173/350) ---------- */
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1;
  for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]; }
  return chk;
}
const hrpExpand = (h) => [...[...h].map((c) => c.charCodeAt(0) >> 5), 0, ...[...h].map((c) => c.charCodeAt(0) & 31)];
function bech32Decode(str, maxLen = 90) {
  if (str.length > maxLen) return null;
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  const s = str.toLowerCase(); const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos); const data = [];
  for (const c of s.slice(pos + 1)) { const d = CS.indexOf(c); if (d < 0) return null; data.push(d); }
  const pm = polymod([...hrpExpand(hrp), ...data]);
  const enc = pm === 1 ? 'bech32' : pm === 0x2bc830a3 ? 'bech32m' : null;
  if (!enc) return null;
  return { hrp, data: data.slice(0, -6), enc };
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = []; const maxv = (1 << to) - 1;
  for (const v of data) { if (v >> from) return null; acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); } }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); } else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}
function segwit(hrpWant, addr) {
  const d = bech32Decode(addr); if (!d || d.hrp !== hrpWant || !d.data.length) return false;
  const ver = d.data[0]; const prog = convertBits(d.data.slice(1), 5, 8, false);
  if (!prog || prog.length < 2 || prog.length > 40 || ver > 16) return false;
  if (ver === 0 && (d.enc !== 'bech32' || (prog.length !== 20 && prog.length !== 32))) return false;
  if (ver !== 0 && d.enc !== 'bech32m') return false;
  if (ver === 1 && prog.length !== 32) return false;
  return true;
}

/* ---------- cashaddr (BCH) ---------- */
function cashPolymod(v) {
  const G = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]; let c = 1n;
  for (const d of v) { const c0 = c >> 35n; c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d); for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= G[i]; }
  return c ^ 1n;
}
function cashaddr(addr) {
  let s = addr; if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null; s = s.toLowerCase();
  if (!s.includes(':')) s = 'bitcoincash:' + s;
  const [prefix, payload] = s.split(':'); if (prefix !== 'bitcoincash' || !payload) return null;
  const data = []; for (const c of payload) { const d = CS.indexOf(c); if (d < 0) return null; data.push(d); }
  const v = [...[...prefix].map((c) => c.charCodeAt(0) & 31), 0, ...data];
  if (cashPolymod(v) !== 0n) return null;
  const bytes = convertBits(data.slice(0, -8), 5, 8, false); if (!bytes || bytes.length !== 21) return null;
  if (![0x00, 0x08].includes(bytes[0])) return null; // P2PKH / P2SH 160-bit
  return s;
}

/* ---------- EVM (EIP-55) ---------- */
function eip55(addrLower) {
  const h = keccak256(Buffer.from(addrLower, 'ascii')).toString('hex');
  return '0x' + [...addrLower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

/* ---------- Monero base58 (8-byte blocks -> 11 chars) ---------- */
function xmrDecode(s) {
  const FULL = 11; const SIZES = [0, -1, 1, 2, -1, 3, 4, 5, -1, 6, 7, 8];
  const out = [];
  for (let i = 0; i < s.length; i += FULL) {
    const blk = s.slice(i, i + FULL); const size = SIZES[blk.length]; if (size == null || size < 0) return null;
    let n = 0n; for (const ch of blk) { const k = B58_BTC.indexOf(ch); if (k < 0) return null; n = n * 58n + BigInt(k); }
    const bytes = []; for (let j = 0; j < (blk.length === FULL ? 8 : size); j++) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    if (n !== 0n) return null; out.push(...bytes);
  }
  return Buffer.from(out);
}

/* ---------- TON user-friendly (crc16-xmodem) ---------- */
function crc16(buf) { let c = 0; for (const b of buf) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }

const ERR = (m) => ({ ok: false, error: m });

/** Networks admin can store. memo: null = not allowed, 'tag' = numeric (XRP), 'text' = free text (TON). */
const NETWORKS = Object.freeze({
  btc: { label: 'Bitcoin (BTC)', short: 'BTC', memo: null, example: 'bc1q…' },
  lightning: { label: 'Bitcoin Lightning (LN adresa / LNURL)', short: 'LN', memo: null, example: 'meno@domena.sk' },
  ltc: { label: 'Litecoin (LTC)', short: 'LTC', memo: null, example: 'ltc1q… / L… / M…' },
  bch: { label: 'Bitcoin Cash (BCH)', short: 'BCH', memo: null, example: 'bitcoincash:q…' },
  doge: { label: 'Dogecoin (DOGE)', short: 'DOGE', memo: null, example: 'D…' },
  evm: { label: 'EVM – všetky siete (ETH, Base, Arbitrum, Polygon, BSC, Optimism)', short: 'EVM', memo: null, example: '0x…', evm: true },
  eth: { label: 'Ethereum (len táto sieť)', short: 'ETH', memo: null, example: '0x…', evm: true },
  base: { label: 'Base (len táto sieť)', short: 'Base', memo: null, example: '0x…', evm: true },
  arbitrum: { label: 'Arbitrum One (len táto sieť)', short: 'ARB', memo: null, example: '0x…', evm: true },
  polygon: { label: 'Polygon PoS (len táto sieť)', short: 'POL', memo: null, example: '0x…', evm: true },
  bsc: { label: 'BNB Smart Chain / BEP-20 (len táto sieť)', short: 'BSC', memo: null, example: '0x…', evm: true },
  optimism: { label: 'Optimism (len táto sieť)', short: 'OP', memo: null, example: '0x…', evm: true },
  sol: { label: 'Solana (SOL + SPL tokeny)', short: 'SOL', memo: null, example: 'base58, 32–44 znakov' },
  trx: { label: 'Tron (TRX + USDT TRC-20)', short: 'TRX', memo: null, example: 'T…' },
  ton: { label: 'TON', short: 'TON', memo: 'text', example: 'UQ… / EQ…' },
  xmr: { label: 'Monero (XMR)', short: 'XMR', memo: null, example: '4… / 8…' },
  xrp: { label: 'XRP Ledger (XRP)', short: 'XRP', memo: 'tag', example: 'r…' },
});

function validateAddress(network, raw) {
  const a = String(raw == null ? '' : raw).trim();
  if (!a) return ERR('Zadajte adresu.');
  if (/\s/.test(a)) return ERR('Adresa nesmie obsahovať medzery ani zalomenie riadku.');
  if (a.length > 200) return ERR('Adresa je príliš dlhá.');
  switch (network) {
    case 'btc': {
      if (/^(bc1)/i.test(a)) return segwit('bc', a) ? { ok: true, address: a.toLowerCase() } : ERR('Neplatná Bitcoin bech32 adresa (bc1…) – nesedí kontrolný súčet alebo dĺžka. Skontrolujte, či ste ju skopírovali celú.');
      if (/^(tb1|bcrt1|[mn2])/.test(a)) return ERR('Toto je testnet adresa – zadajte mainnet Bitcoin adresu (bc1…, 1… alebo 3…).');
      const p = b58check(a); if (p && p.length === 21 && (p[0] === 0x00 || p[0] === 0x05)) return { ok: true, address: a };
      return ERR('Neplatná Bitcoin adresa – nesedí kontrolný súčet alebo formát (povolené bc1…, 1…, 3…).');
    }
    case 'ltc': {
      if (/^ltc1/i.test(a)) return segwit('ltc', a) ? { ok: true, address: a.toLowerCase() } : ERR('Neplatná Litecoin bech32 adresa (ltc1…) – nesedí kontrolný súčet alebo dĺžka.');
      const p = b58check(a); if (p && p.length === 21 && [0x30, 0x32, 0x05].includes(p[0])) return { ok: true, address: a };
      return ERR('Neplatná Litecoin adresa – nesedí kontrolný súčet alebo formát (povolené ltc1…, L…, M…, 3…).');
    }
    case 'doge': {
      const p = b58check(a); if (p && p.length === 21 && [0x1e, 0x16].includes(p[0])) return { ok: true, address: a };
      return ERR('Neplatná Dogecoin adresa – nesedí kontrolný súčet alebo formát (povolené D…, A…, 9…).');
    }
    case 'bch': {
      const c = cashaddr(a); if (c) return { ok: true, address: c };
      const p = b58check(a); if (p && p.length === 21 && (p[0] === 0x00 || p[0] === 0x05)) return { ok: true, address: a };
      return ERR('Neplatná Bitcoin Cash adresa – nesedí kontrolný súčet (povolené bitcoincash:q…/p… alebo staré 1…/3…).');
    }
    case 'evm': case 'eth': case 'base': case 'arbitrum': case 'polygon': case 'bsc': case 'optimism': {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return ERR('Neplatná EVM adresa – musí začínať 0x a mať presne 40 hexadecimálnych znakov.');
      const lower = a.slice(2).toLowerCase();
      if (/^0+$/.test(lower)) return ERR('Nulová adresa (0x000…) sa nedá použiť – prostriedky by sa stratili.');
      const sum = eip55(lower);
      const mixed = a.slice(2) !== lower && a.slice(2) !== lower.toUpperCase();
      if (mixed && a !== sum) return ERR('Neplatná EVM adresa – nesedí EIP-55 kontrolný súčet (veľké/malé písmená). Skopírujte adresu znova presne z peňaženky.');
      return { ok: true, address: sum };
    }
    case 'sol': {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return ERR('Neplatná Solana adresa – očakáva sa base58 reťazec dlhý 32–44 znakov.');
      const b = b58decode(a); if (!b || b.length !== 32) return ERR('Neplatná Solana adresa – po dekódovaní nemá 32 bajtov.');
      return { ok: true, address: a };
    }
    case 'trx': {
      const p = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) ? b58check(a) : null;
      if (p && p.length === 21 && p[0] === 0x41) return { ok: true, address: a };
      return ERR('Neplatná Tron adresa – musí začínať T, mať 34 znakov a sedieť kontrolný súčet.');
    }
    case 'xrp': {
      const p = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a) ? b58check(a, B58_XRP) : null;
      if (p && p.length === 21 && p[0] === 0x00) return { ok: true, address: a };
      if (/^X/.test(a)) return ERR('X-adresy nie sú podporované – zadajte klasickú adresu r… a Destination Tag do poľa Memo/Tag.');
      return ERR('Neplatná XRP adresa – musí začínať r a sedieť kontrolný súčet.');
    }
    case 'ton': {
      if (/^-?[01]:[0-9a-fA-F]{64}$/.test(a)) return { ok: true, address: a.toLowerCase() };
      if (!/^[A-Za-z0-9_+/-]{48}$/.test(a)) return ERR('Neplatná TON adresa – očakáva sa 48-znaková adresa (UQ…/EQ…) alebo 0:<64 hex>.');
      const b = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (b.length !== 36 || ![0x11, 0x51, 0x91, 0xd1].includes(b[0]) || ![0x00, 0xff].includes(b[1])) return ERR('Neplatná TON adresa – nesprávny formát.');
      if (crc16(b.subarray(0, 34)) !== b.readUInt16BE(34)) return ERR('Neplatná TON adresa – nesedí kontrolný súčet.');
      if (b[0] & 0x80) return ERR('Toto je TON testnet adresa – zadajte mainnet adresu.');
      return { ok: true, address: a };
    }
    case 'xmr': {
      if (!/^[48][1-9A-HJ-NP-Za-km-z]{94}$|^4[1-9A-HJ-NP-Za-km-z]{105}$/.test(a)) return ERR('Neplatná Monero adresa – musí začínať 4 alebo 8 a mať 95 znakov (integrovaná 106).');
      const b = xmrDecode(a); if (!b || b.length < 69) return ERR('Neplatná Monero adresa – nedá sa dekódovať.');
      const body = b.subarray(0, -4);
      if (!keccak256(body).subarray(0, 4).equals(b.subarray(-4))) return ERR('Neplatná Monero adresa – nesedí kontrolný súčet.');
      if (![18, 19, 42].includes(b[0])) return ERR('Neplatná Monero adresa – nie je to mainnet adresa.');
      return { ok: true, address: a };
    }
    case 'lightning': {
      if (/^lnurl1/i.test(a)) { const d = bech32Decode(a, 2000); return d && d.hrp === 'lnurl' ? { ok: true, address: a.toLowerCase() } : ERR('Neplatný LNURL – nesedí kontrolný súčet.'); }
      if (/^ln(bc|tb)/i.test(a)) return ERR('Faktúra (invoice) sa nedá použiť opakovane – zadajte Lightning adresu (meno@domena) alebo LNURL.');
      if (/^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/i.test(a)) return { ok: true, address: a.toLowerCase() };
      return ERR('Neplatná Lightning adresa – zadajte v tvare meno@domena.sk alebo LNURL1….');
    }
    default: return ERR('Neznáma sieť.');
  }
}

function validateMemo(network, raw) {
  const m = String(raw == null ? '' : raw).trim();
  const kind = NETWORKS[network] && NETWORKS[network].memo;
  if (!m) return { ok: true, memo: null };
  if (!kind) return ERR('Táto sieť memo/tag nepodporuje – nechajte pole prázdne.');
  if (kind === 'tag') {
    if (!/^\d{1,10}$/.test(m) || Number(m) > 4294967295) return ERR('Destination Tag musí byť celé číslo 0 – 4294967295.');
    return { ok: true, memo: String(Number(m)) };
  }
  if (m.length > 120 || /[\u0000-\u001f]/.test(m)) return ERR('Memo môže mať najviac 120 znakov bez riadiacich znakov.');
  return { ok: true, memo: m };
}

function validate(network, address, memo) {
  if (!NETWORKS[network]) return ERR('Neznáma sieť.');
  const a = validateAddress(network, address); if (!a.ok) return a;
  const m = validateMemo(network, memo); if (!m.ok) return m;
  return { ok: true, address: a.address, memo: m.memo };
}

module.exports = { NETWORKS, validate, validateAddress, validateMemo, keccak256, eip55, _b58check: b58check };
