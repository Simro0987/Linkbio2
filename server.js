'use strict';
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ENV_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SECRET = process.env.SESSION_SECRET || '';
const PROD = process.env.NODE_ENV === 'production';
if (!ENV_HASH || SECRET.length < 32 || !process.env.DATABASE_URL) { console.error('Missing ADMIN_PASSWORD_HASH / SESSION_SECRET / DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: PROD || process.env.PGSSL !== '0' ? { rejectUnauthorized: true } : false, max: 5, keepAlive: true, idleTimeoutMillis: 300000 });
pool.on('error', e => console.error('pg pool', e.message));
const RESERVED = new Set(['admin', 'api', 'static', 'healthz', 'favicon.ico', 'robots.txt', 'theme.css', 'img']);
const SLUG_RE = /^[a-z0-9-]{1,30}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;

// ---- theme presets / fonts ----
const PRESETS = {
  kava: { name: 'Káva', c_bg: '#1b120d', c_card: '#2e1f16', c_btntext: '#fff7ee', c_text: '#f3e6d8' },
  tmava: { name: 'Tmavá', c_bg: '#0f1115', c_card: '#1f2430', c_btntext: '#ffffff', c_text: '#e5e7eb' },
  svetla: { name: 'Svetlá', c_bg: '#f7f5f2', c_card: '#ffffff', c_btntext: '#1f2937', c_text: '#1f2937' },
  moda: { name: 'Modá', c_bg: '#0b1d3a', c_card: '#1e40af', c_btntext: '#ffffff', c_text: '#dbeafe' },
};
const FONTS = {
  system: { name: 'Systémové (sans-serif)', css: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif' },
  serif: { name: 'Pätkové (serif)', css: 'Georgia,Cambria,"Times New Roman",Times,serif' },
  mono: { name: 'Neproporcionálne (mono)', css: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace' },
  rounded: { name: 'Zaoblené', css: 'ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN",Quicksand,Nunito,system-ui,sans-serif' },
  humanist: { name: 'Humanistické', css: 'Seravek,"Gill Sans Nova",Ubuntu,Calibri,"DejaVu Sans",source-sans-pro,sans-serif' },
};
const SOCIALS = [
  ['telegram', 'Telegram', '✈️'], ['instagram', 'Instagram', '📷'], ['facebook', 'Facebook', '📘'],
  ['x', 'X', '✖️'], ['tiktok', 'TikTok', '🎵'], ['email', 'E-mail', '✉️'],
];
const DEFAULTS = {
  slug: 'kava', title: 'Káva v Linku', bio: 'Malá kaviareň s veľkou chuťou ☕ Dobrá káva, pokojná chvíľa.',
  meta_title: '', meta_desc: '', footer: '', preset: 'kava', ...Object.fromEntries(Object.entries(PRESETS.kava).filter(([k]) => k !== 'name')),
  btn_style: 'rounded', font: 'system', ver: '1', pwver: '0', ...Object.fromEntries(SOCIALS.map(([k]) => ['soc_' + k, ''])),
};

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS buttons (id SERIAL PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', pos INT NOT NULL DEFAULT 0)`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE buttons ADD COLUMN IF NOT EXISTS newtab BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`CREATE TABLE IF NOT EXISTS images (k TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, ver TEXT NOT NULL)`);
  const base = { slug: DEFAULTS.slug, title: DEFAULTS.title, bio: DEFAULTS.bio };
  for (const [k, v] of Object.entries(DEFAULTS)) await pool.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING`, [k, v]);
  const r = await pool.query(`INSERT INTO settings (k,v) VALUES ('seeded','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  const m = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_kava','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m.rowCount) for (const [k, v] of Object.entries(base)) await pool.query(`UPDATE settings SET v=$2 WHERE k=$1`, [k, v]);
  if (r.rowCount) await pool.query(`INSERT INTO buttons (label,url,emoji,pos) VALUES ($1,$2,$3,1)`, ['Platby', 'https://chain2pay-checkout-gl.onrender.com', '💳']);
}
let cache = null;
async function getSettings() {
  if (cache) return cache;
  const r = await pool.query(`SELECT k,v FROM settings`);
  const s = { ...DEFAULTS }; r.rows.forEach(x => { s[x.k] = x.v; });
  const im = await pool.query(`SELECT k,ver FROM images`);
  s.img = {}; im.rows.forEach(x => { s.img[x.k] = x.ver; });
  return (cache = s);
}
// write several settings atomically and bump the settings version (cache busting for /theme.css)
async function setSettings(obj) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(obj)) await c.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, String(v)]);
    await c.query(`UPDATE settings SET v=(COALESCE(NULLIF(v,''),'0')::bigint+1)::text WHERE k='ver'`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); cache = null; }
}
let bcache = null;
const getButtons = async () => bcache || (bcache = (await pool.query(`SELECT id,label,url,emoji,pos,enabled,newtab FROM buttons ORDER BY pos, id`)).rows);
const bq = async (q, a) => { try { return await pool.query(q, a); } finally { bcache = null; } };

