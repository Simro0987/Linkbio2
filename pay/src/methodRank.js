'use strict';
/**
 * Payment-method popularity (Ryan): order the checkout methods by what customers actually use.
 * Data: orders in Neon (last DAYS days; paid/confirmed weigh more than just started) + anonymous
 * per-method click counters (table method_clicks: day, method, n — no IP, no personal data).
 * Recomputed hourly (cached); admin settings (auto/manual, pins, manual group order) live in payMethods.
 * Methods with little data fall back to a sensible SK/CZ default (Revolut, card / Apple / Google Pay, SEPA, crypto, gift cards…).
 */
const fs = require('fs');
const path = require('path');

const DAYS = 90;
const MIN_SCORE = 3; // below this a method counts as "little data" → default order decides
const W = { started: 1, proof: 3, paid: 6, click: 0.2 };
const DEFAULT_GROUPS = ['revolut', 'cards', 'wallets', 'sepa', 'changelly', 'crypto_direct', 'skrill', 'paysafecard', 'g2a_amazon', 'g2a_azteco', 'vouchers',
  'mtpelerin', 'keyless', 'meld', 'onramps', 'crypto_btcpay', 'paypal'];
const PAID = new Set(['confirmed', 'paid', 'completed', 'settled', 'complete', 'success', 'finished', 'done']);
const PROOF = new Set(['paid_marked', 'screenshot_uploaded', 'awaiting_confirm', 'received', 'awaiting_redeem']);
const ID_RE = /^[a-z0-9_]{2,60}$/;
const FILE = path.join(__dirname, '..', 'data', 'method-clicks.json');

let log = () => {};
let poolFn = () => null;
let loadOrdersFn = () => ({});
let stats = { at: null, days: DAYS, byMethod: {}, orders: 0, source: 'none' };
let known = new Set();
const pending = new Map(); // "YYYY-MM-DD|id" -> n (not yet flushed)
const seenClick = new Map(); // ip|id -> ts (memory only, never stored)
const ipHits = new Map();
let fileClicks = {}; // local fallback: { "day|id": n }
let tableReady = null;

function methodOf(o) {
  if (!o) return null;
  if (o.methodId && ID_RE.test(String(o.methodId))) return String(o.methodId);
  const a = String(o.providerAlias || '').toLowerCase();
  if (ID_RE.test(a)) return a;
  const p = String(o.provider || o.gateway || '').toLowerCase();
  if (p === 'switchere') return ({ sepa: 'switchere_bank', bank: 'switchere_bank', skrill: 'switchere_skrill' })[o.payinGroup] || 'switchere';
  return ID_RE.test(p) ? p : null;
}
function levelOf(o) {
  const st = String(o.status || '').toLowerCase();
  if (st === 'partial' || st === 'received_check') return 'proof';
  if (PAID.has(st) || o.chainStatus === 'confirmed' || o.confirmedAt) return 'paid';
  if (PROOF.has(st) || o.proofSubmittedAt || o.paidMarkedAt || o.chainStatus === 'unconfirmed') return 'proof';
  return 'started';
}
const isTest = (o) => !!(o.test || o.demo || o.smoke) || /@(example\.|test\.|local$)/i.test(String(o.email || ''));

async function table() {
  const p = poolFn(); if (!p) return null;
  if (!tableReady) {
    tableReady = p.query('CREATE TABLE IF NOT EXISTS method_clicks (day date NOT NULL, method text NOT NULL, n integer NOT NULL DEFAULT 0, PRIMARY KEY (day, method))')
      .catch((x) => { tableReady = null; throw x; });
  }
  await tableReady; return p;
}

async function readOrders() {
  const p = poolFn();
  const since = Date.now() - DAYS * 864e5;
  if (p) {
    const { rows } = await p.query(`SELECT data FROM orders WHERE created_at > now() - interval '${DAYS} days'`);
    return { list: rows.map((r) => r.data), source: 'neon' };
  }
  const all = Object.values(loadOrdersFn() || {});
  return { list: all.filter((o) => { const t = Date.parse(o.createdAt || ''); return !t || t > since; }), source: 'local' };
}
async function readClicks() {
  const out = {};
  const p = await table().catch((x) => { log('METHOD_CLICKS_DB_FAIL ' + x.message); return null; });
  if (p) {
    const { rows } = await p.query(`SELECT method, sum(n)::int n FROM method_clicks WHERE day > current_date - ${DAYS} GROUP BY method`);
    rows.forEach((r) => { out[r.method] = r.n; });
  } else {
    const cut = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
    for (const [k, n] of Object.entries(fileClicks)) { const [d, id] = k.split('|'); if (d > cut) out[id] = (out[id] || 0) + n; }
  }
  for (const [k, n] of pending) { const id = k.split('|')[1]; out[id] = (out[id] || 0) + n; }
  return out;
}

async function recompute() {
  try {
    const [{ list, source }, clicks] = await Promise.all([readOrders(), readClicks()]);
    const by = {};
    const get = (id) => (by[id] = by[id] || { orders: 0, proof: 0, paid: 0, clicks: 0, score: 0 });
    let n = 0;
    for (const o of list) {
      if (!o || isTest(o)) continue;
      const id = methodOf(o); if (!id) continue;
      const s = get(id); const lv = levelOf(o); n++;
      s.orders++; if (lv === 'proof') s.proof++; if (lv === 'paid') s.paid++;
      s.score += W[lv];
    }
    for (const [id, c] of Object.entries(clicks)) { const s = get(id); s.clicks = c; s.score += c * W.click; }
    for (const s of Object.values(by)) s.score = Math.round(s.score * 10) / 10;
    stats = { at: new Date().toISOString(), days: DAYS, byMethod: by, orders: n, source };
    log(`METHOD_RANK_COMPUTED orders=${n} methods=${Object.keys(by).length} source=${source}`);
  } catch (x) { log('METHOD_RANK_FAIL ' + x.message); }
  return stats;
}

