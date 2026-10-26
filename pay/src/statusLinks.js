'use strict';
// Private customer status links: /status/<128-bit hex token>. No personal data is shown.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const orderDb = require('./db');
const i18n = require('./i18n');

const FILE = path.join(__dirname, '..', 'data', 'status-links.json');
const TOKEN_RE = /^[a-f0-9]{32}$/;
const byToken = new Map();
const byRef = new Map();
let log = () => {};

function remember(r) { byToken.set(r.token, r); byRef.set(r.ref, r); }
function persistLocal() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify([...byToken.values()])); } catch { /* read-only fs */ } }
async function persist(r) {
  persistLocal();
  const pool = orderDb.pool();
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO status_links (token, ref, data) VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (token) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [r.token, r.ref, JSON.stringify(r)]);
  } catch (e) { log('STATUS_SAVE_FAIL ' + e.message); }
}

async function init(appendLog) {
  if (appendLog) log = appendLog;
  try { for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) remember(r); } catch { /* none */ }
  const pool = orderDb.pool();
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS status_links (token text PRIMARY KEY, ref text NOT NULL, data jsonb NOT NULL,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  await pool.query('CREATE INDEX IF NOT EXISTS status_links_ref ON status_links (ref)');
  const { rows } = await pool.query('SELECT data FROM status_links');
  rows.forEach((x) => remember(x.data));
  log(`STATUS_LINKS_READY ${rows.length}`);
}

function create(ref, kind, extra = {}) {
  const ex = byRef.get(ref);
  if (ex) return ex;
  const r = { token: crypto.randomBytes(16).toString('hex'), ref, kind, createdAt: new Date().toISOString(), decision: null, ...extra };
  remember(r); persist(r);
  return r;
}
/** Called from saveOrders for every order: attaches a status token once. */
function ensureOrder(order) {
  if (!order || !order.orderId) return null;
  if (order.statusToken && byToken.has(order.statusToken)) return order.statusToken;
  const r = create(order.orderId, 'order', { createdAt: order.createdAt || new Date().toISOString() });
  order.statusToken = r.token;
  return r.token;
}
function forRef(ref) { return byRef.get(ref) || null; }
function update(ref, patch) {
  const r = byRef.get(ref);
  if (!r) return null;
  Object.assign(r, patch, { updatedAt: new Date().toISOString() });
  persist(r);
  return r;
}
async function getByToken(token) {
  if (!TOKEN_RE.test(token)) return null;
  const pool = orderDb.pool();
  if (pool) {
    try { const { rows } = await pool.query('SELECT data FROM status_links WHERE token=$1', [token]); if (rows[0]) { remember(rows[0].data); return rows[0].data; } } catch { /* fall back to memory */ }
  }
  return byToken.get(token) || null;
}

