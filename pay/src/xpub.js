'use strict';
/**
 * Watch-only HD receive addresses from an extended PUBLIC key (xpub/ypub/zpub, Ltub/Mtub).
 * Never accepts private material: xprv/yprv/zprv/Ltpv/Mtpv/tprv, WIF, raw hex keys and seed words are rejected.
 * Addresses: <key>/0/i (receive chain). Script type by prefix (BIP44 → P2PKH, BIP49 → P2SH-P2WPKH, BIP84 → P2WPKH)
 * or an explicit override (many wallets export plain "xpub" for SegWit accounts).
 */
const { HDKey } = require('@scure/bip32');
const { bech32, createBase58check } = require('@scure/base');
const { sha256 } = require('@noble/hashes/sha256');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const b58c = createBase58check(sha256);

const PUB = {
  0x0488b21e: { name: 'xpub', script: 'p2pkh', net: 'main' },
  0x049d7cb2: { name: 'ypub', script: 'p2sh-p2wpkh', net: 'main' },
  0x04b24746: { name: 'zpub', script: 'p2wpkh', net: 'main' },
  0x019da462: { name: 'Ltub', script: 'p2pkh', net: 'main', coin: 'ltc' },
  0x01b26ef6: { name: 'Mtub', script: 'p2sh-p2wpkh', net: 'main', coin: 'ltc' },
  0x043587cf: { name: 'tpub', net: 'test' }, 0x044a5262: { name: 'upub', net: 'test' }, 0x045f1cf6: { name: 'vpub', net: 'test' },
};
const PRIV = new Set([0x0488ade4, 0x049d7878, 0x04b2430c, 0x019d9cfe, 0x01b26792, 0x04358394, 0x044a4e28, 0x045f18bc]);
const PRIV_PREFIX = /^(xprv|yprv|zprv|tprv|uprv|vprv|Ltpv|Mtpv|Zprv|Yprv)/;
const COINS = {
  btc: { hrp: 'bc', p2pkh: 0x00, p2sh: 0x05, label: 'Bitcoin (BTC)' },
  ltc: { hrp: 'ltc', p2pkh: 0x30, p2sh: 0x32, label: 'Litecoin (LTC)' },
};
const SCRIPTS = { auto: 'Automaticky podľa prefixu', p2pkh: 'Legacy – BIP44 (1… / L…)', 'p2sh-p2wpkh': 'SegWit v P2SH – BIP49 (3… / M…)', p2wpkh: 'Native SegWit – BIP84 (bc1q… / ltc1q…)' };

class XpubError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const PRIV_MSG = 'Toto je SÚKROMNÝ kľúč (alebo seed) – ten sem nikdy nevkladajte! Vložte iba rozšírený VEREJNÝ kľúč (xpub / ypub / zpub / Ltub / Mtub). Ak ste súkromný kľúč niekam skopírovali, zvážte presun prostriedkov do novej peňaženky.';

/** Parse + validate. Returns { key, version, name, script, depth, fp } – throws XpubError (message never contains the input). */
function parse(input, coin) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new XpubError('Kľúč je prázdny.', 'empty');
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    if (words.length >= 11 && words.length <= 25 && words.every((w) => /^[a-zA-Z]+$/.test(w))) throw new XpubError(PRIV_MSG, 'seed');
    throw new XpubError('Kľúč nesmie obsahovať medzery.', 'format');
  }
  const s = words[0];
  if (PRIV_PREFIX.test(s)) throw new XpubError(PRIV_MSG, 'private');
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) throw new XpubError(PRIV_MSG, 'private');
  if (/^[5KLc9T6][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) throw new XpubError(PRIV_MSG, 'wif'); // WIF shape (even with a typo)
  let bytes = null;
  try { bytes = b58c.decode(s); } catch { bytes = null; }
  if (bytes && (bytes.length === 33 || bytes.length === 34) && [0x80, 0xb0, 0xef].includes(bytes[0])) throw new XpubError(PRIV_MSG, 'wif');
  if (!bytes || bytes.length !== 78) throw new XpubError('Neplatný kľúč – očakáva sa xpub / ypub / zpub (alebo Ltub / Mtub pre LTC). Skontrolujte, či ste skopírovali celý reťazec.', 'format');
  const version = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  if (PRIV.has(version) || bytes[45] === 0) throw new XpubError(PRIV_MSG, 'private');
  const v = PUB[version];
  if (!v) throw new XpubError('Neznámy typ rozšíreného kľúča.', 'format');
  if (v.net !== 'main') throw new XpubError(`${v.name} je kľúč pre testnet – použite mainnet kľúč.`, 'testnet');
  if (coin && v.coin && v.coin !== coin) throw new XpubError(`${v.name} je kľúč pre Litecoin – vložte ho do poľa LTC.`, 'coin');
  let key;
  try { key = HDKey.fromExtendedKey(s, { public: version, private: 0x0488ade4 }); } catch { throw new XpubError('Neplatný kľúč (kontrolný súčet alebo bod na krivke nesedí).', 'format'); }
  if (key.privateKey) throw new XpubError(PRIV_MSG, 'private');
  const fp = Buffer.from(sha256(new TextEncoder().encode(s))).toString('hex').slice(0, 16);
  return { key: s, version, name: v.name, script: v.script, depth: key.depth, fp, hd: key };
}

