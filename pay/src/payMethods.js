'use strict';
/**
 * Admin-managed payment methods (Ryan): custom external payment links + per-method overrides
 * (logo, enable/disable, name, order) for the built-in checkout methods.
 * Storage: Neon table pay_methods (id text PK, data jsonb) + pay_method_logos (bytea) — same as other admin data;
 * local dev without DATABASE_URL falls back to data/pay-methods.json (gitignored).
 * Public checkout: apply() decorates /api/providers groups with `logos` and appends enabled custom methods.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const orderDb = require('./db');
const { layout, escapeHtml: e } = require('./adminSepa');
const methodRank = require('./methodRank');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'pay-methods.json');
const LOGO_DIR = path.join(DATA_DIR, 'pay-logos');
const LOGO_LIB_DIR = path.join(__dirname, '..', 'public', 'logos');
const LOGO_V = '20261026';
const MAX_LOGO = 512 * 1024;

/* ---------- default (real, official) logos for built-in methods — files in public/logos, sources in SOURCES.md ---------- */
const L = (n) => `/logos/${n}?v=${LOGO_V}`;
const BRAND = {
  switchere: L('switchere.svg'), guardarian: L('guardarian.png'), sepa: L('sepa.svg'), electrocoin: L('electrocoin.png'),
  revolut: L('revolut.svg'), mtpelerin: L('mtpelerin.png'), changenow: L('changenow.png'), paybis: L('paybis.png'),
  anycoin: L('anycoin.svg'), coinmate: L('coinmate.svg'), bitpanda: L('bitpanda.png'), kriptomat: L('kriptomat.png'),
  skrill: L('skrill.png'), paysafecard: L('paysafecard.svg'), amazon: L('amazon.svg'), g2a: L('g2a.svg'), azteco: L('azteco.png'),
  btcpay: L('btcpay.png'), banxa: L('banxa.png'), stripe: L('stripe.svg'), transak: L('transak.png'), ramp: L('ramp.png'),
  alchemypay: L('alchemypay.png'), applepay: L('applepay.svg'), googlepay: L('googlepay.svg'), changelly: L('changelly.svg'), visa: L('visa.svg'), mastercard: L('mastercard.svg'),
  lightning: L('lightning.svg'), bitcoin: L('bitcoin.svg'),
};
const GENERIC = { card: L('generic-card.svg'), bank: L('generic-bank.svg'), voucher: L('generic-voucher.svg'), link: L('generic-link.svg'), wallet: L('generic-wallet.svg') };
const DEFAULT_LOGOS = {
  switchere: ['switchere'], switchere_card: ['switchere'], switchere_bank: ['switchere'], switchere_skrill: ['skrill'], skrill: ['skrill'],
  guardarian_card: ['guardarian'], is_guardarian: ['guardarian'], guardarian_revolut: ['guardarian'],
  bank_sepa_manual: ['sepa', 'electrocoin'], revolut_manual: ['revolut'], mtpelerin: ['mtpelerin'],
  changenow_buy: ['changenow'], paybis_buy: ['paybis'], anycoin_buy: ['anycoin'], coinmate_buy: ['coinmate'], bitpanda_buy: ['bitpanda'], kriptomat_buy: ['kriptomat'],
  paysafecard: ['paysafecard'], btcpay: ['btcpay'], blink_ln: ['lightning', 'bitcoin'],
  changelly_card: ['visa', 'mastercard', 'applepay', 'googlepay'], changelly_sepa: ['sepa'], changelly_revolut: ['revolut', 'changelly'], revolut_ramp: ['revolut'],
  banxa: ['banxa'], banxa_bank: ['banxa'], sepa_instant: ['banxa'], stripe: ['stripe'],
  is_transak: ['transak'], is_transak_sepa: ['transak'], transak: ['transak'], transak_sepa: ['transak'], is_ramp: ['ramp'], is_alchemy: ['alchemypay'],
};
const GENERIC_BY_ID = { crypto_direct: 'wallet', btcpay_onramp: 'card', onramp_btcpay: 'card', is_multihosted: 'card' };
const GENERIC_BY_GROUP = { cards: 'card', sepa: 'bank', wallets: 'wallet', vouchers: 'voucher', g2a_amazon: 'voucher', g2a_azteco: 'voucher', paysafecard: 'voucher' };

function defaultLogos(id, group) {
  id = String(id || '').toLowerCase();
  if (DEFAULT_LOGOS[id]) return DEFAULT_LOGOS[id].map((b) => BRAND[b]);
  if (id.startsWith('g2a_amazon')) return [BRAND.amazon, BRAND.g2a];
  if (id.startsWith('g2a_azteco')) return [BRAND.azteco, BRAND.g2a];
  if (id.startsWith('apple_google_')) {
    const rest = DEFAULT_LOGOS[id.slice('apple_google_'.length)] || [];
    return [BRAND.applepay, BRAND.googlepay, ...rest.map((b) => BRAND[b])];
  }
  if (/^revolut/.test(id)) return [BRAND.revolut];
  if (GENERIC_BY_ID[id]) return [GENERIC[GENERIC_BY_ID[id]]];
  if (GENERIC_BY_GROUP[group]) return [GENERIC[GENERIC_BY_GROUP[group]]];
  return [];
}

/* ---------- groups a custom method can be placed in ---------- */
const EXTRA_GROUPS = { vouchers: { label: 'Poukážky / darčekové karty', color: '#f59e0b' } };
const CATEGORY_CHOICES = [
  ['cards', 'Karta'], ['sepa', 'Banka / SEPA'], ['wallets', 'Apple Pay / Google Pay'], ['vouchers', 'Poukážky / darčekové karty'],
  ['keyless', 'Ostatné (Ďalšie brány)'],
];

/* ---------- state ---------- */
const S = { items: new Map(), logos: new Map() }; // items: id -> data ; logos (file fallback cache): id -> {type, buf}
let log = () => {};
let tablesReady = null;

