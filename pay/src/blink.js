'use strict';
/**
 * ⚡ „Bitcoin Lightning (Blink)“ – exact-amount Lightning invoice per order via Blink's official GraphQL API (https://dev.blink.sv).
 * - No API key needed: the public mutation lnInvoiceCreateOnBehalfOfRecipient creates an invoice for the BTC wallet of the configured
 *   Blink username (wallet id from the public query accountDefaultWallet). An optional Blink API key (admin, AES-256-GCM at rest,
 *   never logged / never shown) is used only as a fallback (lnInvoiceCreate on the key's own BTC wallet).
 * - Blink has no EUR-denominated invoice → EUR is converted to sats server-side with a multi-source BTC/EUR price
 *   (Blink realtimePrice, CoinGecko, Kraken, Binance, Coinbase; median, outliers dropped).
 * - The amount always comes from the stored order (never from the client). Memo = „Objednávka ord_…“.
 * - Payment status: public lnInvoicePaymentStatusByPaymentRequest, polled in the background (PAY_MODULE=on) and on the customer's
 *   status requests; PAID → order.status='paid' + Telegram message to Ryan. Expired invoices are renewed on request (rate limited).
 * - Off by default (payMethods DEFAULT_OFF) and hidden until a Blink username is configured.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const orderDb = require('./db');

const GATEWAY = 'blink_ln';
const API = () => String(process.env.BLINK_API_URL || 'https://api.blink.sv/graphql');
const EXPIRES_MIN = 15;              // invoice lifetime (minutes)
const MAX_INVOICES = 30;             // per order (renewals)
const WATCH_MS = 10e3;               // background poll interval
const WATCH_WINDOW_MS = 26 * 3600e3; // stop polling old orders
const USERNAME_RE = /^[a-zA-Z0-9_]{3,50}$/;
const LNADDR_RE = /^[a-z0-9._-]{1,64}@[a-z0-9.-]{3,190}\.[a-z]{2,}$/i;
const ID_RE = /^ord_[a-f0-9]{16}$/;
const DATA_FILE = path.join(__dirname, '..', 'data', 'blink-config.json');

let log = () => {};
/* ---------- config (username, displayed Lightning address, encrypted API key) ---------- */
let CFG = { username: '', lnAddress: '', walletId: '', keyEnc: '', updatedAt: null };
let tableReady = null;
async function table() {
  const p = orderDb.pool(); if (!p) return null;
  if (!tableReady) tableReady = p.query(`CREATE TABLE IF NOT EXISTS blink_config (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`).catch((x) => { tableReady = null; throw x; });
  await tableReady; return p;
}
async function loadConfig() {
  try { const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (j && typeof j === 'object') CFG = { ...CFG, ...j }; } catch { /* none */ }
  try {
    const p = await table();
    if (p) { const r = await p.query(`SELECT data FROM blink_config WHERE id='main'`); if (r.rows[0]) CFG = { ...CFG, ...r.rows[0].data }; }
  } catch (x) { log('BLINK_CONFIG_DB_FAIL ' + x.message); }
  return CFG;
}
async function saveConfig(next) {
  CFG = { ...CFG, ...next, updatedAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(CFG)); } catch { /* read-only fs */ }
  const p = await table().catch(() => null);
  if (p) await p.query(`INSERT INTO blink_config (id, data) VALUES ('main',$1::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [JSON.stringify(CFG)]);
  return CFG;
}
// API key at rest: AES-256-GCM, key derived from DATA_ENC_KEY (lnkbio) or BACKUP_ENC_KEY (pay module)
function encKey() {
  const k = [process.env.DATA_ENC_KEY, process.env.BACKUP_ENC_KEY].map((v) => String(v || '').trim()).find((v) => /^[0-9a-f]{64}$/i.test(v));
  return k ? crypto.createHmac('sha256', Buffer.from(k, 'hex')).update('blink-api-key-v1').digest() : null;
}
function sealKey(plain) {
  const k = encKey(); if (!k) throw new Error('Chýba DATA_ENC_KEY – API kľúč nie je možné bezpečne uložiť.');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv); c.setAAD(Buffer.from('blink-key'));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function openKey() {
  if (!CFG.keyEnc) return '';
  try {
    const k = encKey(); if (!k) return '';
    const b = Buffer.from(CFG.keyEnc, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAAD(Buffer.from('blink-key')); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const hasKey = () => !!CFG.keyEnc;
const defaultLnAddress = (u) => (u ? `${String(u).toLowerCase()}@blink.sv` : '');
const lnAddress = () => CFG.lnAddress || defaultLnAddress(CFG.username);
/** Customer-visible: method shown only when a Blink wallet is resolvable (username → wallet id, or API key). */
function configured() { return !!(CFG.walletId || hasKey()); }
function status() { return { configured: configured(), hint: configured() ? 'Blink · Lightning faktúra na presnú sumu' : 'nastavte Blink používateľské meno v admine (Platobné metódy → Blink)' }; }
/** Admin view – never contains the key itself. */
function adminView() {
  return { username: CFG.username || '', lnAddress: CFG.lnAddress || '', lnAddressEffective: lnAddress(), lnAddressDefault: defaultLnAddress(CFG.username),
    walletOk: !!CFG.walletId, key: hasKey() ? '(uložený)' : '(nenastavený)', keySet: hasKey(), configured: configured(), updatedAt: CFG.updatedAt || null,
    encAvailable: !!encKey() };
}

/* ---------- Blink GraphQL ---------- */
async function gql(query, variables, { apiKey, timeoutMs = 12000, fetchImpl } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) headers['X-API-KEY'] = apiKey;
  const r = await (fetchImpl || fetch)(API(), { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('Blink API: neplatná odpoveď (HTTP ' + r.status + ')');
  if (j.errors && j.errors.length) throw new Error('Blink API: ' + String(j.errors[0].message || 'chyba').slice(0, 200));
  return j.data || {};
}
const Q_WALLET = `query($u:Username!){accountDefaultWallet(username:$u, walletCurrency: BTC){id walletCurrency}}`;
const Q_ME = `query{me{defaultAccount{wallets{id walletCurrency}}}}`;
const M_ONBEHALF = `mutation($i:LnInvoiceCreateOnBehalfOfRecipientInput!){lnInvoiceCreateOnBehalfOfRecipient(input:$i){errors{message} invoice{paymentRequest paymentHash satoshis}}}`;
const M_CREATE = `mutation($i:LnInvoiceCreateInput!){lnInvoiceCreate(input:$i){errors{message} invoice{paymentRequest paymentHash satoshis}}}`;
const Q_STATUS = `query($i:LnInvoicePaymentStatusByPaymentRequestInput!){lnInvoicePaymentStatusByPaymentRequest(input:$i){status}}`;

async function walletForUsername(username, opts) {
  const d = await gql(Q_WALLET, { u: username }, opts);
  const w = d.accountDefaultWallet;
  if (!w || !w.id || w.walletCurrency !== 'BTC') throw new Error('Blink účet nemá BTC peňaženku.');
  return w.id;
}
async function walletForKey(apiKey, opts) {
  const d = await gql(Q_ME, {}, { ...opts, apiKey });
  const ws = (((d.me || {}).defaultAccount || {}).wallets || []).filter((w) => w.walletCurrency === 'BTC');
  if (!ws.length) throw new Error('API kľúč nemá prístup k BTC peňaženke (potrebné oprávnenia Read + Receive).');
  return ws[0].id;
}
async function createInvoice({ sats, memo }, opts = {}) {
  const amount = Math.round(Number(sats));
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Neplatná suma v sats');
  const pick = (p) => {
    if (!p) throw new Error('Blink API: prázdna odpoveď');
    if (p.errors && p.errors.length) throw new Error('Blink API: ' + String(p.errors[0].message || 'chyba').slice(0, 200));
    if (!p.invoice || !p.invoice.paymentRequest) throw new Error('Blink API: chýba faktúra');
    return { paymentRequest: p.invoice.paymentRequest, paymentHash: p.invoice.paymentHash, sats: Number(p.invoice.satoshis) || amount };
  };
  if (CFG.walletId) { // public route – no key
    const d = await gql(M_ONBEHALF, { i: { recipientWalletId: CFG.walletId, amount, memo, expiresIn: EXPIRES_MIN } }, opts);
    return { ...pick(d.lnInvoiceCreateOnBehalfOfRecipient), via: 'public' };
  }
  const key = openKey();
  if (!key) throw new Error('Blink nie je nastavený');
  const walletId = await walletForKey(key, opts);
  const d = await gql(M_CREATE, { i: { walletId, amount, memo, expiresIn: EXPIRES_MIN } }, { ...opts, apiKey: key });
  return { ...pick(d.lnInvoiceCreate), via: 'key' };
}
async function invoiceStatus(paymentRequest, opts) {
  const d = await gql(Q_STATUS, { i: { paymentRequest } }, opts);
  const s = String(((d.lnInvoicePaymentStatusByPaymentRequest || {}).status) || '').toUpperCase();
  return ['PAID', 'PENDING', 'EXPIRED'].includes(s) ? s : 'UNKNOWN';
}

/* ---------- EUR → sats (multi-source BTC/EUR) ---------- */
const PRICE_SOURCES = {
  blink: async (f) => { const d = await gql(`{realtimePrice(currency:"EUR"){btcSatPrice{base offset}}}`, {}, { fetchImpl: f, timeoutMs: 6000 }); const p = d.realtimePrice.btcSatPrice; return (p.base / 10 ** p.offset) * 1e8 / 100; },
  coingecko: async (f) => (await (await f('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur', { signal: AbortSignal.timeout(6000) })).json()).bitcoin.eur,
  kraken: async (f) => { const j = await (await f('https://api.kraken.com/0/public/Ticker?pair=XBTEUR', { signal: AbortSignal.timeout(6000) })).json(); return Number(Object.values(j.result)[0].c[0]); },
  binance: async (f) => Number((await (await f('https://api.binance.com/api/v3/ticker/price?symbol=BTCEUR', { signal: AbortSignal.timeout(6000) })).json()).price),
  coinbase: async (f) => Number((await (await f('https://api.coinbase.com/v2/prices/BTC-EUR/spot', { signal: AbortSignal.timeout(6000) })).json()).data.amount),
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** Robust BTC/EUR from {source: price}: drop invalid + >3 % outliers, need ≥2 agreeing sources (or Blink's own rate alone). */
function aggregatePrice(quotes) {
  const ok = Object.entries(quotes).filter(([, v]) => Number.isFinite(v) && v > 1000 && v < 1e8);
  if (!ok.length) throw new Error('Kurz BTC/EUR sa nepodarilo načítať.');
  const m0 = median(ok.map(([, v]) => v));
  const agree = ok.filter(([, v]) => Math.abs(v - m0) / m0 <= 0.03);
  if (agree.length < 2 && !(agree.length === 1 && agree[0][0] === 'blink')) throw new Error('Kurz BTC/EUR nie je spoľahlivý (málo zdrojov).');
  return { price: median(agree.map(([, v]) => v)), sources: agree.map(([k]) => k) };
}
let PRICE_CACHE = null;
async function btcEur({ fetchImpl } = {}) {
  if (!fetchImpl && PRICE_CACHE && Date.now() - PRICE_CACHE.t < 60e3) return PRICE_CACHE.v;
  const f = fetchImpl || fetch; const quotes = {};
  await Promise.all(Object.entries(PRICE_SOURCES).map(async ([k, fn]) => { try { quotes[k] = Number(await fn(f)); } catch { /* source down */ } }));
  const v = aggregatePrice(quotes);
  if (!fetchImpl) PRICE_CACHE = { t: Date.now(), v };
  return v;
}
/** EUR (2 dp, from the order) → whole sats, rounded up so the merchant never receives less than the order amount. */
function eurToSats(eur, priceEurPerBtc) {
  const cents = Math.round(Number(eur) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('Neplatná suma v EUR');
  if (!Number.isFinite(priceEurPerBtc) || priceEurPerBtc <= 0) throw new Error('Neplatný kurz');
  return Math.ceil((cents * 1e6) / priceEurPerBtc - 1e-9); // cents/100 * 1e8 / price
}
const fmtEur = (eur) => (Math.round(Number(eur) * 100) / 100).toFixed(2);

/* ---------- order state ---------- */
const current = (o) => (o.blink && o.blink.invoices && o.blink.invoices.length ? o.blink.invoices[o.blink.invoices.length - 1] : null);
/** Pure state transition for one invoice status; returns 'paid' when the order just became paid. */
function applyStatus(order, inv, st, now = Date.now()) {
  if (!inv) return null;
  if (st === 'PAID') {
    inv.status = 'PAID';
    if (order.status !== 'paid') {
      order.status = 'paid'; order.paidAt = new Date(now).toISOString(); order.paidVia = 'blink_ln';
      order.paidSats = inv.sats; order.blinkPaymentHash = inv.paymentHash || null;
      return 'paid';
    }
    return null;
  }
  if (st === 'EXPIRED' || (st === 'PENDING' && Date.parse(inv.expiresAt) + 120e3 < now)) inv.status = 'EXPIRED';
  else if (st === 'PENDING') inv.status = 'PENDING';
  return null;
}
/** Customer-facing status of an order. */
function publicState(o, now = Date.now()) {
  const inv = current(o);
  const paid = o.status === 'paid';
  const expired = !paid && (!inv || inv.status === 'EXPIRED' || Date.parse(inv.expiresAt) <= now);
  return { ok: true, status: paid ? 'paid' : expired ? 'expired' : 'pending', amountEur: fmtEur(o.amountEur), sats: inv ? inv.sats : null,
    paymentRequest: paid || !inv ? null : inv.paymentRequest, qrKey: inv ? String(inv.paymentHash || '').slice(0, 12) : '', expiresAt: inv ? inv.expiresAt : null, now: new Date(now).toISOString() };
}

async function tg(text) {
  try { const t = global.__telegramBot; const chat = t && t.loadAdminChatId && t.loadAdminChatId(); if (chat) await t.sendMessage(chat, text); } catch { /* best effort */ }
}
async function newInvoiceFor(order) {
  const px = await btcEur();
  const sats = eurToSats(order.amountEur, px.price);
  const inv = await createInvoice({ sats, memo: `Objednávka ${order.orderId}` });
  const now = Date.now();
  return { paymentRequest: inv.paymentRequest, paymentHash: inv.paymentHash, sats: inv.sats, rateEur: Math.round(px.price * 100) / 100, rateSources: px.sources,
    via: inv.via, status: 'PENDING', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + EXPIRES_MIN * 60e3 - 15e3).toISOString() };
}

/* ---------- rate limit ---------- */
const HITS = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const a = (HITS.get(key) || []).filter((t) => now - t < windowMs); a.push(now); HITS.set(key, a);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.length || now - v[v.length - 1] > windowMs) HITS.delete(k);
  return a.length > max;
}
const ipOf = (req) => String((req && req.ip) || '').slice(0, 64);

/** Called from handleCreateCheckout (amount already validated server-side). */
async function createOrder({ orderId, amountEur, countryCode, providerAlias, email, ip, loadOrders, saveOrders, appendLog }) {
  if (!configured()) { const e = new Error('Tento spôsob platby momentálne nie je dostupný. Vyberte iný.'); e.status = 400; throw e; }
  if (limited('create:' + (ip || '?'), 10, 10 * 60e3)) { const e = new Error('Príliš veľa pokusov. Skúste to o pár minút.'); e.status = 429; throw e; }
  const order = {
    orderId, amountEur: Number(fmtEur(amountEur)), amount: Number(fmtEur(amountEur)), currency: 'EUR', country: countryCode, email: email || undefined,
    provider: GATEWAY, providerAlias, gateway: GATEWAY, paymentMethod: 'lightning', resolution: 'blink_ln', status: 'awaiting_payment', createdAt: new Date().toISOString(),
  };
  order.blink = { invoices: [await newInvoiceFor(order)] };
  order.checkoutUrl = order.localPayUrl = `/blink-pay?orderId=${encodeURIComponent(orderId)}`;
  const orders = loadOrders(); orders[orderId] = order; saveOrders(orders);
  (appendLog || log)(`ORDER_CREATED ${orderId} eur=${order.amountEur} provider=blink_ln sats=${current(order).sats} via=${current(order).via}`);
  return order;
}

/* ---------- status checks ---------- */
const LAST_CHECK = new Map();
async function checkOrder(orderId, { loadOrders, saveOrders, appendLog }, force) {
  const now = Date.now();
  if (!force && now - (LAST_CHECK.get(orderId) || 0) < 3000) return null;
  LAST_CHECK.set(orderId, now);
  const o0 = loadOrders()[orderId];
  if (!o0 || o0.provider !== GATEWAY || o0.status === 'paid' || !o0.blink) return null;
  const results = [];
  for (const inv of o0.blink.invoices) {
    if (inv.status === 'PAID' || inv.status === 'EXPIRED') continue;
    try { results.push([inv.paymentHash, await invoiceStatus(inv.paymentRequest)]); } catch (x) { (appendLog || log)(`BLINK_STATUS_FAIL ${orderId} ${x.message}`); }
  }
  if (!results.length) return null;
  const orders = loadOrders(); const o = orders[orderId]; if (!o || !o.blink) return null;
  let became = null;
  for (const [hash, st] of results) { const inv = o.blink.invoices.find((x) => x.paymentHash === hash); const r = applyStatus(o, inv, st, now); if (r) became = r; }
  saveOrders(orders);
  if (became === 'paid') {
    (appendLog || log)(`BLINK_PAID ${orderId} eur=${o.amountEur} sats=${o.paidSats}`);
    tg(`⚡ Lightning platba (Blink) · zaplatené ✅\nObjednávka: ${o.orderId}\nSuma: ${fmtEur(o.amountEur)} EUR (${Number(o.paidSats).toLocaleString('sk-SK')} sats)\nPotvrdené automaticky (Blink API).`);
  }
  return became;
}
let timer = null;
function startWatcher(deps) {
  if (timer) return;
  let busy = false;
  timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const now = Date.now();
      const ids = Object.values(deps.loadOrders() || {}).filter((o) => o && o.provider === GATEWAY && o.status !== 'paid' && o.blink && now - Date.parse(o.createdAt) < WATCH_WINDOW_MS
        && o.blink.invoices.some((i) => i.status === 'PENDING' && Date.parse(i.expiresAt) + 180e3 > now)).map((o) => o.orderId);
      for (const id of ids.slice(0, 50)) await checkOrder(id, deps, true);
    } catch (x) { (deps.appendLog || log)('BLINK_WATCH_FAIL ' + x.message); } finally { busy = false; }
  }, WATCH_MS);
  if (timer.unref) timer.unref();
}

/* ---------- customer page ---------- */
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function page(o) {
  const s = publicState(o); const inv = current(o); const addr = lnAddress();
  const sats = s.sats != null ? Number(s.sats).toLocaleString('sk-SK').replace(/\u00a0/g, ' ') : '–';
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Platba – Bitcoin Lightning</title><meta name="robots" content="noindex"><meta name="theme-color" content="#0b1220"><link rel="stylesheet" href="/blink-pay.css?v=20261027"><link rel="stylesheet" href="/tv-theme.css?v=20261026"></head><body>
<div class="wrap bl">
<nav class="tvtop"><a class="tvlogo" href="/tv"><i>▶</i>TV Software</a><a class="tvback" href="/platby">← Späť na platby</a></nav>
<div class="brand"><h1>Platba · Bitcoin Lightning</h1><p>Naskenujte QR kód v Lightning peňaženke. Platba sa potvrdí automaticky.</p></div>
<main class="card bl-card" id="bl" data-order="${esc(o.orderId)}" data-state="${esc(s.status)}" data-exp="${esc(s.expiresAt || '')}" data-now="${esc(s.now)}" data-qk="${esc(s.qrKey)}">
<div class="bl-head"><span class="bl-logos"><img src="/logos/lightning.svg?v=20261027" alt="Lightning" width="34" height="34"><img src="/logos/bitcoin.svg?v=20261027" alt="Bitcoin" width="34" height="34"></span><span class="bl-t">Bitcoin Lightning</span></div>
<div class="bl-amt"><div class="bl-k">Suma na úhradu</div><div class="bl-eur"><b id="blEur">${esc(s.amountEur)}</b> EUR</div><div class="bl-sats"><span id="blSats">${esc(sats)}</span> sats</div></div>
<section class="bl-paid" id="blPaid"${s.status === 'paid' ? '' : ' hidden'}><div class="bl-ok">✓</div><h2>Zaplatené</h2><p>Ďakujeme, platba bola prijatá a potvrdená.</p><p class="bl-small">Objednávka ${esc(o.orderId)}</p>${o.status === 'paid' ? `<p><a class="btn" href="/?paid=${encodeURIComponent(o.orderId)}">Pokračovať – zadať meno a kontakt</a></p>` : ''}</section>
<section class="bl-pay" id="blPay"${s.status === 'paid' ? ' hidden' : ''}>
<div class="bl-grid"><div class="bl-qr"><img id="blQr" src="/api/blink-pay/${esc(o.orderId)}/qr.png?k=${esc(s.qrKey)}" alt="QR kód Lightning faktúry" width="280" height="280"><div class="bl-exp" id="blExp" aria-live="polite">Faktúra platí ešte <b id="blCd">–:–</b></div></div>
<div class="bl-side"><div class="bl-k">Lightning faktúra</div><code class="bl-pr" id="blPr">${esc(s.paymentRequest || '')}</code>
<div class="bl-btns"><button type="button" class="btn bl-btn" data-cp="blPr">📋 Kopírovať faktúru</button><a class="bl-btn2" id="blOpen" href="lightning:${esc(s.paymentRequest || '')}">⚡ Otvoriť v peňaženke</a></div>
<p class="bl-st" id="blSt"><span class="bl-dot"></span>Čakáme na platbu…</p>
<p class="bl-small">Faktúra je na presnú sumu. Po vypršaní sa automaticky vytvorí nová s aktuálnym kurzom.</p></div></div>
${addr ? `<details class="bl-addr"><summary>Platba na Lightning adresu</summary><div class="bl-addr-in"><div class="bl-addr-l"><code class="bl-la" id="blLa">${esc(addr)}</code><button type="button" class="btn bl-btn" data-cp="blLa">📋 Kopírovať adresu</button>
<p class="bl-small">Pošlite presne <b>${esc(sats)} sats</b> a do poznámky uveďte <b>${esc(o.orderId)}</b>. Platba na adresu sa nepotvrdí automaticky – odporúčame faktúru vyššie.</p></div><img class="bl-aqr" src="/api/blink-pay/${esc(o.orderId)}/address-qr.png" alt="QR kód Lightning adresy" width="160" height="160" loading="lazy"></div></details>` : ''}
</section>
</main>
<p class="bl-foot">Objednávka ${esc(o.orderId)}</p>
</div><script src="/blink-pay.js?v=20261027" defer></script></body></html>`;
}

