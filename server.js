'use strict';
const { tx } = require('./uitext');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ENV_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SECRET = process.env.SESSION_SECRET || '';
const PROD = process.env.NODE_ENV === 'production';
if (!ENV_HASH || SECRET.length < 32 || !process.env.DATABASE_URL) { console.error('Missing ADMIN_PASSWORD_HASH / SESSION_SECRET / DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: PROD || process.env.PGSSL !== '0' ? { rejectUnauthorized: true } : false, max: 5, keepAlive: true, idleTimeoutMillis: 300000 });
pool.on('error', e => console.error('pg pool', e.message));
const RESERVED = new Set(['admin', 'api', 'static', 'healthz', 'favicon.ico', 'robots.txt', 'theme.css', 'img', 's', 'qr', 'login', 'logout', 'www', 'static', 'assets', 'platby', 'navody-img']);
const CODE_RE = /^[a-z0-9-]{1,40}$/;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const rndCode = () => Array.from(crypto.randomBytes(7), b => B62[b % 62]).join('');
const BRANDS = { '': '— bez značky —', telegram: 'Telegram', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', x: 'X', youtube: 'YouTube', signal: 'Signal', email: 'Email', web: 'Web', platby: 'Platby' };
const SLUG_RE = /^[a-z0-9-]{1,30}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;

// ---- theme presets / fonts ----
const PRESETS = {
  tvsoft: { name: 'TV Software', c_bg: '#07080f', c_card: '#141a2e', c_btntext: '#f5f7ff', c_text: '#e6e9f5', layout: 'tv' },
  kava: { name: 'Káva', c_bg: '#1b120d', c_card: '#2e1f16', c_btntext: '#fff7ee', c_text: '#f3e6d8', layout: 'classic' },
  tmava: { name: 'Tmavá', c_bg: '#0f1115', c_card: '#1f2430', c_btntext: '#ffffff', c_text: '#e5e7eb', layout: 'classic' },
  svetla: { name: 'Svetlá', c_bg: '#f7f5f2', c_card: '#ffffff', c_btntext: '#1f2937', c_text: '#1f2937', layout: 'classic' },
  moda: { name: 'Modá', c_bg: '#0b1d3a', c_card: '#1e40af', c_btntext: '#ffffff', c_text: '#dbeafe', layout: 'classic' },
};
const FONTS = {
  system: { name: 'Systémové (sans-serif)', css: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' },
  serif: { name: 'Pätkové (serif)', css: 'Georgia,Cambria,"Times New Roman",Times,serif' },
  mono: { name: 'Neproporcionálne (mono)', css: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace' },
  rounded: { name: 'Zaoblené', css: 'ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN",Quicksand,Nunito,system-ui,sans-serif' },
  humanist: { name: 'Humanistické', css: 'Seravek,"Gill Sans Nova",Ubuntu,Calibri,"DejaVu Sans",source-sans-pro,sans-serif' },
};
function brandSvg(d, c) { return `<svg class="sico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="11" fill="#fff"/><path fill="${c}" d="${d}"/></svg>`; }
const SOCIALS = [
  ['telegram', 'Telegram', '✈️'], ['instagram', 'Instagram', '📷'], ['facebook', 'Facebook', '📘'],
  ['x', 'X', '✖️'], ['tiktok', 'TikTok', '🎵'], ['whatsapp', 'WhatsApp', '💬'], ['signal', 'Signal', '🔒'], ['youtube', 'YouTube', '▶️'], ['email', 'E-mail', '✉️'],
  // group links – official brand marks (Simple Icons, CC0) on a white disc, attributes only (CSP: no inline styles)
  ['tg_group', 'Telegram skupina', brandSvg('M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z', '#26A5E4')],
  ['fb_group', 'Facebook skupina', brandSvg('M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z', '#0866FF')],
];
// on/off switches for group links (separate keys – not soc_* so they are neither encrypted nor URL-validated)
const SOC_TOGGLE = ['tg_group', 'fb_group'];
const socOn = (s, k) => !!s['soc_' + k] && (!SOC_TOGGLE.includes(k) || s['socon_' + k] !== '0');
const LNK_PUBLIC = String(process.env.LNKBIO_PUBLIC_URL || 'https://lnkbio.onrender.com').replace(/\/$/, '');
const CHECKOUT_ORIGIN = String(process.env.CHECKOUT_PUBLIC_URL || 'https://chain2pay-checkout-gl.onrender.com').replace(/\/$/, '');
const SHORT_PAY = LNK_PUBLIC + '/platby';
const DEFAULTS = {
  slug: 'tv', title: 'TV Software', bio: 'Softvér pre TV a streamovanie • Jednoduchá inštalácia • Platba kryptom aj kartou',
  meta_title: '', meta_desc: '', footer: '', preset: 'tvsoft', ...Object.fromEntries(Object.entries(PRESETS.tvsoft).filter(([k]) => k !== 'name')),
  btn_style: 'rounded', font: 'system', about_text: 'Vyvíjame a dodávame softvér pre TV a streamovanie – prehrávače, aplikácie pre Android TV a Smart TV a pomoc s inštaláciou.\n\nZáleží nám na jednoduchom ovládaní, rýchlej podpore a férovom prístupe.', contact_text: 'Napíšte nám – radi poradíme s výberom aj inštaláciou.', pay_text: 'Platiť môžete kartou alebo kryptomenami cez zabezpečenú platobnú bránu.', checkout_url: SHORT_PAY, chat_enabled: '1', title_en: '', bio_en: '', about_text_en: '', pay_text_en: '', contact_text_en: '', pricing_intro: '', pricing_intro_en: '', pricing_note: 'Každý plán obsahuje všetky kanály z našej ponuky. Po kliknutí na „Vybrať platbu“ uvidíte všetky spôsoby platby vhodné pre danú sumu (karta, bankový prevod, kryptomeny…) zoradené od najlacnejšieho. Aktivácia prebehne po potvrdení platby.\n\nPodmienky vrátenia peňazí a obchodné podmienky: DOPLŇTE v admin › Cenník.', pricing_note_en: 'Every plan includes all channels in our offer. After clicking “Choose payment” you will see all payment methods suitable for the amount (card, bank transfer, crypto…) sorted from the cheapest. Activation follows payment confirmation.\n\nRefund policy and terms: TO BE FILLED IN admin › Pricing.', stav_nav: '0', ui_texts: '{}', cen_home: '1', tvbar_on: '1', kan_intro: '', kan_intro_en: '', kan_status: '1', kan_catalog: '0', ver: '1', pwver: '0', ...Object.fromEntries(SOCIALS.map(([k]) => ['soc_' + k, ''])), socon_tg_group: '1', socon_fb_group: '1',
};

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS buttons (id SERIAL PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', pos INT NOT NULL DEFAULT 0)`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS newtab BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`CREATE TABLE IF NOT EXISTS images (k TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, ver TEXT NOT NULL)`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS short_links (code TEXT PRIMARY KEY, target_url TEXT NOT NULL, expires_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const base = { slug: DEFAULTS.slug, title: DEFAULTS.title, bio: DEFAULTS.bio };
  for (const [k, v] of Object.entries(DEFAULTS)) await pool.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING`, [k, v]);
  const r = await pool.query(`INSERT INTO settings (k,v) VALUES ('seeded','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  const m = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_kava','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m.rowCount) for (const [k, v] of Object.entries(base)) await pool.query(`UPDATE settings SET v=$2 WHERE k=$1`, [k, v]);
  if (r.rowCount) await pool.query(`INSERT INTO buttons (label,url,emoji,pos,brand) VALUES ($1,$2,$3,1,'platby')`, ['Platby', 'https://chain2pay-checkout-gl.onrender.com', '💳']);
  const tv = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_tvsoft','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (tv.rowCount) {
    const { name, ...cols } = PRESETS.tvsoft;
    await setSettings({ ...base, ...cols, preset: 'tvsoft' });
    await pool.query(`UPDATE buttons SET brand='platby' WHERE label='Platby'`);
  }
  const sp = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_shortpay','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (sp.rowCount) {
    await pool.query(`UPDATE buttons SET url=$1 WHERE url IN ('https://chain2pay-checkout-gl.onrender.com','https://chain2pay-checkout-gl.onrender.com/')`, [SHORT_PAY]);
    await pool.query(`UPDATE settings SET v=$1 WHERE k='checkout_url' AND v IN ('https://chain2pay-checkout-gl.onrender.com','https://chain2pay-checkout-gl.onrender.com/')`, [SHORT_PAY]);
  }
}
// ---- AES-256-GCM encryption at rest for sensitive settings (contacts) ----
const ENC_KEY = /^[0-9a-f]{64}$/i.test(process.env.DATA_ENC_KEY || '') ? Buffer.from(process.env.DATA_ENC_KEY, 'hex') : null;
if (!ENC_KEY) { console.error('Missing/invalid DATA_ENC_KEY (64 hex chars)'); process.exit(1); }
const isEncKey = k => /^soc_/.test(k) || k === 'contact_text' || k === 'contact_text_en' || k === 'totp_secret' || k === 'totp_pending';
function encrypt(buf, aad = 'linkbio') {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function decrypt(o, aad = 'linkbio') {
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(o.iv, 'base64')); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(o.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]);
}
const encV = (k, v) => { v = String(v); if (!isEncKey(k) || !v) return v; const e = encrypt(Buffer.from(v), 'set:' + k); return `enc:v1:${e.iv}:${e.tag}:${e.ct}`; };
const decV = (k, v) => { if (typeof v !== 'string' || !v.startsWith('enc:v1:')) return v; const [, , iv, tag, ct] = v.split(':'); try { return decrypt({ iv, tag, ct }, 'set:' + k).toString(); } catch { console.error('decrypt failed', k); return ''; } };
let cache = null;
async function getSettings() {
  if (cache) return cache;
  const r = await pool.query(`SELECT k,v FROM settings`);
  const s = { ...DEFAULTS }; r.rows.forEach(x => { s[x.k] = decV(x.k, x.v); }); UI.setOverrides(s.ui_texts);
  const im = await pool.query(`SELECT k,ver FROM images`);
  s.img = {}; im.rows.forEach(x => { s.img[x.k] = x.ver; });
  return (cache = s);
}
// write several settings atomically and bump the settings version (cache busting for /theme.css)
async function setSettings(obj) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(obj)) await c.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, encV(k, v)]);
    await c.query(`UPDATE settings SET v=(COALESCE(NULLIF(v,''),'0')::bigint+1)::text WHERE k='ver'`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); cache = null; }
}
let bcache = null;
const getButtons = async () => bcache || (bcache = (await pool.query(`SELECT id,label,url,emoji,pos,enabled,newtab,start_at,end_at,brand,section FROM buttons ORDER BY pos, id`)).rows);
const bq = async (q, a) => { try { return await pool.query(q, a); } finally { bcache = null; } };

const esc = s => String(s == null ? '' : s).replace(/[&<>"'`=\/]/g, c => '&#' + c.charCodeAt(0) + ';');
function safeUrl(u) {
  u = String(u || '').trim();
  if (u.length > 2000) return null;
  try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch { return null; }
}
// Europe/Zurich <-> UTC for datetime-local inputs
const TZ = 'Europe/Zurich';
function tzOffsetMs(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
function zurichToDate(v) {
  v = String(v || '').trim(); if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v); if (!m) return undefined;
  const guess = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  let t = guess - tzOffsetMs(new Date(guess)); t = guess - tzOffsetMs(new Date(t));
  return isNaN(t) ? undefined : new Date(t);
}
function dateToZurich(d) {
  if (!d) return ''; d = new Date(d);
  return new Date(d.getTime() + tzOffsetMs(d)).toISOString().slice(0, 16);
}
const fmtZ = d => d ? dateToZurich(d).replace('T', ' ') : '';
const inWindow = (b, now = Date.now()) => (!b.start_at || new Date(b.start_at).getTime() <= now) && (!b.end_at || new Date(b.end_at).getTime() > now);
const EMAIL_RE = /^[^\s@<>"'()\\,;:]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/i;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const hex = (v, d) => { v = String(v || '').trim().toLowerCase(); return HEX_RE.test(v) ? v : d; };

// ---- image validation (magic bytes; png/jpeg/webp only, no SVG) ----
function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b.slice(1, 8).toString('latin1') === 'PNG\r\n\x1a\n') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 } }).single('image');