const esc = s => String(s == null ? '' : s).replace(/[&<>"'`=\/]/g, c => '&#' + c.charCodeAt(0) + ';');
function safeUrl(u) {
  u = String(u || '').trim();
  if (u.length > 2000) return null;
  try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch { return null; }
}
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
  f.n++; if (f.n >= 5) { f.until = now + 15 * 60e3; f.n = 0; f.first = now; }
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
    defaultSrc: ["'none'"], styleSrc: ["'self'"], imgSrc: ["'self'"], formAction: ["'self'"], baseUri: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: [] } },
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
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /admin\n'));
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
  return `body{background-color:${bg};${bgImg}color:${tx};font-family:${font}}
.bio,.f,.soc a{color:${tx};opacity:.85}.b{background:${card};border-color:${card};color:${bt};border-radius:${rad};filter:none}
.b:hover,.b:focus{background:${card};filter:brightness(1.15)}.soc a{border-color:${card}}`;
}
app.get('/theme.css', wrap(async (req, res) => {
  const s = await getSettings();
  res.type('text/css; charset=utf-8');
  res.setHeader('Cache-Control', req.query.v === s.ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  res.send(themeCss(s));
}));

const page = (title, body, cls = '', desc = '', extra = '') => `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="description" content="${esc(desc || title)}"><meta property="og:title" content="${esc(title)}"><title>${esc(title)}</title><link rel="stylesheet" href="/static/s.css?v=${CSS_V}">${extra}</head><body><main class="w ${cls}">${body}</main></body></html>`;

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
  res.send(page('Prihlásenie', `<h1>Admin</h1>${e}<form method="post" action="/admin/login" class="card">${hid(req)}<label for="p">Heslo</label><input id="p" type="password" name="password" autocomplete="current-password" required maxlength="200"><button>Prihlásiť</button></form>`));
});
admin.post('/login', csrf, wrap(async (req, res) => {
  const ip = req.ip;
  if (lockedFor(ip)) return res.redirect(303, '/admin/login?e=l');
  const good = await bcrypt.compare(String(req.body.password || '').slice(0, 200), await currentHash());
  if (!good) { recordFail(ip); return res.redirect(303, '/admin/login?e=1'); }
  fails.delete(ip);
  const s = await getSettings();
  writeSess(res, { auth: true, pv: s.pwver, csrf: crypto.randomBytes(24).toString('base64url') });
  res.redirect(303, '/admin');
}));
admin.post('/logout', csrf, (req, res) => { writeSess(res, { auth: false, csrf: crypto.randomBytes(24).toString('base64url') }); res.redirect(303, '/admin/login'); });

