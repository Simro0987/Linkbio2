'use strict';
/**
 * Read-only payment watcher: polls PUBLIC block explorers for incoming txs to an
 * order's assigned BTC/LTC/BCH/DOGE payout address.
 * Reused (admin-managed, static) addresses: an order may carry `chainBaseline` (explorer snapshot taken when the
 * order was created) — then only funds/txs ABOVE that snapshot count for the order. No keys, no provider automation.
 * Status: waiting ('čaká sa') | unconfirmed ('prijaté – nepotvrdené') | confirmed ('potvrdené').
 */
const LABELS = { waiting: 'čaká sa', unconfirmed: 'prijaté – nepotvrdené', confirmed: 'potvrdené', unsupported: 'nesledované', error: 'chyba overenia' };
const COINS = ['btc', 'ltc', 'bch', 'doge'];
const TTL_MS = 25000;           // per-address cache
const LOOP_MS = 30000;          // background sweep
const MAX_AGE_MS = 3 * 864e5;   // watch orders up to 3 days old
const backoff = {};             // host -> { until, delay }
const cache = new Map();        // coin:address -> result
const listeners = new Map();    // orderId -> Set(fn)

function hostOf(u) { try { return new URL(u).host; } catch { return u; } }

async function getJson(url) {
  const h = hostOf(url);
  const b = backoff[h];
  if (b && Date.now() < b.until) { const e = new Error(`backoff ${h}`); e.backoff = true; throw e; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'chain2pay-checkout-watcher/1.0', Accept: 'application/json' } });
    if (r.status === 429 || r.status >= 500) {
      const ra = Number(r.headers.get('retry-after'));
      const delay = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : ((b && b.delay) || 15000) * 2, 10 * 60000);
      backoff[h] = { until: Date.now() + delay, delay };
      throw new Error(`${h} HTTP ${r.status}`);
    }
    if (!r.ok) throw new Error(`${h} HTTP ${r.status}`);
    delete backoff[h];
    return await r.json();
  } finally { clearTimeout(t); }
}

// mempool.space-compatible (BTC: mempool.space, LTC: litecoinspace.org)
async function esplora(base, address) {
  const a = await getJson(`${base}/address/${encodeURIComponent(address)}`);
  const conf = a.chain_stats.funded_txo_sum;
  const unconf = a.mempool_stats.funded_txo_sum;
  let txs = [];
  if (a.chain_stats.tx_count + a.mempool_stats.tx_count > 0) {
    try {
      const list = await getJson(`${base}/address/${encodeURIComponent(address)}/txs`);
      txs = list.slice(0, 10).map((t) => ({
        txid: t.txid,
        confirmed: !!(t.status && t.status.confirmed),
        blockTime: t.status && t.status.block_time ? new Date(t.status.block_time * 1000).toISOString() : null,
        valueSat: (t.vout || []).filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0),
      })).filter((t) => t.valueSat > 0);
    } catch { /* summary is enough */ }
  }
  return { confirmedSat: conf, unconfirmedSat: unconf, txCount: a.chain_stats.tx_count + a.mempool_stats.tx_count, txs, source: hostOf(base) };
}

async function blockchair(chain, address) {
  const j = await getJson(`https://api.blockchair.com/${chain}/dashboards/address/${encodeURIComponent(address)}?limit=10`);
  const key = Object.keys(j.data || {})[0];
  const d = key && j.data[key];
  if (!d) throw new Error('blockchair: no data');
  const a = d.address || {};
  const utx = (d.utxo || []);
  const unconfSat = utx.filter((u) => u.block_id === -1).reduce((s, u) => s + u.value, 0);
  const received = Number(a.received || 0);
  return {
    confirmedSat: Math.max(0, received - unconfSat),
    unconfirmedSat: unconfSat,
    txCount: Number(a.transaction_count || 0),
    txs: (d.transactions || []).slice(0, 10).map((txid) => ({ txid, confirmed: !utx.some((u) => u.transaction_hash === txid && u.block_id === -1) })),
    source: 'blockchair.com',
  };
}

async function blockcypher(coin, address) {
  const j = await getJson(`https://api.blockcypher.com/v1/${coin}/main/addrs/${encodeURIComponent(address)}?limit=5`);
  const conf = Number(j.balance || 0);
  const unconf = Number(j.unconfirmed_balance || 0);
  const txs = (j.txrefs || []).slice(0, 10).map((t) => ({ txid: t.tx_hash, confirmed: t.confirmations > 0, valueSat: t.value }));
  return { confirmedSat: conf, unconfirmedSat: Math.max(0, unconf), txCount: Number(j.n_tx || txs.length), txs, source: 'blockcypher.com' };
}