async function flush() {
  if (!pending.size) return;
  const items = [...pending]; pending.clear();
  const p = await table().catch(() => null);
  if (p) {
    for (const [k, n] of items) {
      const [day, id] = k.split('|');
      try { await p.query('INSERT INTO method_clicks (day, method, n) VALUES ($1,$2,$3) ON CONFLICT (day, method) DO UPDATE SET n = method_clicks.n + EXCLUDED.n', [day, id, n]); }
      catch (x) { pending.set(k, (pending.get(k) || 0) + n); log('METHOD_CLICKS_SAVE_FAIL ' + x.message); }
    }
  } else {
    for (const [k, n] of items) fileClicks[k] = (fileClicks[k] || 0) + n;
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(fileClicks)); } catch { /* read-only fs */ }
  }
}

/** Anonymous click: counted once per visitor+method per 30 min, max 60/h per visitor (IP kept only in memory). */
function click(id, ip) {
  id = String(id || '').toLowerCase();
  if (!ID_RE.test(id) || !known.has(id)) return false;
  const now = Date.now(); ip = String(ip || '');
  const h = (ipHits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (h.length >= 60) return false;
  const k = ip + '|' + id;
  if (now - (seenClick.get(k) || 0) < 1800e3) return false;
  h.push(now); ipHits.set(ip, h); seenClick.set(k, now);
  if (seenClick.size > 20000) for (const [kk, t] of seenClick) if (now - t > 1800e3) seenClick.delete(kk);
  if (ipHits.size > 20000) for (const [kk, v] of ipHits) if (!v.some((t) => now - t < 3600e3)) ipHits.delete(kk);
  const key = new Date().toISOString().slice(0, 10) + '|' + id;
  pending.set(key, (pending.get(key) || 0) + 1);
  return true;
}

const scoreOf = (id) => ((stats.byMethod[id] || {}).score || 0);
const eff = (id) => { const s = scoreOf(id); return s >= MIN_SCORE ? s : 0; };

/**
 * Sort groups[*].providers in place and return { groupOrder, methodOrder }.
 * settings: { auto (default true), pins: [ids], groupOrder: [keys] (manual mode) }.
 */
function order(groups, settings) {
  const st = settings || {};
  const auto = st.auto !== false;
  const pins = (st.pins || []).map(String);
  const pinIdx = (id) => { const i = pins.indexOf(id); return i < 0 ? 1e6 : i; };
  const keys = Object.keys(groups || {});
  const ids = new Set();
  for (const k of keys) {
    const g = groups[k];
    for (const it of [...(g.providers || []), ...(g.soon || [])]) ids.add(String(it.id));
    g.providers = (g.providers || []).map((x, i) => [x, i]).sort((a, b) => pinIdx(a[0].id) - pinIdx(b[0].id)
      || (auto ? eff(b[0].id) - eff(a[0].id) : 0) || a[1] - b[1]).map((x) => x[0]);
  }
  known = ids;
  const base = auto ? DEFAULT_GROUPS : (Array.isArray(st.groupOrder) && st.groupOrder.length ? st.groupOrder : DEFAULT_GROUPS);
  const baseIdx = (k) => { const i = base.indexOf(k); return i < 0 ? 500 + keys.indexOf(k) : i; };
  const gPin = (k) => Math.min(1e6, ...(groups[k].providers || []).map((p) => pinIdx(p.id)));
  const gEff = (k) => (groups[k].providers || []).reduce((s, p) => s + eff(p.id), 0);
  const groupOrder = keys.slice().sort((a, b) => gPin(a) - gPin(b) || (auto ? gEff(b) - gEff(a) : 0) || baseIdx(a) - baseIdx(b));
  const methodOrder = [];
  for (const k of groupOrder) for (const p of groups[k].providers || []) methodOrder.push(p.id);
  return { mode: auto ? 'auto' : 'manual', groupOrder, methodOrder, pins: pins.filter((p) => ids.has(p)) };
}

function init({ appendLog, pool, loadOrders }) {
  if (appendLog) log = appendLog;
  if (pool) poolFn = pool;
  if (loadOrders) loadOrdersFn = loadOrders;
  try { fileClicks = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { fileClicks = {}; }
  recompute();
  setInterval(() => { flush().catch(() => {}); }, 60e3).unref();
  setInterval(() => { flush().then(recompute).catch(() => {}); }, 3600e3).unref();
}

function mountPublic(app) {
  const express = require('express');
  // sendBeacon posts text/plain (CORS-safelisted); body is just {"id":"<method>"}
  app.post('/api/m/click', express.text({ type: () => true, limit: '1kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    let id = null;
    try { const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}; id = b && b.id; } catch { id = null; }
    click(id, req.ip);
    res.status(204).end();
  });
}

module.exports = { init, mountPublic, order, recompute, flush, click, methodOf, levelOf, stats: () => stats, DEFAULT_GROUPS, MIN_SCORE, DAYS, W };