const MSGS = { ok: 'Uložené.', badslug: 'Neplatný slug (a-z, 0-9, pomlčka, 1–30 znakov, nie rezervované slovo).', badurl: 'Neplatná URL (povolené len http/https).', badlabel: 'Chýba názov tlačidla.',
  badimg: 'Neplatný obrázok – povolené len PNG, JPG alebo WebP (SVG nie).', big: 'Obrázok je príliš veľký (max 2 MB).', noimg: 'Nevybrali ste súbor.', badsoc: 'Neplatná adresa sociálnej siete.',
  badpw: 'Aktuálne heslo nie je správne.', shortpw: 'Nové heslo musí mať aspoň 12 znakov.', pwmismatch: 'Nové heslá sa nezhodujú.', pwok: 'Heslo bolo zmenené.', lock: 'Príliš veľa pokusov. Skúste neskôr.' };
const sel = (name, opts, cur) => `<select name="${name}">${Object.entries(opts).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

admin.get('/', needAuth, wrap(async (req, res) => {
  const s = await getSettings(); const bs = await getButtons();
  const m = MSGS[req.query.m] ? `<div class="msg ${/^(ok|pwok)$/.test(req.query.m) ? '' : 'err'}">${esc(MSGS[req.query.m])}</div>` : '';
  const chk = (n, v, t) => `<label class="ck"><input type="checkbox" name="${n}" value="1"${v ? ' checked' : ''}> ${t}</label>`;
  const rows = bs.map((b, i) => `<div class="card${b.enabled ? '' : ' off'}"><form method="post" action="/admin/buttons/${b.id}/edit">${hid(req)}
<label>Emoji ikona (voliteľné)</label><input name="emoji" value="${esc(b.emoji)}" maxlength="16">
<label>Názov</label><input name="label" value="${esc(b.label)}" maxlength="80" required>
<label>URL</label><input name="url" type="url" value="${esc(b.url)}" maxlength="2000" required>
${chk('enabled', b.enabled, 'Zobraziť na stránke')}${chk('newtab', b.newtab, 'Otvoriť v novej karte')}<button>Uložiť</button></form>
<div class="row"><form method="post" action="/admin/buttons/${b.id}/toggle">${hid(req)}<button class="g">${b.enabled ? '🙈 Skryť' : '👁 Zobraziť'}</button></form>
${i > 0 ? `<form method="post" action="/admin/buttons/${b.id}/move">${hid(req)}<input type="hidden" name="dir" value="up"><button class="g">↑ Hore</button></form>` : ''}
${i < bs.length - 1 ? `<form method="post" action="/admin/buttons/${b.id}/move">${hid(req)}<input type="hidden" name="dir" value="down"><button class="g">↓ Dole</button></form>` : ''}
<form method="post" action="/admin/buttons/${b.id}/delete">${hid(req)}<button class="d">Zmazať</button></form>${b.enabled ? '' : '<span class="tag">skryté</span>'}</div></div>`).join('');
  const imgBox = (k, t) => `<div class="card"><h3>${t}</h3>${s.img[k] ? `<img class="prev" src="/img/${k}?v=${s.img[k]}" alt="">` : '<p class="hint">Nenahraté.</p>'}
<form method="post" action="/admin/image/${k}" enctype="multipart/form-data">${hid(req)}<input type="file" name="image" accept="image/png,image/jpeg,image/webp" required><p class="hint">PNG, JPG alebo WebP, max 2 MB.</p><button>Nahrať</button></form>
${s.img[k] ? `<form method="post" action="/admin/image/${k}/delete">${hid(req)}<button class="d">Odstrániť</button></form>` : ''}</div>`;
  const color = (k, t) => `<div><label>${t}</label><input type="color" name="${k}" value="${esc(hex(s[k], DEFAULTS[k]))}"></div>`;
  res.send(page('Admin', `<h1>Admin</h1>${m}<p>Verejná stránka: <a href="/${esc(s.slug)}" rel="noopener noreferrer" target="_blank">/${esc(s.slug)}</a></p>
