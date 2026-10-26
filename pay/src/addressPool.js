'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = IS_SERVERLESS
  ? path.join('/tmp', 'chain2pay-data')
  : path.join(ROOT, 'data');
const POOLS_FILE = path.join(ROOT, 'data', 'address-pools.json');
const POOLS_FALLBACK = path.join(DATA_DIR, 'address-pools.json');
const STATE_FILE = path.join(DATA_DIR, 'address-state.json');

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

/** Legacy static pools (data/address-pools.json, committed) — only used by the BTCPay option's own fallback
 * and before the admin wallet table has loaded. */
function loadFilePools() {
  for (const p of [POOLS_FILE, POOLS_FALLBACK]) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      /* try next */
    }
  }
  return { evm: [], btc: [], ltc: [], bch: [], lightning: [], sol: [], doge: [] };
}

/** Source of truth: admin „Adresy peňaženiek“ (Neon wallet_addresses) — enabled addresses in admin order.
 * Falls back to the committed file pools only until the table has loaded (startup / no DB). */
function walletsReady() { try { return require('./wallets').isReady(); } catch { return false; } }
function loadPools() {
  if (!walletsReady()) return loadFilePools();
  const w = require('./wallets');
  const out = {};
  for (const k of ['evm', 'btc', 'ltc', 'bch', 'lightning', 'sol', 'doge', 'trx', 'ton', 'xmr', 'xrp']) out[k] = w.enabledAddresses(k).map((r) => r.address);
  return out;
}

function defaultState(pools) {
  const state = {};
  for (const coin of Object.keys(pools)) {
    state[coin] = { nextIndex: 0, used: [] };
  }
  return state;
}