const hash160 = (b) => ripemd160(sha256(b));
function addressFromPub(pub, coin, script) {
  const c = COINS[coin]; if (!c) throw new XpubError('Nepodporovaná mena.', 'coin');
  const h = hash160(pub);
  if (script === 'p2wpkh') return bech32.encode(c.hrp, [0, ...bech32.toWords(h)]);
  if (script === 'p2sh-p2wpkh') { const redeem = new Uint8Array(22); redeem[0] = 0; redeem[1] = 0x14; redeem.set(h, 2); return b58c.encode(Uint8Array.from([c.p2sh, ...hash160(redeem)])); }
  if (script === 'p2pkh') return b58c.encode(Uint8Array.from([c.p2pkh, ...h]));
  throw new XpubError('Neznámy typ skriptu.', 'script');
}
const effScript = (p, override) => (override && override !== 'auto' && SCRIPTS[override] ? override : p.script);
/** receive address i (path <key>/0/i) */
function derive(parsedOrKey, coin, index, override) {
  const p = typeof parsedOrKey === 'string' ? parse(parsedOrKey, coin) : parsedOrKey;
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new XpubError('Neplatný index.', 'index');
  const child = p.hd.deriveChild(0).deriveChild(index);
  return addressFromPub(child.publicKey, coin, effScript(p, override));
}
const preview = (key, coin, override, n = 3) => { const p = parse(key, coin); return Array.from({ length: n }, (_, i) => ({ index: i, path: `…/0/${i}`, address: derive(p, coin, i, override) })); };
const mask = (k) => { const s = String(k || ''); return s.length > 20 ? s.slice(0, 8) + '…' + s.slice(-6) : s; };