<form method="post" action="/admin/settings" class="card">${hid(req)}<h2>Stránka</h2>
<label>Titulok</label><input name="title" value="${esc(s.title)}" maxlength="80" required>
<label>Krátke bio</label><textarea name="bio" maxlength="300" rows="3">${esc(s.bio)}</textarea>
<label>Slug (adresa stránky)</label><input name="slug" value="${esc(s.slug)}" pattern="[a-z0-9-]{1,30}" maxlength="30" required>
<label>Titulok v prehliadači &lt;title&gt; (prázdne = titulok)</label><input name="meta_title" value="${esc(s.meta_title)}" maxlength="80">
<label>Meta popis (prázdne = bio)</label><textarea name="meta_desc" maxlength="300" rows="2">${esc(s.meta_desc)}</textarea>
<label>Text v pätičke</label><input name="footer" value="${esc(s.footer)}" maxlength="200"><button>Uložiť</button></form>
<h2>Obrázky</h2><div class="grid2">${imgBox('logo', 'Logo / avatar (aj favicon)')}${imgBox('bg', 'Obrázok pozadia')}</div>
<div class="card"><h2>Vzhľad</h2><form method="post" action="/admin/preset">${hid(req)}<label>Predvolená téma</label><div class="row">${sel('preset', Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.name])), s.preset)}<button class="g">Použiť tému</button></div></form>
<form method="post" action="/admin/theme">${hid(req)}<div class="grid4">${color('c_bg', 'Pozadie')}${color('c_card', 'Tlačidlá / karty')}${color('c_btntext', 'Text tlačidiel')}${color('c_text', 'Text')}</div>
<label>Štýl tlačidiel</label>${sel('btn_style', { rounded: 'Zaoblené', square: 'Hranaté' }, s.btn_style)}
<label>Písmo</label>${sel('font', Object.fromEntries(Object.entries(FONTS).map(([k, v]) => [k, v.name])), s.font)}<button>Uložiť vzhľad</button></form></div>
<h2>Tlačidlá</h2>${rows || '<p>Žiadne tlačidlá.</p>'}
<form method="post" action="/admin/buttons" class="card">${hid(req)}<h2>Pridať tlačidlo</h2>
<label>Emoji ikona (voliteľné)</label><input name="emoji" maxlength="16"><label>Názov</label><input name="label" maxlength="80" required>
<label>URL</label><input name="url" type="url" maxlength="2000" required placeholder="https://">${chk('enabled', true, 'Zobraziť na stránke')}${chk('newtab', false, 'Otvoriť v novej karte')}<button>Pridať</button></form>
<form method="post" action="/admin/social" class="card">${hid(req)}<h2>Sociálne siete (voliteľné)</h2><p class="hint">Prázdne pole = nezobrazí sa.</p>
${SOCIALS.map(([k, n, e]) => `<label>${e} ${n}</label><input name="${k}" value="${esc(s['soc_' + k])}" maxlength="${k === 'email' ? 254 : 2000}" ${k === 'email' ? 'type="email" placeholder="meno@domena.sk"' : 'type="url" placeholder="https://"'}>`).join('')}<button>Uložiť</button></form>
<form method="post" action="/admin/password" class="card">${hid(req)}<h2>Zmena hesla</h2>
<label>Aktuálne heslo</label><input type="password" name="current" autocomplete="current-password" required maxlength="200">
<label>Nové heslo (min. 12 znakov)</label><input type="password" name="new1" autocomplete="new-password" required minlength="12" maxlength="200">
<label>Nové heslo znova</label><input type="password" name="new2" autocomplete="new-password" required minlength="12" maxlength="200"><button>Zmeniť heslo</button></form>
<form method="post" action="/admin/logout">${hid(req)}<button class="g">Odhlásiť</button></form>`, 'a'));
}));
admin.post('/settings', needAuth, csrf, wrap(async (req, res) => {
  const slug = String(req.body.slug || '').trim();
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return ok(res, 'badslug');
  await setSettings({ title: clean(req.body.title, 80) || 'Odkazy', bio: clean(String(req.body.bio || '').replace(/\r/g, ''), 300), slug,
    meta_title: clean(req.body.meta_title, 80), meta_desc: clean(String(req.body.meta_desc || '').replace(/\s+/g, ' '), 300), footer: clean(req.body.footer, 200) });
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
  const pm = Object.entries(PRESETS).find(([, p]) => ['c_bg', 'c_card', 'c_btntext', 'c_text'].every(k => p[k] === o[k]));
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
  return { label, url, emoji, enabled: req.body.enabled === '1', newtab: req.body.newtab === '1' };
}
admin.post('/buttons', needAuth, csrf, wrap(async (req, res) => {
  const b = btnInput(req); if (b.err) return ok(res, b.err);
  await bq(`INSERT INTO buttons (label,url,emoji,enabled,newtab,pos) VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(pos),0)+1 FROM buttons))`, [b.label, b.url, b.emoji, b.enabled, b.newtab]);
  ok(res);
}));
const idOf = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };
admin.post('/buttons/:id/edit', needAuth, csrf, wrap(async (req, res) => {
  const b = btnInput(req); if (b.err) return ok(res, b.err);
  await bq(`UPDATE buttons SET label=$1,url=$2,emoji=$3,enabled=$4,newtab=$5 WHERE id=$6`, [b.label, b.url, b.emoji, b.enabled, b.newtab, idOf(req)]);
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
app.use('/admin', admin);

// ---- public page ----
app.get('/:slug', wrap(async (req, res, next) => {
  const s = await getSettings();
  if (req.params.slug !== s.slug) return next();
  const bs = (await getButtons()).filter(b => b.enabled);
  const soc = SOCIALS.filter(([k]) => s['soc_' + k]).map(([k, n, e]) => {
    const href = k === 'email' ? 'mailto:' + s['soc_' + k] : s['soc_' + k];
    return `<a href="${esc(href)}" rel="noopener noreferrer nofollow" title="${esc(n)}" aria-label="${esc(n)}">${e}<span> ${esc(n)}</span></a>`;
  }).join('');
  const extra = `<link rel="stylesheet" href="/theme.css?v=${esc(s.ver)}">${s.img.logo ? `<link rel="icon" href="/img/logo?v=${esc(s.img.logo)}">` : ''}`;
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(page(s.meta_title || s.title, `${s.img.logo ? `<img class="logo" src="/img/logo?v=${esc(s.img.logo)}" alt="${esc(s.title)}" width="96" height="96">` : ''}<h1>${esc(s.title)}</h1>${s.bio ? `<p class="bio">${esc(s.bio)}</p>` : ''}
${bs.map(b => `<a class="b" href="${esc(b.url)}" rel="noopener noreferrer nofollow"${b.newtab ? ' target="_blank"' : ''}>${b.emoji ? esc(b.emoji) + ' ' : ''}${esc(b.label)}</a>`).join('\n')}
${soc ? `<nav class="soc">${soc}</nav>` : ''}${s.footer ? `<p class="f">${esc(s.footer)}</p>` : ''}`, 'pub', s.meta_desc || s.bio, extra));
}));
app.use((req, res) => res.status(404).send(page('404', '<h1>404</h1><p class="bio">Stránka neexistuje.</p>')));
app.use((err, req, res, next) => { console.error(err && err.message); res.status(500).send('Chyba servera'); });

init().then(() => {
  app.listen(PORT, () => console.log('listening on ' + PORT));
  // keep-awake self-ping through the public Render URL every 10 min
  // + cross-ping the checkout service so waking one wakes the other
  const targets = [process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL + '/healthz',
    (process.env.PEER_URL || 'https://chain2pay-checkout-gl.onrender.com') + '/health'].filter(Boolean);
  const ping = () => targets.forEach(u => fetch(u, { signal: AbortSignal.timeout(60e3) }).catch(() => {}));
  setTimeout(ping, 30e3).unref(); setInterval(ping, 10 * 60e3).unref();
}).catch(e => { console.error('init failed', e.message); process.exit(1); });