// ---- signed cookie session ----
const sign = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');
function readSess(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('__Host-sid='));
  if (!m) return null;
  const [d, sig] = m.slice(11).split('.');
  if (!d || !sig) return null;
  const a = Buffer.from(sign(d)), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const s = JSON.parse(Buffer.from(d, 'base64url').toString()); return s.exp > Date.now() ? s : null; } catch { return null; }
}
function writeSess(res, s) {
  s.exp = Date.now() + (s.auth ? 8 * 3600e3 : 3600e3);
  const d = Buffer.from(JSON.stringify(s)).toString('base64url');
  res.setHeader('Set-Cookie', `__Host-sid=${d}.${sign(d)}; Path=/; HttpOnly; SameSite=Strict${PROD ? '; Secure' : ''}; Max-Age=${s.auth ? 28800 : 3600}`);
}
function session(req, res, next) {
  let s = readSess(req);
  if (!s) { s = { auth: false, csrf: crypto.randomBytes(24).toString('base64url') }; writeSess(res, s); }
  req.sess = s; next();
}
function csrf(req, res, next) {
  const t = String((req.body && req.body._csrf) || '');
  const a = Buffer.from(t), b = Buffer.from(req.sess.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('Neplatný CSRF token. Obnovte stránku.');
  next();
}
// password change invalidates other sessions (pwver)
const needAuth = (req, res, next) => getSettings().then(s => (req.sess.auth && String(req.sess.pv || '0') === s.pwver) ? next() : res.redirect(303, '/admin/login')).catch(next);
const currentHash = async () => { const r = await pool.query(`SELECT v FROM settings WHERE k='pwhash'`); return (r.rows[0] && r.rows[0].v) || ENV_HASH; };

// ---- login rate limit + lockout ----
const fails = new Map(); let globalFails = [];
function lockedFor(ip) {
  const now = Date.now();
  globalFails = globalFails.filter(t => now - t < 15 * 60e3);
  if (globalFails.length >= 30) return 15;
  const f = fails.get(ip);
  if (f && f.until > now) return Math.ceil((f.until - now) / 60e3);
  return 0;
}
function recordFail(ip) {
  const now = Date.now(); globalFails.push(now);
  const f = fails.get(ip) || { n: 0, first: now, until: 0 };
  if (now - f.first > 15 * 60e3) { f.n = 0; f.first = now; }
  f.n++; if (f.n >= 5) { f.until = now + 15 * 60e3; f.n = 0; f.first = now; if (global.__notifyAdmin) global.__notifyAdmin(`🚨 Admin lnkbio: 5 neúspešných pokusov – IP ${String(ip).slice(0, 45)} zablokovaná na 15 min`); }
  if (globalFails.length === 30 && global.__notifyAdmin) global.__notifyAdmin('🚨 Admin lnkbio: globálny limit neúspešných prihlásení (30/15 min) – prihlasovanie dočasne zablokované');
  fails.set(ip, f);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (v.until < now && now - v.first > 15 * 60e3) fails.delete(k); }, 10 * 60e3).unref();

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression({ threshold: 0, filter: (req, res) => !/^image\//.test(String(res.getHeader('Content-Type') || '')) && compression.filter(req, res) }));
app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: {
    defaultSrc: ["'none'"], scriptSrc: ["'self'"], connectSrc: ["'self'", CHECKOUT_ORIGIN], styleSrc: ["'self'"], imgSrc: ["'self'", "https:"], formAction: ["'self'"], baseUri: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: [] } },
  strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()'); next(); });
const CSS_V = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static', 's.css'))).digest('hex').slice(0, 10);
app.use('/static', express.static(path.join(__dirname, 'static'), { maxAge: '365d', immutable: true, etag: true, index: false }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// ---- SK/EN language: ?lang=en|sk (sets cookie) or cookie; UI strings via dictionary, admin content as entered ----
app.use((req, res, next) => {
  const q = String(req.query.lang || '').toLowerCase();
  if (q === 'sk' || q === 'en') { req.lang = q; res.append('Set-Cookie', `lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax${PROD ? '; Secure' : ''}`); }
  else { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)lang=(sk|en)\b/); req.lang = m ? m[1] : 'sk'; }
  next();
});
const EN = { 'Cenník': 'Pricing', 'Domov': 'Home', 'Kanály': 'Channels', 'Platby': 'Payments', 'Kontakt': 'Contact', 'FAQ': 'FAQ', 'O nás': 'About us', 'Stav služieb': 'Service status', 'Návody': 'Guides', 'Návrhy': 'Suggestions',
  'Vyberte región.': 'Choose a region.', 'Vyberte kategóriu.': 'Choose a category.', 'kategórií': 'categories', 'položiek': 'items', '‹ Predošlá': '‹ Previous', 'Ďalšia ›': 'Next ›',
  'Katalóg je zatiaľ prázdny.': 'The catalogue is empty for now.', '💳 Prejsť k platbe': '💳 Go to payment', 'Kontakty zatiaľ nie sú vyplnené.': 'No contacts yet.',
  'Časté otázky': 'Frequently asked questions', 'Zatiaľ žiadne otázky.': 'No questions yet.', 'Hlavné menu': 'Main menu', 'Omrvinky': 'Breadcrumbs', 'Menu': 'Menu',
  'Odkaz neexistuje.': 'This link does not exist.', 'Odkaz neexistuje alebo vypršal.': 'This link does not exist or has expired.', 'Stránka neexistuje.': 'Page not found.',
  'Aktuálny stav našich služieb. Stránka sa obnovuje automaticky.': 'Current status of our services. This page refreshes automatically.' };
Object.assign(EN, { 'Kontroluje sa': 'Checking', 'Funguje': 'Up', 'Pomalé': 'Slow', 'Výpadok': 'Down', '● LIVE': '● LIVE', '▶ Stream': '▶ Stream', '📺 TV': '📺 TV', '⚙ Software': '⚙ Software' });
const UI = require('./uitext'); UI.addDefaults(EN);
const T = (req, sk) => UI.tx(!!(req && req.lang === 'en'), sk, EN[sk] || '');
const loc = (req, s, k) => (req && req.lang === 'en' && s[k + '_en']) || s[k];
const langHref = req => { const u = new URL(req.originalUrl, 'http://x'); u.searchParams.set('lang', req.lang === 'en' ? 'sk' : 'en'); return u.pathname.replace(/^[/\\]+/, '/') + u.search; };
const langSw = req => `<a class="langsw" href="${esc(langHref(req))}" hreflang="${req.lang === 'en' ? 'sk' : 'en'}">🌐 ${req.lang === 'en' ? 'SK' : 'EN'}</a>`;
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/robots.txt', (req, res) => res.type('text').set('Cache-Control', 'public, max-age=86400').send(`User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${pubOrigin(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', wrap(async (req, res) => { const s = await getSettings(), o = pubOrigin(req), xe = v => String(v).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const paths = ['', ...Object.values(PAGES).map(p => p[1]).filter(Boolean)], now = new Date().toISOString().slice(0, 10);
  const u = paths.map(p => { const l = `${o}/${s.slug}${p}`; return `<url><loc>${xe(l)}</loc><lastmod>${now}</lastmod><xhtml:link rel="alternate" hreflang="sk" href="${xe(l)}?lang=sk"/><xhtml:link rel="alternate" hreflang="en" href="${xe(l)}?lang=en"/></url>`; }).join('');
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${u}</urlset>`); }));
app.get('/favicon.ico', wrap(async (req, res) => { const s = await getSettings(); if (s.img.logo) return res.redirect(302, '/img/logo?v=' + s.img.logo); res.status(204).end(); }));

// images served from Postgres bytea
app.get('/img/:k(logo|bg)', wrap(async (req, res) => {
  const r = await pool.query(`SELECT mime,data,ver FROM images WHERE k=$1`, [req.params.k]);
  if (!r.rowCount) return res.status(404).end();
  const im = r.rows[0];
  res.setHeader('Content-Type', im.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', req.query.v === im.ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  res.setHeader('ETag', '"' + im.ver + '"');
  if (req.headers['if-none-match'] === '"' + im.ver + '"') return res.status(304).end();
  res.end(im.data);
}));

// dynamic theme CSS (served as a same-origin stylesheet -> CSP style-src 'self' still holds)
function themeCss(s) {
  const bg = hex(s.c_bg, DEFAULTS.c_bg), card = hex(s.c_card, DEFAULTS.c_card), bt = hex(s.c_btntext, DEFAULTS.c_btntext), tx = hex(s.c_text, DEFAULTS.c_text);
  const font = (FONTS[s.font] || FONTS.system).css, rad = s.btn_style === 'square' ? '0' : '14px';
  const bgImg = s.img.bg ? `background-image:url("/img/bg?v=${s.img.bg}");background-size:cover;background-position:center;background-attachment:fixed;` : '';
  const tvCss = s.layout === 'tv' && !s.img.bg ? `background-image:radial-gradient(1200px 500px at 50% -10%,rgba(229,9,20,.28),transparent 60%),radial-gradient(900px 500px at 100% 100%,rgba(37,99,235,.25),transparent 60%),linear-gradient(180deg,#0b0d18 0%,${bg} 100%);background-attachment:fixed;` : '';
  return `body{background-color:${bg};${bgImg}${tvCss}color:${tx};font-family:${font}}
.bio,.f,.soc a{color:${tx};opacity:.85}.b{background:${card};border-color:${card};color:${bt};border-radius:${rad};filter:none}
.b:hover,.b:focus{background:${card};filter:brightness(1.15)}.soc a{border-color:${card}}`;
}
app.get('/theme.css', wrap(async (req, res) => {
  const s = await getSettings();
  res.type('text/css; charset=utf-8');
  res.setHeader('Cache-Control', req.query.v === s.ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  res.send(themeCss(s));
}));

const page = (title, body, cls = '', desc = '', extra = '') => `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="description" content="${esc(desc || title)}"><meta property="og:title" content="${esc(title)}"><title>${esc(title)}</title><link rel="stylesheet" href="/static/s.css?v=${CSS_V}">${extra}</head><body${/\badm\b/.test(cls) ? ' class="adm"' : ''}>${/\badm\b/.test(cls) ? '<header class="ah"><span class="bl">▶</span><b>TV Software</b><span class="at">Admin</span></header>' : ''}<main class="w ${cls}">${body}</main></body></html>`;

const CHAT_V = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static', 'chat.js')) + fs.readFileSync(path.join(__dirname, 'static', 'chat.css'))).digest('hex').slice(0, 10);
// short one-word payment link
app.get('/platby', (req, res) => { res.setHeader('Cache-Control', 'no-store'); const pid = /^\d{1,9}$/.test(String(req.query.plan || '')) ? String(req.query.plan) : ''; res.redirect(302, CHECKOUT_ORIGIN + (pid ? '/?plan=' + pid : '')); });
// public plan lookup for the checkout (server-side price verification by id)
app.get('/api/plans/:id(\\d{1,9})', wrap(async (req, res) => {
  const p = (await getList('plans')).find(x => x.id === Number(req.params.id));
  res.setHeader('Cache-Control', 'no-store');
  if (!p || !p.active) return res.status(404).json({ error: 'not found' });
  res.json({ id: p.id, name: p.name, name_en: p.name_en, amount: Number(p.price), currency: 'EUR', period: Number(p.period) || 1, active: true });
}));
// public site info for the support chatbot knowledge base (only data already shown on public pages)
app.get('/api/site-info', wrap(async (req, res) => {
  const s = await getSettings(), base = LNK_PUBLIC + '/' + s.slug;
  const t = await chTree();
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ title: s.title, bio: s.bio, chat_enabled: s.chat_enabled !== '0', pay_link: SHORT_PAY,
    pages: Object.fromEntries(Object.entries(PAGES).map(([k, [n, u]]) => [n, base + u])),
    about: s.about_text, payments: s.pay_text, contact: s.contact_text,
    contacts: Object.fromEntries(SOCIALS.filter(([k]) => socOn(s, k)).map(([k, n]) => [n, s['soc_' + k]])),
    pricing: { intro: s.pricing_intro, footnote: s.pricing_note, page: base + '/cennik', plans: (await getList('plans')).filter(p => p.active).map(p => ({ name: p.name, price: fmtEur(p.price), old_price: p.old_price ? fmtEur(p.old_price) : '', period: perLabel(p.period, false), popular: p.popular, badge: p.badge, includes: p.features.split('\n').filter(Boolean), note: p.note, link: p.btn_url || planUrl(p) })) },
    faq: (await getList('faq')).map(x => ({ q: x.q, a: x.a })),
    channels: [...t.entries()].map(([r, m]) => ({ region: r, categories: [...m.entries()].map(([c, l]) => ({ name: c, items: l.slice(0, 40).map(x => x.name) })) })) });
}));

app.get('/', wrap(async (req, res) => { const s = await getSettings(); res.redirect(302, '/' + s.slug); }));

// ---- admin ----
const admin = express.Router();
admin.use(session);
admin.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); next(); });
const hid = req => `<input type="hidden" name="_csrf" value="${esc(req.sess.csrf)}">`;
const ok = (res, m = 'ok', a = '') => res.redirect(303, '/admin?m=' + m + (a ? '#' + a : ''));

admin.get('/login', (req, res) => {
  if (req.sess.auth) return res.redirect(303, '/admin');
  const e = req.query.e === '1' ? '<div class="msg err">Nesprávne heslo.</div>' : req.query.e === 'l' ? '<div class="msg err">Príliš veľa pokusov. Skúste neskôr.</div>' : '';
  res.send(page('Prihlásenie', `<h1>Admin</h1>${e}<form method="post" action="/admin/login" class="card">${hid(req)}<label for="p">Heslo</label><input id="p" type="password" name="password" autocomplete="current-password" required maxlength="200"><button>Prihlásiť</button></form>`, 'adm login'));
});
admin.post('/login', csrf, wrap(async (req, res) => {
  const ip = req.ip;
  if (lockedFor(ip)) return res.redirect(303, '/admin/login?e=l');
  const good = await bcrypt.compare(String(req.body.password || '').slice(0, 200), await currentHash());
  if (!good) { recordFail(ip); return res.redirect(303, '/admin/login?e=1'); }
  const s = await getSettings();
  if (s.totp_on === '1' && s.totp_secret) {
    // password ok -> second step (TOTP / recovery code); rate limit continues on the 2FA step
    writeSess(res, { auth: false, mfa: true, mfaAt: Date.now(), mfaN: 0, pv: s.pwver, csrf: crypto.randomBytes(24).toString('base64url') });
    return res.redirect(303, '/admin/login/2fa');
  }
  fails.delete(ip);
  writeSess(res, { auth: true, pv: s.pwver, csrf: crypto.randomBytes(24).toString('base64url') });
  res.redirect(303, '/admin');
}));
admin.post('/logout', csrf, (req, res) => { writeSess(res, { auth: false, csrf: crypto.randomBytes(24).toString('base64url') }); res.redirect(303, '/admin/login'); });