function pool() { return orderDb.pool(); }
async function tables() {
  const p = pool(); if (!p) return null;
  if (!tablesReady) {
    tablesReady = p.query(`CREATE TABLE IF NOT EXISTS pay_methods (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`)
      .then(() => p.query(`CREATE TABLE IF NOT EXISTS pay_method_logos (id text PRIMARY KEY, type text NOT NULL, data bytea NOT NULL, created_at timestamptz DEFAULT now())`))
      .catch((x) => { tablesReady = null; throw x; });
  }
  await tablesReady; return p;
}
function persistLocal() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify([...S.items.values()], null, 1)); } catch { /* read-only fs */ }
}
async function put(rec) {
  rec.updatedAt = new Date().toISOString();
  S.items.set(rec.id, rec);
  persistLocal();
  const p = await tables().catch((x) => { log('PAYMETHODS_DB_FAIL ' + x.message); return null; });
  if (p) {
    await p.query(`INSERT INTO pay_methods (id, data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [rec.id, JSON.stringify(rec)]);
  }
  return rec;
}
async function init(appendLog) {
  if (appendLog) log = appendLog;
  try { for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) S.items.set(r.id, r); } catch { /* none */ }
  const p = await tables().catch((x) => { log('PAYMETHODS_DB_FAIL ' + x.message); return null; });
  if (!p) return;
  const { rows } = await p.query('SELECT data FROM pay_methods');
  S.items.clear();
  rows.forEach((x) => S.items.set(x.data.id, x.data));
  log(`PAYMETHODS_READY ${rows.length}`);
}

const customs = () => [...S.items.values()].filter((r) => r.kind === 'custom');
const override = (id) => S.items.get('ov:' + String(id).toLowerCase()) || null;
const orderOf = (group) => (S.items.get('order:' + group) || {}).ids || null;
/** Checkout ordering settings: auto (by usage, default ON) vs manual; pinned methods always first. */
function rankSettings() {
  const r = S.items.get('rank:settings') || {};
  return { auto: r.auto !== false, pins: Array.isArray(r.pins) ? r.pins.slice(0, 10) : [], groupOrder: Array.isArray(r.groupOrder) ? r.groupOrder : [] };
}
async function saveRank(patch) { return put({ id: 'rank:settings', kind: 'rank', ...rankSettings(), ...patch }); }

/** Enabled, not-deleted custom method (checkout lookup). */
function customFor(id) {
  const r = S.items.get(String(id || '').toLowerCase());
  return r && r.kind === 'custom' && !r.deleted && r.enabled !== false ? r : null;
}
// Built-ins that start OFF until the admin explicitly switches them on (new methods that need configuration first).
const DEFAULT_OFF = new Set(['blink_ln']);
function isBuiltinDisabled(id) {
  const o = override(id);
  if (DEFAULT_OFF.has(String(id || '').toLowerCase())) return !(o && o.enabled === true);
  return !!(o && o.enabled === false);
}

/* ---------- public: decorate grouped providers ---------- */
function logosFor(item) {
  if (item.custom) return item.logos;
  const o = override(item.id);
  if (o && o.hideLogo) return [];
  if (o && o.logo) return [o.logo];
  return defaultLogos(item.id, item.group);
}
function customItem(r) {
  const min = Number(r.minEur) > 0 ? Number(r.minEur) : 1;
  return {
    id: r.id, providerId: r.id, provider_name: r.name, method_label: r.name, status: 'active', group: r.group,
    gateway: 'custom', configured: true, soon: false, unavailableLabel: null, preferred: false,
    hint: r.description || 'Platba cez externý odkaz.', minimum_amount: min, minimum_currency: 'EUR',
    custom: true, logos: r.logo ? [r.logo] : [GENERIC[GENERIC_BY_GROUP[r.group] || 'link'] || GENERIC.link],
  };
}
function apply(res, methodGroups) {
  if (!res || !res.groups) return res;
  const groups = res.groups;
  const gmeta = Object.fromEntries((methodGroups || []).map((g) => [g.key, g]));
  const removed = new Set();
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    for (const listName of ['providers', 'soon']) {
      g[listName] = (g[listName] || []).filter((it) => {
        if (isBuiltinDisabled(it.id)) { removed.add(it.id); return false; }
        const o = override(it.id);
        if (o && o.name) {
          it.provider_name = o.name;
          it.method_label = it.soon && it.unavailableLabel ? `${o.name} — ${it.unavailableLabel}` : o.name;
        }
        it.logos = logosFor(it);
        return true;
      });
    }
  }
  const flat = (res.providers || []).filter((p) => !removed.has(p.id));
  const soonFlat = (res.soonProviders || []).filter((p) => !removed.has(p.id));
  const byId = new Map();
  for (const g of Object.values(groups)) for (const it of [...g.providers, ...g.soon]) byId.set(it.id, it);
  flat.forEach((p) => { if (byId.has(p.id)) p.logos = byId.get(p.id).logos; });
  soonFlat.forEach((p) => { if (byId.has(p.id)) p.logos = byId.get(p.id).logos; });
  for (const r of customs()) {
    if (r.deleted || r.enabled === false) continue;
    const it = customItem(r);
    if (!groups[r.group]) {
      const m = gmeta[r.group] || EXTRA_GROUPS[r.group] || { label: r.group, color: '#64748b' };
      groups[r.group] = { label: m.label, color: m.color || null, providers: [], soon: [] };
    }
    groups[r.group].providers.push(it);
    flat.push(it);
  }
  // admin-defined order inside each group (unknown ids keep their natural position after the ordered ones)
  for (const key of Object.keys(groups)) {
    const ids = orderOf(key); if (!ids) continue;
    const rank = (id) => { const i = ids.indexOf(id); return i < 0 ? 1e6 : i; };
    groups[key].providers = groups[key].providers.map((x, i) => [x, i]).sort((a, b) => rank(a[0].id) - rank(b[0].id) || a[1] - b[1]).map((x) => x[0]);
  }
  for (const key of Object.keys(groups)) if (!groups[key].providers.length && !groups[key].soon.length) delete groups[key];
  // popularity / pins / manual order (methodRank): reorder groups + flat list; expose ids only (never usage numbers)
  const rk = methodRank.order(groups, rankSettings());
  const pos = new Map(rk.methodOrder.map((id, i) => [id, i]));
  const at = (id) => (pos.has(id) ? pos.get(id) : 1e6);
  flat.sort((a, b) => at(a.id) - at(b.id));
  const ordered = {};
  for (const k of rk.groupOrder) ordered[k] = groups[k];
  res.groups = ordered;
  res.rank = { mode: rk.mode, groupOrder: rk.groupOrder, methodOrder: rk.methodOrder, pins: rk.pins };
  res.providers = flat;
  res.soonProviders = soonFlat;
  return res;
}

/* ---------- logos: upload / fetch-from-URL, stored in DB (file fallback), served at /pm-logo/:id ---------- */
/* ---------- checkout ordering by usage (admin + bridge share these) ---------- */
const feeText = (c) => { if (!c) return null; const pct = Number(c.feePct) || 0, fix = Number(c.feeFix) || 0; if (!pct && !fix) return 'bez poplatku'; return [pct ? `~${pct} %` : '', fix ? `+${fix} €` : ''].filter(Boolean).join(' '); };
/** pv = groupProviders() result (same as /api/providers). Usage numbers are admin-only. */
function rankState(pv, feeOf) {
  const st = methodRank.stats(); const set = rankSettings();
  const rk = (pv && pv.rank) || { mode: set.auto ? 'auto' : 'manual', groupOrder: [], methodOrder: [], pins: [] };
  const meta = new Map();
  for (const [k, g] of Object.entries((pv && pv.groups) || {})) for (const p of g.providers || []) meta.set(p.id, { name: p.method_label || p.provider_name || p.id, group: k, groupLabel: g.label || k });
  const z = { orders: 0, proof: 0, paid: 0, clicks: 0, score: 0 };
  const methods = rk.methodOrder.map((id, i) => {
    const m = meta.get(id) || { name: id, group: '', groupLabel: '' };
    const u = { ...z, ...(st.byMethod[id] || {}) };
    return { pos: i + 1, id, name: m.name, group: m.group, groupLabel: m.groupLabel, ...u, enough: u.score >= methodRank.MIN_SCORE, pinned: set.pins.includes(id), fee: feeOf ? feeText(feeOf(id, m.group)) : null };
  });
  const other = Object.entries(st.byMethod).filter(([id]) => !meta.has(id)).map(([id, u]) => ({ id, ...u })).sort((a, b) => b.score - a.score);
  const groups = rk.groupOrder.map((k) => ({ key: k, label: ((pv.groups || {})[k] || {}).label || k }));
  return { ok: true, auto: set.auto, mode: rk.mode, pins: set.pins, groups, methods, other, computedAt: st.at, days: st.days, ordersCounted: st.orders, source: st.source,
    weights: methodRank.W, minScore: methodRank.MIN_SCORE };
}
async function rankSetAuto(on) { await saveRank({ auto: !!on }); }
async function rankSetPin(id, on, known) {
  const set = rankSettings(); id = String(id || '').toLowerCase();
  if (on && !known.has(id)) return false;
  let pins = set.pins.filter((x) => x !== id);
  if (on) pins = [id, ...pins].slice(0, 10);
  await saveRank({ pins }); return true;
}
async function rankGroupMove(group, dir, current) {
  const list0 = current.slice(); const i = list0.indexOf(group); if (i < 0) return false;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list0.length) return true;
  [list0[i], list0[j]] = [list0[j], list0[i]];
  await saveRank({ groupOrder: list0, auto: false }); return true;
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString() === 'GIF8') return 'image/gif';
  const head = buf.slice(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}
function svgSafe(buf) {
  const s = buf.toString('utf8');
  if (/<script|<foreignObject|<iframe|<embed|<object|<use\b|javascript:|data:text|\bon[a-z]+\s*=/i.test(s)) return false;
  // only internal references (#id) allowed — no external images/fonts/styles
  if (/(?:xlink:)?href\s*=\s*["']\s*(?!#)/i.test(s)) return false;
  if (/url\(\s*["']?\s*(?!#)/i.test(s) || /@import/i.test(s)) return false;
  return true;
}
function checkLogo(buf) {
  if (!buf || !buf.length) throw new Error('Prázdny súbor loga');
  if (buf.length > MAX_LOGO) throw new Error('Logo je príliš veľké (max 512 kB)');
  const type = sniffImage(buf);
  if (!type) throw new Error('Nepodporovaný formát loga (povolené: SVG, PNG, JPG, WebP, GIF)');
  if (type === 'image/svg+xml' && !svgSafe(buf)) throw new Error('SVG obsahuje nepovolený obsah (skripty / externé odkazy)');
  return type;
}
async function storeLogo(buf) {
  const type = checkLogo(buf);
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
  const p = await tables().catch(() => null);
  if (p) await p.query('INSERT INTO pay_method_logos (id, type, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, type, buf]);
  else { fs.mkdirSync(LOGO_DIR, { recursive: true }); fs.writeFileSync(path.join(LOGO_DIR, id), buf); fs.writeFileSync(path.join(LOGO_DIR, id + '.type'), type); }
  S.logos.set(id, { type, buf });
  return `/pm-logo/${id}`;
}
async function getLogo(id) {
  if (S.logos.has(id)) return S.logos.get(id);
  const p = pool();
  let r = null;
  if (p) { const { rows } = await p.query('SELECT type, data FROM pay_method_logos WHERE id = $1', [id]).catch(() => ({ rows: [] })); if (rows[0]) r = { type: rows[0].type, buf: rows[0].data }; }
  if (!r) { try { r = { buf: fs.readFileSync(path.join(LOGO_DIR, id)), type: fs.readFileSync(path.join(LOGO_DIR, id + '.type'), 'utf8') }; } catch { /* none */ } }
  if (r) S.logos.set(id, r);
  return r;
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
/** Admin pasted a logo URL: download it once and keep a local copy (never hotlink). */
async function fetchLogo(urlStr) {
  let u;
  for (let hop = 0; hop < 4; hop++) {
    try { u = new URL(urlStr); } catch { throw new Error('Neplatná URL loga'); }
    if (u.protocol !== 'https:') throw new Error('URL loga musí začínať https://');
    const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('Doménu loga sa nepodarilo overiť');
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    let r;
    try { r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (TV Software logo fetch)', Accept: 'image/*' } }); }
    catch { clearTimeout(t); throw new Error('Logo sa nepodarilo stiahnuť'); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { clearTimeout(t); urlStr = new URL(r.headers.get('location'), u).toString(); continue; }
    if (!r.ok) { clearTimeout(t); throw new Error(`Logo sa nepodarilo stiahnuť (HTTP ${r.status})`); }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_LOGO) { clearTimeout(t); throw new Error('Logo je príliš veľké (max 512 kB)'); }
    const buf = Buffer.from(await r.arrayBuffer()); clearTimeout(t);
    return storeLogo(buf);
  }
  throw new Error('Príliš veľa presmerovaní');
}
function libraryLogos() {
  try { return fs.readdirSync(LOGO_LIB_DIR).filter((f) => /\.(svg|png)$/i.test(f)).sort(); } catch { return []; }
}

async function resolveLogoShared(fields, files, current) {
  const f = (files || []).find((x) => x.field === 'logo');
  if (f) return storeLogo(f.buf);
  const url = String(fields.logoUrl || '').trim();
  if (url) return fetchLogo(url);
  const lib = String(fields.lib || '').trim();
  if (lib) { if (!libraryLogos().includes(lib)) throw new Error('Neznáme logo z knižnice'); return L(lib); }
  if (fields.removeLogo) return null;
  return current || null;
}

/* ---------- admin helpers ---------- */
function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || ''); const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!/^multipart\/form-data/i.test(ct) || !bm) return resolve({ fields: { ...(req.body || {}) }, files: [] });
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => { n += c.length; if (n > MAX_LOGO + 128 * 1024) { over = true; } else chunks.push(c); });
    req.on('end', () => {
      if (over) return reject(new Error('Súbor je príliš veľký (max 512 kB)'));
      const buf = Buffer.concat(chunks), sep = Buffer.from('--' + (bm[1] || bm[2])); const fields = {}, files = [];
      let i = buf.indexOf(sep);
      while (i >= 0) {
        const j = buf.indexOf(sep, i + sep.length); if (j < 0) break;
        const part = buf.subarray(i + sep.length + 2, j - 2), h = part.indexOf('\r\n\r\n');
        if (h > 0) {
          const head = part.subarray(0, h).toString('utf8'), body = part.subarray(h + 4), name = (head.match(/name="([^"]*)"/) || [])[1], fn = (head.match(/filename="([^"]*)"/) || [])[1];
          if (fn !== undefined) { if (body.length) files.push({ field: name, name: fn, buf: body }); } else if (name) fields[name] = body.toString('utf8');
        }
        i = j;
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}
/** CSRF guard for admin POSTs (cookie is SameSite=Lax too). Browsers send Origin "null" when the page has
 * Referrer-Policy no-referrer, so prefer Sec-Fetch-Site, then Origin/Referer; no headers at all = non-browser client. */
const sameOrigin = (req) => {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const o = (req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '') || req.headers.referer || '';
  if (!o) return !req.headers.origin; // explicit Origin: null without Sec-Fetch-Site → refuse
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};
const nostore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
function slug(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'metoda'; }
function cleanUrl(v) {
  const s = String(v || '').trim();
  let u; try { u = new URL(s.replace(/\{(amount|orderId)\}/g, 'X')); } catch { throw new Error('Neplatná URL platobného odkazu'); }
  if (u.protocol !== 'https:') throw new Error('Platobný odkaz musí začínať https://');
  if (s.length > 1000) throw new Error('URL je príliš dlhá');
  return s;
}
/** Final customer URL: {amount} and {orderId} placeholders are filled in. */
function buildUrl(r, { amountEur, orderId }) {
  return String(r.url).replace(/\{amount\}/g, encodeURIComponent(String(amountEur))).replace(/\{orderId\}/g, encodeURIComponent(String(orderId)));
}
function logoTag(src, alt = '') {
  return src ? `<img src="${e(src)}" alt="${e(alt)}" class="lg">` : '<span class="lg none">—</span>';
}

function mount(app, { appendLog, methodGroups, builtins, liveStatus, preview, feeOf }) {
  if (appendLog) log = appendLog;
  const groupsAll = () => {
    const m = (methodGroups() || []).map((g) => [g.key, g.label]);
    for (const [k, v] of Object.entries(EXTRA_GROUPS)) if (!m.some((x) => x[0] === k)) m.push([k, v.label]);
    return m;
  };
  const groupLabel = (k) => (groupsAll().find((g) => g[0] === k) || [k, k])[1];
  const validGroup = (k) => groupsAll().some((g) => g[0] === k);
  Object.assign(ADMIN, { groupLabel, groupsAll, preview, rows: () => rows(), isOn: (x) => (x.kind === 'custom' ? x.rec.enabled !== false : !isBuiltinDisabled(x.id)), logos: (x) => (x.kind === 'custom' ? (x.rec.logo ? [x.rec.logo] : []) : logosFor({ id: x.id, group: x.group })) });
  const css = `<style>
.lg{height:24px;max-width:64px;object-fit:contain;background:#fff;border-radius:6px;padding:2px 4px;vertical-align:middle}.lg.none{background:transparent;color:#64748b}
.lgs{display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap}.pm-actions{display:flex;flex-wrap:wrap;gap:.35rem}.pm-actions form{display:inline;margin:0}
.pm-actions button,.pm-actions .btn{padding:.4rem .65rem;font-size:.85rem}button.danger{background:#b91c1c}.libgrid{display:flex;flex-wrap:wrap;gap:.4rem;margin:.3rem 0}
.libgrid label{display:inline-flex;align-items:center;gap:.3rem;margin:0;padding:.25rem .45rem;border:1px solid var(--line);border-radius:8px;cursor:pointer;color:var(--text)}
.libgrid input{width:auto}.chk{display:flex;align-items:center;gap:.5rem;color:var(--text)}.chk input{width:auto}
table.pm td{vertical-align:middle}.off{opacity:.55}
@media(max-width:640px){table.pm thead{display:none}table.pm tr{display:block;border-bottom:1px solid var(--line);padding:.5rem 0}table.pm td{display:block;border:0;padding:.2rem 0}.grid{grid-template-columns:1fr}}
</style>`;
  const page = (req, title, body, msg = '', err = '') => layout({ title, userEmail: req.adminSession && req.adminSession.email, body: `${css}${msg ? `<div class="ok">${e(msg)}</div>` : ''}${err ? `<div class="err">${e(err)}</div>` : ''}${body}
<script>document.addEventListener('submit',function(ev){var f=ev.target;if(f&&f.getAttribute('data-confirm')&&!window.confirm(f.getAttribute('data-confirm')))ev.preventDefault()});</script>` });

  const libPicker = (current) => `<div class="libgrid"><label><input type="radio" name="lib" value="" ${!current || !String(current).startsWith('/logos/') ? 'checked' : ''}> bez zmeny</label>${libraryLogos().filter((f) => !f.startsWith('generic-')).map((f) => {
    const v = L(f); return `<label><input type="radio" name="lib" value="${e(f)}" ${current === v ? 'checked' : ''}><img src="${e(v)}" alt="" class="lg"> ${e(f.replace(/\.\w+$/, ''))}</label>`;
  }).join('')}</div>`;
  const logoFields = (current, { builtin }) => `<label>Logo – nahrať súbor (SVG, PNG, JPG, WebP; max 512 kB; zobrazí sa vo výške 24 px)</label><input type="file" name="logo" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif">
<label>alebo vložiť URL loga (https://… – stiahne sa a uloží u nás, žiadne hotlinkovanie)</label><input type="url" name="logoUrl" maxlength="1000" placeholder="https://www.znacka.sk/logo.svg">
<label>alebo vybrať z oficiálnych log v knižnici</label>${libPicker(current)}
${current ? `<p class="muted">Aktuálne: ${logoTag(current)}</p>` : ''}
<label class="chk"><input type="checkbox" name="removeLogo" value="1"> ${builtin ? 'Vrátiť predvolené logo' : 'Odstrániť logo (zobrazí sa neutrálna ikona)'}</label>
${builtin ? '<label class="chk"><input type="checkbox" name="hideLogo" value="1"> Nezobrazovať žiadne logo</label>' : ''}`;
  const resolveLogo = resolveLogoShared;

  function customForm(r = {}) {
    const isNew = !r.id;
    return `<form method="post" action="${isNew ? '/admin/platby/methods/new' : '/admin/platby/methods/save/' + e(r.id)}" enctype="multipart/form-data">
<div class="grid"><div><label>Názov (zobrazí sa na tlačidle) *</label><input name="name" required maxlength="60" value="${e(r.name || '')}" placeholder="napr. Platba cez XY"></div>
<div><label>Kategória / skupina *</label><select name="group">${groupsAll().map(([k, v]) => `<option value="${e(k)}" ${(r.group || 'keyless') === k ? 'selected' : ''}>${e((CATEGORY_CHOICES.find((c) => c[0] === k) || [k, v])[1])}</option>`).join('')}</select></div></div>
<label>Platobný odkaz (URL) *</label><input type="url" name="url" required maxlength="1000" value="${e(r.url || '')}" placeholder="https://…">
<p class="muted">Voliteľne môžete do odkazu vložiť <code>{amount}</code> (suma v EUR) a <code>{orderId}</code> – doplnia sa automaticky.</p>
<label>Krátky popis / pokyny pre zákazníka (voliteľné)</label><textarea name="description" rows="3" maxlength="600">${e(r.description || '')}</textarea>
<div class="grid"><div><label>Minimálna suma v EUR (voliteľné)</label><input type="number" name="minEur" min="0" step="0.01" value="${r.minEur != null ? e(r.minEur) : ''}"></div>
<div><label>Postup po kliknutí</label><select name="mode"><option value="btc" ${(r.mode || 'btc') === 'btc' ? 'selected' : ''}>BTC adresa + odkaz (ako ChangeNOW / Paybis)</option><option value="link" ${r.mode === 'link' ? 'selected' : ''}>Len suma, pokyny a odkaz (bez BTC adresy)</option></select></div></div>
<label class="chk"><input type="checkbox" name="proofForm" value="1" ${r.proofForm !== false ? 'checked' : ''}> Zobraziť formulár „Poslať doklad“ (doklad príde do Telegramu)</label>
<label class="chk"><input type="checkbox" name="enabled" value="1" ${r.enabled !== false ? 'checked' : ''}> Zapnuté (zobrazuje sa zákazníkom)</label>
${logoFields(r.logo, { builtin: false })}
<p><button>${isNew ? '➕ Pridať spôsob platby' : '💾 Uložiť'}</button> ${isNew ? '' : '<a href="/admin/platby/methods">Späť</a>'}</p></form>`;
  }

  function rows() {
    // unified per-group list: built-ins + customs, in current display order
    const bi = builtins();
    const out = {};
    for (const [k] of groupsAll()) out[k] = [];
    for (const b of bi) { (out[b.group] = out[b.group] || []).push({ kind: 'builtin', id: b.id, name: (override(b.id) || {}).name || b.label, origName: b.label, group: b.group, soon: b.soon }); }
    for (const r of customs()) if (!r.deleted) (out[r.group] = out[r.group] || []).push({ kind: 'custom', id: r.id, name: r.name, group: r.group, rec: r });
    for (const k of Object.keys(out)) {
      const ids = orderOf(k); if (!ids) continue;
      const rank = (id) => { const i = ids.indexOf(id); return i < 0 ? 1e6 : i; };
      out[k] = out[k].map((x, i) => [x, i]).sort((a, b) => rank(a[0].id) - rank(b[0].id) || a[1] - b[1]).map((x) => x[0]);
    }
    return out;
  }
  function rankCard(rs) {
    const n = (v) => `<td class="num">${e(v)}</td>`;
    const when = rs.computedAt ? new Date(rs.computedAt).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }) : '—';
    const pinF = (m) => `<form method="post" action="/admin/platby/methods/rank/pin/${e(m.id)}"><input type="hidden" name="pin" value="${m.pinned ? 0 : 1}"><button class="secondary" title="${m.pinned ? 'Odopnúť' : 'Pripnúť navrch pokladne'}">${m.pinned ? '📌 Odopnúť' : '📌 Pripnúť'}</button></form>`;
    const trs = rs.methods.map((m) => `<tr class="${m.pinned ? 'pinned' : ''}"><td class="num"><b>${m.pos}.</b></td><td><b>${e(m.name)}</b>${m.pinned ? ' <span class="badge ok">pripnuté</span>' : ''}<br><span class="muted">${e(m.groupLabel)} · ${e(m.id)}</span></td>
${n(m.orders)}${n(m.proof)}${n(m.paid)}${n(m.clicks)}<td class="num"><b>${e(m.score)}</b>${m.enough ? '' : '<br><span class="muted" title="Málo dát – rozhoduje predvolené poradie">málo dát</span>'}</td><td class="muted">${e(m.fee || '—')}</td><td>${pinF(m)}</td></tr>`).join('');
    const gm = (k, dir, lbl, dis) => `<form method="post" action="/admin/platby/methods/rank/group"><input type="hidden" name="group" value="${e(k)}"><input type="hidden" name="dir" value="${dir}"><button class="secondary" ${dis ? 'disabled' : ''}>${lbl}</button></form>`;
    const groupsHtml = rs.groups.map((g, i) => `<li><span>${i + 1}. ${e(g.label)}</span><span class="pm-actions">${gm(g.key, 'up', '↑', i === 0)}${gm(g.key, 'down', '↓', i === rs.groups.length - 1)}</span></li>`).join('');
    return `<div class="card" id="poradie"><h2>↕️ Poradie na pokladni</h2>
<form method="post" action="/admin/platby/methods/rank/auto" class="rk-auto"><input type="hidden" name="auto" value="${rs.auto ? 0 : 1}">
<span class="rk-sw ${rs.auto ? 'on' : ''}" role="switch" aria-checked="${rs.auto}">Zoradiť automaticky podľa používania: <b>${rs.auto ? 'ZAPNUTÉ' : 'VYPNUTÉ (manuálne poradie)'}</b></span>
<button class="${rs.auto ? 'secondary' : ''}">${rs.auto ? 'Prepnúť na manuálne poradie' : 'Zapnúť automatické poradie'}</button></form>
<p class="muted">${rs.auto ? `Automaticky: skupiny aj spôsoby sú zoradené podľa skóre za posledných ${e(rs.days)} dní (objednávka ×${e(rs.weights.started)}, s dokladom ×${e(rs.weights.proof)}, zaplatená ×${e(rs.weights.paid)}, klik ×${e(rs.weights.click)}). Pri skóre pod ${e(rs.minScore)} („málo dát“) rozhoduje predvolené poradie (Revolut, karta / Apple / Google Pay, SEPA, krypto, darčekové karty…) a vaše poradie v zozname nižšie.` : 'Manuálne: poradie skupín určujú šípky nižšie, poradie v rámci skupiny šípky v zozname spôsobov platby.'} Pripnuté spôsoby sú vždy úplne hore. Zákazník čísla ani poplatky nevidí.</p>
<div class="muted rk-meta">Naposledy prepočítané: ${e(when)} · započítaných objednávok: ${e(rs.ordersCounted)} · prepočet každú hodinu
<form method="post" action="/admin/platby/methods/rank/recompute" style="display:inline"><button class="secondary">🔄 Prepočítať teraz</button></form></div>
<div class="rk-wrap"><table class="pm rk"><thead><tr><th>#</th><th>Spôsob platby</th><th>Objednávky</th><th>S dokladom</th><th>Zaplatené</th><th>Kliky</th><th>Skóre</th><th>Poplatok (len admin)</th><th></th></tr></thead><tbody>${trs}</tbody></table></div>
${rs.other.length ? `<p class="muted">Mimo pokladne (vypnuté / staré metódy): ${rs.other.slice(0, 12).map((o) => `${e(o.id)} ${e(o.orders)}×`).join(' · ')}</p>` : ''}
${rs.auto ? '' : `<h3>Poradie skupín</h3><ul class="rk-groups">${groupsHtml}</ul>`}</div>`;
  }
  const rankCss = `<style>.rk-auto{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:.4rem 0}.rk-sw{padding:.45rem .8rem;border-radius:999px;background:#334155}.rk-sw.on{background:#14532d;color:#bbf7d0}
.rk-wrap{overflow-x:auto}table.rk td.num{text-align:right;font-variant-numeric:tabular-nums}table.rk tr.pinned td{background:rgba(34,197,94,.08)}table.rk form{margin:0}
.rk-groups{list-style:none;padding:0;margin:0}.rk-groups li{display:flex;justify-content:space-between;align-items:center;padding:.3rem 0;border-bottom:1px solid var(--line)}
@media(max-width:640px){table.rk thead{display:none}table.rk tr{display:grid;grid-template-columns:2.2rem 1fr;gap:.2rem .5rem;border:1px solid var(--line);border-radius:10px;padding:.5rem;margin:.4rem 0}
table.rk td{display:block;border:0;padding:0}table.rk td.num{text-align:left}table.rk td:nth-child(n+3){grid-column:2}
table.rk td:nth-child(3)::before{content:'Objednávky: '}table.rk td:nth-child(4)::before{content:'S dokladom: '}table.rk td:nth-child(5)::before{content:'Zaplatené: '}table.rk td:nth-child(6)::before{content:'Kliky: '}table.rk td:nth-child(7)::before{content:'Skóre: '}table.rk td:nth-child(8)::before{content:'Poplatok: '}
table.rk td:nth-child(n+3)::before{color:#94a3b8}table.rk td:last-child button{width:100%;min-height:44px}}</style>`;
  function list(req, msg, err, rs) {
    const all = rows();
    const tbl = Object.entries(all).filter(([, v]) => v.length).map(([k, v]) => `<h2>${e(groupLabel(k))}</h2><table class="pm"><thead><tr><th>Logo</th><th>Názov</th><th>Stav</th><th>Akcie</th></tr></thead><tbody>${v.map((x, i) => {
      const enabled = x.kind === 'custom' ? x.rec.enabled !== false : !isBuiltinDisabled(x.id);
      const logos = x.kind === 'custom' ? (x.rec.logo ? [x.rec.logo] : []) : logosFor({ id: x.id, group: x.group });
      const mv = (dir, lbl, dis) => `<form method="post" action="/admin/platby/methods/move/${e(x.id)}"><input type="hidden" name="dir" value="${dir}"><input type="hidden" name="group" value="${e(k)}"><button class="secondary" ${dis ? 'disabled' : ''} title="${dir === 'up' ? 'Posunúť vyššie' : 'Posunúť nižšie'}">${lbl}</button></form>`;
      return `<tr class="${enabled ? '' : 'off'}"><td><span class="lgs">${logos.map((s) => logoTag(s)).join('') || logoTag(null)}</span></td>
<td><b>${e(x.name)}</b><br><span class="muted">${x.kind === 'custom' ? 'vlastný odkaz · ' + e(x.rec.url.replace(/^https:\/\//, '').slice(0, 60)) : 'vstavaný · ' + e(x.id)}${x.kind === 'builtin' && x.soon ? ' · čoskoro' : ''}</span></td>
<td>${enabled ? '<span class="badge ok">zapnuté</span>' : '<span class="badge bad">vypnuté</span>'}${x.kind === 'custom' && x.rec.minEur ? ` <span class="badge">min. ${e(x.rec.minEur)} €</span>` : ''}</td>
<td><div class="pm-actions">${mv('up', '↑', i === 0)}${mv('down', '↓', i === v.length - 1)}<a class="btn" href="/admin/platby/methods/edit/${e(x.id)}">Upraviť</a>
<form method="post" action="/admin/platby/methods/toggle/${e(x.id)}"><button class="secondary">${enabled ? 'Vypnúť' : 'Zapnúť'}</button></form>
${x.kind === 'custom' ? `<form method="post" action="/admin/platby/methods/delete/${e(x.id)}" data-confirm="Naozaj zmazať „${e(x.name)}“?"><button class="danger">Zmazať</button></form>` : ''}</div></td></tr>`;
    }).join('')}</tbody></table>`).join('');
    const del = customs().filter((r) => r.deleted);
    return page(req, 'Spôsoby platby', `<div class="card"><h1>💳 Spôsoby platby</h1><p class="muted">Pridávajte vlastné platobné odkazy, meňte logá, zapínajte/vypínajte a meňte poradie tlačidiel na pokladni. Zmeny sa prejavia okamžite.</p></div>
${rs ? rankCss + rankCard(rs) : ''}
<div class="card"><h2>➕ Nový spôsob platby</h2>${customForm()}</div>
<div class="card">${tbl}</div>
${del.length ? `<div class="card"><h2>🗑 Zmazané (${del.length})</h2><table class="pm"><tbody>${del.map((r) => `<tr><td>${logoTag(r.logo)}</td><td>${e(r.name)}<br><span class="muted">${e(r.url)}</span></td><td><form method="post" action="/admin/platby/methods/restore/${e(r.id)}"><button class="secondary">Obnoviť</button></form></td></tr>`).join('')}</tbody></table></div>` : ''}`, msg, err);
  }
  function editPage(req, id, err) {
    const r = S.items.get(id);
    if (r && r.kind === 'custom' && !r.deleted) return page(req, 'Upraviť spôsob platby', `<div class="card"><h1>Upraviť: ${e(r.name)}</h1>${customForm(r)}</div>`, '', err);
    const b = builtins().find((x) => x.id === id);
    if (!b) return null;
    const o = override(id) || {};
    return page(req, 'Upraviť spôsob platby', `<div class="card"><h1>Upraviť: ${e(b.label)}</h1><p class="muted">Vstavaný spôsob platby (${e(b.id)} · ${e(groupLabel(b.group))}). Predvolené logo: <span class="lgs">${defaultLogos(b.id, b.group).map((s) => logoTag(s)).join('') || 'žiadne'}</span></p>
<form method="post" action="/admin/platby/methods/save/${e(id)}" enctype="multipart/form-data">
<label>Názov na tlačidle (prázdne = predvolený „${e(b.label)}“)</label><input name="name" maxlength="60" value="${e(o.name || '')}">
<label class="chk"><input type="checkbox" name="enabled" value="1" ${!isBuiltinDisabled(id) ? 'checked' : ''}> Zapnuté (zobrazuje sa zákazníkom)</label>
${logoFields(o.logo, { builtin: true })}
<p><button>💾 Uložiť</button> <a href="/admin/platby/methods">Späť</a></p></form></div>`, '', err);
  }

  /* ---------- dashboard panel „Platobné odkazy“ (rendered on /admin/platby/sepa, the admin landing page) ---------- */
  const isOn = (x) => (x.kind === 'custom' ? x.rec.enabled !== false : !isBuiltinDisabled(x.id));
  function counts() {
    let on = 0, off = 0;
    for (const v of Object.values(rows())) for (const x of v) (isOn(x) ? on++ : off++);
    return { on, off, total: on + off };
  }
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
  const cap = (t) => String(t || '').replace(/^./, (c) => c.toUpperCase());
  function dashFlash(req) {
    const m = String(req.query.pm || ''); if (!m) return null;
    if (m === 'on' || m === 'off') {
      const id = String(req.query.pmid || '').toLowerCase();
      const r = S.items.get(id); const b = builtins().find((x) => x.id === id);
      const name = (r && r.kind === 'custom' && r.name) || (override(id) || {}).name || (b && b.label) || id;
      return m === 'on' ? `✅ „${name}“ je zapnuté – na pokladni sa zobrazuje.` : `⛔ „${name}“ je vypnuté – na pokladni sa už nezobrazuje a nedá sa ním platiť.`;
    }
    const g = m.match(/^g(on|off):([^:]+):(\d+)$/);
    if (g) return `${g[1] === 'on' ? '✅ Zapnuté' : '⛔ Vypnuté'}: skupina „${groupLabel(g[2])}“ (zmenených ${g[3]}).`;
    if (m === 'err') return '⚠️ Zmena sa nepodarila.';
    return null;
  }
  function dashboardPanel(req) {
    const all = rows();
    let live = {};
    try { live = (liveStatus && liveStatus()) || {}; } catch (x) { log('PAYMETHOD_LIVE_FAIL ' + x.message); }
    const builtinById = new Map(builtins().map((b) => [b.id, b]));
    let nOn = 0, nOff = 0, nSoon = 0;
    const groupsHtml = Object.entries(all).filter(([, v]) => v.length).map(([k, v]) => {
      const gl = groupLabel(k);
      const gOn = v.filter(isOn).length;
      const rowsHtml = v.map((x) => {
        const on = isOn(x); on ? nOn++ : nOff++;
        const logos = x.kind === 'custom' ? (x.rec.logo ? [x.rec.logo] : [GENERIC[GENERIC_BY_GROUP[x.group] || 'link'] || GENERIC.link]) : logosFor({ id: x.id, group: x.group });
        const b = builtinById.get(x.id);
        const st = x.kind === 'builtin' ? (live[x.id] || { soon: true, label: b && b.soon ? 'čoskoro' : 'dočasne nedostupné' }) : { soon: false };
        if (st.soon) nSoon++;
        let url = null;
        if (x.kind === 'custom') { try { url = buildUrl(x.rec, { amountEur: 20, orderId: 'TEST' }); } catch { url = null; } }
        else if (b && b.url) url = b.url;
        if (url && !/^https:\/\//i.test(url)) url = null;
        const meta = `${e(gl)} · ${x.kind === 'custom' ? 'vlastný odkaz' : 'vstavaný'} · <span class="mono">${e(x.id)}</span>`;
        return `<li class="pl-row${on ? '' : ' is-off'}" data-id="${e(x.id)}" data-on="${on ? 1 : 0}" data-soon="${st.soon ? 1 : 0}">
<span class="pl-logo">${logos.map((s2) => logoTag(s2, x.name)).join('') || logoTag(null)}</span>
<span class="pl-main"><b class="pl-name">${e(x.name)}</b><span class="pl-meta muted">${meta}</span></span>
<span class="pl-status"><span class="badge pl-state ${on ? 'ok' : 'bad'}">${on ? 'Zapnuté' : 'Vypnuté'}</span>${st.soon ? ` <span class="badge warn" title="Systém: ${e(st.label)}">${e(cap(st.label))}</span>` : ''}</span>
<span class="pl-acts"><form method="post" action="/admin/platby/methods/toggle/${e(x.id)}" class="pl-toggle" data-name="${e(x.name)}"><input type="hidden" name="state" value="${on ? 'off' : 'on'}"><input type="hidden" name="back" value="dash"><button type="submit" class="${on ? 'danger' : 'go'}" aria-label="${on ? 'Vypnúť' : 'Zapnúť'} ${e(x.name)}">${on ? 'Vypnúť' : 'Zapnúť'}</button></form>
${url ? `<a class="btn secondary" href="${e(url)}" target="_blank" rel="noopener noreferrer" title="${e(url)}">↗ Otvoriť odkaz</a>` : ''}<a class="btn secondary" href="/admin/platby/methods/edit/${e(x.id)}">✏️ Upraviť</a></span></li>`;
      }).join('');
      const gform = (state, label, cls) => `<form method="post" action="/admin/platby/methods/group/${e(k)}" data-confirm="Naozaj ${state === 'on' ? 'ZAPNÚŤ' : 'VYPNÚŤ'} všetky spôsoby platby v skupine „${e(gl)}“ (${v.length})? Zmena sa prejaví na pokladni okamžite."><input type="hidden" name="state" value="${state}"><button type="submit" class="${cls}">${label}</button></form>`;
      return `<section class="pl-group" data-group="${e(k)}"><div class="pl-ghead"><h2>${e(gl)} <span class="muted pl-gcount">${gOn}/${v.length} zapnutých</span></h2>
<div class="pl-gact">${gform('off', 'Vypnúť všetky', 'secondary')}${gform('on', 'Zapnúť všetky', 'secondary')}</div></div><ul class="pl-list">${rowsHtml}</ul></section>`;
    }).join('');
    const flash = dashFlash(req);
    const fbtn = (f, label, n) => `<button type="button" class="pl-f${f === 'all' ? ' is-active' : ''}" data-f="${f}" aria-pressed="${f === 'all'}">${label} <span class="pl-n" data-n="${f}">${n}</span></button>`;
    return `${dashCss}<div class="card pl" id="platobne-odkazy">
<div class="pl-head"><h1>🔗 Platobné odkazy</h1><a class="btn secondary" href="/admin/platby/methods">💳 Spravovať spôsoby platby</a></div>
<p class="muted">Ak niektorý odkaz nefunguje, vypnite ho jedným klikom – na verejnej pokladni sa okamžite skryje a nedá sa ním zaplatiť. Zapnutím sa hneď vráti.</p>
<p class="pl-sum"><b class="pl-c-on">${nOn} ${plural(nOn, 'zapnutý', 'zapnuté', 'zapnutých')}</b> / <b class="pl-c-off">${nOff} ${plural(nOff, 'vypnutý', 'vypnuté', 'vypnutých')}</b> <span class="muted">· spolu ${nOn + nOff} · ${nSoon} čoskoro / dočasne nedostupné</span></p>
<div class="pl-flash ${flash ? 'ok' : ''}" role="status" aria-live="polite"${flash ? '' : ' hidden'}>${flash ? e(flash) : ''}</div>
<div class="pl-filters" role="group" aria-label="Filter">${fbtn('all', 'Všetky', nOn + nOff)}${fbtn('on', 'Zapnuté', nOn)}${fbtn('off', 'Vypnuté', nOff)}${fbtn('soon', 'Čoskoro / dočasne nedostupné', nSoon)}
<input type="search" class="pl-q" placeholder="Hľadať názov…" aria-label="Hľadať spôsob platby"></div>
${groupsHtml}</div>${dashJs}`;
  }
  const dashCss = `<style>
.pl .lg{height:26px;max-width:72px;object-fit:contain;background:#fff;border-radius:6px;padding:2px 4px;vertical-align:middle}.pl .lg.none{background:transparent;color:#64748b}
.pl-head{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;justify-content:space-between}.pl-head h1{margin:0}
.pl-sum{font-size:1rem;margin:.6rem 0}.pl-c-on{color:#4ade80}.pl-c-off{color:#f87171}
.pl-flash{margin:.5rem 0}.pl-flash.bad{background:#3f1d1d;border:1px solid #7f1d1d;color:#fecaca;padding:.75rem;border-radius:10px}
.pl-filters{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 .2rem}.pl-filters .pl-f{background:#1e293b;color:var(--text);border:1px solid var(--line);font-weight:500;padding:.45rem .75rem}
.pl-filters .pl-f.is-active{background:var(--accent);border-color:var(--accent);color:#fff}.pl-n{opacity:.8;font-variant-numeric:tabular-nums}
.pl-q{flex:1 1 180px;min-width:0;width:auto;font-size:16px;padding:.5rem .75rem;border-radius:10px;border:1px solid var(--line);background:#0d1524;color:var(--text)}
.pl-group{border-top:1px solid var(--line);margin-top:.9rem;padding-top:.2rem}.pl-group[hidden],.pl-row[hidden]{display:none!important}
.pl-ghead{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between}.pl-ghead h2{margin:.7rem 0 .4rem}
.pl-gact{display:flex;gap:.4rem;flex-wrap:wrap}.pl-gact form,.pl-acts form{margin:0;display:inline}.pl-gact button{padding:.4rem .7rem;font-size:.85rem}
.pl-list{list-style:none;margin:0;padding:0}
.pl-row{display:grid;grid-template-columns:110px minmax(0,1fr) auto auto;gap:.4rem .8rem;align-items:center;padding:.55rem .25rem;border-bottom:1px solid var(--line)}
.pl-row.is-off .pl-logo,.pl-row.is-off .pl-main{opacity:.55}
.pl-logo{display:flex;gap:4px;flex-wrap:wrap;align-items:center}.pl-main{display:flex;flex-direction:column;min-width:0}.pl-name{overflow-wrap:anywhere}
.pl-meta{font-size:.78rem;overflow-wrap:anywhere}.pl-status{display:flex;flex-wrap:wrap;gap:.3rem;justify-content:flex-end;align-items:center}
.pl .badge{margin:0;border:0;padding:.2rem .6rem;font-size:.78rem;line-height:1.3;white-space:nowrap}.pl .badge.ok{background:#14532d;color:#bbf7d0}.pl .badge.bad{background:#7f1d1d;color:#fecaca}
.pl-row.is-off .pl-state{background:#475569;color:#f1f5f9;box-shadow:inset 0 0 0 1px #ef4444}.pl-acts{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}
.pl-acts button,.pl-acts .btn{padding:.45rem .75rem;font-size:.85rem;min-width:84px;text-align:center}
.pl button.danger{background:#b91c1c}.pl button.go{background:#15803d}.pl .btn.secondary{background:#334155;color:#fff}
.pl button[aria-busy=true]{opacity:.6;cursor:progress}
@media(max-width:820px){.pl-row{grid-template-columns:96px minmax(0,1fr) auto}.pl-acts{grid-column:1/-1;justify-content:flex-start}}
@media(max-width:640px){
 .pl-row{grid-template-columns:minmax(0,1fr);gap:.45rem;padding:.75rem;margin:0 0 .6rem;border:1px solid var(--line);border-radius:12px;background:#0d1524}
 .pl-status{justify-content:flex-start}.pl-acts{display:grid;grid-template-columns:1fr 1fr;gap:.45rem}
 .pl-acts form{display:block;grid-column:1/-1}.pl-acts button,.pl-acts .btn{width:100%;min-height:48px;font-size:1rem;display:flex;align-items:center;justify-content:center}
 .pl-acts .btn:only-of-type{grid-column:1/-1}
 .pl-gact{width:100%;display:grid;grid-template-columns:1fr 1fr}.pl-gact button{width:100%;min-height:48px;font-size:.95rem}
 .pl-filters .pl-f{min-height:44px;flex:1 1 auto}.pl-q{flex-basis:100%;min-height:48px}.pl-head .btn{width:100%;text-align:center;min-height:48px;display:flex;align-items:center;justify-content:center}
}
</style>`;
  const dashJs = `<script>(function(){
var root=document.getElementById('platobne-odkazy');if(!root)return;
var flash=root.querySelector('.pl-flash'),cur='all',q='';
function say(t,bad){flash.textContent=t;flash.className='pl-flash '+(bad?'bad':'ok');flash.hidden=false;}
function pl(n,a,b,c){return n===1?a:(n>=2&&n<=4?b:c);}
function recount(){var rows=root.querySelectorAll('.pl-row'),on=0,off=0,soon=0;
 rows.forEach(function(r){r.dataset.on==='1'?on++:off++;if(r.dataset.soon==='1')soon++;});
 root.querySelector('.pl-c-on').textContent=on+' '+pl(on,'zapnutý','zapnuté','zapnutých');
 root.querySelector('.pl-c-off').textContent=off+' '+pl(off,'vypnutý','vypnuté','vypnutých');
 var n={all:on+off,on:on,off:off,soon:soon};Object.keys(n).forEach(function(k){var el=root.querySelector('[data-n="'+k+'"]');if(el)el.textContent=n[k];});
 root.querySelectorAll('.pl-group').forEach(function(g){var rs=g.querySelectorAll('.pl-row'),c=0;rs.forEach(function(r){if(r.dataset.on==='1')c++;});g.querySelector('.pl-gcount').textContent=c+'/'+rs.length+' zapnutých';});}
function filter(){root.querySelectorAll('.pl-group').forEach(function(g){var vis=0;g.querySelectorAll('.pl-row').forEach(function(r){
 var ok=cur==='all'||(cur==='on'&&r.dataset.on==='1')||(cur==='off'&&r.dataset.on!=='1')||(cur==='soon'&&r.dataset.soon==='1');
 if(ok&&q){ok=(r.textContent||'').toLowerCase().indexOf(q)>=0;}r.hidden=!ok;if(ok)vis++;});g.hidden=!vis;});}
function paint(row,on){row.dataset.on=on?'1':'0';row.classList.toggle('is-off',!on);
 var b=row.querySelector('.pl-state');b.textContent=on?'Zapnuté':'Vypnuté';b.className='badge pl-state '+(on?'ok':'bad');
 var f=row.querySelector('.pl-toggle'),btn=f.querySelector('button');f.querySelector('[name=state]').value=on?'off':'on';
 btn.textContent=on?'Vypnúť':'Zapnúť';btn.className=on?'danger':'go';btn.setAttribute('aria-label',(on?'Vypnúť ':'Zapnúť ')+f.dataset.name);}
root.addEventListener('click',function(ev){var b=ev.target.closest('.pl-f');if(!b)return;cur=b.dataset.f;
 root.querySelectorAll('.pl-f').forEach(function(x){var a=x===b;x.classList.toggle('is-active',a);x.setAttribute('aria-pressed',a);});filter();});
root.querySelector('.pl-q').addEventListener('input',function(ev){q=ev.target.value.trim().toLowerCase();filter();});
root.addEventListener('submit',function(ev){var f=ev.target;
 if(f.getAttribute('data-confirm')&&!window.confirm(f.getAttribute('data-confirm'))){ev.preventDefault();return;}
 if(!f.classList.contains('pl-toggle')||!window.fetch)return;
 ev.preventDefault();var btn=f.querySelector('button');if(btn.getAttribute('aria-busy')==='true')return;btn.setAttribute('aria-busy','true');btn.disabled=true;
 var state=f.querySelector('[name=state]').value,row=f.closest('.pl-row');
 fetch(f.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({state:state})})
 .then(function(r){return r.json().catch(function(){return{ok:false,error:'HTTP '+r.status};});})
 .then(function(j){if(!j||!j.ok)throw new Error((j&&j.error)||'Chyba');paint(row,j.enabled);recount();filter();
   say(j.enabled?'✅ „'+j.name+'“ je zapnuté – na pokladni sa zobrazuje.':'⛔ „'+j.name+'“ je vypnuté – na pokladni sa už nezobrazuje a nedá sa ním platiť.');})
 .catch(function(x){say('⚠️ Zmena sa nepodarila: '+x.message+' – obnovte stránku a skúste znova.',true);})
 .then(function(){btn.disabled=false;btn.removeAttribute('aria-busy');});});
if(location.hash==='#platobne-odkazy'&&!flash.hidden)setTimeout(function(){flash.scrollIntoView({block:'center'});},50);
})();</script>`;
  require('./adminSepa').addDashboardPanel(dashboardPanel);

  const guard = (req, res) => { if (!sameOrigin(req)) { res.status(403).send('Zakázané'); return false; } return true; };
  const wrap = (fn) => (req, res) => fn(req, res).catch((x) => { log('PAYMETHOD_ERR ' + x.message); if (!res.headersSent) res.status(500).type('html').send(list(req, '', x.message)); });
  const back = (res, m) => res.redirect(303, '/admin/platby/methods' + (m ? '?m=' + m : ''));
  /** Category admin (/admin/platby/kategorie/…) posts here with back=<its own path>; only that exact admin path shape is honoured. */
  const catBack = (req, res, m) => { const b = String((req.body || {}).back || ''); if (!/^\/admin\/kategorie(\/[a-z0-9_]{1,32})?$/.test(b)) return false; res.redirect(303, b + '?m=' + m); return true; };
  const MSG = { added: 'Spôsob platby pridaný.', saved: 'Uložené.', toggled: 'Stav zmenený.', moved: 'Poradie zmenené.', rank: 'Poradie na pokladni uložené.', rankerr: 'Zmena poradia sa nepodarila.', deleted: 'Zmazané (dá sa obnoviť nižšie).', restored: 'Obnovené.' };

  const rankNow = async () => { const pv = preview ? await preview() : null; return { pv, rs: rankState(pv || {}, feeOf) }; };
  app.get('/admin/platby/methods', wrap(async (req, res) => { nostore(res); const { rs } = await rankNow(); res.type('html').send(list(req, MSG[req.query.m] || '', '', rs)); }));
  const backRank = (res, m) => res.redirect(303, '/admin/platby/methods?m=' + m + '#poradie');
  app.post('/admin/platby/methods/rank/auto', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const on = String((req.body || {}).auto) === '1';
    await rankSetAuto(on); log(`PAYMETHOD_RANK_AUTO ${on} by=${req.adminSession.email}`); backRank(res, 'rank');
  }));
  app.post('/admin/platby/methods/rank/pin/:id', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const id = String(req.params.id).toLowerCase(); const on = String((req.body || {}).pin) === '1';
    const { rs } = await rankNow();
    const ok = await rankSetPin(id, on, new Set(rs.methods.map((m) => m.id)));
    if (ok) log(`PAYMETHOD_RANK_${on ? 'PIN' : 'UNPIN'} ${id} by=${req.adminSession.email}`);
    backRank(res, ok ? 'rank' : 'rankerr');
  }));
  app.post('/admin/platby/methods/rank/group', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const { rs } = await rankNow(); const g = String((req.body || {}).group || '');
    const ok = await rankGroupMove(g, (req.body || {}).dir, rs.groups.map((x) => x.key));
    if (ok) log(`PAYMETHOD_RANK_GROUP ${g} ${(req.body || {}).dir === 'up' ? 'up' : 'down'} by=${req.adminSession.email}`);
    backRank(res, ok ? 'rank' : 'rankerr');
  }));
  app.post('/admin/platby/methods/rank/recompute', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    await methodRank.flush().catch(() => {}); await methodRank.recompute(); log(`PAYMETHOD_RANK_RECOMPUTE by=${req.adminSession.email}`); backRank(res, 'rank');
  }));
  app.get('/admin/platby/methods/edit/:id', (req, res) => {
    nostore(res); const html = editPage(req, String(req.params.id).toLowerCase());
    if (!html) return res.status(404).type('html').send(list(req, '', 'Spôsob platby sa nenašiel.'));
    res.type('html').send(html);
  });
  async function customFromFields(fields, files, prev = {}) {
    const name = String(fields.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Zadajte názov.');
    const group = String(fields.group || 'keyless');
    if (!validGroup(group)) throw new Error('Neplatná kategória.');
    const url = cleanUrl(fields.url);
    const minRaw = String(fields.minEur || '').trim().replace(',', '.');
    const minEur = minRaw === '' ? null : Number(minRaw);
    if (minEur != null && (!Number.isFinite(minEur) || minEur < 0 || minEur > 100000)) throw new Error('Neplatná minimálna suma.');
    return {
      ...prev, kind: 'custom', name, group, url, minEur: minEur || null,
      description: String(fields.description || '').trim().slice(0, 600),
      mode: fields.mode === 'link' ? 'link' : 'btc', proofForm: !!fields.proofForm, enabled: !!fields.enabled,
      logo: await resolveLogo(fields, files, prev.logo),
    };
  }
  app.post('/admin/platby/methods/new', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    try {
      const { fields, files } = await readMultipart(req);
      let id = 'cm_' + slug(fields.name); if (S.items.has(id)) id += '_' + crypto.randomBytes(3).toString('hex');
      const rec = await customFromFields(fields, files, { id, createdAt: new Date().toISOString(), createdBy: req.adminSession.email });
      await put(rec);
      log(`PAYMETHOD_ADDED ${id} group=${rec.group} by=${req.adminSession.email}`);
      back(res, 'added');
    } catch (x) { res.status(400).type('html').send(list(req, '', x.message)); }
  });
  app.post('/admin/platby/methods/save/:id', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const id = String(req.params.id).toLowerCase();
    try {
      const { fields, files } = await readMultipart(req);
      const r = S.items.get(id);
      if (r && r.kind === 'custom') {
        await put(await customFromFields(fields, files, r));
      } else {
        const b = builtins().find((x) => x.id === id); if (!b) throw new Error('Spôsob platby sa nenašiel.');
        const o = override(id) || { id: 'ov:' + id, kind: 'override', builtin: id };
        o.name = String(fields.name || '').trim().slice(0, 60) || null;
        o.enabled = !!fields.enabled;
        o.hideLogo = !!fields.hideLogo;
        o.logo = await resolveLogo(fields, files, o.logo);
        await put(o);
      }
      log(`PAYMETHOD_SAVED ${id} by=${req.adminSession.email}`);
      back(res, 'saved');
    } catch (x) { const html = editPage(req, id, x.message); res.status(400).type('html').send(html || list(req, '', x.message)); }
  });
  /** Same enable/disable logic for /admin/platby/methods and the dashboard panel. want: true/false, or null = flip. */
  async function setEnabled(id, want) {
    const r = S.items.get(id);
    if (r && r.kind === 'custom' && !r.deleted) {
      const enabled = want == null ? r.enabled === false : want;
      if ((r.enabled !== false) !== enabled) await put({ ...r, enabled });
      return { id, name: r.name, enabled };
    }
    const b = builtins().find((x) => x.id === id);
    if (!b) return null;
    const o = override(id) || { id: 'ov:' + id, kind: 'override', builtin: id };
    const cur = !isBuiltinDisabled(id);
    const enabled = want == null ? !cur : want;
    if (cur !== enabled) await put({ ...o, enabled });
    return { id, name: o.name || b.label, enabled };
  }
  const wantState = (req) => { const v = String((req.body || {}).state || '').toLowerCase(); return v === 'on' ? true : v === 'off' ? false : null; };
  const wantsJson = (req) => req.is('application/json') || /application\/json/.test(String(req.headers.accept || ''));
  const toDash = (res, m, id) => res.redirect(303, `/admin/platby/sepa?pm=${encodeURIComponent(m)}${id ? '&pmid=' + encodeURIComponent(id) : ''}#platobne-odkazy`);
  app.post('/admin/platby/methods/toggle/:id', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const id = String(req.params.id).toLowerCase();
    const json = wantsJson(req);
    const out = await setEnabled(id, wantState(req));
    if (!out) { if (json) return res.status(404).json({ ok: false, error: 'Spôsob platby sa nenašiel.' }); return back(res, ''); }
    log(`PAYMETHOD_TOGGLED ${id} enabled=${out.enabled} by=${req.adminSession.email}`);
    if (json) return res.json({ ok: true, ...out, counts: counts() });
    if ((req.body || {}).back === 'dash') return toDash(res, out.enabled ? 'on' : 'off', id);
    if (catBack(req, res, 'toggled')) return;
    back(res, 'toggled');
  }));
  /** Dashboard: switch a whole group on/off. */
  app.post('/admin/platby/methods/group/:group', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const group = String(req.params.group); const want = wantState(req);
    const json = wantsJson(req);
    const items = rows()[group];
    if (!items || want == null) { if (json) return res.status(400).json({ ok: false, error: 'Neplatná skupina alebo stav.' }); return toDash(res, 'err'); }
    let changed = 0;
    for (const x of items) {
      const before = x.kind === 'custom' ? x.rec.enabled !== false : !isBuiltinDisabled(x.id);
      if (before !== want) { await setEnabled(x.id, want); changed++; }
    }
    log(`PAYMETHOD_GROUP ${group} enabled=${want} changed=${changed} by=${req.adminSession.email}`);
    if (json) return res.json({ ok: true, group, enabled: want, changed, counts: counts() });
    toDash(res, (want ? 'gon:' : 'goff:') + group + ':' + changed);
  }));
  app.post('/admin/platby/methods/move/:id', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const id = String(req.params.id).toLowerCase(); const group = String((req.body || {}).group || '');
    const list0 = (rows()[group] || []).map((x) => x.id); const i = list0.indexOf(id);
    if (i >= 0) {
      const j = (req.body || {}).dir === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < list0.length) { [list0[i], list0[j]] = [list0[j], list0[i]]; await put({ id: 'order:' + group, kind: 'order', group, ids: list0 }); }
    }
    if (catBack(req, res, 'moved')) return;
    back(res, 'moved');
  }));
  app.post('/admin/platby/methods/delete/:id', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const id = String(req.params.id).toLowerCase(); const r = S.items.get(id);
    if (r && r.kind === 'custom') { await put({ ...r, deleted: true, deletedAt: new Date().toISOString() }); log(`PAYMETHOD_DELETED ${id} by=${req.adminSession.email}`); }
    back(res, 'deleted');
  }));
  app.post('/admin/platby/methods/restore/:id', wrap(async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const id = String(req.params.id).toLowerCase(); const r = S.items.get(id);
    if (r && r.kind === 'custom') await put({ ...r, deleted: false, deletedAt: null });
    back(res, 'restored');
  }));

  /* ---------- signed admin bridge for the lnkbio admin dashboard (server-to-server, HMAC, no passwords) ---------- */
  mountBridge(app, { rows, groupsAll, groupLabel, isOn, counts, setEnabled, customFromFields, builtins, liveStatus, rankNow });
}