// ---------- allocation (Postgres, atomic per coin row lock; gap-limit aware) ----------
let pool = null; let cfg = {}; // coin -> { coin, xpub, fp, script, gap_limit, enabled, next_index }
const parsedCache = new Map();
function setPool(p) { pool = p; }
async function init(p) {
  if (p) pool = p; if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS xpub_keys (coin text PRIMARY KEY, xpub text NOT NULL, fp text NOT NULL, script text NOT NULL DEFAULT 'auto', gap_limit int NOT NULL DEFAULT 20, enabled boolean NOT NULL DEFAULT true, next_index int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS xpub_addrs (coin text NOT NULL, fp text NOT NULL, idx int NOT NULL, address text NOT NULL, order_id text, issued_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz, PRIMARY KEY (coin, fp, idx))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS xpub_addrs_order ON xpub_addrs (order_id)`);
  await reload();
}
async function reload() {
  if (!pool) return; const r = await pool.query(`SELECT coin,xpub,fp,script,gap_limit,enabled,next_index FROM xpub_keys`);
  cfg = Object.fromEntries(r.rows.map((x) => [x.coin, x]));
}
const has = (coin) => !!(pool && cfg[coin] && cfg[coin].enabled);
const parsedFor = (row) => { let p = parsedCache.get(row.fp); if (!p) { p = parse(row.xpub, row.coin); parsedCache.set(row.fp, p); } return p; };
const RECYCLE_AGE_MS = 4 * 24 * 3600e3; // chainWatcher watches orders for 3 days

/** Next unused receive address for an order, or null when no xpub is configured (caller then keeps its old behaviour). */
async function nextAddress(coin, orderId) {
  if (!has(coin)) return null;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const k = (await c.query(`SELECT * FROM xpub_keys WHERE coin=$1 AND enabled FOR UPDATE`, [coin])).rows[0];
    if (!k) { await c.query('ROLLBACK'); return null; }
    const p = parsedFor(k);
    if (orderId) { const ex = (await c.query(`SELECT idx,address FROM xpub_addrs WHERE coin=$1 AND fp=$2 AND order_id=$3`, [coin, k.fp, orderId])).rows[0]; if (ex) { await c.query('COMMIT'); return { address: ex.address, index: ex.idx, fp: k.fp, coin }; } }
    const lu = (await c.query(`SELECT COALESCE(MAX(idx),-1) m FROM xpub_addrs WHERE coin=$1 AND fp=$2 AND used_at IS NOT NULL`, [coin, k.fp])).rows[0].m;
    const unusedAhead = k.next_index - (lu + 1);
    if (unusedAhead >= k.gap_limit) {
      // gap limit reached: re-issue the oldest never-paid address (no longer watched) instead of walking past the wallet's gap
      const old = (await c.query(`SELECT idx,address FROM xpub_addrs WHERE coin=$1 AND fp=$2 AND used_at IS NULL AND issued_at < $3 ORDER BY issued_at LIMIT 1 FOR UPDATE`, [coin, k.fp, new Date(Date.now() - RECYCLE_AGE_MS)])).rows[0];
      if (old) {
        await c.query(`UPDATE xpub_addrs SET order_id=$4, issued_at=now() WHERE coin=$1 AND fp=$2 AND idx=$3`, [coin, k.fp, old.idx, orderId || null]);
        await c.query('COMMIT'); return { address: old.address, index: old.idx, fp: k.fp, coin, reused: true };
      }
      console.warn(`[xpub] ${coin}: gap limit ${k.gap_limit} reached, issuing beyond gap`);
    }
    const idx = (await c.query(`UPDATE xpub_keys SET next_index=next_index+1 WHERE coin=$1 RETURNING next_index-1 AS i`, [coin])).rows[0].i;
    const address = derive(p, coin, idx, k.script);
    await c.query(`INSERT INTO xpub_addrs (coin,fp,idx,address,order_id) VALUES ($1,$2,$3,$4,$5)`, [coin, k.fp, idx, address, orderId || null]);
    await c.query('COMMIT');
    if (cfg[coin]) cfg[coin].next_index = idx + 1;
    return { address, index: idx, fp: k.fp, coin };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('[xpub] allocation failed', e.message); return null; } finally { c.release(); }
}
async function markUsed(orderId) { if (!pool || !orderId) return; await pool.query(`UPDATE xpub_addrs SET used_at=COALESCE(used_at, now()) WHERE order_id=$1`, [orderId]).catch(() => {}); }
async function save(coin, key, script, gap, enabled) {
  const p = parse(key, coin); const sc = SCRIPTS[script] ? script : 'auto'; const g = Math.max(5, Math.min(1000, parseInt(gap, 10) || 20));
  await pool.query(`INSERT INTO xpub_keys (coin,xpub,fp,script,gap_limit,enabled,next_index) VALUES ($1,$2,$3,$4,$5,$6,COALESCE((SELECT MAX(idx)+1 FROM xpub_addrs WHERE coin=$1 AND fp=$3),0))
    ON CONFLICT (coin) DO UPDATE SET xpub=EXCLUDED.xpub, script=EXCLUDED.script, gap_limit=EXCLUDED.gap_limit, enabled=EXCLUDED.enabled, updated_at=now(),
      next_index=CASE WHEN xpub_keys.fp=EXCLUDED.fp THEN xpub_keys.next_index ELSE EXCLUDED.next_index END, fp=EXCLUDED.fp`, [coin, p.key, p.fp, sc, g, !!enabled]);
  await reload(); return p;
}
async function remove(coin) { await pool.query(`DELETE FROM xpub_keys WHERE coin=$1`, [coin]); await reload(); }
async function status(coin) {
  const k = cfg[coin]; if (!k || !pool) return null;
  const r = (await pool.query(`SELECT count(*)::int n, count(used_at)::int used, max(issued_at) last FROM xpub_addrs WHERE coin=$1 AND fp=$2`, [coin, k.fp])).rows[0];
  return { ...k, issued: r.n, used: r.used, last: r.last };
}
const getCfg = (coin) => cfg[coin] || null;

module.exports = { parse, derive, preview, addressFromPub, mask, XpubError, COINS, SCRIPTS, setPool, init, reload, has, nextAddress, markUsed, save, remove, status, getCfg, _setCfg: (c) => { cfg = c; } };