// Rotation state lives in Neon (table pay_kv, key 'address-state') – the Render disk is ephemeral.
// In-memory copy is the working state; every change is written through (serialised). File = local-dev fallback.
let memState = null;
let dbChain = Promise.resolve();
function dbPool() { try { return require('./db').pool(); } catch { return null; } }
async function initState(log) {
  const pool = dbPool();
  if (!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS pay_kv (k text PRIMARY KEY, v jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
  const r = await pool.query(`SELECT v FROM pay_kv WHERE k = 'address-state'`);
  if (r.rows.length) memState = r.rows[0].v;
  else {
    let file = null;
    try { if (fs.existsSync(STATE_FILE)) file = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { file = null; }
    memState = file || {};
    await pool.query(`INSERT INTO pay_kv (k, v) VALUES ('address-state', $1::jsonb) ON CONFLICT (k) DO NOTHING`, [JSON.stringify(memState)]);
  }
  if (log) log('ADDRESS_STATE_DB ready coins=' + Object.keys(memState || {}).length);
  return true;
}

function loadState(pools) {
  let s = null;
  if (memState) s = JSON.parse(JSON.stringify(memState));
  else {
    ensureDataDir();
    try { if (fs.existsSync(STATE_FILE)) s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { s = null; }
  }
  if (!s) return defaultState(pools);
  for (const coin of Object.keys(pools)) {
    if (!s[coin]) s[coin] = { nextIndex: 0, used: [] };
  }
  return s;
}

function saveState(state) {
  const pool = dbPool();
  if (pool && memState) {
    memState = JSON.parse(JSON.stringify(state));
    const j = JSON.stringify(memState);
    dbChain = dbChain.then(() => pool.query(`INSERT INTO pay_kv (k, v, updated_at) VALUES ('address-state', $1::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`, [j])).catch(() => {});
    return;
  }
  ensureDataDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* memory-only on read-only FS */
  }
}

/**
 * Pick next address for coin: unused-first, then round-robin.
 * Persists index + used list in data/address-state.json.
 * @param {string} coin - btc | ltc | bch | evm | lightning | sol | doge
 * @param {{orderId?: string}} [meta]
 * @returns {{ coin: string, address: string, index: number, poolSize: number, reused: boolean }}
 */

// --- BTCPay fresh BTC addresses (Greenfield) -------------------------------
// Sync callers need an address immediately, so keep a small prefetched queue of
// never-used BTCPay addresses (forceGenerate=true). Empty queue / BTCPay down →
// static pool (unchanged behaviour).
const btcpayQueue = [];
const btcpayIssued = new Set();
let btcpayRefilling = false;
let btcpayLastError = null;
const BTCPAY_BUFFER = Math.max(1, Number(process.env.BTCPAY_ADDRESS_BUFFER || 3));

function btcpayCfg() {
  const url = String(process.env.BTCPAY_URL || process.env.BTCPay_URL || '').trim().replace(/\/$/, '');
  const storeId = String(process.env.BTCPAY_STORE_ID || '').trim();
  const apiKey = String(process.env.BTCPAY_API_KEY || '').trim();
  if (!url || !storeId || !apiKey || String(process.env.BTCPAY_FRESH_ADDRESSES || '1') === '0') return null;
  return { url, storeId, apiKey };
}

async function fetchBtcpayAddress() {
  const c = btcpayCfg();
  if (!c) throw new Error('BTCPay not configured');
  const r = await fetch(`${c.url}/api/v1/stores/${encodeURIComponent(c.storeId)}/payment-methods/BTC-CHAIN/wallet/address?forceGenerate=true`, {
    headers: { Authorization: `token ${c.apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.address) throw new Error(`BTCPay ${r.status} ${j.message || ''}`.trim());
  return { address: j.address, keyPath: j.keyPath || null };
}

async function refillBtcpay() {
  if (btcpayRefilling || !btcpayCfg()) return;
  btcpayRefilling = true;
  try {
    while (btcpayQueue.length < BTCPAY_BUFFER) {
      const a = await fetchBtcpayAddress();
      if (btcpayIssued.has(a.address) || btcpayQueue.some((x) => x.address === a.address)) continue;
      btcpayQueue.push(a);
      btcpayLastError = null;
    }
  } catch (e) {
    btcpayLastError = { message: e.message, at: new Date().toISOString() };
  } finally {
    btcpayRefilling = false;
  }
}

/** Await a fresh BTCPay address directly (async callers). Returns null when unavailable. */
async function freshBtcpayAddress() {
  const q = btcpayQueue.shift();
  if (q) { btcpayIssued.add(q.address); refillBtcpay(); return q; }
  try {
    const a = await fetchBtcpayAddress();
    btcpayIssued.add(a.address); refillBtcpay();
    return a;
  } catch (e) {
    btcpayLastError = { message: e.message, at: new Date().toISOString() };
    return null;
  }
}

function btcpayStatus() {
  return { configured: Boolean(btcpayCfg()), buffered: btcpayQueue.length, issued: btcpayIssued.size, lastError: btcpayLastError };
}

if (btcpayCfg()) setTimeout(refillBtcpay, 500);

/**
 * meta.btcpay === true → ONLY the BTCPay checkout option: fresh BTCPay address first, then the legacy file pool
 * (exactly the previous behaviour). Every other caller gets Ryan's admin-managed addresses, never BTCPay ones.
 */
function nextAddress(coin, meta = {}) {
  const key = String(coin || '').toLowerCase();
  if (key === 'btc' && meta.btcpay === true && !meta.staticOnly) {
    const q = btcpayQueue.shift();
    if (q) {
      btcpayIssued.add(q.address);
      refillBtcpay();
      return { coin: 'btc', address: q.address, index: q.keyPath, poolSize: null, reused: false, source: 'btcpay', keyPath: q.keyPath };
    }
    refillBtcpay();
  }
  const pools = meta.btcpay === true ? loadFilePools() : loadPools();
  const pool = Array.isArray(pools[key]) ? pools[key].filter(Boolean) : [];
  if (!pool.length) {
    const err = new Error(`Address pool empty for coin=${key}`);
    err.code = 'EMPTY_POOL';
    throw err;
  }

  const state = loadState(pools);
  const slot = state[key] || { nextIndex: 0, used: [] };
  const usedSet = new Set(slot.used || []);

  let index = -1;
  let reused = false;

  // Prefer never-used addresses first
  for (let i = 0; i < pool.length; i++) {
    if (!usedSet.has(pool[i])) {
      index = i;
      break;
    }
  }

  if (index < 0) {
    // All used — round-robin from nextIndex
    reused = true;
    index = Number(slot.nextIndex) % pool.length;
    if (!Number.isFinite(index) || index < 0) index = 0;
  }

  const address = pool[index];
  slot.nextIndex = (index + 1) % pool.length;
  if (!usedSet.has(address)) {
    slot.used = [...(slot.used || []), address];
  }
  // Cap used log growth (keep last poolSize*3)
  if (slot.used.length > pool.length * 3) {
    slot.used = slot.used.slice(-pool.length * 2);
  }
  if (meta.orderId) {
    slot.lastOrderId = meta.orderId;
    slot.lastAssignedAt = new Date().toISOString();
  }
  state[key] = slot;
  saveState(state);

  return {
    coin: key,
    address,
    index,
    poolSize: pool.length,
    reused,
  };
}

function peek(coin) {
  const key = String(coin || '').toLowerCase();
  const pools = loadPools();
  const pool = pools[key] || [];
  const state = loadState(pools);
  const slot = state[key] || { nextIndex: 0, used: [] };
  return {
    coin: key,
    poolSize: pool.length,
    nextIndex: slot.nextIndex || 0,
    usedCount: (slot.used || []).length,
    addresses: pool,
  };
}

function poolStats() {
  const pools = loadPools();
  const state = loadState(pools);
  const out = {};
  for (const coin of Object.keys(pools)) {
    const pool = pools[coin] || [];
    const slot = state[coin] || { nextIndex: 0, used: [] };
    out[coin] = {
      poolSize: pool.length,
      nextIndex: slot.nextIndex || 0,
      usedCount: (slot.used || []).length,
      nextAddress: pool[(slot.nextIndex || 0) % Math.max(pool.length, 1)] || null,
    };
  }
  return out;
}

function merchantEvm() {
  if (walletsReady()) { const r = require('./wallets').forChain('polygon'); return r ? r.address : ''; }
  const pools = loadFilePools();
  return (pools.evm && pools.evm[0]) || process.env.MERCHANT_WALLET || '';
}

module.exports = {
  initState,
  nextAddress,
  freshBtcpayAddress,
  refillBtcpay,
  btcpayStatus,
  peek,
  poolStats,
  loadPools,
  loadFilePools,
  walletsReady,
  merchantEvm,
};