const MSGS = { ok: 'Uložené.', pmok: '💳 Platobné metódy boli aktualizované.', needconfirm: 'Zmazanie treba potvrdiť zaškrtnutím.', trashed: 'Presunuté do koša – dá sa obnoviť dole v sekcii Kôš.', restored: 'Obnovené z koša.', badslug: 'Neplatný slug (a-z, 0-9, pomlčka, 1–30 znakov, nie rezervované slovo).', badurl: 'Neplatná URL (povolené len http/https).', badlabel: 'Chýba názov tlačidla.',
  badimg: 'Neplatný obrázok – povolené len PNG, JPG alebo WebP (SVG nie).', big: 'Obrázok je príliš veľký (max 2 MB).', noimg: 'Nevybrali ste súbor.', badsoc: 'Neplatná adresa sociálnej siete.',
  badtime: 'Neplatný dátum/čas.', badwin: 'Koniec musí byť po začiatku.', badcode: 'Neplatný alebo rezervovaný kód.', dupcode: 'Kód už existuje.', rate: 'Príliš veľa nových odkazov. Skúste neskôr.',
  badlist: 'Neplatné údaje položky (skontrolujte povinné polia a URL).', badjson: 'Neplatný súbor zálohy.', bigjson: 'Záloha je príliš veľká (max 10 MB).', noconfirm: 'Potvrďte obnovu zaškrtnutím.', restored: 'Záloha bola obnovená.',
  badpw: 'Aktuálne heslo nie je správne.', shortpw: 'Nové heslo musí mať aspoň 12 znakov.', pwmismatch: 'Nové heslá sa nezhodujú.', pwok: 'Heslo bolo zmenené.', lock: 'Príliš veľa pokusov. Skúste neskôr.' };
const sel = (name, opts, cur) => `<select name="${name}">${Object.entries(opts).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

admin.get('/', needAuth, wrap(async (req, res) => {
  const s = await getSettings(); const bs = await getButtons();
  const m = MSGS[req.query.m] ? `<div class="msg ${/^(ok|pwok|restored|pmok)$/.test(req.query.m) ? '' : 'err'}">${esc(MSGS[req.query.m])}</div>` : '';
  const chk = (n, v, t) => `<label class="ck"><input type="checkbox" name="${n}" value="1"${v ? ' checked' : ''}> ${t}</label>`;
  const rows = bs.map((b, i) => `<div class="card${b.enabled ? '' : ' off'}"><form method="post" action="/admin/buttons/${b.id}/edit">${hid(req)}
<label>Emoji ikona (voliteľné)</label><input name="emoji" value="${esc(b.emoji)}" maxlength="16">
<label>Názov</label><input name="label" value="${esc(b.label)}" maxlength="80" required>
<label>URL</label><input name="url" type="url" value="${esc(b.url)}" maxlength="2000" required>
${btnExtra(b)}${chk('enabled', b.enabled, 'Zobraziť na stránke')}${chk('newtab', b.newtab, 'Otvoriť v novej karte')}<button>Uložiť</button></form>
<div class="row"><form method="post" action="/admin/buttons/${b.id}/toggle">${hid(req)}<button class="g">${b.enabled ? '🙈 Skryť' : '👁 Zobraziť'}</button></form>
${i > 0 ? `<form method="post" action="/admin/buttons/${b.id}/move">${hid(req)}<input type="hidden" name="dir" value="up"><button class="g">↑ Hore</button></form>` : ''}
${i < bs.length - 1 ? `<form method="post" action="/admin/buttons/${b.id}/move">${hid(req)}<input type="hidden" name="dir" value="down"><button class="g">↓ Dole</button></form>` : ''}
<a class="btnl" href="/admin/qr/b/${b.id}.svg">⬇ QR</a>${(b.start_at || b.end_at) ? `<span class="tag${inWindow(b) ? ' ok' : ''}">${inWindow(b) ? 'v čase' : 'mimo času'}</span>` : ''}<form method="post" action="/admin/buttons/${b.id}/delete">${hid(req)}<button class="d">Zmazať</button></form>${b.enabled ? '' : '<span class="tag">skryté</span>'}</div></div>`).join('');
  const sl = (await pool.query(`SELECT code,target_url,expires_at,active FROM short_links ORDER BY created_at DESC`)).rows;
  const origin = 'https://' + req.get('host');
  const slRows = sl.map(l => { const live = l.active && !(l.expires_at && new Date(l.expires_at) <= new Date());
    return `<div class="card${live ? '' : ' off'}"><p><a href="/s/${esc(l.code)}" rel="noopener noreferrer" target="_blank">${esc(origin)}/s/${esc(l.code)}</a> → <span class="hint">${esc(l.target_url)}</span> ${live ? '' : '<span class="tag">neaktívny</span>'}</p>
<form method="post" action="/admin/short/${esc(l.code)}/edit">${hid(req)}<label>Cieľová URL</label><input name="target_url" type="url" value="${esc(l.target_url)}" maxlength="2000" required>
<label>Platnosť do (Europe/Zurich, voliteľné)</label><input type="datetime-local" name="expires_at" value="${esc(dateToZurich(l.expires_at))}">${chk('active', l.active, 'Aktívny')}<button>Uložiť</button></form>
<div class="row"><img class="qr" src="/admin/qr/s/${esc(l.code)}.svg?inline=1" alt="QR" width="96" height="96"><a class="btnl" href="/admin/qr/s/${esc(l.code)}.svg">⬇ Stiahnuť QR</a><form method="post" action="/admin/short/${esc(l.code)}/delete">${hid(req)}<button class="d">Zmazať</button></form></div></div>`; }).join('');
  const imgBox = (k, t) => `<div class="card"><h3>${t}</h3>${s.img[k] ? `<img class="prev" src="/img/${k}?v=${s.img[k]}" alt="">` : '<p class="hint">Nenahraté.</p>'}
<form method="post" action="/admin/image/${k}" enctype="multipart/form-data">${hid(req)}<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required><p class="hint">PNG, JPG alebo WebP, max 2 MB.</p><button>Nahrať</button></form>
${s.img[k] ? `<form method="post" action="/admin/image/${k}/delete">${hid(req)}<button class="d">Odstrániť</button></form>` : ''}</div>`;
  const color = (k, t) => `<div><label>${t}</label><input type="color" name="${k}" value="${esc(hex(s[k], DEFAULTS[k]))}"></div>`;
  res.send(page('Admin', `<h1>Admin</h1>${m}<p class="row"><a class="btnl" href="/admin/2fa">🔐 2FA${s.totp_on === '1' ? ' ✅' : ''}</a><a class="btnl" href="/admin/cennik">🏷️ Cenník</a><a class="btnl" href="/admin/kluce">🔑 API kľúče</a><a class="btnl" href="/admin/stav">📡 Stav služieb</a><a class="btnl" href="/admin/texty">✏️ Texty stránky</a><a class="btnl" href="/admin/kanaly-katalog">📺 Katalóg kanálov</a><a class="btnl" href="/admin/epg">🗓 TV program</a><a class="btnl" href="/admin/platobne-metody">💳 Platobné metódy</a><a class="btnl" href="#kanaly">📺 Kanály</a><a class="btnl" href="#trash">🗑️ Kôš</a></p><p>Verejná stránka: <a href="/${esc(s.slug)}" rel="noopener noreferrer" target="_blank">/${esc(s.slug)}</a></p>