/* ---------- routes ---------- */
function mount(app, deps) {
  const { loadOrders, saveOrders, appendLog } = deps;
  if (appendLog) log = appendLog;
  loadConfig().catch(() => {});
  const { sameOrigin, nostore } = require('./payMethods');
  const find = (id) => (ID_RE.test(String(id || '')) ? loadOrders()[id] : null);
  const ok = (o) => o && o.provider === GATEWAY && o.blink;
  app.get('/blink-pay', async (req, res) => {
    const o = find(req.query.orderId);
    if (!ok(o)) return res.status(404).type('html').send('<p>Objednávka sa nenašla. <a href="/platby">Späť</a></p>');
    nostore(res);
    res.type('html').send(page(o));
  });
  app.get('/api/blink-pay/:id/status', async (req, res) => {
    nostore(res);
    if (!find(req.params.id) || !ok(find(req.params.id))) return res.status(404).json({ ok: false, error: 'Objednávka sa nenašla' });
    if (limited('st:' + ipOf(req), 120, 60e3)) return res.status(429).json({ ok: false, error: 'Príliš veľa požiadaviek' });
    await checkOrder(req.params.id, deps).catch(() => null);
    res.json(publicState(find(req.params.id)));
  });
  app.post('/api/blink-pay/:id/renew', async (req, res) => {
    nostore(res);
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Neplatný pôvod požiadavky' });
    const id = req.params.id; const o0 = find(id);
    if (!ok(o0)) return res.status(404).json({ ok: false, error: 'Objednávka sa nenašla' });
    await checkOrder(id, deps, true).catch(() => null); // a late payment of the old invoice wins
    const o1 = find(id);
    const s = publicState(o1);
    if (s.status !== 'expired') return res.json(s);
    if (o1.blink.invoices.length >= MAX_INVOICES || limited('renew:' + ipOf(req), 12, 10 * 60e3) || limited('renew:' + id, 6, 30 * 60e3)) return res.status(429).json({ ok: false, error: 'Príliš veľa nových faktúr. Skúste to neskôr alebo začnite novú platbu.' });
    try {
      const inv = await newInvoiceFor(o1);
      const orders = loadOrders(); const o = orders[id];
      if (o.status === 'paid') return res.json(publicState(o));
      o.blink.invoices.push(inv); saveOrders(orders);
      (appendLog || log)(`BLINK_RENEW ${id} sats=${inv.sats} n=${o.blink.invoices.length}`);
      res.json(publicState(o));
    } catch (x) { (appendLog || log)(`BLINK_RENEW_FAIL ${id} ${x.message}`); res.status(502).json({ ok: false, error: 'Novú faktúru sa nepodarilo vytvoriť. Skúste to o chvíľu.' }); }
  });
  app.get('/api/blink-pay/:id/qr.png', async (req, res) => {
    const o = find(req.params.id); if (!ok(o)) return res.status(404).end();
    const inv = current(o); if (!inv || o.status === 'paid') return res.status(404).end();
    try {
      const png = await QRCode.toBuffer('lightning:' + inv.paymentRequest.toUpperCase(), { type: 'png', width: 560, margin: 2, errorCorrectionLevel: 'M' });
      res.set('Cache-Control', 'no-store'); res.type('png').send(png);
    } catch { res.status(500).end(); }
  });
  app.get('/api/blink-pay/:id/address-qr.png', async (req, res) => {
    const o = find(req.params.id); const a = lnAddress(); if (!ok(o) || !a) return res.status(404).end();
    try { const png = await QRCode.toBuffer('lightning:' + a, { type: 'png', width: 320, margin: 2, errorCorrectionLevel: 'M' }); res.set('Cache-Control', 'no-store'); res.type('png').send(png); } catch { res.status(500).end(); }
  });
  if (require('./payMode').jobs()) startWatcher(deps);

  // admin bridge (lnkbio /admin/platobne-metody/blink calls these in-process; never returns the key)
  const ACTIONS = {
    blink_get: async () => ({ ok: true, ...adminView() }),
    blink_save: async (b) => {
      const username = String(b.username || '').trim().replace(/^@/, '');
      const lnAddr = String(b.lnAddress || '').trim().toLowerCase();
      const newKey = String(b.apiKey || '').trim();
      const clearKey = String(b.clearKey || '') === '1';
      if (username && !USERNAME_RE.test(username)) return { ok: false, status: 400, error: 'Neplatné Blink používateľské meno (3–50 znakov: písmená, čísla, _).' };
      if (lnAddr && !LNADDR_RE.test(lnAddr)) return { ok: false, status: 400, error: 'Neplatná Lightning adresa (formát meno@domena.sk).' };
      if (newKey && !/^[A-Za-z0-9_\-]{10,200}$/.test(newKey)) return { ok: false, status: 400, error: 'Neplatný formát API kľúča.' };
      const next = { username, lnAddress: lnAddr };
      if (username) {
        try { next.walletId = await walletForUsername(username); } catch (x) {
          return { ok: false, status: 400, error: /does not exist/i.test(x.message) ? `Blink účet „${username}“ neexistuje. Skontrolujte používateľské meno v aplikácii Blink.` : 'Blink peňaženku sa nepodarilo overiť: ' + x.message };
        }
      } else next.walletId = '';
      if (newKey) {
        try { await walletForKey(newKey); } catch (x) { return { ok: false, status: 400, error: 'API kľúč nebol prijatý: ' + x.message.replace(newKey, '***') }; }
        try { next.keyEnc = sealKey(newKey); } catch (x) { return { ok: false, status: 400, error: x.message }; }
      } else if (clearKey) next.keyEnc = '';
      await saveConfig(next);
      log(`BLINK_CONFIG_SAVED user=${username ? 'set' : 'none'} wallet=${next.walletId ? 'ok' : 'none'} key=${CFG.keyEnc ? 'set' : 'none'}`);
      return { ok: true, ...adminView() };
    },
  };
  require('./payMethods').serveSigned(app, '/api/admin-bridge/blink', ACTIONS, 'BLINK');
}

module.exports = { GATEWAY, EXPIRES_MIN, configured, status, adminView, createOrder, mount, loadConfig, eurToSats, aggregatePrice, btcEur, applyStatus, publicState, invoiceStatus, createInvoice, walletForUsername,
  _setConfig: (c) => { CFG = { ...CFG, ...c }; }, _current: current };