/**
 * POST /api/admin-bridge/pay-methods  — one endpoint, body {action, ...}.
 * Auth: env PAY_ADMIN_BRIDGE_SECRET (same value on lnkbio + checkout). Headers:
 *   X-Bridge-Ts: unix seconds (±300 s) ; X-Bridge-Sig: hex HMAC_SHA256(secret, ts + "." + rawBody)
 * Replays (same signature) are rejected. Without the env var the endpoint answers 503 (feature off).
 */
const BRIDGE_PATH = '/api/admin-bridge/pay-methods';
function bridgeSecret() { const v = String(process.env.PAY_ADMIN_BRIDGE_SECRET || ''); return v.length >= 32 ? v : ''; }
function bridgeVerify(req, raw) {
  const sec = bridgeSecret(); if (!sec) return 'off';
  const ts = Number(req.headers['x-bridge-ts'] || 0); const sig = String(req.headers['x-bridge-sig'] || '');
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300 || !/^[a-f0-9]{64}$/.test(sig)) return 'bad';
  const want = crypto.createHmac('sha256', sec).update(ts + '.').update(raw).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return 'bad';
  const now = Date.now();
  for (const [k, t] of SEEN) if (now - t > 600e3) SEEN.delete(k);
  if (SEEN.has(sig)) return 'replay';
  SEEN.set(sig, now);
  return 'ok';
}
const SEEN = new Map();
const bridgeHits = new Map();
function mountBridge(app, h) {
  const absUrl = (u) => (u && /^https:\/\//i.test(u) ? u : null);
  function state() {
    const all = h.rows();
    let live = {};
    try { live = (h.liveStatus && h.liveStatus()) || {}; } catch { live = {}; }
    const bi = new Map(h.builtins().map((b) => [b.id, b]));
    const groups = Object.entries(all).filter(([, v]) => v.length).map(([k, v]) => ({
      key: k, label: h.groupLabel(k),
      items: v.map((x) => {
        const b = bi.get(x.id);
        const st = x.kind === 'builtin' ? (live[x.id] || { soon: true, label: b && b.soon ? 'čoskoro' : 'dočasne nedostupné' }) : { soon: false, label: null };
        let url = null;
        if (x.kind === 'custom') { try { url = buildUrl(x.rec, { amountEur: 20, orderId: 'TEST' }); } catch { url = null; } } else if (b) url = b.url;
        return {
          id: x.id, kind: x.kind, name: x.name, origName: x.origName || null, on: h.isOn(x), soon: !!st.soon, soonLabel: st.soon ? st.label : null,
          logos: x.kind === 'custom' ? (x.rec.logo ? [x.rec.logo] : [GENERIC[GENERIC_BY_GROUP[x.group] || 'link'] || GENERIC.link]) : logosFor({ id: x.id, group: x.group }),
          url: absUrl(url), target: x.kind === 'custom' ? x.rec.url : null, minEur: x.kind === 'custom' ? x.rec.minEur || null : null,
        };
      }),
    }));
    const deleted = customs().filter((r) => r.deleted).map((r) => ({ id: r.id, name: r.name, url: r.url, logo: r.logo || null }));
    return { ok: true, groups, deleted, counts: h.counts(), groupChoices: h.groupsAll().map(([k, v]) => [k, (CATEGORY_CHOICES.find((c) => c[0] === k) || [k, v])[1]]),
      library: libraryLogos().filter((f) => !f.startsWith('generic-')).map((f) => ({ file: f, src: L(f) })) };
  }
  function detail(id) {
    const r = S.items.get(id);
    if (r && r.kind === 'custom' && !r.deleted) return { ok: true, kind: 'custom', id, rec: { id: r.id, name: r.name, group: r.group, url: r.url, description: r.description || '', minEur: r.minEur, mode: r.mode || 'btc', proofForm: r.proofForm !== false, enabled: r.enabled !== false, logo: r.logo || null } };
    const b = h.builtins().find((x) => x.id === id);
    if (!b) return null;
    const o = override(id) || {};
    return { ok: true, kind: 'builtin', id, label: b.label, group: b.group, groupLabel: h.groupLabel(b.group), defaultLogos: defaultLogos(b.id, b.group),
      rec: { name: o.name || '', enabled: !isBuiltinDisabled(id), hideLogo: !!o.hideLogo, logo: o.logo || null } };
  }
  const filesOf = (logo) => {
    if (!logo || !logo.b64) return [];
    const buf = Buffer.from(String(logo.b64), 'base64');
    return buf.length ? [{ field: 'logo', name: String(logo.name || 'logo'), buf }] : [];
  };
  const fieldsOf = (f) => { const o = {}; for (const [k, v] of Object.entries(f || {})) if (v != null && typeof v !== 'object') o[k] = String(v); return o; };
  const ACTIONS = {
    state: async () => state(),
    get: async (b) => detail(String(b.id || '').toLowerCase()) || { ok: false, status: 404, error: 'Spôsob platby sa nenašiel.' },
    toggle: async (b) => {
      const v = String(b.state || '').toLowerCase(); const want = v === 'on' ? true : v === 'off' ? false : null;
      const out = await h.setEnabled(String(b.id || '').toLowerCase(), want);
      if (!out) return { ok: false, status: 404, error: 'Spôsob platby sa nenašiel.' };
      log(`PAYMETHOD_TOGGLED ${out.id} enabled=${out.enabled} by=lnkbio-admin`);
      return { ok: true, ...out, counts: h.counts() };
    },
    group: async (b) => {
      const group = String(b.group || ''); const v = String(b.state || '').toLowerCase(); const want = v === 'on' ? true : v === 'off' ? false : null;
      const items = h.rows()[group];
      if (!items || want == null) return { ok: false, status: 400, error: 'Neplatná skupina alebo stav.' };
      let changed = 0;
      for (const x of items) if (h.isOn(x) !== want) { await h.setEnabled(x.id, want); changed++; }
      log(`PAYMETHOD_GROUP ${group} enabled=${want} changed=${changed} by=lnkbio-admin`);
      return { ok: true, group, label: h.groupLabel(group), enabled: want, changed, counts: h.counts() };
    },
    move: async (b) => {
      const id = String(b.id || '').toLowerCase(); const group = String(b.group || '');
      const list0 = (h.rows()[group] || []).map((x) => x.id); const i = list0.indexOf(id);
      if (i < 0) return { ok: false, status: 404, error: 'Spôsob platby sa nenašiel.' };
      const j = b.dir === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < list0.length) { [list0[i], list0[j]] = [list0[j], list0[i]]; await put({ id: 'order:' + group, kind: 'order', group, ids: list0 }); }
      return { ok: true };
    },
    create: async (b) => {
      const fields = fieldsOf(b.fields);
      let id = 'cm_' + slug(fields.name); if (S.items.has(id)) id += '_' + crypto.randomBytes(3).toString('hex');
      const rec = await h.customFromFields(fields, filesOf(b.logo), { id, createdAt: new Date().toISOString(), createdBy: 'lnkbio-admin' });
      await put(rec);
      log(`PAYMETHOD_ADDED ${id} group=${rec.group} by=lnkbio-admin`);
      return { ok: true, id, name: rec.name };
    },
    save: async (b) => {
      const id = String(b.id || '').toLowerCase(); const fields = fieldsOf(b.fields); const files = filesOf(b.logo);
      const r = S.items.get(id);
      if (r && r.kind === 'custom') await put(await h.customFromFields(fields, files, r));
      else {
        const bi = h.builtins().find((x) => x.id === id); if (!bi) return { ok: false, status: 404, error: 'Spôsob platby sa nenašiel.' };
        const o = override(id) || { id: 'ov:' + id, kind: 'override', builtin: id };
        o.name = String(fields.name || '').trim().slice(0, 60) || null;
        o.enabled = !!fields.enabled; o.hideLogo = !!fields.hideLogo;
        o.logo = await resolveLogoShared(fields, files, o.logo);
        await put(o);
      }
      log(`PAYMETHOD_SAVED ${id} by=lnkbio-admin`);
      return { ok: true, id };
    },
    delete: async (b) => {
      const id = String(b.id || '').toLowerCase(); const r = S.items.get(id);
      if (!r || r.kind !== 'custom') return { ok: false, status: 404, error: 'Zmazať sa dajú len vlastné odkazy.' };
      await put({ ...r, deleted: true, deletedAt: new Date().toISOString() }); log(`PAYMETHOD_DELETED ${id} by=lnkbio-admin`);
      return { ok: true, id, name: r.name };
    },
    rank_state: async () => (await h.rankNow()).rs,
    rank_auto: async (b) => {
      const on = b.auto === true || String(b.auto) === '1' || String(b.auto) === 'on';
      await rankSetAuto(on); log(`PAYMETHOD_RANK_AUTO ${on} by=lnkbio-admin`); return { ok: true, auto: on };
    },
    rank_pin: async (b) => {
      const id = String(b.id || '').toLowerCase(); const on = b.pin === true || String(b.pin) === '1';
      const { rs } = await h.rankNow();
      if (!(await rankSetPin(id, on, new Set(rs.methods.map((m) => m.id))))) return { ok: false, status: 404, error: 'Spôsob platby sa nenašiel.' };
      log(`PAYMETHOD_RANK_${on ? 'PIN' : 'UNPIN'} ${id} by=lnkbio-admin`); return { ok: true, id, pinned: on };
    },
    rank_group_move: async (b) => {
      const { rs } = await h.rankNow(); const g = String(b.group || '');
      if (!(await rankGroupMove(g, b.dir, rs.groups.map((x) => x.key)))) return { ok: false, status: 404, error: 'Skupina sa nenašla.' };
      log(`PAYMETHOD_RANK_GROUP ${g} ${b.dir === 'up' ? 'up' : 'down'} by=lnkbio-admin`); return { ok: true };
    },
    rank_recompute: async () => { await methodRank.flush().catch(() => {}); await methodRank.recompute(); log('PAYMETHOD_RANK_RECOMPUTE by=lnkbio-admin'); return { ok: true }; },
    restore: async (b) => {
      const id = String(b.id || '').toLowerCase(); const r = S.items.get(id);
      if (!r || r.kind !== 'custom') return { ok: false, status: 404, error: 'Spôsob platby sa nenašiel.' };
      await put({ ...r, deleted: false, deletedAt: null }); log(`PAYMETHOD_RESTORED ${id} by=lnkbio-admin`);
      return { ok: true, id, name: r.name };
    },
  };
  serveSigned(app, BRIDGE_PATH, ACTIONS, 'PAYMETHOD');
}