async function fullstackBch(address) {
  const cash = address.includes(':') ? address : `bitcoincash:${address}`;
  const bare = cash.replace(/^bitcoincash:/, '');
  // Try Electrumx balance first (lighter than tx list)
  try {
    const bal = await getJson(`https://api.fullstack.cash/v5/electrumx/balance/${encodeURIComponent(cash)}`);
    const conf = Number(bal.balance || bal.confirmed || 0);
    const unconf = Number(bal.unconfirmed || bal.unconfirmedBalance || 0);
    if (conf || unconf || bal.success !== false) {
      return { confirmedSat: conf, unconfirmedSat: Math.max(0, unconf), txCount: conf || unconf ? 1 : 0, txs: [], source: 'fullstack.cash' };
    }
  } catch { /* fall through */ }
  const j = await getJson(`https://api.fullstack.cash/v5/electrumx/transactions/${encodeURIComponent(cash)}`);
  const txs = (j.transactions || []).map((t) => ({ txid: t.tx_hash, confirmed: t.height > 0 }));
  const anyConf = txs.some((t) => t.confirmed);
  return { confirmedSat: anyConf ? 1 : 0, unconfirmedSat: txs.some((t) => !t.confirmed) ? 1 : 0, txCount: txs.length, txs: txs.slice(0, 10), source: 'fullstack.cash', amountsUnknown: true };
}

async function bchCom(address) {
  const bare = String(address).replace(/^bitcoincash:/i, '');
  const j = await getJson(`https://bch-chain.api.btc.com/v3/address/${encodeURIComponent(bare)}`);
  const d = j.data || j;
  const received = Number(d.received || 0);
  const unconf = Number(d.unconfirmed_received || 0);
  return {
    confirmedSat: Math.max(0, received - unconf),
    unconfirmedSat: unconf,
    txCount: Number(d.tx_count || 0),
    txs: [],
    source: 'bch-chain.api.btc.com',
  };
}

const BACKENDS = {
  btc: [(a) => esplora('https://mempool.space/api', a), (a) => blockchair('bitcoin', a)],
  ltc: [(a) => esplora('https://litecoinspace.org/api', a), (a) => blockcypher('ltc', a), (a) => blockchair('litecoin', a)],
  bch: [(a) => fullstackBch(a), (a) => bchCom(a), (a) => blockchair('bitcoin-cash', a)],
  doge: [(a) => blockcypher('doge', a), (a) => blockchair('dogecoin', a)],
};

function classify(r) {
  if (r.unconfirmedSat > 0 || r.txs.some((t) => !t.confirmed)) return 'unconfirmed';
  if (r.confirmedSat > 0 || r.txs.some((t) => t.confirmed)) return 'confirmed';
  return 'waiting';
}

async function checkAddress(coin, address, { force = false } = {}) {
  coin = String(coin || '').toLowerCase();
  if (!COINS.includes(coin) || !address) return { status: 'unsupported', label: LABELS.unsupported, coin, address: address || null };
  const k = `${coin}:${address}`;
  const c = cache.get(k);
  if (!force && c && Date.now() - c._t < TTL_MS) return c;
  const errors = [];
  for (const fn of BACKENDS[coin]) {
    try {
      const r = await fn(address);
      const status = classify(r);
      const out = { coin, address, status, label: LABELS[status], ...r, checkedAt: new Date().toISOString(), _t: Date.now() };
      cache.set(k, out);
      return out;
    } catch (e) { errors.push(e.message); }
  }
  if (c) return { ...c, stale: true, errors };
  return { coin, address, status: 'error', label: LABELS.error, errors, checkedAt: new Date().toISOString() };
}

function publicView(order, r) {
  const { _t, ...rest } = r;
  return { orderId: order.orderId, ...rest };
}

/** Snapshot used as baseline for a reused address (null when no explorer answered). */
async function baseline(coin, address) {
  const r = await checkAddress(coin, address, { force: true });
  if (!r || r.status === 'error' || r.status === 'unsupported' || r.stale) return null;
  return { source: r.source, confirmedSat: Number(r.confirmedSat || 0), unconfirmedSat: Number(r.unconfirmedSat || 0), txCount: Number(r.txCount || 0), amountsUnknown: !!r.amountsUnknown, at: r.checkedAt };
}