${payMethods.dashCard()}
<form method="post" action="/admin/settings" class="card">${hid(req)}<h2>Stránka</h2>
<label>Titulok</label><input name="title" value="${esc(s.title)}" maxlength="80" required>
<label>Krátke bio</label><textarea name="bio" maxlength="300" rows="3">${esc(s.bio)}</textarea>
<label>Titulok (EN, voliteľné)</label><input name="title_en" value="${esc(s.title_en)}" maxlength="80">
<label>Krátke bio (EN, voliteľné)</label><textarea name="bio_en" maxlength="300" rows="2">${esc(s.bio_en)}</textarea>
<label>Slug (adresa stránky)</label><input name="slug" value="${esc(s.slug)}" pattern="[a-z0-9\\-]{1,30}" maxlength="30" required>
<label>Titulok v prehliadači &lt;title&gt; (prázdne = titulok)</label><input name="meta_title" value="${esc(s.meta_title)}" maxlength="80">
<label>Meta popis (prázdne = bio)</label><textarea name="meta_desc" maxlength="300" rows="2">${esc(s.meta_desc)}</textarea>
<label>Text v pätičke</label><input name="footer" value="${esc(s.footer)}" maxlength="200"><button>Uložiť</button></form>
<h2>Obrázky</h2><div class="grid2">${imgBox('logo', 'Logo / avatar (aj favicon)')}${imgBox('bg', 'Obrázok pozadia')}</div>
<div class="card"><h2>Vzhľad</h2><form method="post" action="/admin/preset">${hid(req)}<label>Predvolená téma</label><div class="row">${sel('preset', Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.name])), s.preset)}<button class="g">Použiť tému</button></div></form>
<form method="post" action="/admin/theme">${hid(req)}<div class="grid4">${color('c_bg', 'Pozadie')}${color('c_card', 'Tlačidlá / karty')}${color('c_btntext', 'Text tlačidiel')}${color('c_text', 'Text')}</div>
<label>Štýl tlačidiel</label>${sel('btn_style', { rounded: 'Zaoblené', square: 'Hranaté' }, s.btn_style)}
<label>Rozloženie</label>${sel('layout', { tv: 'TV Software (hero, karty)', classic: 'Klasické' }, s.layout)}
<label>Písmo</label>${sel('font', Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.name])), s.font)}<button>Uložiť vzhľad</button></form></div>
<div class="card"><h2>QR kód stránky</h2><div class="row"><img class="qr" src="/admin/qr/page.svg?inline=1" alt="QR" width="96" height="96"><a class="btnl" href="/admin/qr/page.svg">⬇ Stiahnuť QR (SVG)</a></div></div>
<h2>Tlačidlá</h2>${rows || '<p>Žiadne tlačidlá.</p>'}
<form method="post" action="/admin/buttons" class="card">${hid(req)}<h2>Pridať tlačidlo</h2>
<label>Emoji ikona (voliteľné)</label><input name="emoji" maxlength="16"><label>Názov</label><input name="label" maxlength="80" required>
<label>URL</label><input name="url" type="url" maxlength="2000" required placeholder="https://">${btnExtra({})}${chk('enabled', true, 'Zobraziť na stránke')}${chk('newtab', false, 'Otvoriť v novej karte')}<button>Pridať</button></form>
<h2>Krátke odkazy</h2>${slRows || '<p class="hint">Žiadne krátke odkazy.</p>'}
<form method="post" action="/admin/short" class="card">${hid(req)}<h2>Nový krátky odkaz</h2>
<label>Kód (voliteľné, a-z 0-9 pomlčka; prázdne = náhodný 7 znakov)</label><input name="code" pattern="[a-z0-9\\-]{1,40}" maxlength="40">
<label>Cieľová URL</label><input name="target_url" type="url" maxlength="2000" required placeholder="https://">
<label>Platnosť do (Europe/Zurich, voliteľné)</label><input type="datetime-local" name="expires_at">${chk('active', true, 'Aktívny')}<button>Vytvoriť</button></form>
${listAdmin(req, 'nav', await getList('nav'))}
<form method="post" action="/admin/texts" class="card" id="texts">${hid(req)}<h2>Texty stránok</h2>
<label>O nás</label><textarea name="about_text" rows="5" maxlength="5000">${esc(s.about_text)}</textarea>
<label>Kontakt – doplňujúci text</label><textarea name="contact_text" rows="3" maxlength="5000">${esc(s.contact_text)}</textarea>
<label>Platby – úvodný text</label><textarea name="pay_text" rows="3" maxlength="5000">${esc(s.pay_text)}</textarea>
<details><summary>🇬🇧 Anglické verzie textov (voliteľné; prázdne = zobrazí sa slovenský text)</summary>
<label>O nás (EN)</label><textarea name="about_text_en" rows="4" maxlength="5000">${esc(s.about_text_en)}</textarea>
<label>Kontakt (EN)</label><textarea name="contact_text_en" rows="2" maxlength="5000">${esc(s.contact_text_en)}</textarea>
<label>Platby (EN)</label><textarea name="pay_text_en" rows="2" maxlength="5000">${esc(s.pay_text_en)}</textarea></details>
<label>URL platobnej brány (checkout)</label><input name="checkout_url" type="url" maxlength="2000" value="${esc(s.checkout_url)}">${chk('chat_enabled', s.chat_enabled !== '0', '💬 Zobraziť AI chatbota podpory na verejných stránkach')}<button>Uložiť texty</button></form>
${listAdmin(req, 'faq', await getList('faq'))}
<form method="post" action="/admin/kanaly" class="card" id="kanaly">${hid(req)}<h2>📺 Sekcia „Kanály“</h2>
<p><a class="btnl" href="/admin/kanaly-katalog">📺 Spravovať katalóg kanálov (pridať, upraviť, import CSV/Excel)</a> <a class="btnl" href="/admin/epg">🗓 TV program (EPG) a „Dnes v TV“</a></p><p class="hint">Stavový zoznam sa načítava automaticky zo <a href="/admin/stav">📡 Stav služieb</a> (jediný zdroj – kanály pridávajte/upravujte len tam). Názov, zobrazenie v menu a poradie nastavíte v <a href="#l-nav">Navigácii</a> (položka so stránkou „Kanály“).</p>
<label>Úvodný text (SK)</label><textarea name="kan_intro" rows="2" maxlength="1000">${esc(s.kan_intro)}</textarea>
<label>Úvodný text (EN)</label><textarea name="kan_intro_en" rows="2" maxlength="1000">${esc(s.kan_intro_en)}</textarea>
${chk('kan_status', s.kan_status !== '0', 'Zobraziť stav pri každom kanáli')}${chk('kan_catalog', s.kan_catalog === '1', 'Zobraziť aj starý katalóg (regióny/kategórie) pod zoznamom')}<button>Uložiť</button></form>
${listAdmin(req, 'channels', await getList('channels'))}
${await trashAdmin(req)}
<form method="post" action="/admin/social" class="card">${hid(req)}<h2>Sociálne siete (voliteľné)</h2><p class="hint">Prázdne pole = nezobrazí sa. Skupiny (Telegram / Facebook) sa dajú aj dočasne vypnúť bez mazania odkazu.</p>
${SOCIALS.map(([k, n, e]) => `<label>${e} ${n}</label><input name="${k}" value="${esc(s['soc_' + k])}" maxlength="${k === 'email' ? 254 : 2000}" ${k === 'email' ? 'type="email" placeholder="meno@domena.sk"' : k === 'tg_group' ? 'type="url" placeholder="https://t.me/…"' : k === 'fb_group' ? 'type="url" placeholder="https://www.facebook.com/groups/…"' : 'type="url" placeholder="https://"'}>${SOC_TOGGLE.includes(k) ? `<label class="ck"><input type="checkbox" name="on_${k}" value="1"${s['socon_' + k] !== '0' ? ' checked' : ''}> Zobraziť ${esc(n)}</label>` : ''}`).join('')}<button>Uložiť</button></form>
<div class="card"><h2>Záloha a obnova</h2><p><a class="btnl" href="/admin/export.json">⬇ Stiahnuť zálohu (JSON)</a></p>
<form method="post" action="/admin/restore" enctype="multipart/form-data">${hid(req)}<label>Súbor zálohy (JSON, max 10 MB)</label><input type="file" name="backup" accept="application/json,.json" required>
${chk('confirm', false, 'Rozumiem, že obnova prepíše všetky nastavenia, tlačidlá, krátke odkazy a obrázky.')}<button class="d">Obnoviť zo zálohy</button></form></div>
<form method="post" action="/admin/password" class="card">${hid(req)}<h2>Zmena hesla</h2>
<label>Aktuálne heslo</label><input type="password" name="current" autocomplete="current-password" required maxlength="200">
<label>Nové heslo (min. 12 znakov)</label><input type="password" name="new1" autocomplete="new-password" required minlength="12" maxlength="200">
<label>Nové heslo znova</label><input type="password" name="new2" autocomplete="new-password" required minlength="12" maxlength="200"><button>Zmeniť heslo</button></form>
<form method="post" action="/admin/logout">${hid(req)}<button class="g">Odhlásiť</button></form>`, 'a adm', '', payMethods.HEAD));
}));
admin.post('/settings', needAuth, csrf, wrap(async (req, res) => {
  const slug = String(req.body.slug || '').trim();
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return ok(res, 'badslug');
  await setSettings({ title: clean(req.body.title, 80) || 'Odkazy', bio: clean(String(req.body.bio || '').replace(/\r/g, ''), 300), slug,
    title_en: clean(req.body.title_en, 80), bio_en: clean(String(req.body.bio_en || '').replace(/\r/g, ''), 300), meta_title: clean(req.body.meta_title, 80), meta_desc: clean(String(req.body.meta_desc || '').replace(/\s+/g, ' '), 300), footer: clean(req.body.footer, 200) });
  ok(res);
}));
admin.post('/preset', needAuth, csrf, wrap(async (req, res) => {
  const p = PRESETS[req.body.preset]; if (!p) return ok(res);
  const { name, ...cols } = p; await setSettings({ ...cols, preset: req.body.preset }); ok(res);
}));
admin.post('/theme', needAuth, csrf, wrap(async (req, res) => {
  const s = await getSettings(); const o = {};
  for (const k of ['c_bg', 'c_card', 'c_btntext', 'c_text']) o[k] = hex(req.body[k], s[k]);
  o.btn_style = req.body.btn_style === 'square' ? 'square' : 'rounded';
  o.font = FONTS[req.body.font] ? req.body.font : 'system';
  o.layout = req.body.layout === 'tv' ? 'tv' : 'classic';
  const pm = Object.entries(PRESETS).find(([, p]) => ['c_bg', 'c_card', 'c_btntext', 'c_text', 'layout'].every(k => p[k] === o[k]));
  o.preset = pm ? pm[0] : 'custom';
  await setSettings(o); ok(res);
}));
admin.post('/social', needAuth, csrf, wrap(async (req, res) => {
  const o = {};
  for (const [k] of SOCIALS) {
    const v = String(req.body[k] || '').trim();
    if (!v) { o['soc_' + k] = ''; continue; }
    if (k === 'email') { if (!EMAIL_RE.test(v)) return ok(res, 'badsoc'); o['soc_' + k] = v; }
    else { const u = safeUrl(v); if (!u) return ok(res, 'badsoc'); o['soc_' + k] = u; }
  }
  for (const k of SOC_TOGGLE) o['socon_' + k] = req.body['on_' + k] ? '1' : '0';
  await setSettings(o); ok(res);
}));
admin.post('/image/:k(logo|bg)', needAuth, (req, res, next) => upload(req, res, e => {
  if (e) return ok(res, e.code === 'LIMIT_FILE_SIZE' ? 'big' : 'badimg');
  next();
}), csrf, wrap(async (req, res) => {
  if (!req.file || !req.file.buffer.length) return ok(res, 'noimg');
  const mime = sniff(req.file.buffer); if (!mime) return ok(res, 'badimg');
  const ver = crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 12);
  await pool.query(`INSERT INTO images (k,mime,data,ver) VALUES ($1,$2,$3,$4) ON CONFLICT (k) DO UPDATE SET mime=EXCLUDED.mime,data=EXCLUDED.data,ver=EXCLUDED.ver`, [req.params.k, mime, req.file.buffer, ver]);
  await setSettings({}); ok(res);
}));
admin.post('/image/:k(logo|bg)/delete', needAuth, csrf, wrap(async (req, res) => {
  await pool.query(`DELETE FROM images WHERE k=$1`, [req.params.k]); await setSettings({}); ok(res);
}));
admin.post('/password', needAuth, csrf, wrap(async (req, res) => {
  const ip = req.ip;
  if (lockedFor(ip)) return ok(res, 'lock');
  const cur = String(req.body.current || '').slice(0, 200), n1 = String(req.body.new1 || ''), n2 = String(req.body.new2 || '');
  if (!(await bcrypt.compare(cur, await currentHash()))) { recordFail(ip); return ok(res, 'badpw'); }
  if (n1.length < 12 || n1.length > 200) return ok(res, 'shortpw');
  if (n1 !== n2) return ok(res, 'pwmismatch');
  const s = await getSettings(); const pv = String(Number(s.pwver || 0) + 1);
  await setSettings({ pwhash: await bcrypt.hash(n1, 12), pwver: pv });
  writeSess(res, { auth: true, pv, csrf: crypto.randomBytes(24).toString('base64url') });
  ok(res, 'pwok');
}));
function btnInput(req) {
  const label = clean(req.body.label, 80), url = safeUrl(req.body.url), emoji = clean(req.body.emoji, 16);
  if (!label) return { err: 'badlabel' }; if (!url) return { err: 'badurl' };
  const start_at = zurichToDate(req.body.start_at), end_at = zurichToDate(req.body.end_at);
  if (start_at === undefined || end_at === undefined) return { err: 'badtime' };
  if (start_at && end_at && end_at <= start_at) return { err: 'badwin' };
  const brand = Object.prototype.hasOwnProperty.call(BRANDS, req.body.brand) ? String(req.body.brand) : '';
  return { label, url, emoji, enabled: req.body.enabled === '1', newtab: req.body.newtab === '1', start_at, end_at, brand, section: req.body.section === 'pay' ? 'pay' : 'home' };
}
admin.post('/buttons', needAuth, csrf, wrap(async (req, res) => {
  const b = btnInput(req); if (b.err) return ok(res, b.err);
  await bq(`INSERT INTO buttons (label,url,emoji,enabled,newtab,start_at,end_at,brand,section,pos) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT COALESCE(MAX(pos),0)+1 FROM buttons))`, [b.label, b.url, b.emoji, b.enabled, b.newtab, b.start_at, b.end_at, b.brand, b.section]);
  ok(res);
}));
const idOf = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };
admin.post('/buttons/:id/edit', needAuth, csrf, wrap(async (req, res) => {
  const b = btnInput(req); if (b.err) return ok(res, b.err);
  await bq(`UPDATE buttons SET label=$1,url=$2,emoji=$3,enabled=$4,newtab=$5,start_at=$6,end_at=$7,brand=$8,section=$9 WHERE id=$10`, [b.label, b.url, b.emoji, b.enabled, b.newtab, b.start_at, b.end_at, b.brand, b.section, idOf(req)]);
  ok(res);
}));
admin.post('/buttons/:id/toggle', needAuth, csrf, wrap(async (req, res) => {
  await bq(`UPDATE buttons SET enabled = NOT enabled WHERE id=$1`, [idOf(req)]); ok(res);
}));
admin.post('/buttons/:id/delete', needAuth, csrf, wrap(async (req, res) => {
  await bq(`DELETE FROM buttons WHERE id=$1`, [idOf(req)]); ok(res);
}));
admin.post('/buttons/:id/move', needAuth, csrf, wrap(async (req, res) => {
  const bs = (await getButtons()).slice(); const i = bs.findIndex(b => b.id === idOf(req));
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < bs.length) {
    [bs[i], bs[j]] = [bs[j], bs[i]];
    const c = await pool.connect();
    try { await c.query('BEGIN'); for (let k = 0; k < bs.length; k++) await c.query(`UPDATE buttons SET pos=$1 WHERE id=$2`, [k + 1, bs[k].id]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); bcache = null; }
  }
  ok(res);
}));
// ---- buttons: brand + time window fields ----
function btnExtra(b) {
  return `<label>Sekcia</label>${sel('section', { home: 'Domov', pay: 'Platby (stránka Platby)' }, b.section || 'home')}<label>Štýl značky (voliteľné)</label>${sel('brand', BRANDS, b.brand || '')}