const CONFIRMED = new Set(['confirmed', 'paid', 'completed', 'settled', 'complete', 'success']);
const REJECTED = new Set(['rejected', 'cancelled', 'canceled', 'failed', 'expired']);
function stateOf(rec, order) {
  if (rec.decision === 'confirmed') return 'confirmed';
  if (rec.decision === 'rejected') return 'rejected';
  if (order) {
    const st = String(order.status || '').toLowerCase();
    if (st === 'partial' || st === 'received_check') return 'proof';
    if (CONFIRMED.has(st) || order.chainStatus === 'confirmed') return 'confirmed';
    if (REJECTED.has(st)) return 'rejected';
    if (order.proofSubmittedAt || st === 'paid_marked' || st === 'screenshot_uploaded') return 'proof';
  }
  if (rec.proofAt) return 'proof';
  return 'pending';
}
const LABEL = { pending: 'Čaká na platbu', proof: 'Doklad prijatý', confirmed: 'Potvrdené', rejected: 'Zamietnuté' };
const AZ = { new: 'Spracúva sa', awaiting_redeem: 'Uplatňuje sa – čakáme na prijatie BTC', received: 'BTC prijaté, čaká na potvrdenie siete', confirmed: 'Uplatnené ✅', btcpay_down: 'Dočasná chyba – riešime ručne', duplicate: 'Kód už bol odoslaný', timeout: 'Neprijaté – kontaktujeme vás' };
const COLOR = { pending: '#fbbf24', proof: '#60a5fa', confirmed: '#22c55e', rejected: '#f87171' };
const METHOD = { bank_sepa_manual: 'SEPA prevod', revolut_manual: 'Revolut', paysafecard: 'PaysafeCard' };
const methodName = (m) => METHOD[m] || String(m || '—').replace(/^g2a_/, 'G2A ').replace(/_/g, ' ');
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso, lang) => { try { return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'sk-SK', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' }) + ' (CET/CEST)'; } catch { return '—'; } };

function publicBase(req) {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
function statusPath(token) { return `/status/${token}`; }
function linkBox(url, lang) {
  return `<div class="c2p-status-link" style="margin:16px auto;max-width:640px;padding:12px 14px;border:1px solid #334155;border-radius:12px;background:#0f172a;color:#e2e8f0;font:14px system-ui">` +
    `${esc(i18n.t(lang, 'Uložte si tento súkromný odkaz – stav platby uvidíte kedykoľvek:'))}<br><a href="${esc(url)}" style="color:#93c5fd;word-break:break-all">${esc(url)}</a></div>`;
}

function register(app, { loadOrders }) {
  app.get('/status/:token', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    const lang = req.lang || 'sk';
    const rec = await getByToken(String(req.params.token || ''));
    if (!rec) return res.status(404).type('html').send(`<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex"/><title>Nenájdené</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body style="font-family:system-ui;background:#0b1220;color:#e8eef9;padding:2rem"><h1>Nenájdené</h1><p>Odkaz neexistuje alebo vypršal.</p></body></html>`);
    const order = rec.kind === 'order' ? loadOrders()[rec.ref] : null;
    const st = stateOf(rec, order);
    const amount = order ? (order.amountExact || order.amountEur) : rec.amount;
    const method = order ? (order.provider || order.gateway) : rec.method;
    const created = (order && order.createdAt) || rec.createdAt;
    const final = st === 'confirmed' || st === 'rejected';
    res.type('html').send(`<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>${final ? '' : '<meta http-equiv="refresh" content="20"/>'}<title>Stav objednávky</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eef9;margin:0;padding:24px 14px}.st{max-width:520px;margin:0 auto;background:#121a2b;border:1px solid #243044;border-radius:16px;padding:22px}
.badge{display:inline-block;padding:8px 14px;border-radius:999px;font-weight:800;font-size:1.15rem;color:#0b1220;background:${COLOR[st]}}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin:18px 0 6px}dt{color:#93a0b8}dd{margin:0;font-weight:600;min-width:0;overflow-wrap:anywhere}.hint{color:#93a0b8;font-size:.85rem}
.steps{display:flex;gap:6px;margin-top:16px}.steps span{flex:1;height:6px;border-radius:3px;background:#243044}.steps span.on{background:${COLOR[st]}}</style></head>
<body><div class="st"><h1 style="margin-top:0">Stav objednávky</h1><div class="badge">${esc(LABEL[st])}</div>
<div class="steps"><span class="on"></span><span class="${st !== 'pending' ? 'on' : ''}"></span><span class="${final ? 'on' : ''}"></span></div>
<dl><dt>Suma</dt><dd>${amount ? esc(amount) + ' EUR' : '—'}</dd><dt>Metóda</dt><dd>${esc(methodName(method))}</dd><dt>Vytvorené</dt><dd>${esc(fmt(created, lang))}</dd>${rec.azteco ? `<dt>Azteco</dt><dd>${esc(AZ[rec.azteco] || rec.azteco)}</dd>` : ''}${rec.decidedAt ? `<dt>Aktualizované</dt><dd>${esc(fmt(rec.decidedAt, lang))}</dd>` : ''}</dl>
${final ? '' : '<p class="hint">Stránka sa obnovuje automaticky.</p>'}</div></body></html>`);
  });
}

/** Adds a status link box to HTML confirmation pages that carry ?orderId= / /order/:id, and statusUrl to JSON. */
function injector({ loadOrders }) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') return next();
    const send = res.send.bind(res);
    res.send = (body) => {
      try {
        if (req.method === 'GET' && typeof body === 'string' && /<\/body>/i.test(body) && !req.path.startsWith('/admin') && !req.path.startsWith('/status/') && !/c2p-status-link/.test(body)) {
          const m = req.path.match(/^\/order\/([^/]+)$/);
          const oid = String((req.query && req.query.orderId) || (m && decodeURIComponent(m[1])) || '').trim();
          const o = oid && loadOrders()[oid];
          if (o && o.statusToken) body = body.replace(/<\/body>/i, linkBox(publicBase(req) + statusPath(o.statusToken), req.lang) + '</body>');
        }
      } catch { /* never break pages */ }
      return send(body);
    };
    const json = res.json.bind(res);
    res.json = (obj) => {
      try {
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && req.method === 'POST' && obj.orderId && !obj.statusUrl && req.path.startsWith('/api/') && !req.path.startsWith('/api/admin')) {
          const o = loadOrders()[obj.orderId];
          if (o && o.statusToken) obj = { ...obj, statusUrl: publicBase(req) + statusPath(o.statusToken) };
        }
      } catch { /* ignore */ }
      return json(obj);
    };
    next();
  };
}

module.exports = { init, register, injector, ensureOrder, create, forRef, update, getByToken, stateOf, statusPath, publicBase, LABEL, methodName };