/** Status relative to a baseline: only new funds / new txs count. */
function relative(r, b) {
  if (!b || r.status === 'error' || r.status === 'unsupported') return r;
  const out = { ...r, txs: [], baselineAt: b.at };
  let status = 'waiting', newSat = null;
  // Prefer per-tx amounts when explorers provide them (filter to txs after baseline time when known).
  const baseMs = b.at ? Date.parse(b.at) : 0;
  const freshTxs = (r.txs || []).filter((t) => {
    if (!t || !t.txid) return false;
    if (t.blockTime && baseMs && Date.parse(t.blockTime) + 5000 < baseMs) return false;
    return Number(t.valueSat) > 0 || t.txid;
  });
  const valued = freshTxs.filter((t) => Number(t.valueSat) > 0);
  if (valued.length) {
    newSat = valued.reduce((s, t) => s + Number(t.valueSat), 0);
    status = valued.every((t) => t.confirmed) ? 'confirmed' : 'unconfirmed';
    out.txs = freshTxs;
  } else if (b.source === r.source && !b.amountsUnknown && !r.amountsUnknown) {
    const before = b.confirmedSat + b.unconfirmedSat;
    const total = Number(r.confirmedSat || 0) + Number(r.unconfirmedSat || 0) - before;
    if (total > 0) { newSat = total; status = Number(r.confirmedSat || 0) - before >= total ? 'confirmed' : 'unconfirmed'; }
    out.txs = freshTxs;
  } else if (Number(r.txCount || 0) > b.txCount) {
    status = Number(r.unconfirmedSat || 0) > 0 ? 'unconfirmed' : 'confirmed';
    out.txs = freshTxs;
  }
  out.status = status; out.label = LABELS[status]; out.newSat = newSat;
  return out;
}

async function statusForOrder(order, opts) {
  const r = await checkAddress(order.payoutCoin, order.payoutAddress, opts);
  if (order.chainBaselinePending && !order.chainBaseline) return publicView(order, { ...r, status: 'waiting', label: LABELS.waiting, txs: [] });
  return publicView(order, order.chainBaseline ? relative(r, order.chainBaseline) : r);
}

function subscribe(orderId, fn) {
  if (!listeners.has(orderId)) listeners.set(orderId, new Set());
  listeners.get(orderId).add(fn);
  return () => { const s = listeners.get(orderId); if (s) { s.delete(fn); if (!s.size) listeners.delete(orderId); } };
}

function start({ loadOrders, saveOrders, appendLog, onStatus }) {
  let running = false;
  const sweep = async () => {
    if (running) return; running = true;
    try {
      const orders = loadOrders();
      let dirty = false;
      for (const o of Object.values(orders)) {
        if (!COINS.includes(String(o.payoutCoin || '').toLowerCase()) || !o.payoutAddress) continue;
        if (o.chainStatus === 'confirmed') continue;
        const age = Date.now() - Date.parse(o.createdAt || 0);
        if (!(age < MAX_AGE_MS) && !listeners.has(o.orderId)) continue;
        if (o.chainBaselinePending && !o.chainBaseline) { // creation-time snapshot failed → take it now
          const b = await baseline(o.payoutCoin, o.payoutAddress).catch(() => null);
          if (b) { o.chainBaseline = b; o.chainBaselinePending = false; dirty = true; if (appendLog) appendLog(`CHAIN_BASELINE ${o.orderId} ${o.payoutCoin} late`); }
          continue;
        }
        const r = await statusForOrder(o);
        if (r.status !== 'error' && r.status !== o.chainStatus) {
          const prev = o.chainStatus;
          o.chainStatus = r.status; o.chainStatusAt = r.checkedAt; dirty = true;
          if (appendLog) appendLog(`CHAIN_STATUS ${o.orderId} ${o.payoutCoin} ${r.status}`);
          if (onStatus && r.status !== prev && (r.status === 'unconfirmed' || r.status === 'confirmed')) {
            try { onStatus(o, r.status, r); } catch {}
          }
        }
        const s = listeners.get(o.orderId);
        if (s) for (const fn of s) { try { fn(r); } catch {} }
        await new Promise((ok) => setTimeout(ok, 1200)); // spread requests
      }
      if (dirty) {
        // re-load to avoid clobbering concurrent writes
        const fresh = loadOrders();
        for (const o of Object.values(orders)) {
          const f = fresh[o.orderId]; if (!f) continue;
          if (o.chainStatus) { f.chainStatus = o.chainStatus; f.chainStatusAt = o.chainStatusAt; }
          if (o.chainBaseline && !f.chainBaseline) { f.chainBaseline = o.chainBaseline; f.chainBaselinePending = false; }
        }
        saveOrders(fresh);
      }
    } catch (e) { if (appendLog) appendLog(`CHAIN_WATCH_ERR ${e.message}`); }
    finally { running = false; }
  };
  if (String(process.env.CHAIN_WATCHER || '1') !== '0') {
    setTimeout(sweep, 5000);
    setInterval(sweep, LOOP_MS).unref();
  }
  return { sweep };
}

module.exports = { checkAddress, statusForOrder, baseline, relative, subscribe, start, LABELS, COINS };