<div class="grid2"><div><label>Zobraziť od (Europe/Zurich, voliteľné)</label><input type="datetime-local" name="start_at" value="${esc(dateToZurich(b.start_at))}"></div>
<div><label>Zobraziť do (Europe/Zurich, voliteľné)</label><input type="datetime-local" name="end_at" value="${esc(dateToZurich(b.end_at))}"></div></div>`;
}

// ---- short links admin ----
const slRate = new Map();
function slLimited(key) {
  const now = Date.now(); const a = (slRate.get(key) || []).filter(t => now - t < 10 * 60e3);
  if (a.length >= 20) { slRate.set(key, a); return true; }
  a.push(now); slRate.set(key, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of slRate) if (!a.some(t => now - t < 10 * 60e3)) slRate.delete(k); }, 10 * 60e3).unref();
const codeOk = async c => CODE_RE.test(c) && !RESERVED.has(c) && c !== (await getSettings()).slug;
function slInput(req) {
  const target_url = safeUrl(req.body.target_url); if (!target_url) return { err: 'badurl' };
  const expires_at = zurichToDate(req.body.expires_at); if (expires_at === undefined) return { err: 'badtime' };
  return { target_url, expires_at, active: req.body.active === '1' };
}
admin.post('/short', needAuth, csrf, wrap(async (req, res) => {
  if (slLimited(req.ip) || slLimited('*global')) return ok(res, 'rate');
  const l = slInput(req); if (l.err) return ok(res, l.err);
  let code = String(req.body.code || '').trim();
  if (code) { if (!(await codeOk(code))) return ok(res, 'badcode'); }
  for (let i = 0; i < 5 && !code; i++) { const c = rndCode(); if (!(await pool.query(`SELECT 1 FROM short_links WHERE code=$1`, [c])).rowCount) code = c; }
  const r = await pool.query(`INSERT INTO short_links (code,target_url,expires_at,active) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`, [code, l.target_url, l.expires_at, l.active]);
  ok(res, r.rowCount ? 'ok' : 'dupcode');
}));
admin.post('/short/:code/edit', needAuth, csrf, wrap(async (req, res) => {
  const l = slInput(req); if (l.err) return ok(res, l.err);
  await pool.query(`UPDATE short_links SET target_url=$1,expires_at=$2,active=$3 WHERE code=$4`, [l.target_url, l.expires_at, l.active, String(req.params.code)]); ok(res);
}));
admin.post('/short/:code/delete', needAuth, csrf, wrap(async (req, res) => {
  await pool.query(`DELETE FROM short_links WHERE code=$1`, [String(req.params.code)]); ok(res);
}));

// ---- QR codes (server-side SVG) ----
async function sendQr(req, res, url, name) {
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', (req.query.inline === '1' ? 'inline' : 'attachment') + `; filename="${name}.svg"`);
  res.send(svg);
}
const pubOrigin = req => (process.env.PUBLIC_URL || ('https://' + req.get('host'))).replace(/\/+$/, '');
admin.get('/qr/page.svg', needAuth, wrap(async (req, res) => { const s = await getSettings(); await sendQr(req, res, pubOrigin(req) + '/' + s.slug, 'qr-' + s.slug); }));
admin.get('/qr/s/:code.svg', needAuth, wrap(async (req, res, next) => {
  const c = String(req.params.code); if (!/^[A-Za-z0-9-]{1,40}$/.test(c)) return next();
  if (!(await pool.query(`SELECT 1 FROM short_links WHERE code=$1`, [c])).rowCount) return next();
  await sendQr(req, res, pubOrigin(req) + '/s/' + c, 'qr-s-' + c);
}));
admin.get('/qr/b/:id.svg', needAuth, wrap(async (req, res, next) => {
  const b = (await getButtons()).find(x => x.id === idOf(req)); if (!b) return next();
  await sendQr(req, res, b.url, 'qr-button-' + b.id);
}));

// ---- backup / restore ----
const SKIP_KEYS = new Set(['pwhash', 'pwver', 'ver', 'seeded', 'totp_on', 'totp_secret', 'totp_pending', 'totp_rc', 'totp_last', 'sec_meta']);
const isMigr = k => /^migr_/.test(k);
async function buildExport() {
  const st = (await pool.query(`SELECT k,v FROM settings ORDER BY k`)).rows.filter(r => !SKIP_KEYS.has(r.k) && !isMigr(r.k)).map(r => ({ k: r.k, v: decV(r.k, r.v) }));
  const bs = (await pool.query(`SELECT label,url,emoji,pos,enabled,newtab,start_at,end_at,brand,section FROM buttons ORDER BY pos,id`)).rows;
  const sl = (await pool.query(`SELECT code,target_url,expires_at,active FROM short_links ORDER BY created_at`)).rows;
  const im = (await pool.query(`SELECT k,mime,data FROM images ORDER BY k`)).rows;
  const out = { format: 'linkbio-backup', version: 1, exported_at: new Date().toISOString(),
    settings: Object.fromEntries(st.map(r => [r.k, r.v])),
    buttons: bs.map(b => ({ ...b, start_at: b.start_at && b.start_at.toISOString(), end_at: b.end_at && b.end_at.toISOString() })),
    short_links: sl.map(l => ({ ...l, expires_at: l.expires_at && l.expires_at.toISOString() })),
    images: Object.fromEntries(im.map(i => [i.k, { mime: i.mime, data: i.data.toString('base64') }])),
    lists: Object.fromEntries(await Promise.all(Object.keys(LISTS).map(async t => [t, (await pool.query(`SELECT * FROM l_${t} ORDER BY pos,id`)).rows.map(({ id, pos, ...r }) => r)]))) };
  return out;
}
admin.get('/export.json', needAuth, wrap(async (req, res) => {
  const out = await buildExport();
  // encrypted + authenticated (AES-256-GCM) backup file; only this server (DATA_ENC_KEY) can restore it
  const e = encrypt(Buffer.from(JSON.stringify(out)), 'backup');
  const file = { format: 'linkbio-backup-enc', version: 1, alg: 'AES-256-GCM', exported_at: out.exported_at, ...e };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="linkbio-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(JSON.stringify(file));
}));
const SETTING_KEYS = new Set([...Object.keys(DEFAULTS).filter(k => !SKIP_KEYS.has(k)), 'layout']);
const isoOrNull = v => { if (v === null) return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) throw 0; const d = new Date(v); if (isNaN(d)) throw 0; return d; };
const exactKeys = (o, req, opt = []) => { if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; for (const k of Object.keys(o)) if (!req.includes(k) && !opt.includes(k)) throw 0; for (const k of req) if (!(k in o)) throw 0; };
function validateBackup(j) {
  exactKeys(j, ['format', 'version', 'settings', 'buttons', 'short_links', 'images', 'lists'], ['exported_at']);
  if (j.format !== 'linkbio-backup' || j.version !== 1) throw 0;
  exactKeys(j.settings, [], [...SETTING_KEYS]);
  const st = {};
  for (const [k, v] of Object.entries(j.settings)) {
    const LONG = /^(about_text|contact_text|pay_text|pricing_intro|pricing_note)(_en)?$/.test(k);
    if (typeof v !== 'string' || v.length > (LONG ? 5000 : 2000)) throw 0;
    if (k === 'slug' && (!SLUG_RE.test(v) || RESERVED.has(v))) throw 0;
    if (/^c_/.test(k) && !HEX_RE.test(v)) throw 0;
    if (k === 'font' && !FONTS[v]) throw 0;
    if (k === 'btn_style' && !['rounded', 'square'].includes(v)) throw 0;
    if (k === 'layout' && !['tv', 'classic'].includes(v)) throw 0;
    if (k === 'preset' && !PRESETS[v] && v !== 'custom') throw 0;
    if (/^socon_/.test(k) && !/^[01]$/.test(v)) throw 0;
    if (/^soc_/.test(k) && v && !(k === 'soc_email' ? EMAIL_RE.test(v) : safeUrl(v) === v)) throw 0;
    st[k] = LONG ? clean(v.replace(/\r/g, ''), 5000) : k === 'bio' || k === 'bio_en' || k === 'meta_desc' ? clean(v, 300) : clean(v, k === 'footer' ? 200 : k.startsWith('soc_') ? 2000 : 80);
  }
  if (!Array.isArray(j.buttons) || j.buttons.length > 200) throw 0;
  const bs = j.buttons.map(b => {
    exactKeys(b, ['label', 'url', 'emoji', 'pos', 'enabled', 'newtab', 'start_at', 'end_at', 'brand', 'section']); if (!['home', 'pay'].includes(b.section)) throw 0;
    if (typeof b.label !== 'string' || !clean(b.label, 80) || typeof b.emoji !== 'string' || typeof b.url !== 'string' || !safeUrl(b.url)) throw 0;
    if (!Number.isInteger(b.pos) || typeof b.enabled !== 'boolean' || typeof b.newtab !== 'boolean' || typeof b.brand !== 'string' || !Object.prototype.hasOwnProperty.call(BRANDS, b.brand)) throw 0;
    return { label: clean(b.label, 80), url: safeUrl(b.url), emoji: clean(b.emoji, 16), pos: b.pos, enabled: b.enabled, newtab: b.newtab, start_at: isoOrNull(b.start_at), end_at: isoOrNull(b.end_at), brand: b.brand, section: b.section };
  });
  if (!Array.isArray(j.short_links) || j.short_links.length > 5000) throw 0;
  const seen = new Set();
  const sl = j.short_links.map(l => {
    exactKeys(l, ['code', 'target_url', 'expires_at', 'active']);
    if (typeof l.code !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(l.code) || RESERVED.has(l.code) || seen.has(l.code)) throw 0; seen.add(l.code);
    if (typeof l.target_url !== 'string' || !safeUrl(l.target_url) || typeof l.active !== 'boolean') throw 0;
    return { code: l.code, target_url: safeUrl(l.target_url), expires_at: isoOrNull(l.expires_at), active: l.active };
  });
  exactKeys(j.images, [], ['logo', 'bg']);
  const im = Object.entries(j.images).map(([k, v]) => {
    exactKeys(v, ['mime', 'data']);
    if (typeof v.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)) throw 0;
    const buf = Buffer.from(v.data, 'base64'); const mime = sniff(buf);
    if (!mime || mime !== v.mime || buf.length > 2 * 1024 * 1024) throw 0;
    return { k, mime, buf, ver: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12) };
  });
  exactKeys(j.lists, [], Object.keys(LISTS));
  const ls = {};
  for (const t of Object.keys(LISTS)) {
    if (!(t in j.lists)) continue;
    if (!Array.isArray(j.lists[t]) || j.lists[t].length > 20000) throw 0;
    const names = LISTS[t].fields.map(f => f[0]);
    ls[t] = j.lists[t].map(o => { exactKeys(o, names.filter(n => !/_en$/.test(n)), names); const r = listInput(t, o); if (!r) throw 0; return r; });
  }
  return { st, bs, sl, im, ls };
}
const restoreUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, fieldSize: 1024 } }).single('backup');
admin.post('/restore', needAuth, (req, res, next) => restoreUp(req, res, e => {
  if (e) return ok(res, e.code === 'LIMIT_FILE_SIZE' ? 'bigjson' : 'badjson');
  next();
}), csrf, wrap(async (req, res) => {
  if (req.body.confirm !== '1') return ok(res, 'noconfirm');
  if (!req.file || !req.file.buffer.length) return ok(res, 'badjson');
  let d; try {
    const f = JSON.parse(req.file.buffer.toString('utf8'));
    exactKeys(f, ['format', 'version', 'alg', 'iv', 'tag', 'ct'], ['exported_at']);
    if (f.format !== 'linkbio-backup-enc' || f.version !== 1 || f.alg !== 'AES-256-GCM') throw 0;
    d = validateBackup(JSON.parse(decrypt(f, 'backup').toString('utf8')));
  } catch { return ok(res, 'badjson'); }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM settings WHERE k <> ALL($1::text[]) AND k NOT LIKE 'migr\\_%'`, [[...SKIP_KEYS]]);
    for (const [k, v] of Object.entries({ ...Object.fromEntries([...SETTING_KEYS].map(k => [k, DEFAULTS[k] ?? ''])), ...d.st })) await c.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, encV(k, v)]);
    await c.query(`UPDATE settings SET v=(COALESCE(NULLIF(v,''),'0')::bigint+1)::text WHERE k='ver'`);
    await c.query(`DELETE FROM buttons`);
    for (const b of d.bs) await c.query(`INSERT INTO buttons (label,url,emoji,pos,enabled,newtab,start_at,end_at,brand,section) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [b.label, b.url, b.emoji, b.pos, b.enabled, b.newtab, b.start_at, b.end_at, b.brand, b.section]);
    await c.query(`DELETE FROM short_links`);
    for (const l of d.sl) await c.query(`INSERT INTO short_links (code,target_url,expires_at,active) VALUES ($1,$2,$3,$4)`, [l.code, l.target_url, l.expires_at, l.active]);
    await c.query(`DELETE FROM images`);
    for (const i of d.im) await c.query(`INSERT INTO images (k,mime,data,ver) VALUES ($1,$2,$3,$4)`, [i.k, i.mime, i.buf, i.ver]);
    for (const [t, rows] of Object.entries(d.ls)) {
      await c.query(`DELETE FROM l_${t}`);
      let i = 1; for (const r of rows) { const ks = Object.keys(r); await c.query(`INSERT INTO l_${t} (${ks.join(',')},pos) VALUES (${ks.map((_, j) => '$' + (j + 1)).join(',')},$${ks.length + 1})`, [...Object.values(r), i++]); }
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); cache = null; bcache = null; Object.keys(LISTS).forEach(dropList); }
  ok(res, 'restored');
}));
// ---- generic admin-managed lists (FAQ, channels, nav) ----
const PAGES = { home: ['Domov', ''], channels: ['Kanály', '/kanaly'], payments: ['Platby', '/platby'], contact: ['Kontakt', '/kontakt'], faq: ['FAQ', '/faq'], about: ['O nás', '/o-nas'], navody: ['Návody', '/navody'], navrhy: ['Návrhy', '/navrhy'], cennik: ['Cenník', '/cennik'] };
const NAV_ICONS = { home: '🏠', channels: '📺', payments: '💳', contact: '✉️', faq: '❓', about: 'ℹ️', navody: '📘', navrhy: '💡', cennik: '🏷️' };
const LISTS = {
  faq: { title: 'FAQ', fields: [['q', 'Otázka', 'text', 200, true], ['a', 'Odpoveď', 'area', 2000, true], ['q_en', 'Otázka (EN, voliteľné)', 'text', 200, false], ['a_en', 'Odpoveď (EN, voliteľné)', 'area', 2000, false]] },
  channels: { title: 'Kanály (katalóg)', fields: [['name', 'Názov', 'text', 80, true], ['region', 'Región', 'text', 40, true], ['category', 'Kategória', 'text', 40, true], ['note', 'Popis', 'area', 500, false]] },
  plans: { title: 'Cenník – plány', fields: [['name', 'Názov plánu', 'text', 60, true], ['name_en', 'Názov (EN)', 'text', 60, false], ['price', 'Cena v EUR (napr. 9,99)', 'eur', 0, true], ['old_price', 'Pôvodná cena EUR (voliteľné, prečiarknutá)', 'eur', 0, false],
    ['period', 'Obdobie v mesiacoch (1, 3, 6, 12…)', 'int', 0, true], ['badge', 'Odznak / zľava (voliteľné, napr. −20 %)', 'text', 30, false], ['badge_en', 'Odznak (EN)', 'text', 30, false], ['popular', 'Najobľúbenejší (zvýrazniť)', 'bool'],
    ['features', 'Čo obsahuje – jedna položka na riadok', 'area', 2000, false], ['features_en', 'Čo obsahuje (EN) – jedna na riadok', 'area', 2000, false], ['note', 'Poznámka (voliteľné)', 'text', 200, false], ['note_en', 'Poznámka (EN)', 'text', 200, false],
    ['btn', 'Text tlačidla', 'text', 40, false], ['btn_en', 'Text tlačidla (EN)', 'text', 40, false], ['btn_url', 'Odkaz tlačidla (prázdne = platobná stránka s týmto plánom a sumou – odporúčané)', 'url', 2000, false], ['active', 'Aktívny (zobraziť)', 'bool']] },
  nav: { title: 'Navigácia', fields: [['label', 'Názov', 'text', 40, true], ['page', 'Interná stránka (ak nie je URL)', 'sel', 0, false], ['url', 'Externá URL (voliteľné, prepíše stránku)', 'url', 2000, false], ['visible', 'Zobraziť v menu', 'bool'], ['newtab', 'Otvoriť v novej karte', 'bool']] },
};
const NAV_PAGES = { '': '—', ...Object.fromEntries(Object.entries(PAGES).map(([k, v]) => [k, v[0]])) };
function listInput(t, o) {
  const r = {};
  for (const [k, , type, max, req] of LISTS[t].fields) {
    const v = o[k];
    if (type === 'bool') { r[k] = v === true || v === '1'; continue; }
    if (v != null && typeof v !== 'string') return null;
    if (type === 'sel') { r[k] = NAV_PAGES[v || ''] ? (v || '') : null; if (r[k] === null) return null; continue; }
    if (type === 'eur') { const s = String(v || '').trim().replace(/\s|€/g, ''); if (!s) { if (req) return null; r[k] = ''; continue; } if (!/^\d{1,5}([.,]\d{1,2})?$/.test(s)) return null; r[k] = Number(s.replace(',', '.')).toFixed(2); continue; }
    if (type === 'int') { const s = String(v ?? '').trim(); if (!/^\d{1,3}$/.test(s) || +s < 1) return null; r[k] = String(+s); continue; }
    if (type === 'url') { const s = String(v || '').trim(); if (!s) { r[k] = ''; continue; } r[k] = safeUrl(s); if (!r[k]) return null; continue; }
    r[k] = type === 'area' ? clean(String(v || '').replace(/\r/g, ''), max) : clean(v, max);
    if (req && !r[k]) return null;
  }
  if (t === 'nav' && !r.url && !r.page) return null;
  return r;
}
const lcache = {};
const getList = async t => lcache[t] || (lcache[t] = (await pool.query(`SELECT * FROM l_${t} ORDER BY pos, id`)).rows);
const dropList = t => { delete lcache[t]; };
async function initLists() {
  const pl = (await pool.query(`SELECT k,v FROM settings WHERE (k LIKE 'soc\\_%' OR k='contact_text') AND v<>'' AND v NOT LIKE 'enc:v1:%'`)).rows;
  for (const r of pl) await pool.query(`UPDATE settings SET v=$2 WHERE k=$1`, [r.k, encV(r.k, r.v)]);
  if (pl.length) cache = null;
  await pool.query(`CREATE TABLE IF NOT EXISTS l_faq (id SERIAL PRIMARY KEY, pos INT NOT NULL DEFAULT 0, q TEXT NOT NULL, a TEXT NOT NULL)`);
  await pool.query(`ALTER TABLE l_faq ADD COLUMN IF NOT EXISTS q_en TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE l_faq ADD COLUMN IF NOT EXISTS a_en TEXT NOT NULL DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS l_channels (id SERIAL PRIMARY KEY, pos INT NOT NULL DEFAULT 0, name TEXT NOT NULL, region TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS l_channels_rc ON l_channels (region, category)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS l_nav (id SERIAL PRIMARY KEY, pos INT NOT NULL DEFAULT 0, label TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', visible BOOLEAN NOT NULL DEFAULT TRUE, newtab BOOLEAN NOT NULL DEFAULT FALSE)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS l_plans (id SERIAL PRIMARY KEY, pos INT NOT NULL DEFAULT 0, name TEXT NOT NULL, name_en TEXT NOT NULL DEFAULT '', price TEXT NOT NULL DEFAULT '0.00', old_price TEXT NOT NULL DEFAULT '', period TEXT NOT NULL DEFAULT '1', badge TEXT NOT NULL DEFAULT '', badge_en TEXT NOT NULL DEFAULT '', popular BOOLEAN NOT NULL DEFAULT FALSE, features TEXT NOT NULL DEFAULT '', features_en TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', note_en TEXT NOT NULL DEFAULT '', btn TEXT NOT NULL DEFAULT '', btn_en TEXT NOT NULL DEFAULT '', btn_url TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE)`);
  const m3 = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_plans','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m3.rowCount) {
    const mx = (await pool.query(`SELECT COALESCE(MAX(pos),0) AS p FROM l_nav`)).rows[0].p;
    await pool.query(`INSERT INTO l_nav (pos,label,page) SELECT $1,'Cenník','cennik' WHERE NOT EXISTS (SELECT 1 FROM l_nav WHERE page='cennik')`, [mx + 1]);
    const FSK = ['Všetky kanály z našej ponuky (všetky regióny a kategórie)', 'HD / Full HD kvalita, kde je dostupná', 'Archív / catch-up pri kanáloch, ktoré ho podporujú', 'TV program (EPG)', 'Funguje vo všetkých podporovaných prehrávačoch a zariadeniach – pozri Návod na inštaláciu prehrávača', 'Podpora cez Telegram', 'Aktivácia po potvrdení platby'];
    const FEN = ['All channels in our offer (all regions and categories)', 'HD / Full HD quality where available', 'Archive / catch-up on channels that support it', 'TV guide (EPG)', 'Works in all supported players and devices – see the Player installation guide', 'Support via Telegram', 'Activation after payment confirmation'];
    const ex = [['1 mesiac', '1 month', '9.99', '1', false, '', '', 1], ['3 mesiace', '3 months', '24.99', '3', false, '', '', 1], ['6 mesiacov', '6 months', '44.99', '6', true, '', '', 1], ['12 mesiacov', '12 months', '79.99', '12', false, '', '', 1], ['12 mesiacov – 2 zariadenia', '12 months – 2 devices', '129.99', '12', false, 'Rodina', 'Family', 2]];
    let i = 1; for (const [n, ne, pr, per, pop, bd, bde, dev] of ex) await pool.query(`INSERT INTO l_plans (pos,name,name_en,price,period,popular,badge,badge_en,features,features_en,note,note_en,btn,btn_en) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Vybrať platbu','Choose payment')`,
      [i++, n, ne, pr, per, pop, bd, bde, [dev > 1 ? '2 zariadenia súčasne' : '1 zariadenie', ...FSK].join('\n'), [dev > 1 ? '2 devices at the same time' : '1 device', ...FEN].join('\n'), '', '']);
  }
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'home'`);
  // trash (soft delete) for sections/list items – deleted rows can be restored from admin
  await pool.query(`CREATE TABLE IF NOT EXISTS l_trash (id SERIAL PRIMARY KEY, t TEXT NOT NULL, data JSONB NOT NULL, label TEXT NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const m2 = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_nav2','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m2.rowCount) {
    const mx = (await pool.query(`SELECT COALESCE(MAX(pos),0) AS p FROM l_nav`)).rows[0].p;
    await pool.query(`INSERT INTO l_nav (pos,label,page) SELECT $1,'Návody','navody' WHERE NOT EXISTS (SELECT 1 FROM l_nav WHERE page='navody')`, [mx + 1]);
    await pool.query(`INSERT INTO l_nav (pos,label,page) SELECT $1,'Návrhy','navrhy' WHERE NOT EXISTS (SELECT 1 FROM l_nav WHERE page='navrhy')`, [mx + 2]);
  }
  const m = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_nav','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m.rowCount) {
    let i = 1; for (const [k, [n]] of Object.entries(PAGES)) await pool.query(`INSERT INTO l_nav (pos,label,page) VALUES ($1,$2,$3)`, [i++, n, k]);
    await pool.query(`INSERT INTO l_faq (pos,q,a) VALUES (1,$1,$2),(2,$3,$4),(3,$5,$6)`, ['Ako prebieha inštalácia?', 'Po objednávke dostanete návod krok za krokom. Inštalácia na Android TV box alebo Smart TV trvá pár minút.',
      'Aké platby prijímate?', 'Platbu kartou aj kryptomenami cez zabezpečenú platobnú bránu. Viac na stránke Platby.', 'Poskytujete podporu?', 'Áno, ozvite sa nám cez Kontakt – odpovedáme spravidla do 24 hodín.']);
  }
  // restore the accidentally deleted 'Kanály' menu section (only if it is missing)
  const m4 = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_kanaly_restore','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m4.rowCount) {
    const has = (await pool.query(`SELECT 1 FROM l_nav WHERE page='channels' LIMIT 1`)).rowCount;
    if (!has) {
      const hp = (await pool.query(`SELECT pos FROM l_nav WHERE page='home' ORDER BY pos LIMIT 1`)).rows[0];
      const at = hp ? hp.pos + 1 : 1;
      await pool.query(`UPDATE l_nav SET pos=pos+1 WHERE pos>=$1`, [at]);
      await pool.query(`INSERT INTO l_nav (pos,label,page,visible) VALUES ($1,'Kanály','channels',TRUE)`, [at]);
      console.log('MIGR kanaly section restored at pos', at);
    }
  }
}
const lok = (res, t, m) => (t === 'plans' ? res.redirect(303, '/admin/cennik?m=' + m) : ok(res, m, 'l-' + t));
const sectionOf = v => v === 'pay' ? 'pay' : 'home';
admin.post('/l/:t(faq|channels|nav|plans)', needAuth, csrf, wrap(async (req, res) => {
  const t = req.params.t, r = listInput(t, req.body); if (!r) return lok(res, t, 'badlist');
  const ks = Object.keys(r);
  await pool.query(`INSERT INTO l_${t} (${ks.join(',')},pos) VALUES (${ks.map((_, i) => '$' + (i + 1)).join(',')},(SELECT COALESCE(MAX(pos),0)+1 FROM l_${t}))`, Object.values(r));
  dropList(t); lok(res, t, 'ok');
}));
admin.post('/l/:t(faq|channels|nav|plans)/:id/edit', needAuth, csrf, wrap(async (req, res) => {
  const t = req.params.t, r = listInput(t, req.body); if (!r) return lok(res, t, 'badlist');
  const ks = Object.keys(r);
  await pool.query(`UPDATE l_${t} SET ${ks.map((k, i) => k + '=$' + (i + 1)).join(',')} WHERE id=$${ks.length + 1}`, [...Object.values(r), idOf(req)]);
  dropList(t); lok(res, t, 'ok');
}));
admin.post('/l/:t(faq|channels|nav|plans)/:id/delete', needAuth, csrf, wrap(async (req, res) => {
  const t = req.params.t; if (req.body.confirm !== '1') return lok(res, t, 'needconfirm');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = (await c.query(`DELETE FROM l_${t} WHERE id=$1 RETURNING *`, [idOf(req)])).rows[0];
    if (r) await c.query(`INSERT INTO l_trash (t,data,label) VALUES ($1,$2::jsonb,$3)`, [t, JSON.stringify(r), String(r.label || r.q || r.name || '').slice(0, 200)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); dropList(t); }
  lok(res, t, 'trashed');
}));
// restore from trash (sections, list items, monitors)
admin.post('/trash/:id(\\d+)/restore', needAuth, csrf, wrap(async (req, res) => {
  const c = await pool.connect(); let t = null;
  try {
    await c.query('BEGIN');
    const x = (await c.query(`DELETE FROM l_trash WHERE id=$1 RETURNING t,data`, [idOf(req)])).rows[0];
    if (x) {
      t = x.t; if (/^tvch(_bulk|_logos)?$/.test(t)) { await features.tvchRestore(c, x); await c.query('COMMIT'); ok(res, 'restored', 'trash'); return; }
      const tbl = t === 'monitors' ? 'monitors' : LISTS[t] ? 'l_' + t : null; if (!tbl) throw new Error('bad trash type');
      const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [tbl])).rows.map(r => r.column_name).filter(k => k !== 'id' && k in x.data);
      const vals = cols.map(k => (x.data[k] !== null && typeof x.data[k] === 'object') ? JSON.stringify(x.data[k]) : x.data[k]);
      await c.query(`INSERT INTO ${tbl} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  if (t && LISTS[t]) dropList(t); if (t === 'monitors' && features.dropMon) features.dropMon();
  ok(res, 'restored', 'trash');
}));
admin.post('/trash/:id(\\d+)/purge', needAuth, csrf, wrap(async (req, res) => {
  if (req.body.confirm !== '1') return ok(res, 'needconfirm', 'trash');
  await pool.query(`DELETE FROM l_trash WHERE id=$1`, [idOf(req)]); ok(res, 'ok', 'trash');
}));
async function trashAdmin(req) {
  const rows = (await pool.query(`SELECT id,t,label,deleted_at FROM l_trash ORDER BY deleted_at DESC LIMIT 200`)).rows;
  const TN = { nav: 'Sekcia menu', faq: 'FAQ', channels: 'Kanál (katalóg)', plans: 'Plán', monitors: 'Stav služieb', tvch: 'Kanál (katalóg kanálov)', tvch_bulk: 'Katalóg kanálov (hromadne)', tvch_logos: 'Logá kanálov' };
  return `<h2 id="trash">🗑️ Kôš (obnoviť zmazané)</h2>${rows.map(r => `<div class="card"><p><b>${esc(r.label || '—')}</b> <span class="hint">${esc(TN[r.t] || r.t)} · zmazané ${esc(new Date(r.deleted_at).toLocaleString('sk-SK', { timeZone: 'Europe/Zurich' }))}</span></p><div class="row">
<form method="post" action="/admin/trash/${r.id}/restore">${hid(req)}<button class="g">↩ Obnoviť</button></form>
<form method="post" action="/admin/trash/${r.id}/purge">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> natrvalo</label><button class="d">Vymazať natrvalo</button></form></div></div>`).join('') || '<p class="hint">Kôš je prázdny.</p>'}`;
}
admin.post('/l/:t(faq|channels|nav|plans)/:id/move', needAuth, csrf, wrap(async (req, res) => {
  const t = req.params.t, bs = (await getList(t)).slice(), i = bs.findIndex(b => b.id === idOf(req)), j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < bs.length) {
    [bs[i], bs[j]] = [bs[j], bs[i]];
    const c = await pool.connect();
    try { await c.query('BEGIN'); for (let k = 0; k < bs.length; k++) await c.query(`UPDATE l_${t} SET pos=$1 WHERE id=$2`, [k + 1, bs[k].id]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); dropList(t); }
  }
  lok(res, t, 'ok');
}));
admin.get('/texty', needAuth, wrap(async (req, res) => {
  const s = await getSettings(); const rows = UI.all();
  const m = req.query.m === 'ok' ? '<p class="ok">Uložené.</p>' : '';
  res.send(page('Texty stránky', `<h1>✏️ Texty stránky</h1>${m}<p><a href="/admin">← Admin</a></p><p class="hint">Všetky nadpisy, popisy a tlačidlá verejnej stránky. Ľavý stĺpec je predvolený text; vyplňte vlastný SK/EN text (prázdne = predvolené). Názvy sekcií v menu sa menia v Navigácii, ceny a balíky v Cenníku, kanály v Stave služieb.</p>
<form method="post" action="/admin/texty" class="card">${hid(req)}
<label class="ck"><input type="checkbox" name="cen_home" value="1"${s.cen_home !== '0' ? ' checked' : ''}> Zobraziť Cenník aj na hlavnej stránke</label>
<label class="ck"><input type="checkbox" name="tvbar_on" value="1"${s.tvbar_on !== '0' ? ' checked' : ''}> Zobraziť TV pás (● LIVE …) na hlavnej stránke</label>
${rows.map((r, i) => `<details><summary>${esc(r.sk)}${r.osk || r.oen ? ' ✏️' : ''}</summary><input type="hidden" name="k${i}" value="${esc(r.sk)}"><label>SK (predvolené: ${esc(r.sk)})</label><input name="s${i}" maxlength="500" value="${esc(r.osk)}"><label>EN (predvolené: ${esc(r.en)})</label><input name="e${i}" maxlength="500" value="${esc(r.oen)}"></details>`).join('')}
<button>Uložiť texty</button></form>`));
}));
admin.post('/texty', needAuth, csrf, wrap(async (req, res) => {
  const o = {};
  for (let i = 0; i < 2000 && req.body['k' + i] != null; i++) {
    const k = String(req.body['k' + i]); if (!UI.has(k)) continue;
    const sk = clean(req.body['s' + i], 500), en = clean(req.body['e' + i], 500);
    if (sk || en) o[k] = { ...(sk ? { sk } : {}), ...(en ? { en } : {}) };
  }
  await setSettings({ ui_texts: JSON.stringify(o), cen_home: req.body.cen_home ? '1' : '0', tvbar_on: req.body.tvbar_on ? '1' : '0' }); res.redirect(303, '/admin/texty?m=ok');
}));
admin.post('/kanaly', needAuth, csrf, wrap(async (req, res) => {
  const t = k => clean(String(req.body[k] || '').replace(/\r/g, ''), 1000);
  await setSettings({ kan_intro: t('kan_intro'), kan_intro_en: t('kan_intro_en'), kan_status: req.body.kan_status ? '1' : '0', kan_catalog: req.body.kan_catalog ? '1' : '0' }); ok(res, 'ok', 'kanaly');
}));
admin.post('/texts', needAuth, csrf, wrap(async (req, res) => {
  const u = String(req.body.checkout_url || '').trim(), cu = u ? safeUrl(u) : '';
  if (cu === null) return ok(res, 'badurl', 'texts');
  const t = k => clean(String(req.body[k] || '').replace(/\r/g, ''), 5000);
  await setSettings({ about_text: t('about_text'), contact_text: t('contact_text'), pay_text: t('pay_text'), about_text_en: t('about_text_en'), contact_text_en: t('contact_text_en'), pay_text_en: t('pay_text_en'), checkout_url: cu, chat_enabled: req.body.chat_enabled ? '1' : '0' }); ok(res, 'ok', 'texts');
}));
function listAdmin(req, t, rows) {
  const L = LISTS[t];
  const fld = (o = {}) => L.fields.map(([k, n, type, max, rq]) => type === 'bool' ? `<label class="ck"><input type="checkbox" name="${k}" value="1"${(o.id ? o[k] : !['newtab', 'popular'].includes(k)) ? ' checked' : ''}> ${n}</label>`
    : type === 'sel' ? `<label>${n}</label>${sel(k, NAV_PAGES, o[k] || '')}`
    : type === 'area' ? `<label>${n}</label><textarea name="${k}" maxlength="${max}" rows="3"${rq ? ' required' : ''}>${esc(o[k] || '')}</textarea>`
    : `<label>${n}</label><input name="${k}"${type === 'url' ? ' type="url" placeholder="https://"' : type === 'eur' ? ' inputmode="decimal" autocomplete="off" placeholder="9,99"' : type === 'int' ? ' inputmode="numeric" autocomplete="off" placeholder="1"' : ''} maxlength="${max > 0 ? max : type === 'int' ? 3 : 12}" value="${esc(o[k] || '')}"${rq ? ' required' : ''}>`).join('');
  const body = rows.map((o, i) => `<details class="card${o.visible === false || o.active === false ? ' off' : ''}"><summary>${esc(o.label || o.q || o.name)}${o.price ? ` <span class="hint">${esc(fmtEur(o.price))} / ${esc(perLabel(o.period, false))}</span>` : ''}${o.region ? ` <span class="hint">${esc(o.region)} › ${esc(o.category)}</span>` : ''}</summary>
<form method="post" action="/admin/l/${t}/${o.id}/edit">${hid(req)}${fld(o)}<button>Uložiť</button></form><div class="row">
${i > 0 ? `<form method="post" action="/admin/l/${t}/${o.id}/move">${hid(req)}<input type="hidden" name="dir" value="up"><button class="g">↑</button></form>` : ''}
${i < rows.length - 1 ? `<form method="post" action="/admin/l/${t}/${o.id}/move">${hid(req)}<input type="hidden" name="dir" value="down"><button class="g">↓</button></form>` : ''}
<form method="post" action="/admin/l/${t}/${o.id}/delete">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> Potvrdiť zmazanie</label><button class="d">Zmazať (do koša)</button></form></div></details>`).join('');
  return `<h2 id="l-${t}">${L.title}</h2>${body || '<p class="hint">Prázdne.</p>'}<details class="card"><summary>➕ Pridať</summary><form method="post" action="/admin/l/${t}">${hid(req)}${fld()}<button>Pridať</button></form></details>`;
}
const PM = { ok: 'Uložené.', badlist: 'Neplatné údaje (cena napr. 9,99; obdobie celé číslo mesiacov; odkaz https://…).' };
admin.get('/cennik', needAuth, wrap(async (req, res) => {
  const s = await getSettings(), m = PM[req.query.m];
  res.send(page('Cenník', `<h1>🏷️ Cenník</h1><p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="/${esc(s.slug)}/cennik" target="_blank" rel="noopener">Verejne: /${esc(s.slug)}/cennik</a></p>${m ? `<div class="msg${req.query.m === 'ok' ? '' : ' err'}">${esc(m)}</div>` : ''}
<form method="post" action="/admin/cennik/texts" class="card">${hid(req)}<h2>Texty</h2><label>Úvod (SK)</label><textarea name="pricing_intro" rows="3" maxlength="5000">${esc(s.pricing_intro)}</textarea><label>Úvod (EN)</label><textarea name="pricing_intro_en" rows="3" maxlength="5000">${esc(s.pricing_intro_en)}</textarea>
<label>Poznámka pod cenníkom – čo je zahrnuté, platby, vrátenie peňazí, podmienky (SK)</label><textarea name="pricing_note" rows="4" maxlength="5000">${esc(s.pricing_note)}</textarea><label>Poznámka (EN)</label><textarea name="pricing_note_en" rows="4" maxlength="5000">${esc(s.pricing_note_en)}</textarea><button>Uložiť texty</button></form>
<p class="hint">Plány sa zobrazujú na úvodnej stránke aj na /cennik v poradí nižšie. Ceny v EUR sa formátujú ako „9,99 €“. Príkladové plány (cena 0) upravte alebo zmažte.</p>
${listAdmin(req, 'plans', await getList('plans'))}`, 'a adm'));
}));
admin.post('/cennik/texts', needAuth, csrf, wrap(async (req, res) => {
  const t = k => clean(String(req.body[k] || '').replace(/\r/g, ''), 5000);
  await setSettings({ pricing_intro: t('pricing_intro'), pricing_intro_en: t('pricing_intro_en'), pricing_note: t('pricing_note'), pricing_note_en: t('pricing_note_en') });
  res.redirect(303, '/admin/cennik?m=ok');
}));
const features = require('./features')({ app, admin, pool, getSettings, setSettings, page, esc, hid, csrf, needAuth, lockedFor, recordFail, fails, currentHash, encV, decV, wrap, writeSess,
  dropCache: () => { cache = null; }, buildExport, safeUrl, chTree: (...a) => chTree(...a), PROD });
require('./extras')(Object.assign(features, { sniff, shell: (...a) => shell(...a), slugOk: (r) => slugOk(r), T, clean }));
require('./tvch')(features);
require('./epg')(features);
const payMethods = require('./paymethods')(features);
app.use('/admin', admin);

// ---- short links ----
app.get('/s/:code', wrap(async (req, res) => {
  const code = String(req.params.code);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
  if (!/^[A-Za-z0-9-]{1,40}$/.test(code)) return res.status(404).send(page('404', '<h1>404</h1><p class="bio">Odkaz neexistuje.</p>'));
  const r = await pool.query(`SELECT target_url FROM short_links WHERE code=$1 AND active AND (expires_at IS NULL OR expires_at > now())`, [code]);
  const u = r.rowCount && safeUrl(r.rows[0].target_url);
  if (!u) return res.status(404).send(page('404', '<h1>404</h1><p class="bio">Odkaz neexistuje alebo vypršal.</p>'));
  res.redirect(302, u);
}));

// ---- public site ----
const PER_PAGE = 24;
const enc = encodeURIComponent;
const ARROW = '<span class="chev">›</span>';
async function shell(req, res, s, active, title, content, sub = '') {
  const nav = (await getList('nav')).filter(n => n.visible);
  const items = nav.map(n => {
    const href = n.url || ('/' + s.slug + PAGES[n.page][1]);
    const on = !n.url && n.page === active;
    const label = !n.url && PAGES[n.page] && n.label === PAGES[n.page][0] ? T(req, n.label) : n.label;
    return `<li><a href="${esc(href)}"${on ? ' class="on" aria-current="page"' : ''}${n.url ? ' rel="noopener noreferrer nofollow"' + (n.newtab ? ' target="_blank"' : '') : ''}><span class="ni">${n.url ? '🔗' : NAV_ICONS[n.page]}</span>${esc(label)}</a>${on && sub ? sub : ''}</li>`;
  }).join('') + (s.stav_nav === '1' ? `<li><a href="/${esc(s.slug)}/stav"${active === 'stav' ? ' class="on" aria-current="page"' : ''}><span class="ni">📡</span>${esc(T(req, 'Stav služieb'))}</a></li>` : '');
  const chat = s.chat_enabled !== '0';
  const extra = `<link rel="stylesheet" href="/theme.css?v=${esc(s.ver)}">${chat ? `<link rel="stylesheet" href="/static/chat.css?v=${CHAT_V}"><script src="/static/chat.js?v=${CHAT_V}" defer></script>` : ''}${s.img.logo ? `<link rel="icon" href="/img/logo?v=${esc(s.img.logo)}">` : ''}`;
  const brand = `<a class="brand" href="/${esc(s.slug)}">${s.img.logo ? `<img src="/img/logo?v=${esc(s.img.logo)}" alt="" width="32" height="32">` : '<span class="bl">▶</span>'}${esc(loc(req, s, 'title'))}</a>`;
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Vary', 'Cookie');
  res.send(`<!doctype html><html lang="${req.lang === 'en' ? 'en' : 'sk'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${active === 'stav' ? '<meta http-equiv="refresh" content="60">' : ''}<meta name="description" content="${esc(s.meta_desc || loc(req, s, 'bio'))}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(s.meta_desc || loc(req, s, 'bio'))}"><meta property="og:type" content="website"><meta property="og:site_name" content="${esc(loc(req, s, 'title'))}"><meta property="og:locale" content="${req.lang === 'en' ? 'en_US' : 'sk_SK'}"><meta property="og:url" content="${esc(pubOrigin(req) + req.path)}">${s.img.logo ? `<meta property="og:image" content="${esc(pubOrigin(req))}/img/logo?v=${esc(s.img.logo)}">` : ''}<meta name="twitter:card" content="summary"><link rel="canonical" href="${esc(pubOrigin(req) + req.path)}"><link rel="alternate" hreflang="sk" href="${esc(pubOrigin(req) + req.path)}?lang=sk"><link rel="alternate" hreflang="en" href="${esc(pubOrigin(req) + req.path)}?lang=en"><title>${esc(title)}</title><link rel="stylesheet" href="/static/s.css?v=${CSS_V}">${extra}</head>
<body class="site${s.layout === 'tv' ? ' tv' : ''}"><input type="checkbox" id="nt" class="nt" aria-hidden="true"><header class="top">${brand}${langSw(req)}<label for="nt" class="burger" aria-label="Menu">☰</label></header>
<aside class="side"><div class="sb">${brand}${langSw(req)}</div><nav aria-label="${T(req, 'Hlavné menu')}"><ul>${items}</ul></nav></aside><label for="nt" class="scrim" aria-hidden="true"></label>
<main class="w pub${s.layout === 'tv' ? ' tv' : ''}">${content}${s.footer ? `<p class="f">${esc(s.footer)}</p>` : ''}</main></body></html>`);
}
const crumbs = (s, parts) => `<nav class="crumbs" aria-label="Breadcrumbs">${parts.map(([n, h], i) => i < parts.length - 1 ? `<a href="${esc(h)}">${esc(n)}</a>${ARROW}` : `<span>${esc(n)}</span>`).join('')}</nav>`;
const DEF_PLAN_URL = SHORT_PAY;
const planUrl = p => DEF_PLAN_URL + '?plan=' + p.id;
function fmtEur(v) { const n = Number(v); return (isFinite(n) ? n : 0).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\u00a0€'; }
function perLabel(p, en) { const n = +p || 1; return en ? `${n} ${n === 1 ? 'month' : 'months'}` : `${n} ${n === 1 ? 'mesiac' : n < 5 ? 'mesiace' : 'mesiacov'}`; }
async function pricingHtml(req, s, h = 'h2') {
  const en = req.lang === 'en', L = (o, k) => (en && o[k + '_en']) || o[k];
  const ps = (await getList('plans')).filter(p => p.active); if (!ps.length) return '';
  const cards = ps.map(p => { const f = L(p, 'features').split('\n').map(x => x.trim()).filter(Boolean), mo = (+p.period || 1);
    return `<div class="plan${p.popular ? ' pop' : ''}">${p.popular ? `<span class="pbadge">⭐ ${tx(en, 'Najobľúbenejší', 'Most popular')}</span>` : ''}${L(p, 'badge') ? `<span class="pdisc">${esc(L(p, 'badge'))}</span>` : ''}
<h3>${esc(L(p, 'name'))}</h3><p class="pprice">${p.old_price ? `<s>${esc(fmtEur(p.old_price))}</s> ` : ''}<b>${esc(fmtEur(p.price))}</b><span> / ${esc(perLabel(p.period, en))}</span></p>${mo > 1 && +p.price > 0 ? `<p class="hint">≈ ${esc(fmtEur(p.price / mo))} / ${tx(en, 'mesiac', 'month')}</p>` : ''}
${f.length ? `<ul class="pfeat">${f.map(x => `<li>${esc(x).replace(/(Návod na inštaláciu prehrávača|Player installation guide)/, `<a href="/${esc(s.slug)}/navody">$1</a>`)}</li>`).join('')}</ul>` : ''}${L(p, 'note') ? `<p class="hint">${esc(L(p, 'note'))}</p>` : ''}<a class="btn pbtn" href="${esc(p.btn_url || planUrl(p))}" rel="noopener">${esc(L(p, 'btn') || (tx(en, 'Vybrať platbu', 'Choose payment')))}</a></div>`; }).join('');
  return `<section class="pricing" id="cennik"><${h} class="ph">${T(req, 'Cenník')}</${h}>${loc(req, s, 'pricing_intro') ? `<div class="prose">${para(loc(req, s, 'pricing_intro'))}</div>` : ''}<div class="plans">${cards}</div>${loc(req, s, 'pricing_note') ? `<div class="prose hint pnote">${para(loc(req, s, 'pricing_note'))}</div>` : ''}</section>`;
}
const para = t => esc(t).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const btnHtml = b => `<a class="b${b.brand ? ' br br-' + b.brand : ''}" href="${esc(b.url)}" rel="noopener noreferrer nofollow"${b.newtab ? ' target="_blank"' : ''}>${b.emoji ? esc(b.emoji) + ' ' : ''}${esc(b.label)}</a>`;
const SOC_BRAND = { telegram: 'telegram', instagram: 'instagram', facebook: 'facebook', x: 'x', tiktok: 'tiktok', email: 'email', whatsapp: 'whatsapp', signal: 'signal', youtube: 'youtube', tg_group: 'telegram', fb_group: 'facebook' };
const pubBtns = async sec => { const now = Date.now(); return (await getButtons()).filter(b => b.enabled && (b.section || 'home') === sec && inWindow(b, now)); };
const slugOk = async (req) => { const s = await getSettings(); return req.params.slug === s.slug ? s : null; };
// channel catalogue tree (cached, invalidated with list cache)
async function chTree() {
  const rows = await getList('channels');
  if (rows._tree) return rows._tree;
  const t = new Map();
  for (const c of rows) { if (!t.has(c.region)) t.set(c.region, new Map()); const m = t.get(c.region); if (!m.has(c.category)) m.set(c.category, []); m.get(c.category).push(c); }
  return (rows._tree = t);
}
const chBase = s => '/' + s.slug + '/kanaly';

app.get('/:slug', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const bs = await pubBtns('home');
  const soc = SOCIALS.filter(([k]) => socOn(s, k)).map(([k, n, e]) => `<a href="${esc(k === 'email' ? 'mailto:' + s['soc_' + k] : s['soc_' + k])}" rel="noopener noreferrer nofollow" title="${esc(n)}" aria-label="${esc(n)}">${e}<span> ${esc(n)}</span></a>`).join('');
  const banner = await features.monitorBanner(req.lang).catch(() => '');
  await shell(req, res, s, 'home', s.meta_title || loc(req, s, 'title'), `${banner}<section class="hero">${s.img.logo ? `<img class="logo" src="/img/logo?v=${esc(s.img.logo)}" alt="${esc(s.title)}" width="96" height="96">` : ''}<h1>${esc(loc(req, s, 'title'))}</h1>${loc(req, s, 'bio') ? `<p class="bio">${esc(loc(req, s, 'bio'))}</p>` : ''}
${s.layout === 'tv' ? (s.tvbar_on !== '0' ? `<div class="tvbar"><span class="live">${esc(T(req, '● LIVE'))}</span><span>${esc(T(req, '▶ Stream'))}</span><span>${esc(T(req, '📺 TV'))}</span><span>${esc(T(req, '⚙ Software'))}</span></div>` : '') : ''}</section>
${features.dnesBlock ? await features.dnesBlock(req, s) : ''}${bs.map(btnHtml).join('\n')}${soc ? `<nav class="soc">${soc}</nav>` : ''}${s.cen_home !== '0' ? await pricingHtml(req, s) : ''}`);
}));
app.get('/:slug/cennik', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const h = await pricingHtml(req, s, 'h1');
  await shell(req, res, s, 'cennik', T(req, 'Cenník') + ' – ' + loc(req, s, 'title'), h || `<h1 class="ph">${T(req, 'Cenník')}</h1><p class="hint">${tx(req.lang === 'en', 'Cenník pripravujeme.', 'Pricing coming soon.')}</p>`);
}));
app.get('/:slug/kanaly', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const en = req.lang === 'en';
  const ni = (await getList('nav')).find(n => n.page === 'channels' && !n.url);
  const title = ni && ni.label !== PAGES.channels[0] ? ni.label : T(req, 'Kanály');
  const chs = await features.monitorChannels(req.lang).catch(() => []);
  const intro = (en && s.kan_intro_en) || s.kan_intro;
  const showSt = s.kan_status !== '0';
  const list = chs.length ? `<div class="guide">${chs.map((c, i) => `<div class="gi"><span class="gn">${i + 1}</span><span class="gt">${esc(c.name)}</span>${showSt ? `<span class="tbadge"><span class="dot ${esc(c.cls)}"></span>${esc(T(req, c.label))}</span>` : '<span class="gp">▶</span>'}</div>`).join('')}</div>`
    : `<p class="hint">${tx(en, 'Zatiaľ žiadne kanály.', 'No channels yet.')}</p>`;
  let cat = '';
  if (s.kan_catalog === '1') {
    const t = await chTree(), b = chBase(s);
    const regs = [...t.entries()].map(([r, m]) => [r, m.size, [...m.values()].reduce((a, x) => a + x.length, 0)]);
    if (regs.length) cat = `<h2 class="ph">${tx(en, 'Katalóg', 'Catalogue')}</h2><div class="tiles">${regs.map(([r, nc, n]) => `<a class="tile" href="${b}/${enc(r)}"><span class="tt">${esc(r)}</span><span class="tm">${nc} ${T(req, 'kategórií')} • ${n} ${T(req, 'položiek')}</span></a>`).join('')}</div>`;
  }
  return shell(req, res, s, 'channels', title + ' – ' + loc(req, s, 'title'), `<h1 class="ph">${esc(title)}</h1>${intro ? `<div class="prose lead">${para(intro)}</div>` : ''}${list}${await features.tvchPublic(req)}${features.epgAssets ? await features.epgAssets(req) : ''}${cat}`);
}));
app.get('/:slug/kanaly-katalog', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const t = await chTree(), b = chBase(s);
  const regs = [...t.entries()].map(([r, m]) => [r, m.size, [...m.values()].reduce((a, x) => a + x.length, 0)]);
  const sub = regs.length ? `<ul class="subnav">${regs.map(([r]) => `<li><a href="${b}/${enc(r)}">${esc(r)}</a></li>`).join('')}</ul>` : '';
  const badges = await Promise.all(regs.map(([r]) => features.monitorBadge(r, req.lang).catch(() => '')));
  await shell(req, res, s, 'channels', T(req, 'Kanály') + ' – ' + loc(req, s, 'title'), `${crumbs(s, [[T(req, 'Kanály')]])}<h1 class="ph">${T(req, 'Kanály')}</h1><p class="lead">${T(req, 'Vyberte región.')}</p>
<div class="tiles">${regs.map(([r, nc, n], i) => `<a class="tile" href="${b}/${enc(r)}"><span class="tt">${esc(r)}</span><span class="tm">${nc} ${T(req, 'kategórií')} • ${n} ${T(req, 'položiek')}</span>${badges[i]}</a>`).join('') || `<p class="hint">${T(req, 'Katalóg je zatiaľ prázdny.')}</p>`}</div>`, sub);
}));
app.get('/:slug/kanaly/:reg', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const t = await chTree(), b = chBase(s), r = req.params.reg, m = t.get(r); if (!m) return next();
  const sub = `<ul class="subnav"><li><a class="on" href="${b}/${enc(r)}">${esc(r)}</a><ul>${[...m.keys()].map(c => `<li><a href="${b}/${enc(r)}/${enc(c)}">${esc(c)}</a></li>`).join('')}</ul></li></ul>`;
  const cats = [...m.entries()];
  const badges = await Promise.all(cats.map(([c]) => features.monitorBadge(r + ' › ' + c, req.lang).catch(() => '')));
  await shell(req, res, s, 'channels', r + ' – ' + T(req, 'Kanály'), `${crumbs(s, [[T(req, 'Kanály'), b], [r]])}<h1 class="ph">${esc(r)}</h1><p class="lead">${T(req, 'Vyberte kategóriu.')}</p>
<div class="tiles">${cats.map(([c, l], i) => `<a class="tile" href="${b}/${enc(r)}/${enc(c)}"><span class="tt">${esc(c)}</span><span class="tm">${l.length} ${T(req, 'položiek')}</span>${badges[i]}</a>`).join('')}</div>`, sub);
}));
app.get('/:slug/kanaly/:reg/:cat', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const t = await chTree(), b = chBase(s), r = req.params.reg, c = req.params.cat, m = t.get(r), l = m && m.get(c); if (!l) return next();
  const pages = Math.max(1, Math.ceil(l.length / PER_PAGE)), p = Math.min(pages, Math.max(1, parseInt(req.query.p, 10) || 1));
  const base = `${b}/${enc(r)}/${enc(c)}`;
  const pg = pages > 1 ? `<nav class="pager">${p > 1 ? `<a href="${base}?p=${p - 1}">${T(req, '‹ Predošlá')}</a>` : ''}<span>${p} / ${pages}</span>${p < pages ? `<a href="${base}?p=${p + 1}">${T(req, 'Ďalšia ›')}</a>` : ''}</nav>` : '';
  const sub = `<ul class="subnav"><li><a href="${b}/${enc(r)}">${esc(r)}</a><ul>${[...m.keys()].map(x => `<li><a${x === c ? ' class="on"' : ''} href="${b}/${enc(r)}/${enc(x)}">${esc(x)}</a></li>`).join('')}</ul></li></ul>`;
  await shell(req, res, s, 'channels', c + ' – ' + r, `${crumbs(s, [[T(req, 'Kanály'), b], [r, b + '/' + enc(r)], [c]])}<h1 class="ph">${esc(c)}</h1>
<div class="guide">${l.slice((p - 1) * PER_PAGE, p * PER_PAGE).map((x, i) => `<a class="gi" href="/${esc(s.slug)}/kanal/${x.id}"><span class="gn">${(p - 1) * PER_PAGE + i + 1}</span><span class="gt">${esc(x.name)}</span><span class="gp">▶</span></a>`).join('')}</div>${pg}`, sub);
}));
app.get('/:slug/kanal/:id(\\d+)', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const x = (await getList('channels')).find(c => c.id === Number(req.params.id)); if (!x) return next();
  const b = chBase(s);
  await shell(req, res, s, 'channels', x.name, `${crumbs(s, [[T(req, 'Kanály'), b], [x.region, b + '/' + enc(x.region)], [x.category, b + '/' + enc(x.region) + '/' + enc(x.category)], [x.name]])}
<article class="card detail"><div class="dh"><span class="bl">▶</span><h1 class="ph">${esc(x.name)}</h1></div><p class="tm">${esc(x.region)} • ${esc(x.category)}</p>${x.note ? para(x.note) : ''}</article>`);
}));
app.get('/:slug/platby', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const bs = await pubBtns('pay');
  const co = s.checkout_url && req.lang === 'en' ? (() => { try { const u = new URL(s.checkout_url); u.searchParams.set('lang', 'en'); return u.href; } catch { return s.checkout_url; } })() : s.checkout_url;
  await shell(req, res, s, 'payments', T(req, 'Platby') + ' – ' + loc(req, s, 'title'), `<h1 class="ph">${T(req, 'Platby')}</h1>${loc(req, s, 'pay_text') ? `<div class="prose">${para(loc(req, s, 'pay_text'))}</div>` : ''}
${s.checkout_url ? `<a class="b br br-platby" href="${esc(co)}" rel="noopener noreferrer nofollow">${T(req, '💳 Prejsť k platbe')}</a>` : ''}${bs.map(btnHtml).join('\n')}`);
}));
app.get('/:slug/kontakt', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const soc = SOCIALS.filter(([k]) => socOn(s, k)).map(([k, n, e]) => `<a class="b br br-${SOC_BRAND[k]}" href="${esc(k === 'email' ? 'mailto:' + s['soc_' + k] : s['soc_' + k])}" rel="noopener noreferrer nofollow">${e} ${esc(n)}${k === 'email' ? ': ' + esc(s.soc_email) : ''}</a>`).join('');
  await shell(req, res, s, 'contact', T(req, 'Kontakt') + ' – ' + loc(req, s, 'title'), `<h1 class="ph">${T(req, 'Kontakt')}</h1>${loc(req, s, 'contact_text') ? `<div class="prose">${para(loc(req, s, 'contact_text'))}</div>` : ''}${soc || `<p class="hint">${T(req, 'Kontakty zatiaľ nie sú vyplnené.')}</p>`}`);
}));
app.get('/:slug/faq', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  const f = await getList('faq');
  const en = req.lang === 'en';
  await shell(req, res, s, 'faq', 'FAQ – ' + loc(req, s, 'title'), `<h1 class="ph">${T(req, 'Časté otázky')}</h1>${f.map(x => `<details class="qa"><summary>${esc(en && x.q_en ? x.q_en : x.q)}</summary>${para(en && x.a_en ? x.a_en : x.a)}</details>`).join('') || `<p class="hint">${T(req, 'Zatiaľ žiadne otázky.')}</p>`}`);
}));
app.get('/:slug/o-nas', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  await shell(req, res, s, 'about', T(req, 'O nás') + ' – ' + loc(req, s, 'title'), `<h1 class="ph">${T(req, 'O nás')}</h1><div class="prose">${para(loc(req, s, 'about_text') || '')}</div>`);
}));
app.get('/:slug/stav', wrap(async (req, res, next) => {
  const s = await slugOk(req); if (!s) return next();
  res.setHeader('X-Robots-Tag', 'noindex');
  await shell(req, res, s, 'stav', T(req, 'Stav služieb') + ' – ' + loc(req, s, 'title'), `<h1 class="ph">${T(req, 'Stav služieb')}</h1><p class="lead">${T(req, 'Aktuálny stav našich služieb. Stránka sa obnovuje automaticky.')}</p>${await features.monitorPage(req.lang)}`);
}));
app.use((req, res) => res.status(404).send(page('404', `<h1>404</h1><p class="bio">${T(req, 'Stránka neexistuje.')}</p>`)));
app.use((err, req, res, next) => { console.error(err && err.message); res.status(500).send('Chyba servera'); });

init().then(initLists).then(() => features.initFeatures()).then(() => features.initExtras()).then(() => features.tvchInit()).then(() => features.epgInit()).then(() => {
  app.listen(PORT, () => console.log('listening on ' + PORT));
  // keep-awake self-ping through the public Render URL every 10 min
  // + cross-ping the checkout service so waking one wakes the other
  const targets = [process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL + '/healthz',
    (process.env.PEER_URL || CHECKOUT_ORIGIN) + '/health'].filter(Boolean);
  const ping = () => targets.forEach(u => fetch(u, { signal: AbortSignal.timeout(60e3) }).catch(() => {}));
  setTimeout(ping, 30e3).unref(); setInterval(ping, 10 * 60e3).unref();
}).catch(e => { console.error('init failed', e.message); process.exit(1); });
