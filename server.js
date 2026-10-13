'use strict';
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SECRET = process.env.SESSION_SECRET || '';
const PROD = process.env.NODE_ENV === 'production';
if (!HASH || SECRET.length < 32 || !process.env.DATABASE_URL) { console.error('Missing ADMIN_PASSWORD_HASH / SESSION_SECRET / DATABASE_URL'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 5, keepAlive: true, idleTimeoutMillis: 300000 });
pool.on('error', e => console.error('pg pool', e.message));
const RESERVED = new Set(['admin', 'api', 'static', 'healthz', 'favicon.ico', 'robots.txt']);
const SLUG_RE = /^[a-z0-9-]{1,30}$/;

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS buttons (id SERIAL PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', pos INT NOT NULL DEFAULT 0)`);
  const defs = { slug: 'kava', title: 'Káva v Linku', bio: 'Malá kaviareň s veľkou chuťou ☕ Dobrá káva, pokojná chvíľa.' };
  for (const [k, v] of Object.entries(defs)) await pool.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING`, [k, v]);
  const r = await pool.query(`INSERT INTO settings (k,v) VALUES ('seeded','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  // one-time migration: drop personal name, generic coffee profile
  const m = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_kava','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
  if (m.rowCount) for (const [k, v] of Object.entries(defs)) await pool.query(`UPDATE settings SET v=$2 WHERE k=$1`, [k, v]);
  if (r.rowCount) await pool.query(`INSERT INTO buttons (label,url,emoji,pos) VALUES ($1,$2,$3,1)`, ['Platby', 'https://chain2pay-checkout-gl.onrender.com', '💳']);
}
let cache = null;
async function getSettings() {
  if (cache) return cache;
  const r = await pool.query(`SELECT k,v FROM settings`);
  const s = {}; r.rows.forEach(x => { s[x.k] = x.v; });
  return (cache = s);
}
const setSetting = (k, v) => pool.query(`UPDATE settings SET v=$2 WHERE k=$1`, [k, v]).then(() => { cache = null; });
let bcache = null;
const getButtons = async () => bcache || (bcache = (await pool.query(`SELECT id,label,url,emoji,pos FROM buttons ORDER BY pos, id`)).rows);
const bq = async (q, a) => { try { return await pool.query(q, a); } finally { bcache = null; } };

const esc = s => String(s == null ? '' : s).replace(/[&<>"'`=\/]/g, c => '&#' + c.charCodeAt(0) + ';');
function safeUrl(u) {
  u = String(u || '').trim();
  if (u.length > 2000) return null;
  try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; } catch { return null; }
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

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
const needAuth = (req, res, next) => req.sess.auth ? next() : res.redirect(303, '/admin/login');

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
app.use(compression({ threshold: 0 }));
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
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /admin\n'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

const page = (title, body, cls = '', desc = '') => `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="description" content="${esc(desc || title)}"><meta property="og:title" content="${esc(title)}"><title>${esc(title)}</title><link rel="stylesheet" href="/static/s.css?v=${CSS_V}"></head><body><main class="w ${cls}">${body}</main></body></html>`;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/', wrap(async (req, res) => { const s = await getSettings(); res.redirect(302, '/' + s.slug); }));

// ---- admin ----
const admin = express.Router();
admin.use(session);
admin.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); next(); });
const hid = req => `<input type="hidden" name="_csrf" value="${esc(req.sess.csrf)}">`;

admin.get('/login', (req, res) => {
  if (req.sess.auth) return res.redirect(303, '/admin');
  const e = req.query.e === '1' ? '<div class="msg err">Nesprávne heslo.</div>' : req.query.e === 'l' ? '<div class="msg err">Príliš veľa pokusov. Skúste neskôr.</div>' : '';
  res.send(page('Prihlásenie', `<h1>Admin</h1>${e}<form method="post" action="/admin/login" class="card">${hid(req)}<label for="p">Heslo</label><input id="p" type="password" name="password" autocomplete="current-password" required maxlength="200"><button>Prihlásiť</button></form>`));
});
admin.post('/login', csrf, wrap(async (req, res) => {
  const ip = req.ip;
  if (lockedFor(ip)) return res.redirect(303, '/admin/login?e=l');
  const ok = await bcrypt.compare(String(req.body.password || '').slice(0, 200), HASH);
  if (!ok) { recordFail(ip); return res.redirect(303, '/admin/login?e=1'); }
  fails.delete(ip);
  writeSess(res, { auth: true, csrf: crypto.randomBytes(24).toString('base64url') });
  res.redirect(303, '/admin');
}));
admin.post('/logout', csrf, (req, res) => { writeSess(res, { auth: false, csrf: crypto.randomBytes(24).toString('base64url') }); res.redirect(303, '/admin/login'); });