/** Shared signed-bridge endpoint (same HMAC secret, replay cache and rate limit for every /api/admin-bridge/* path). */
function serveSigned(app, routePath, ACTIONS, tag) {
  // merged into lnkbio: lnkbio's admin calls the same actions in-process (pay/index.js callBridge), no HTTP/HMAC hop
  (global.__payBridge = global.__payBridge || {})[routePath] = ACTIONS;
  const express = require('express');
  const raw = express.raw({ type: () => true, limit: '1500kb' });
  app.post(routePath, raw, async (req, res) => {
    nostore(res);
    const ip = String(req.ip || ''); const now = Date.now();
    const hit = bridgeHits.get(ip) || []; const recent = hit.filter((t) => now - t < 60e3); recent.push(now); bridgeHits.set(ip, recent);
    if (recent.length > 120) return res.status(429).json({ ok: false, error: 'Príliš veľa požiadaviek' });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const v = bridgeVerify(req, body);
    if (v === 'off') return res.status(503).json({ ok: false, error: 'not_configured' });
    if (v === 'replay') return res.status(409).json({ ok: false, error: 'replay' });
    if (v !== 'ok') { log(tag + '_BRIDGE_DENIED ' + ip.slice(0, 45)); return res.status(401).json({ ok: false, error: 'unauthorized' }); }
    let b; try { b = JSON.parse(body.toString('utf8') || '{}'); } catch { return res.status(400).json({ ok: false, error: 'bad json' }); }
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, String(b.action || '')) ? ACTIONS[String(b.action)] : null;
    if (!fn) return res.status(400).json({ ok: false, error: 'unknown action' });
    try {
      const out = await fn(b);
      res.status(out && out.status ? out.status : 200).json(out);
    } catch (x) { log(tag + '_BRIDGE_ERR ' + x.message); res.status(400).json({ ok: false, error: x.message }); }
  });
  app.get(routePath, (req, res) => { nostore(res); res.json({ ok: true, configured: !!bridgeSecret() }); });
}

/** Public: uploaded / downloaded logos (content-hash ids). */
function register(app) {
  app.get('/pm-logo/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{24}$/.test(id)) return res.status(404).end();
    const r = await getLogo(id);
    if (!r) return res.status(404).end();
    res.set({ 'Content-Type': r.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cross-Origin-Resource-Policy': 'same-site' });
    res.send(Buffer.isBuffer(r.buf) ? r.buf : Buffer.from(r.buf));
  });
}

/** Read-only hooks for the category admin (filled in mount). */
const ADMIN = {};
module.exports = { ADMIN, BRIDGE_PATH, serveSigned, sameOrigin, nostore, customs, init, mount, register, apply, customFor, isBuiltinDisabled, buildUrl, defaultLogos, EXTRA_GROUPS, _sniffImage: sniffImage, _svgSafe: svgSafe };