admin.get('/', needAuth, wrap(async (req, res) => {
  const s = await getSettings(); const bs = await getButtons();
  const msgs = { ok: 'Uložené.', badslug: 'Neplatný slug (a-z, 0-9, pomlčka, 1–30 znakov, nie rezervované slovo).', badurl: 'Neplatná URL (povolené len http/https).', badlabel: 'Chýba názov tlačidla.' };
  const m = msgs[req.query.m] ? `<div class="msg ${req.query.m === 'ok' ? '' : 'err'}">${esc(msgs[req.query.m])}</div>` : '';
  const rows = bs.map((b, i) => `<div class="card"><form method="post" action="/admin/buttons/${b.id}/edit">${hid(req)}
<label>Emoji (voliteľné)</label><input name="emoji" value="${esc(b.emoji)}" maxlength="16">
<label>Názov</label><input name="label" value="${esc(b.label)}" maxlength="80" required>
<label>URL</label><input name="url" type="url" value="${esc(b.url)}" maxlength="2000" required><button>Uložiť</button></form>
<div class="row">${i > 0 ? `<form method="post" action="/admin/buttons/${b.id}/move">${hid(req)}<input type="hidden" name="dir" value="up"><button class="g">↑ Hore</button></form>` : ''}
${i < bs.length - 1 ? `<form method="post" action="/admin/buttons/${b.id}/move">${hid(req)}<input type="hidden" name="dir" value="down"><button class="g">↓ Dole</button></form>` : ''}
<form method="post" action="/admin/buttons/${b.id}/delete">${hid(req)}<button class="d">Zmazať</button></form></div></div>`).join('');
  res.send(page('Admin', `<h1>Admin</h1>${m}<p>Verejná stránka: <a href="/${esc(s.slug)}" rel="noopener noreferrer" target="_blank">/${esc(s.slug)}</a></p>
<form method="post" action="/admin/settings" class="card">${hid(req)}<h2>Stránka</h2>
<label>Titulok</label><input name="title" value="${esc(s.title)}" maxlength="80" required>
<label>Krátke bio</label><textarea name="bio" maxlength="300" rows="3">${esc(s.bio)}</textarea>
<label>Slug (adresa stránky)</label><input name="slug" value="${esc(s.slug)}" pattern="[a-z0-9-]{1,30}" maxlength="30" required><button>Uložiť</button></form>
<h2>Tlačidlá</h2>${rows || '<p>Žiadne tlačidlá.</p>'}
<form method="post" action="/admin/buttons" class="card">${hid(req)}<h2>Pridať tlačidlo</h2>
<label>Emoji (voliteľné)</label><input name="emoji" maxlength="16"><label>Názov</label><input name="label" maxlength="80" required>
<label>URL</label><input name="url" type="url" maxlength="2000" required placeholder="https://"><button>Pridať</button></form>
<form method="post" action="/admin/logout">${hid(req)}<button class="g">Odhlásiť</button></form>`, 'a'));
}));
admin.post('/settings', needAuth, csrf, wrap(async (req, res) => {
  const slug = String(req.body.slug || '').trim();
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) return res.redirect(303, '/admin?m=badslug');
  await setSetting('title', clean(req.body.title, 80) || 'Odkazy');
  await setSetting('bio', clean(String(req.body.bio || '').replace(/\r/g, ''), 300));
  await setSetting('slug', slug);
  res.redirect(303, '/admin?m=ok');
}));
function btnInput(req) {
  const label = clean(req.body.label, 80), url = safeUrl(req.body.url), emoji = clean(req.body.emoji, 16);
  if (!label) return { err: 'badlabel' }; if (!url) return { err: 'badurl' };
  return { label, url, emoji };
}
admin.post('/buttons', needAuth, csrf, wrap(async (req, res) => {
  const b = btnInput(req); if (b.err) return res.redirect(303, '/admin?m=' + b.err);
  await bq(`INSERT INTO buttons (label,url,emoji,pos) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(pos),0)+1 FROM buttons))`, [b.label, b.url, b.emoji]);
  res.redirect(303, '/admin?m=ok');
}));
const idOf = req => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0; };
admin.post('/buttons/:id/edit', needAuth, csrf, wrap(async (req, res) => {
  const b = btnInput(req); if (b.err) return res.redirect(303, '/admin?m=' + b.err);
  await bq(`UPDATE buttons SET label=$1,url=$2,emoji=$3 WHERE id=$4`, [b.label, b.url, b.emoji, idOf(req)]);
  res.redirect(303, '/admin?m=ok');
}));
admin.post('/buttons/:id/delete', needAuth, csrf, wrap(async (req, res) => {
  await bq(`DELETE FROM buttons WHERE id=$1`, [idOf(req)]); res.redirect(303, '/admin?m=ok');
}));
admin.post('/buttons/:id/move', needAuth, csrf, wrap(async (req, res) => {
  const bs = await getButtons(); const i = bs.findIndex(b => b.id === idOf(req));
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < bs.length) {
    [bs[i], bs[j]] = [bs[j], bs[i]];
    const c = await pool.connect();
    try { await c.query('BEGIN'); for (let k = 0; k < bs.length; k++) await c.query(`UPDATE buttons SET pos=$1 WHERE id=$2`, [k + 1, bs[k].id]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); bcache = null; }
  }
  res.redirect(303, '/admin?m=ok');
}));
app.use('/admin', admin);

// ---- public page ----
app.get('/:slug', wrap(async (req, res, next) => {
  const s = await getSettings();
  if (req.params.slug !== s.slug) return next();
  const bs = await getButtons();
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(page(s.title, `<h1>${esc(s.title)}</h1>${s.bio ? `<p class="bio">${esc(s.bio)}</p>` : ''}
${bs.map(b => `<a class="b" href="${esc(b.url)}" rel="noopener noreferrer nofollow">${b.emoji ? esc(b.emoji) + ' ' : ''}${esc(b.label)}</a>`).join('\n')}`, '', s.bio));
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
