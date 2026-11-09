'use strict';
// 👤 Zákaznícke účty + affiliate bonusy + napojenie na server predplatného (len čítanie stavu/expirácie).
// Bezpečnosť: bcrypt (cost 12), relácie v DB (hash tokenu, rotácia pri prihlásení), CSRF double-submit + kontrola Origin,
// rate-limity + lockout, žiadna enumerácia používateľov, honeypot + časový token pri registrácii. Heslo zadané zákazníkom
// pri overení sa nikdy neukladá ani neloguje. Admin môže uložiť linky (meno+heslo) šifrovane pre overenie len podľa mena.
// Žiadny inline JS/CSS (CSP).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QR = require('qrcode');
const AFF = require('./affiliate');
const PANEL = require('./panel');
const LINES = require('./panellines');
const CHS = require('./chsync');
const EPGFETCH = require('./epgfetch');

const C_SESS = '__Host-acc', C_CSRF = '__Host-acsrf', C_REF = '__Host-aref', C_DEV = '__Host-adev';
const REF_RE = /^[a-z2-9]{8}$/;
const USER_RE = /^[a-z0-9][a-z0-9_.-]{2,23}$/;
const RESERVED_USERS = new Set(['admin', 'administrator', 'root', 'support', 'podpora', 'system', 'tokigo', 'moderator', 'owner', 'api', 'ucet']);
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
const SESS_DAYS = 30;
const K = crypto.createHash('sha256').update('lnk-accounts:' + String(process.env.DATA_ENC_KEY || process.env.SESSION_SECRET || 'dev')).digest();
const hmac = (s) => crypto.createHmac('sha256', K).update(String(s)).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
const setCookie = (res, name, val, maxAge, same = 'Lax') => res.append('Set-Cookie', `${name}=${val}; Path=/; HttpOnly; Secure; SameSite=${same}; Max-Age=${maxAge}`);
const clearCookie = (res, name) => res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
const ipKey = (ip) => hmac('ip:' + String(ip || '')).slice(0, 24);
const tx = (en, sk, e) => (en ? e : sk);

function refMiddleware(req, res, next) {
  if ((req.method === 'GET' || req.method === 'HEAD') && typeof req.query.ref === 'string') {
    const code = req.query.ref.trim().toLowerCase();
    if (REF_RE.test(code)) setCookie(res, C_REF, code, 30 * 86400, 'Lax');
  }
  next();
}
function fmtDate(d) {
  if (!d) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year}`;
}
const fmtDT = (d) => (d ? new Date(d).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }) : '–');
const moLabel = (n, en) => (en ? `${n} ${Math.abs(n) === 1 ? 'month' : 'months'}` : `${n} ${Math.abs(n) === 1 ? 'mesiac' : Math.abs(n) >= 2 && Math.abs(n) <= 4 ? 'mesiace' : 'mesiacov'}`);
function limiter() {
  const m = new Map();
  const hit = (k, n, ms) => { const now = Date.now(), a = (m.get(k) || []).filter((t) => now - t < ms); a.push(now); m.set(k, a); return a.length > n; };
  const count = (k, ms) => (m.get(k) || []).filter((t) => Date.now() - t < ms).length;
  setInterval(() => { const now = Date.now(); for (const [k, a] of m) if (!a.some((t) => now - t < 86400e3)) m.delete(k); }, 600e3).unref();
  return { hit, count };
}

function install(ctx) {
  const { app, admin, pool, page, esc, hid, csrf: adminCsrf, needAuth, wrap, getSettings, setSettings, encrypt, decrypt } = ctx;
  const shell = (...a) => ctx.shell(...a);
  const audit = (req, a, d) => { try { if (ctx.audit) ctx.audit(req, a, d); } catch {} };
  const notify = (t) => { try { if (global.__notifyAdmin) global.__notifyAdmin(t); } catch {} };
  const panelApi = PANEL.create();
  const L = limiter();
  const DUMMY = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);
  const done = new Set();

  ctx.accountsInit = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_users (id serial PRIMARY KEY, username text UNIQUE NOT NULL, pw_hash text NOT NULL, email text,
      ref_code text UNIQUE NOT NULL, referrer_id int, ref_flag text NOT NULL DEFAULT '', ref_blocked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), created_ip text NOT NULL DEFAULT '', dev_hash text NOT NULL DEFAULT '', last_login_at timestamptz, last_ip text NOT NULL DEFAULT '',
      disabled boolean NOT NULL DEFAULT false, licence_until timestamptz, override_until timestamptz, aff_choice text NOT NULL DEFAULT 'months',
      panel_user text, panel_verified text NOT NULL DEFAULT '', panel_expiry timestamptz, panel_synced_at timestamptz, panel_status text NOT NULL DEFAULT '',
      note text NOT NULL DEFAULT '', reset_hash text, reset_exp timestamptz, failed int NOT NULL DEFAULT 0, locked_until timestamptz)`);
    await pool.query(`ALTER TABLE acc_users ADD COLUMN IF NOT EXISTS panel_pending text`);
    await pool.query(`ALTER TABLE acc_users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS verify_hash text, ADD COLUMN IF NOT EXISTS verify_exp timestamptz`);
    await pool.query(`UPDATE acc_users SET email=lower(btrim(email)) WHERE email IS NOT NULL AND email<>lower(btrim(email))`).catch(() => {});
    await pool.query(`ALTER TABLE acc_users ADD COLUMN IF NOT EXISTS remind_for timestamptz`); // licence end-date we already sent the 7-day reminder for
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS acc_users_email ON acc_users (lower(email)) WHERE email IS NOT NULL`).catch((e) => console.error('[acc] email index: ' + e.message));
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS acc_users_panel ON acc_users (lower(panel_user)) WHERE panel_user IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS acc_users_ref ON acc_users (referrer_id)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_sessions (token_hash text PRIMARY KEY, user_id int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_orders (order_id text PRIMARY KEY, user_id int NOT NULL, plan_id int, months int NOT NULL DEFAULT 0, amount numeric NOT NULL DEFAULT 0, paid_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_ledger (id serial PRIMARY KEY, user_id int NOT NULL, order_id text, kind text NOT NULL, package_months int NOT NULL DEFAULT 0, bonus_months int NOT NULL DEFAULT 0,
      active_count int NOT NULL DEFAULT 0, tier_min int NOT NULL DEFAULT 0, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (order_id, kind))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_devices (id serial PRIMARY KEY, user_id int NOT NULL, order_id text UNIQUE, from_at timestamptz NOT NULL, until_at timestamptz NOT NULL, panel_user text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_software (username text PRIMARY KEY, display text NOT NULL DEFAULT '', user_id int, order_id text, until_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS acc_software_user ON acc_software (user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS acc_panel_cfg (k text PRIMARY KEY, v text NOT NULL)`);
    await pool.query(`DELETE FROM acc_panel_cfg WHERE k='key'`).catch(() => {});
    await pool.query(`CREATE TABLE IF NOT EXISTS acc_panel_lines (id serial PRIMARY KEY, username text NOT NULL, pass_enc text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS acc_panel_lines_user ON acc_panel_lines (lower(username))`);
    await pool.query(`DELETE FROM acc_sessions WHERE expires_at < now()`);
    (await pool.query(`SELECT order_id FROM acc_orders`)).rows.forEach((x) => done.add(x.order_id));
    // affiliate defaults changed (2026-10-27): migrate the stored tier table only if it still equals the old defaults
    try { const st = await getSettings(), mig = AFF.migrateTiers(st.aff_tiers); if (mig) { await setSettings({ aff_tiers: mig }); console.log('[acc] affiliate tiers migrated to new defaults'); } } catch (e) { console.error('[acc] tier migration', e.message); }
  };

  // panel config – credentials encrypted at rest (AES-256-GCM via DATA_ENC_KEY)
  const SECRET_K = new Set(['user', 'pass', 'm3u_url', 'xmltv_url']);
  let pcfg = null;
  async function panelCfg() {
    if (pcfg && pcfg.t > Date.now() - 60000) return pcfg.v;
    const r = await pool.query(`SELECT k,v FROM acc_panel_cfg`); const v = {};
    for (const x of r.rows) { if (SECRET_K.has(x.k)) { try { v[x.k] = decrypt(JSON.parse(x.v), 'panel:' + x.k).toString(); } catch { v[x.k] = ''; } } else v[x.k] = x.v; }
    v.base = PANEL.normBase(v.url); pcfg = { t: Date.now(), v }; return v;
  }
  async function setPanel(k, val) {
    if (val === null || val === undefined) await pool.query(`DELETE FROM acc_panel_cfg WHERE k=$1`, [k]);
    else await pool.query(`INSERT INTO acc_panel_cfg (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, SECRET_K.has(k) ? JSON.stringify(encrypt(Buffer.from(String(val)), 'panel:' + k)) : String(val)]);
    pcfg = null; panelApi.clear();
  }
  const panelReady = (c) => !!(c && c.base && c.type);
  const pcConf = (c) => ({ base: PANEL.normBase(c.base || c.url) || PANEL.joinUrl(c.base || '', ''), type: c.type, user: c.user || '', pass: c.pass || '', tpl: c.tpl || '', datePath: c.datepath || '' });
  const canLookup = (c) => panelReady(c) && !!(panelApi.ADAPTERS[c.type] && panelApi.ADAPTERS[c.type].lookup);
  const selfCheck = (c) => panelReady(c) && c.type !== 'stalker' && c.type !== 'custom';
  const hasLines = async () => !!(await pool.query('SELECT 1 FROM acc_panel_lines LIMIT 1')).rowCount;
  async function linePass(username) {
    const r = (await pool.query('SELECT username, pass_enc FROM acc_panel_lines WHERE lower(username)=lower($1)', [username])).rows[0];
    if (!r) return null;
    try { return decrypt(JSON.parse(r.pass_enc), 'panel-line:' + String(r.username).toLowerCase()).toString(); } catch { return null; }
  }
  async function saveLine(user, pass) {
    const enc = JSON.stringify(encrypt(Buffer.from(String(pass)), 'panel-line:' + user.toLowerCase()));
    await pool.query(`INSERT INTO acc_panel_lines (username, pass_enc, updated_at) VALUES ($1,$2,now())
      ON CONFLICT ((lower(username))) DO UPDATE SET username=EXCLUDED.username, pass_enc=EXCLUDED.pass_enc, updated_at=now()`, [user, enc]);
  }

  // sessions / csrf
  async function fromReq(req) {
    if (req.__acc !== undefined) return req.__acc;
    const t = cookies(req)[C_SESS];
    if (!t || !/^[A-Za-z0-9_-]{43}$/.test(t)) return (req.__acc = null);
    const r = await pool.query(`SELECT u.* FROM acc_sessions s JOIN acc_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [sha(t)]).catch(() => ({ rows: [] }));
    return (req.__acc = r.rows[0] || null);
  }
  async function startSession(req, res, uid) {
    const old = cookies(req)[C_SESS]; if (old) await pool.query(`DELETE FROM acc_sessions WHERE token_hash=$1`, [sha(old)]);
    const t = crypto.randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO acc_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '${SESS_DAYS} days')`, [sha(t), uid]);
    setCookie(res, C_SESS, t, SESS_DAYS * 86400, 'Lax');
    setCookie(res, C_CSRF, crypto.randomBytes(24).toString('base64url'), 7 * 86400, 'Strict');
  }
  function csrfTok(req, res) {
    if (req.__csrfT) return req.__csrfT;
    let t = cookies(req)[C_CSRF];
    if (!t || !/^[A-Za-z0-9_-]{32}$/.test(t)) { t = crypto.randomBytes(24).toString('base64url'); setCookie(res, C_CSRF, t, 7 * 86400, 'Strict'); }
    return (req.__csrfT = t);
  }
  const csrfField = (req, res) => `<input type="hidden" name="_csrf" value="${esc(csrfTok(req, res))}">`;
  function csrfOk(req) {
    const host = String(req.headers.host || ''), src = req.headers.origin || req.headers.referer;
    // Referrer-Policy: no-referrer makes browsers send "Origin: null" on same-site form posts → rely on Sec-Fetch-Site + token there
    const sfs = String(req.headers['sec-fetch-site'] || '');
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
    if (src && src !== 'null') { try { if (new URL(src).host !== host) return false; } catch { return false; } }
    const a = Buffer.from(String((req.body && req.body._csrf) || '')), b = Buffer.from(String(cookies(req)[C_CSRF] || ''));
    return b.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function devId(req, res) { let d = cookies(req)[C_DEV]; if (!d || !/^[A-Za-z0-9_-]{22}$/.test(d)) { d = req.__dev || crypto.randomBytes(16).toString('base64url'); if (!req.__dev) setCookie(res, C_DEV, d, 400 * 86400, 'Lax'); req.__dev = d; } return hmac('dev:' + d).slice(0, 24); }
  const formTok = () => { const t = Date.now().toString(36); return t + '.' + hmac('form:' + t).slice(0, 22); };
  const formTokOk = (v, minMs = 2000) => { const [t, sig] = String(v || '').split('.'); if (!t || !sig) return false; const want = hmac('form:' + t).slice(0, 22); const age = Date.now() - parseInt(t, 36);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) && age > minMs && age < 3 * 3600e3; };

  // licence / affiliate helpers
  const affSettings = async () => AFF.settings(await getSettings());
  const ACT = (p = '') => `COALESCE(${p}override_until, CASE WHEN ${p}panel_user IS NOT NULL AND ${p}panel_synced_at IS NOT NULL THEN ${p}panel_expiry END, ${p}licence_until)`;
  async function refCounts(uid, q = pool) {
    const r = await q.query(`SELECT count(*)::int total, count(*) FILTER (WHERE NOT disabled AND NOT ref_blocked AND ${ACT()} > now())::int active FROM acc_users WHERE referrer_id=$1`, [uid]);
    return r.rows[0];
  }
  const plansList = async () => (await ctx.getList('plans')).filter((p) => p.active !== false && +p.price > 0);
  async function planByAmount(amount) {
    const a = Math.round(Number(amount) * 100); if (!(a > 0)) return null;
    const m = (await plansList()).filter((p) => Math.round(+p.price * 100) === a);
    return m.length === 1 ? { id: m[0].id, period: +m[0].period || 1, amount: +m[0].price } : null;
  }
  async function packages() { return [...new Set([...AFF.DEF_PACKAGES, ...(await plansList()).map((p) => +p.period || 1)])].sort((a, b) => a - b); }
  async function bonusInfo(user) {
    const st = await affSettings(); if (!st.on || !user) return null;
    const { active, total } = await refCounts(user.id);
    return { st, active, total, tier: AFF.tierFor(active, st.tiers), next: AFF.nextTier(active, st.tiers), device: AFF.deviceAllowed(active, st.tiers), bonus: (m) => AFF.bonusFor(active, +m, st.tiers),
      devFor: (m) => AFF.deviceFor(active, +m, st.tiers), reward: (m) => AFF.rewardFor(active, +m, st.tiers, user.aff_choice) };
  }

  // paid-order processing
  function pgStore(c) {
    return {
      async getUser(id) { return (await c.query(`SELECT * FROM acc_users WHERE id=$1 FOR UPDATE`, [id])).rows[0] || null; },
      async recordPurchase(p) { return (await c.query(`INSERT INTO acc_orders (order_id,user_id,plan_id,months,amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING order_id`, [p.orderId, p.userId, p.planId, p.months, p.amount])).rowCount > 0; },
      async setLicence(id, until) { await c.query(`UPDATE acc_users SET licence_until=$2 WHERE id=$1`, [id, until]); },
      async countActiveReferred(id) { return (await refCounts(id, c)).active; },
      async addLedger(r) { await c.query(`INSERT INTO acc_ledger (user_id,order_id,kind,package_months,bonus_months,active_count,tier_min,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [r.user_id, r.order_id, r.kind, r.package_months, r.bonus_months, r.active_count, r.tier_min, r.note]); },
      async addDevice(d) { await c.query(`INSERT INTO acc_devices (user_id,order_id,from_at,until_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [d.user_id, d.order_id, d.from, d.until]); },
    };
  }
  async function processOrder(o, st) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await AFF.processPaidOrder(pgStore(c), o, st);
      if (r && !r.skipped) { // first paid order confirms the panel username the customer entered (ownership via payment)
        await c.query(`UPDATE acc_users u SET panel_user=u.panel_pending, panel_verified='order', panel_pending=NULL WHERE u.id=$1 AND u.panel_user IS NULL AND u.panel_pending IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM acc_users x WHERE lower(x.panel_user)=lower(u.panel_pending))`, [o.acct.id]);
      }
      await c.query('COMMIT');
      done.add(o.orderId);
      if (r && r.ledger) notify(`🎁 Affiliate bonus: ${r.ledger.username} – objednávka ${o.orderId}, balík ${moLabel(r.months)}, aktívni odporučení: ${r.active}. ${r.device ? '➕ 2. zariadenie na rovnaké obdobie (priraďte mu meno v paneli).' : `Bonus +${moLabel(r.bonus)} – pridajte ich aj v paneli predplatného.`}`);
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); console.error('[acc] order processing failed', o.orderId, e.message); return null; } finally { c.release(); }
  }
  let sweeping = false;
  async function sweep() {
    if (sweeping || !global.__payOrders) return; sweeping = true;
    try {
      const all = (await global.__payOrders.load()) || {}; const st = await affSettings();
      for (const o of Object.values(all)) {
        if (!o || !o.orderId) continue;
        if (o.acct && o.acct.id && !done.has(o.orderId) && AFF.isPaidOrder(o)) await processOrder(o, st);
        if (o.xpubAddr && !markedXpub.has(o.orderId) && (AFF.isPaidOrder(o) || o.chainStatus === 'unconfirmed' || o.chainStatus === 'confirmed')) { try { await require('./pay/src/xpub').markUsed(o.orderId); markedXpub.add(o.orderId); } catch {} }
      }
    } catch (e) { console.error('[acc] sweep', e.message); } finally { sweeping = false; }
  }
  const markedXpub = new Set();
  let kickT = null;
  const kick = () => { if (!kickT) kickT = setTimeout(() => { kickT = null; sweep(); }, 1500); };
  setInterval(sweep, 60e3).unref();

  // panel sync
  async function syncUser(u, c) {
    c = c || await panelCfg(); if (!panelReady(c) || !u.panel_user) return null;
    const r = await panelApi.lookup(pcConf(c), u.panel_user).catch((e) => ({ error: String(e.message).slice(0, 120) }));
    if (!r || r.error) return r;
    await pool.query(`UPDATE acc_users SET panel_expiry=$2, panel_synced_at=now(), panel_status=$3 WHERE id=$1`, [u.id, r.found ? r.expiry : null, r.found ? (r.active ? 'active' : 'expired') : 'notfound']);
    return r;
  }
  async function syncAll() {
    const c = await panelCfg(); if (!panelReady(c)) return { ok: false, why: 'nenastavený server' };
    const a = panelApi.ADAPTERS[c.type]; if (!a || !a.lookup) return { ok: false, why: 'typ servera nevie vyhľadať používateľa bez jeho hesla' };
    const us = (await pool.query(`SELECT * FROM acc_users WHERE panel_user IS NOT NULL AND NOT disabled ORDER BY id`)).rows; let n = 0, err = 0;
    for (const u of us) { const r = await syncUser(u, c); if (r && !r.error) n++; else err++; await new Promise((ok) => setTimeout(ok, 250)); }
    await setPanel('last_sync', new Date().toISOString());
    return { ok: true, n, err };
  }
  setInterval(async () => {
    try {
      const c = await panelCfg(); if (!panelReady(c)) return;
      const h = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
      if (h < 4 || (c.last_sync && Date.now() - new Date(c.last_sync) < 20 * 3600e3)) return;
      console.log('[acc] daily panel sync', JSON.stringify(await syncAll()));
    } catch (e) { console.error('[acc] daily sync', e.message); }
  }, 30 * 60e3).unref();

  // ---------- licence-expiry reminder: ~7 days before the end → e-mail to the customer (if e-mail sending is set up) + Telegram to admin ----------
  const pubOrigin = () => String(process.env.LNKBIO_PUBLIC_URL || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://lnkbio.onrender.com').replace(/\/$/, '').replace(/^http:\/\//i, 'https://');
  async function remindRun(now = new Date()) {
    const s = await getSettings(); if (s.acc_remind === '0') return { skipped: 'off' };
    const us = (await pool.query(`SELECT id,username,email, ${ACT()} AS eff, remind_for FROM acc_users WHERE NOT disabled AND ${ACT()} > $1 AND ${ACT()} <= $1::timestamptz + interval '7 days'
      AND (remind_for IS NULL OR remind_for <> ${ACT()}) ORDER BY id LIMIT 200`, [now])).rows;
    let mailed = 0, failed = 0;
    for (const u of us) {
      const until = fmtDate(u.eff), days = Math.max(1, Math.ceil((new Date(u.eff) - now) / 86400e3)); let how = 'bez e-mailu';
      if (u.email && smtpOn()) {
        try {
          await sendMail(u.email, `${s.title || 'TV Software'} – predplatné končí ${until}`, `Dobrý deň ${u.username},\n\nvaše predplatné platí do ${until} (o ${days} ${days === 1 ? 'deň' : days < 5 ? 'dni' : 'dní'}).\nPredĺžiť ho môžete tu: ${pubOrigin()}/platby\nStav predplatného: ${pubOrigin()}/ucet\n\nĎakujeme,\n${s.title || 'TV Software'}`);
          mailed++; how = 'e-mail odoslaný';
        } catch (e) { failed++; console.error('[acc] remind mail: ' + (e.code || 'ERR')); continue; } // retry on the next run
      }
      await pool.query(`UPDATE acc_users SET remind_for=$2 WHERE id=$1`, [u.id, u.eff]);
      notify(`⏰ Predplatné zákazníka ${u.username} končí ${until} (${how}).`);
    }
    return { n: us.length, mailed, failed };
  }
  ctx.accRemind = remindRun;
  const remindTick = async () => {
    try {
      const h = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
      if (h < 9 || h > 20) return; // daytime only; de-duplicated per user + end date (remind_for)
      const r = await remindRun(); if (r.n) console.log('[acc] expiry reminders', JSON.stringify(r));
    } catch (e) { console.error('[acc] remind', e.message); }
  };
  setInterval(remindTick, 30 * 60e3).unref();
  setTimeout(remindTick, Number(process.env.ACC_REMIND_FIRST_MS) || 120e3).unref(); // first pass soon after (re)deploy

  global.__lnkAccounts = { fromReq, planByAmount, kick, registerFromCheckout: (...a) => registerFromCheckout(...a), applySoftwareExpiry: (...a) => applySoftwareExpiry(...a) };

  // ================= public pages =================
  const noStore = (res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); };
  const pub = async (req, res, title, body) => { noStore(res); const s = await getSettings(); await shell(req, res, s, 'ucet', title + ' – ' + s.title, `<div class="acc">${body}</div>`); };
  const accOn = async () => (await getSettings()).acc_on !== '0';
  const MSG = {
    bad: ['Nesprávne meno alebo heslo.', 'Wrong username or password.'], locked: ['Príliš veľa pokusov. Skúste to neskôr.', 'Too many attempts. Try again later.'],
    csrf: ['Formulár vypršal – skúste to znova.', 'The form expired – please try again.'], out: ['Boli ste odhlásený.', 'You have been logged out.'],
    taken: ['Toto používateľské meno nie je dostupné. Zvoľte iné.', 'This username is not available. Choose another.'], uname: ['Meno: 3–24 znakov, malé písmená, číslice, _ . -', 'Username: 3–24 chars, lowercase letters, digits, _ . -'],
    pw: ['Heslo musí mať 8–72 znakov a nesmie byť rovnaké ako meno.', 'Password must be 8–72 characters and differ from the username.'], pw2: ['Heslá sa nezhodujú.', 'Passwords do not match.'],
    email: ['Neplatný e-mail.', 'Invalid e-mail.'], limit: ['Príliš veľa registrácií z tejto siete. Skúste neskôr.', 'Too many sign-ups from this network. Try later.'], spam: ['Registrácia zlyhala – skúste znova.', 'Sign-up failed – please try again.'],
    welcome: ['Účet bol vytvorený. Vitajte!', 'Your account has been created. Welcome!'], pwok: ['Heslo bolo zmenené.', 'Password changed.'], oldpw: ['Heslo nesedí.', 'Password is wrong.'],
    panelok: ['Predplatné bolo prepojené s vaším účtom.', 'Your subscription is now linked.'], panelbad: ['Meno alebo heslo k predplatnému nesedí.', 'Subscription username or password is wrong.'],
    paneltaken: ['Toto predplatné je už prepojené s iným účtom. Kontaktujte podporu.', 'This subscription is linked to another account. Contact support.'], paneloff: ['Overenie predplatného momentálne nie je dostupné.', 'Subscription check is currently unavailable.'],
    choice: ['Voľba uložená.', 'Choice saved.'], reset: ['Odkaz na obnovu hesla je neplatný alebo vypršal.', 'The reset link is invalid or expired.'], resetok: ['Heslo nastavené – prihláste sa.', 'Password set – please log in.'],
    emailreq: ['Zadajte platný e-mail – slúži na obnovu hesla.', 'Enter a valid e-mail – it is used for password reset.'],
    taken2: ['Toto meno alebo e-mail nie je dostupný. Zvoľte iné meno, alebo ak už účet máte, použite „Zabudnuté heslo“.', 'This username or e-mail is not available. Choose another username, or use “Forgot password” if you already have an account.'],
    sent: ['Ak existuje účet s týmto e-mailom, poslali sme naň odkaz na nastavenie nového hesla (platí 1 hodinu). Skontrolujte aj spam. Ak nič nepríde, kontaktujte podporu.', 'If an account with this e-mail exists, we have sent a link to set a new password (valid 1 hour). Check your spam folder too. If nothing arrives, contact support.'],
    vsent: ['Overovací odkaz bol odoslaný na váš e-mail.', 'A verification link has been sent to your e-mail.'], vfail: ['E-mail sa teraz nepodarilo odoslať. Skúste neskôr.', 'The e-mail could not be sent right now. Try later.'],
    verified: ['E-mail bol overený. Ďakujeme!', 'Your e-mail is verified. Thank you!'], vbad: ['Overovací odkaz je neplatný alebo vypršal.', 'The verification link is invalid or expired.'],
    emailok: ['E-mail bol zmenený.', 'E-mail changed.'],
    off: ['Registrácia je momentálne vypnutá.', 'Sign-up is currently disabled.'], del: ['Účet bol zrušený.', 'Your account has been deleted.'],
  };
  const OKM = new Set(['out', 'welcome', 'pwok', 'panelok', 'choice', 'resetok', 'del', 'sent', 'vsent', 'verified', 'emailok']);
  const msgOf = (k, en) => (MSG[k] ? `<div class="msg${OKM.has(k) ? '' : ' err'}" role="status">${esc(MSG[k][en ? 1 : 0])}</div>` : '');
  const msg = (req) => msgOf(String(req.query.m || ''), req.lang === 'en');
  // e-mail goes through mailer.js (Brevo/Resend/Mailjet HTTPS API – Render free blocks SMTP – or SMTP)
  const smtpOn = () => !!(global.__lnkMailer && global.__lnkMailer.ready());
  async function sendMail(to, subject, text) {
    if (!global.__lnkMailer || !to) { const e = new Error('E-mail nie je nastavený'); e.code = 'NO_SMTP'; throw e; }
    await global.__lnkMailer.send({ to, subject: String(subject).slice(0, 200), text: String(text).slice(0, 10000) });
  }
  const normEmail = (v) => String(v || '').trim().toLowerCase().slice(0, 200);
  const newTok = () => crypto.randomBytes(32).toString('base64url');
  async function sendVerify(req, u) {
    const t = newTok();
    await pool.query(`UPDATE acc_users SET verify_hash=$2, verify_exp=now()+interval '48 hours' WHERE id=$1`, [u.id, sha(t)]);
    const s = await getSettings();
    await sendMail(u.email, `${s.title || 'TV Software'} – overenie e-mailu`, `Dobrý deň ${u.username},\n\npotvrďte prosím svoj e-mail kliknutím na odkaz (platí 48 hodín):\n${origin(req)}/ucet/overit-email/${t}\n\nAk ste si účet nezakladali, tento e-mail ignorujte.\n`);
  }
  // „Prečo sa zaregistrovať?“ – tier table generated from the admin-editable affiliate settings + current price list
  const eur = (n) => (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €';
  async function priceByMonths() { const byM = new Map(); for (const p of await plansList()) { const m = +p.period || 1, pr = +p.price; if (!/zariaden|device/i.test(p.name + ' ' + (p.name_en || '')) && (!byM.has(m) || pr < byM.get(m))) byM.set(m, pr); } return byM; }
  async function whyHtml(req, full) {
    const en = req.lang === 'en', st = await affSettings();
    const byM = await priceByMonths();
    const mx = st.on ? AFF.matrix(st.tiers, [...byM.keys()]) : null;
    const pk = mx ? mx.packages.filter((m) => byM.has(m) && mx.rows.some((r) => r.bonus[m] || r.dev[m])) : [];
    const devTxt = tx(en, '2. zariadenie zadarmo', '2nd device free');
    const cell = (m, b, d) => { const pr = byM.get(m); if (!b) return d ? `<b>🖥️ ${devTxt}</b>` : '–'; const eff = pr / (m + b), disc = Math.round((b / (m + b)) * 100); return `<b>${m} + ${b} m</b><br>${eur(eff)} / ${tx(en, 'mes.', 'mo')}<br><span class="accdisc">−${disc} %</span>${d ? `<br><span class="hint">${tx(en, 'alebo', 'or')} 🖥️ ${devTxt} *</span>` : ''}`; };
    const rows = mx ? mx.rows.filter((r) => pk.some((m) => r.bonus[m] || r.dev[m])) : [];
    const table = pk.length ? `<div class="tblw"><table class="tbl acctier"><thead><tr><th>${tx(en, 'Aktívni odporučení', 'Active referrals')}</th>${pk.map((m) => `<th>${esc(moLabel(m, en))}<br><span class="hint">${eur(byM.get(m))} · ${eur(byM.get(m) / m)}/${tx(en, 'mes.', 'mo')}</span></th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><th>${r.min > 0 ? '≥ ' + r.min : tx(en, 'každý', 'everyone')}</th>${pk.map((m) => `<td>${cell(m, r.bonus[m], r.dev[m])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
<p class="hint">${tx(en, 'Bonusové mesiace dostanete k balíku, ktorý si sami zaplatíte – cena sa nemení. Platí najvyššia dosiahnutá úroveň podľa počtu aktívnych odporučených v čase nákupu. Cena za mesiac = cena balíka / (mesiace + bonus).', 'Bonus months are added to the package you pay for – same price. The highest tier reached (active referrals at purchase time) applies. Price per month = package price / (months + bonus).')}${rows.some((r) => pk.some((m) => r.dev[m] && r.bonus[m])) ? ' ' + tx(en, '* Na tejto úrovni si môžete namiesto mesiacov vybrať druhé zariadenie – nepotrebujete 2 zariadenia? Druhé jednoducho dajte niekomu a máte pre seba zadarmo.', '* At this tier you can choose a second device instead – don\'t need two? Give the second one to someone and yours is free.') : ''}</p>` : '';
    const li = [
      st.on ? tx(en, '🤝 <b>Vlastný affiliate odkaz a mesiace zadarmo</b> – odporučte nás známym a pri každom vašom nákupe dostanete mesiace navyše.', '🤝 <b>Your own affiliate link and free months</b> – refer friends and get extra months with every purchase.') : '',
      tx(en, '📅 <b>Prehľad, do kedy platí predplatné</b> – kedykoľvek na jednom mieste.', '📅 <b>See when your subscription ends</b> – anytime, in one place.'),
      tx(en, '⏰ <b>Pripomenutie pred koncom predplatného</b> – 7 dní vopred s tlačidlom Predĺžiť.', '⏰ <b>Reminder before it ends</b> – 7 days ahead with a Renew button.'),
      tx(en, '⚡ <b>Rýchlejšie objednávky</b> – platba sa automaticky pripíše k vášmu účtu.', '⚡ <b>Faster orders</b> – payments are linked to your account automatically.'),
      tx(en, '🧾 <b>História platieb</b> – všetky zaplatené objednávky prehľadne.', '🧾 <b>Payment history</b> – all your paid orders at a glance.'),
    ].filter(Boolean);
    const head = `<h2>✨ ${tx(en, 'Prečo sa zaregistrovať?', 'Why sign up?')}</h2><ul class="accwhy">${li.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    if (full === 'table') return table;
    if (full) return `<div class="card">${head}${table ? `<h3>🎁 ${tx(en, 'Koľko ušetríte s odporúčaniami', 'How much you save with referrals')}</h3>${table}` : ''}</div>`;
    return `<section class="card accpromo">${head}${table ? `<details><summary>🎁 ${tx(en, 'Tabuľka bonusov a cena za mesiac', 'Bonus table and price per month')}</summary>${table}</details>` : ''}<p><a class="b" href="/registracia">📝 ${tx(en, 'Zaregistrovať sa zadarmo', 'Sign up for free')}</a> <a class="btnl" href="/prihlasenie">🔑 ${tx(en, 'Prihlásiť sa', 'Log in')}</a></p></section>`;
  }
  ctx.accWhyForReq = async (req) => { if (!(await accOn()) || cookies(req)[C_SESS]) return ''; return whyHtml(req, false).catch(() => ''); };
  // section manager (sections.js): full benefits/affiliate table card, sign-up promo box, login state
  ctx.accWhyHtml = async (req, full) => ((await accOn()) ? whyHtml(req, full).catch(() => '') : '');
  ctx.accLogged = (req) => !!cookies(req)[C_SESS];
  ctx.accEnabled = accOn;
  const smtpWarn = () => (smtpOn() ? '' : `<div class="msg err">⚠️ E-mail odosielanie nie je nastavené – e-maily „Zabudnuté heslo“ a overenie e-mailu sa neodosielajú (zákazník vidí rovnakú neutrálnu správu, vám príde Telegram notifikácia). Nastavte ho zadarmo v <a href="/admin/email">📧 E-mail odosielanie</a> (Brevo – Render free blokuje SMTP), alebo zákazníkovi pošlite odkaz cez „🔐 Odkaz na reset hesla“ v jeho detaile.</div>`);
  const safeNext = (v) => { const n = String(v || ''); return /^\/(platby|ucet)(\?[A-Za-z0-9=&_.%-]{0,200})?$/.test(n) ? n : ''; };

  app.get('/prihlasenie', wrap(async (req, res) => {
    const nx = safeNext(req.query.next);
    if (await fromReq(req)) return res.redirect(303, nx || '/ucet');
    const en = req.lang === 'en';
    await pub(req, res, tx(en, 'Prihlásenie', 'Log in'), `<h1 class="ph">🔑 ${tx(en, 'Prihlásenie', 'Log in')}</h1>${msg(req)}
<form method="post" action="/prihlasenie" class="card accf">${csrfField(req, res)}${nx ? `<input type="hidden" name="next" value="${esc(nx)}">` : ''}
<label for="u">${tx(en, 'E-mail alebo používateľské meno', 'E-mail or username')}</label><input id="u" name="username" required maxlength="200" autocomplete="username" autocapitalize="none" spellcheck="false">
<label for="p">${tx(en, 'Heslo', 'Password')}</label><input id="p" name="password" type="password" required maxlength="200" autocomplete="current-password">
<button class="b">${tx(en, 'Prihlásiť sa', 'Log in')}</button></form>
<p class="hint">${tx(en, 'Po prihlásení uvidíte svoje objednávky, ich stav a okno s prihlasovacími údajmi.', 'After you log in you will see your orders, their status, and the credentials window.')}</p>
<p class="hint">${tx(en, 'Nemáte účet?', 'No account yet?')} <a href="/registracia">${tx(en, 'Registrácia', 'Sign up')}</a> · <a href="/overit-predplatne">${tx(en, 'Overiť predplatné', 'Check subscription')}</a></p>
<p class="hint"><a href="/zabudnute-heslo">🔐 ${tx(en, 'Zabudnuté heslo?', 'Forgot password?')}</a></p>`);
  }));
  app.post('/prihlasenie', wrap(async (req, res) => {
    const back = (m) => res.redirect(303, '/prihlasenie?m=' + m);
    if (!csrfOk(req)) return back('csrf');
    const ip = ipKey(req.ip);
    if (L.count('lf:' + ip, 15 * 60e3) >= 10 || L.count('lfg', 15 * 60e3) >= 300) return back('locked');
    const un = String(req.body.username || req.body.email || '').trim().toLowerCase().slice(0, 200), pw = String(req.body.password || '').slice(0, 200);
    let u = null;
    if (EMAIL_RE.test(un)) u = (await pool.query(`SELECT * FROM acc_users WHERE lower(email)=$1`, [un])).rows[0];
    else if (USER_RE.test(un)) u = (await pool.query(`SELECT * FROM acc_users WHERE username=$1`, [un])).rows[0];
    const okPw = await bcrypt.compare(pw, u ? u.pw_hash : DUMMY);
    const locked = u && u.locked_until && new Date(u.locked_until) > new Date();
    if (!u || !okPw || locked || u.disabled) {
      L.hit('lf:' + ip, 1e9, 15 * 60e3); L.hit('lfg', 1e9, 15 * 60e3);
      if (u && !okPw) await pool.query(`UPDATE acc_users SET locked_until=CASE WHEN failed+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END, failed=CASE WHEN failed+1>=5 THEN 0 ELSE failed+1 END WHERE id=$1`, [u.id]).catch(() => {});
      return back(L.count('lf:' + ip, 15 * 60e3) >= 10 ? 'locked' : 'bad');
    }
    await pool.query(`UPDATE acc_users SET failed=0, locked_until=NULL, last_login_at=now(), last_ip=$2, dev_hash=CASE WHEN dev_hash='' THEN $3 ELSE dev_hash END WHERE id=$1`, [u.id, ip, devId(req, res)]);
    if (bcrypt.getRounds(u.pw_hash) < 12) await pool.query(`UPDATE acc_users SET pw_hash=$2 WHERE id=$1`, [u.id, await bcrypt.hash(pw, 12)]);
    await startSession(req, res, u.id);
    res.redirect(303, safeNext(req.body.next) || '/ucet');
  }));

  app.get('/registracia', wrap(async (req, res) => {
    if (await fromReq(req)) return res.redirect(303, '/ucet');
    const en = req.lang === 'en';
    if (!(await accOn())) return pub(req, res, tx(en, 'Registrácia', 'Sign up'), `<h1 class="ph">${tx(en, 'Registrácia', 'Sign up')}</h1>${msgOf('off', en)}`);
    devId(req, res);
    const code = String(req.query.ref || cookies(req)[C_REF] || '').toLowerCase();
    const ref = REF_RE.test(code) ? (await pool.query(`SELECT username FROM acc_users WHERE ref_code=$1 AND NOT disabled`, [code])).rows[0] : null;
    await pub(req, res, tx(en, 'Registrácia', 'Sign up'), `<h1 class="ph">📝 ${tx(en, 'Registrácia', 'Sign up')}</h1>${msg(req)}
${ref ? `<p class="hint">🤝 ${tx(en, 'Odporučil vás', 'Referred by')}: <b>${esc(ref.username)}</b></p>` : ''}
<form method="post" action="/registracia" class="card accf">${csrfField(req, res)}<input type="hidden" name="t" value="${esc(formTok())}"><div class="hp" aria-hidden="true"><label>Web</label><input name="web" tabindex="-1" autocomplete="off"></div>
<label for="u">${tx(en, 'Používateľské meno', 'Username')}</label><input id="u" name="username" required minlength="3" maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false"><p class="hint">${esc(MSG.uname[en ? 1 : 0])}</p>
<label for="p">${tx(en, 'Heslo (min. 8 znakov)', 'Password (min. 8 characters)')}</label><input id="p" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
<label for="p2">${tx(en, 'Heslo znova', 'Repeat password')}</label><input id="p2" name="password2" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
<label for="e">${tx(en, 'E-mail', 'E-mail')}</label><input id="e" name="email" type="email" required maxlength="200" autocomplete="email" autocapitalize="none" spellcheck="false"><p class="hint">${tx(en, 'Slúži na obnovu zabudnutého hesla. Nikomu ho neposkytujeme.', 'Used to reset a forgotten password. Never shared.')}</p>
<button class="b">${tx(en, 'Vytvoriť účet', 'Create account')}</button></form>
<p class="hint">${tx(en, 'Už máte účet?', 'Already registered?')} <a href="/prihlasenie">${tx(en, 'Prihlásenie', 'Log in')}</a></p>${await whyHtml(req, true).catch(() => '')}`);
  }));
  async function newRefCode() { const A = 'abcdefghijkmnpqrstuvwxyz23456789'; for (;;) { const c = Array.from(crypto.randomBytes(8), (x) => A[x % 32]).join(''); if (!(await pool.query(`SELECT 1 FROM acc_users WHERE ref_code=$1`, [c])).rowCount) return c; } }
  async function registerFromCheckout({ username, email, password, req, res }) {
    const logged = await fromReq(req);
    if (logged) return { ok: true, user: { id: logged.id, username: logged.username, email: logged.email || '' }, existing: true };
    const un = String(username || '').trim().toLowerCase();
    if (RESERVED_USERS.has(un) || !/^[a-z0-9][a-z0-9_.-]{7,23}$/.test(un)) {
      return { error: 'Používateľské meno musí mať 8–24 znakov (malé písmená, číslice, . _ -) a začínať písmenom alebo číslicou.', code: 'USERNAME' };
    }
    const pw = String(password == null ? '' : password);
    if (pw.length < 8 || Buffer.byteLength(pw) > 72 || pw.toLowerCase() === un) {
      return { error: MSG.pw[0], code: 'PASSWORD' };
    }
    const em = email ? normEmail(email) : '';
    if (em && !EMAIL_RE.test(em)) return { error: 'Zadajte platný e-mail, alebo nechajte pole prázdne.', code: 'EMAIL' };
    if (em) {
      const byEm = (await pool.query(`SELECT id,username,email FROM acc_users WHERE lower(email)=$1`, [em])).rows[0];
      if (byEm) return { error: 'Účet s týmto e-mailom už existuje. Prihláste sa (e-mail a heslo) a potom dokončite platbu.', code: 'EMAIL_EXISTS', login: '/prihlasenie?next=/platby' };
    }
    const byUn = (await pool.query(`SELECT id,username,email FROM acc_users WHERE username=$1`, [un])).rows[0];
    if (byUn) return { error: 'Toto používateľské meno už má účet. Prihláste sa menom a heslom a potom dokončite platbu.', code: 'USER_EXISTS', login: '/prihlasenie?next=/platby' };
    const hash = await bcrypt.hash(pw, 12);
    const ip = ipKey(req && req.ip);
    const dev = devId(req, res);
    const ins = await pool.query(
      `INSERT INTO acc_users (username,pw_hash,email,ref_code,created_ip,dev_hash,last_ip,last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$5,now()) RETURNING id,username,email`,
      [un, hash, em || null, await newRefCode(), ip, dev]
    );
    if (!ins.rowCount) return { error: 'Účet sa nepodarilo vytvoriť.', code: 'FAIL' };
    const user = ins.rows[0];
    await startSession(req, res, user.id);
    req.__acc = { id: user.id, username: user.username, email: user.email, pw_hash: hash };
    if (em && smtpOn()) sendVerify(req, { id: user.id, username: un, email: em }).catch(() => {});
    return { ok: true, user: { id: user.id, username: user.username, email: user.email || '' }, created: true };
  }

  async function applySoftwareExpiry({ username, until, userId, orderId }) {
    const un = String(username || '').trim();
    const at = until instanceof Date ? until : new Date(until);
    if (!un || !at || Number.isNaN(+at)) return { ok: false };
    const key = un.toLowerCase();
    await pool.query(
      `INSERT INTO acc_software (username, display, user_id, order_id, until_at, updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (username) DO UPDATE SET display=EXCLUDED.display, user_id=COALESCE(EXCLUDED.user_id, acc_software.user_id), order_id=COALESCE(EXCLUDED.order_id, acc_software.order_id), until_at=GREATEST(acc_software.until_at, EXCLUDED.until_at), updated_at=now()`,
      [key, un, userId || null, orderId || null, at]
    );
    if (userId) {
      const cur = (await pool.query(`SELECT licence_until FROM acc_users WHERE id=$1`, [userId])).rows[0];
      const prev = cur && cur.licence_until ? new Date(cur.licence_until) : null;
      if (!prev || at > prev) await pool.query(`UPDATE acc_users SET licence_until=$2 WHERE id=$1`, [userId, at]);
      const u = (await pool.query(`SELECT panel_user FROM acc_users WHERE id=$1`, [userId])).rows[0];
      if (u && !u.panel_user) await pool.query(`UPDATE acc_users SET panel_pending=COALESCE(panel_pending,$2) WHERE id=$1`, [userId, un]);
    }
    return { ok: true };
  }
  async function softwareByName(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return (await pool.query(`SELECT display, until_at, user_id, order_id FROM acc_software WHERE username=$1`, [key])).rows[0] || null;
  }
  if (global.__lnkAccounts) {
    global.__lnkAccounts.applySoftwareExpiry = applySoftwareExpiry;
    global.__lnkAccounts.softwareByName = softwareByName;
  }

  app.post('/registracia', wrap(async (req, res) => {
    const back = (m) => res.redirect(303, '/registracia?m=' + m);
    if (!(await accOn())) return back('off');
    if (!csrfOk(req)) return back('csrf');
    if (req.body.web || !formTokOk(req.body.t)) return back('spam');
    const ip = ipKey(req.ip);
    if (L.count('rg:' + ip, 3600e3) >= 3 || L.count('rgd:' + ip, 86400e3) >= 10 || L.count('rgg', 3600e3) >= 30) return back('limit');
    const un = String(req.body.username || '').trim().toLowerCase(), pw = String(req.body.password || ''), pw2 = String(req.body.password2 || ''), em = normEmail(req.body.email);
    if (RESERVED_USERS.has(un)) return back('taken');
    if (!USER_RE.test(un)) return back('uname');
    if (pw.length < 8 || Buffer.byteLength(pw) > 72 || pw.toLowerCase() === un) return back('pw');
    if (pw !== pw2) return back('pw2');
    if (!em || !EMAIL_RE.test(em)) return back('emailreq');
    if ((await pool.query(`SELECT 1 FROM acc_users WHERE lower(email)=$1`, [em])).rowCount) return back('taken2');
    L.hit('rg:' + ip, 1e9, 3600e3); L.hit('rgd:' + ip, 1e9, 86400e3); L.hit('rgg', 1e9, 3600e3);
    const dev = devId(req, res);
    let refId = null, flag = '', blocked = false;
    const code = String(cookies(req)[C_REF] || '').toLowerCase();
    if (REF_RE.test(code)) {
      const r = (await pool.query(`SELECT id,dev_hash,created_ip,last_ip FROM acc_users WHERE ref_code=$1 AND NOT disabled`, [code])).rows[0];
      const cur = await fromReq(req);
      if (r) {
        refId = r.id;
        if (cur && cur.id === r.id) { flag = 'self_account'; blocked = true; }
        else if (r.dev_hash && r.dev_hash === dev) { flag = 'same_device'; blocked = true; }
        else if (r.created_ip === ip || r.last_ip === ip) { flag = 'same_ip'; blocked = (await affSettings()).blockIp; }
      }
    }
    const hash = await bcrypt.hash(pw, 12);
    const ins = await pool.query(`INSERT INTO acc_users (username,pw_hash,email,ref_code,referrer_id,ref_flag,ref_blocked,created_ip,dev_hash,last_ip,last_login_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,now()) ON CONFLICT (username) DO NOTHING RETURNING id`,
      [un, hash, em, await newRefCode(), refId, flag, blocked, ip, dev]).catch((e) => { if (e.code === '23505') return { rowCount: 0 }; throw e; });
    if (!ins.rowCount) return back('taken2');
    clearCookie(res, C_REF);
    await startSession(req, res, ins.rows[0].id);
    if (flag) notify(`⚠️ Affiliate: nový účet ${un} – odporúčanie označené (${flag}${blocked ? ', zablokované' : ''}).`);
    if (smtpOn()) sendVerify(req, { id: ins.rows[0].id, username: un, email: em }).catch((e) => console.error('[acc] verify mail: ' + (e.code || 'ERR')));
    res.redirect(303, '/ucet?m=welcome');
  }));
  app.post('/odhlasenie', wrap(async (req, res) => {
    if (!csrfOk(req)) return res.redirect(303, '/ucet');
    const t = cookies(req)[C_SESS]; if (t) await pool.query(`DELETE FROM acc_sessions WHERE token_hash=$1`, [sha(t)]);
    clearCookie(res, C_SESS);
    res.redirect(303, '/prihlasenie?m=out');
  }));

  // ---------- account page ----------
  async function qrSvg(text) { try { return await QR.toString(text, { type: 'svg', margin: 1, width: 168, errorCorrectionLevel: 'M' }); } catch { return ''; } }
  const origin = (req) => String(process.env.LNKBIO_PUBLIC_URL || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ('https://' + req.get('host'))).replace(/\/$/, '').replace(/^http:\/\//i, 'https://');
  const ACC_V = (() => { try { return sha(require('fs').readFileSync(require('path').join(__dirname, 'static', 'acc.js'))).slice(0, 10); } catch { return '1'; } })();
  app.get('/ucet', wrap(async (req, res) => {
    const u = await fromReq(req); if (!u) return res.redirect(303, '/prihlasenie');
    const en = req.lang === 'en', now = new Date();
    const until = AFF.effectiveUntil(u), active = !!until && until > now, days = until ? Math.ceil((until - now) / 86400e3) : 0;
    const src = u.override_until ? tx(en, 'nastavené podporou', 'set by support') : u.panel_user && u.panel_synced_at && u.panel_expiry ? tx(en, 'podľa servera predplatného', 'from the subscription server') : u.licence_until ? tx(en, 'podľa zaplatených objednávok', 'from paid orders') : '';
    const lic = `<div class="card"><h2>📺 ${tx(en, 'Predplatné', 'Subscription')}</h2>${until ? `<p class="accst ${active ? 'ok' : 'bad'}">${active ? `✅ ${tx(en, 'Predplatné aktívne do', 'Subscription active until')} <b>${fmtDate(until)}</b>` : `⛔ ${tx(en, 'Predplatné vypršalo', 'Subscription expired')} (${fmtDate(until)})`}</p><p class="hint">${esc(src)}</p>` : `<p>${tx(en, 'Zatiaľ nemáte aktívne predplatné.', 'No active subscription yet.')}</p>`}
${active && days <= 7 ? `<div class="msg err">⏰ ${tx(en, `Predplatné končí o ${days} ${days === 1 ? 'deň' : days < 5 ? 'dni' : 'dní'}.`, `Your subscription ends in ${days} day(s).`)}</div><p><a class="b" href="/platby">🔁 ${tx(en, 'Predĺžiť', 'Renew')}</a></p>` : active ? `<p><a class="btnl" href="/platby">💳 ${tx(en, 'Predĺžiť', 'Renew')}</a></p>` : `<p><a class="b" href="/platby">💳 ${tx(en, 'Kúpiť predplatné', 'Buy subscription')}</a></p>`}</div>`;
    const pc = await panelCfg();
    const panelBox = `<div class="card"><h2>🔗 ${tx(en, 'Prepojenie s predplatným', 'Link your subscription')}</h2>${u.panel_user ? `<p>${tx(en, 'Prepojené meno', 'Linked username')}: <b>${esc(u.panel_user)}</b>${u.panel_synced_at ? ` · ${tx(en, 'overené', 'checked')} ${esc(fmtDT(u.panel_synced_at))}` : ''}</p>` : ''}
${selfCheck(pc) ? `<form method="post" action="/ucet/panel" class="accf">${csrfField(req, res)}<p class="hint">${tx(en, 'Zadajte prihlasovacie údaje k predplatnému (z aplikácie v TV). Heslo slúži len na overenie a neukladá sa.', 'Enter your subscription login (from the TV app). The password is only used to verify and is never stored.')}</p>
<label for="pu">${tx(en, 'Meno k predplatnému', 'Subscription username')}</label><input id="pu" name="panel_user" required maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false">
<label for="pp">${tx(en, 'Heslo k predplatnému', 'Subscription password')}</label><input id="pp" name="panel_pass" type="password" required maxlength="128" autocomplete="off">
<button class="btnl sm">${tx(en, 'Overiť a prepojiť', 'Verify & link')}</button></form>` : `<p class="hint">${tx(en, 'Predplatné s účtom prepojí podpora (alebo sa prepojí pri prvej zaplatenej objednávke).', 'Support links your subscription (or it is linked with your first paid order).')}</p>`}
${!u.panel_user ? `<form method="post" action="/ucet/panel-meno" class="accf">${csrfField(req, res)}<p class="hint">${tx(en, 'Alebo len zadajte meno k predplatnému – prepojí sa automaticky pri vašej prvej zaplatenej objednávke.', 'Or just enter your subscription username – it will be linked with your first paid order.')}</p>
<label for="pn">${tx(en, 'Meno k predplatnému', 'Subscription username')}</label><input id="pn" name="panel_user" maxlength="64" value="${esc(u.panel_pending || '')}" autocomplete="off" autocapitalize="none" spellcheck="false"><button class="btnl sm">${tx(en, 'Uložiť', 'Save')}</button></form>` : ''}</div>`;
    const bi = await bonusInfo(u);
    let aff = '';
    if (bi) {
      const link = `${origin(req)}/?ref=${u.ref_code}`, mx = AFF.matrix(bi.st.tiers, await packages());
      const nx = bi.next, cur = bi.tier;
      const shown = mx.packages.filter((m) => mx.rows.some((r) => r.bonus[m] || r.dev[m]));
      const perPk = shown.map((m) => { const b = bi.bonus(m), d = bi.devFor(m), nb = nx ? AFF.bonusFor(nx.min, m, bi.st.tiers) : 0; return `<li>${esc(moLabel(m, en))}: <b>${b ? `+${esc(moLabel(b, en))} ${tx(en, 'zadarmo', 'free')}` : d ? '' : '–'}${d ? `${b ? ` ${tx(en, 'alebo', 'or')} ` : ''}🖥️ ${tx(en, '2. zariadenie zadarmo', '2nd device free')}` : ''}</b>${nb > b ? ` <span class="hint">(${tx(en, 'od', 'from')} ${nx.min} ${tx(en, 'aktívnych', 'active')}: +${nb})</span>` : ''}</li>`; }).join('');
      const earned = (await pool.query(`SELECT COALESCE(sum(bonus_months) FILTER (WHERE kind='bonus'),0)::int m, count(*) FILTER (WHERE kind='device')::int d FROM acc_ledger WHERE user_id=$1`, [u.id])).rows[0];
      const devs = (await pool.query(`SELECT from_at,until_at,panel_user FROM acc_devices WHERE user_id=$1 ORDER BY id DESC LIMIT 10`, [u.id])).rows;
      const pct = nx ? Math.min(100, Math.round((bi.active / nx.min) * 100)) : 100;
      aff = `<div class="card"><h2>🤝 ${tx(en, 'Odporúčajte a získajte mesiace zadarmo', 'Refer friends, get free months')}</h2>
<p>${tx(en, 'Váš odkaz', 'Your link')}:</p><div class="accl"><input id="reflink" readonly value="${esc(link)}" aria-label="Affiliate link"><button type="button" class="b sm" data-copy="reflink" data-ok="${tx(en, '✅ Skopírované', '✅ Copied')}">📋 ${tx(en, 'Kopírovať', 'Copy')}</button></div>
<div class="accqr">${await qrSvg(link)}</div>
<p>${tx(en, 'Aktívni odporučení', 'Active referrals')}: <b>${bi.active}</b> · ${tx(en, 'spolu', 'total')}: ${bi.total}</p>
<p>${tx(en, 'Aktuálna úroveň', 'Current tier')}: <b>${cur ? '≥ ' + cur.min : tx(en, 'zatiaľ žiadna', 'none yet')}</b>${nx ? ` · ${tx(en, 'ďalšia úroveň', 'next tier')}: <b>${nx.min}</b> (${tx(en, 'chýba', 'missing')} ${nx.min - bi.active})` : ''}</p>
<div class="accbar"><span class="w${Math.round(pct / 5) * 5}"></span></div>
<p>${tx(en, 'Bonus k vášmu ďalšiemu nákupu (cena ostáva rovnaká)', 'Bonus on your next purchase (same price)')}:</p><ul class="accb">${perPk}</ul>
${earned.m || earned.d ? `<p>${tx(en, 'Doteraz získané', 'Earned so far')}: <b>${esc(moLabel(earned.m, en))}</b>${earned.d ? ` + ${earned.d}× ${tx(en, 'druhé zariadenie', 'second device')}` : ''}</p>` : ''}
${bi.device || u.aff_choice === 'device' ? `<form method="post" action="/ucet/volba" class="accf">${csrfField(req, res)}<p><b>${tx(en, 'Na vašej úrovni si môžete vybrať (pri balíkoch, kde je to možné)', 'At your tier you can choose (for packages where available)')}:</b></p>
<label class="chk"><input type="radio" name="choice" value="months"${u.aff_choice !== 'device' ? ' checked' : ''}> ${tx(en, 'Bonusové mesiace', 'Bonus months')}</label>
<label class="chk"><input type="radio" name="choice" value="device"${u.aff_choice === 'device' ? ' checked' : ''}> ${tx(en, 'Druhé zariadenie (na rovnaké obdobie ako kúpený balík)', 'Second device (same period as the package)')}</label>
<p class="hint">${tx(en, 'Nepotrebujete 2 zariadenia? Druhé jednoducho dajte niekomu a máte pre seba zadarmo', "Don't need 2 devices? Simply give the second one to someone and yours is free")}</p><button class="btnl sm">${tx(en, 'Uložiť voľbu', 'Save choice')}</button></form>` : ''}
${devs.length ? `<p>${tx(en, 'Druhé zariadenia', 'Second devices')}:</p><ul>${devs.map((d) => `<li>${fmtDate(d.from_at)} – ${fmtDate(d.until_at)}${d.panel_user ? ' · ' + esc(d.panel_user) : ` · <span class="hint">${tx(en, 'prístup vám pošle podpora', 'support will send the login')}</span>`}</li>`).join('')}</ul>` : ''}
<details><summary>${tx(en, 'Pravidlá', 'Rules')}</summary><ul class="hint">
<li>${tx(en, 'Kto sa zaregistruje cez váš odkaz (platí 30 dní), je váš odporučený člen.', 'Anyone who signs up via your link (valid 30 days) becomes your referred member.')}</li>
<li>${tx(en, 'Aktívny = má platné predplatné. Po vypršaní sa nepočíta, po predĺžení opäť áno.', 'Active = has a valid subscription. Expired members do not count until they renew.')}</li>
<li>${tx(en, 'Bonus sa pripíše automaticky k balíku, ktorý si zaplatíte (cena sa nemení), podľa počtu aktívnych odporučených v čase nákupu. Musíte byť pri nákupe prihlásený.', 'The bonus is added automatically to the package you pay for (same price), based on active referrals at the time of purchase. You must be logged in when buying.')}</li>
<li>${mx.rows.map((r) => `≥ ${r.min}: ${shown.filter((m) => r.bonus[m]).map((m) => `${m} m +${r.bonus[m]}`).join(', ') || '–'}${r.device ? ` (${tx(en, 'alebo 2. zariadenie', 'or 2nd device')})` : ''}`).join(' · ')}</li>
<li>${tx(en, 'Odporúčanie seba samého (rovnaký účet alebo zariadenie) sa nepočíta.', 'Self-referrals (same account or device) do not count.')}</li></ul></details></div>`;
    }
    const orders = (await pool.query(`SELECT order_id,months,paid_at FROM acc_orders WHERE user_id=$1 ORDER BY paid_at DESC LIMIT 20`, [u.id])).rows;
    const ord = orders.length ? `<div class="card"><h2>🧾 ${tx(en, 'Zaplatené objednávky', 'Paid orders')}</h2><ul>${orders.map((o) => `<li>${fmtDate(o.paid_at)} · ${esc(moLabel(o.months, en))} · <code>${esc(o.order_id)}</code></li>`).join('')}</ul></div>` : '';
    let checkoutOrd = '';
    try {
      const F = require('./pay/src/fulfill');
      const all = (global.__payOrders && typeof global.__payOrders.load === 'function') ? global.__payOrders.load() : {};
      const rows = F.listAccountOrders(all, u, req);
      const tr = rows.map((r) => {
        const st = en ? `${esc(r.status)} / ${esc(r.statusEn)}` : esc(r.status);
        const link = r.confirmed
          ? `<a href="${esc(r.path)}">${tx(en, 'Okno s údajmi', 'Credentials window')}</a>`
          : `<span class="hint">${tx(en, 'Dostupné po potvrdení', 'Available after confirmation')}</span>`;
        return `<tr><td><code>${esc(r.orderId)}</code></td><td>${esc(r.amount != null ? r.amount + ' €' : '—')}</td><td>${st}</td><td>${link}</td></tr>`;
      }).join('');
      checkoutOrd = `<div class="card"><h2>📦 ${tx(en, 'Moje objednávky', 'My orders')}</h2>
${rows.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>${tx(en, 'Objednávka', 'Order')}</th><th>${tx(en, 'Suma', 'Amount')}</th><th>${tx(en, 'Stav', 'Status')}</th><th></th></tr></thead><tbody>${tr}</tbody></table></div>` : `<p class="hint">${tx(en, 'K tomuto účtu zatiaľ nie je priradená žiadna objednávka. Po vyplnení údajov pred platbou sa tu objavia.', 'No orders are linked to this account yet. They appear here after you enter your details at checkout.')}</p>`}
<p class="hint">${tx(en, 'Súkromný odkaz k objednávke, ktorý ste dostali pri platbe, ostáva v platnosti.', 'The private order link from checkout stays valid.')}</p></div>`;
    } catch (e) { checkoutOrd = ''; }
    try {
      const F = require('./pay/src/fulfill');
      const all = (global.__payOrders && global.__payOrders.load) ? global.__payOrders.load() : {};
      const mine = Object.values(all).filter((o) => o && ((o.acct && o.acct.id === u.id) || (o.fulfill && o.fulfill.accountId === u.id)) && o.fulfill && o.fulfill.credSentAt && F.isConfirmed(o));
      if (mine.length) {
        const body = mine.map((o) => {
          const msgs = F.renderMessages(o, req).replace(/src="\/objednavka\/[^"]+\/foto\/(\d+)"/g, 'src="/ucet/objednavka/' + encodeURIComponent(o.orderId) + '/foto/$1"');
          return `<div class="card"><h3>${tx(en, 'Údaje k objednávke', 'Details for order')} <code>${esc(o.orderId)}</code></h3>
<p class="hint">${tx(en, 'Prihlasovacie údaje do TV Software (nie na túto stránku).', 'These are logins for the TV software, not for this website.')}</p>
<div class="msgs">${msgs}</div>
<p class="hint"><a href="${esc(F.pathFor(o))}">${tx(en, 'Súkromné okno', 'Private window')}</a></p></div>`;
        }).join('');
        checkoutOrd += body;
      }
    } catch (e) { /* */ }

    const emailRow = `<p>E-mail: ${u.email ? `<b>${esc(u.email)}</b> ${u.email_verified ? `<span class="accok">✅ ${tx(en, 'overený', 'verified')}</span>` : `<span class="hint">(${tx(en, 'neoverený', 'not verified')})</span>`}` : `<span class="msg err inl">${tx(en, 'chýba – doplňte ho, inak nebude možné obnoviť heslo', 'missing – add it, otherwise password reset is impossible')}</span>`}</p>
${u.email && !u.email_verified && smtpOn() ? `<form method="post" action="/ucet/overit-email" class="accout">${csrfField(req, res)}<button class="btnl sm">📧 ${tx(en, 'Poslať overovací odkaz', 'Send verification link')}</button></form>` : ''}
<details${u.email ? '' : ' open'}><summary>${tx(en, u.email ? 'Zmeniť e-mail' : 'Doplniť e-mail', u.email ? 'Change e-mail' : 'Add e-mail')}</summary><form method="post" action="/ucet/email" class="accf">${csrfField(req, res)}
<label for="ne">${tx(en, 'Nový e-mail', 'New e-mail')}</label><input id="ne" name="email" type="email" required maxlength="200" autocomplete="email">
<label for="ep">${tx(en, 'Heslo na potvrdenie', 'Password to confirm')}</label><input id="ep" name="password" type="password" required autocomplete="current-password" maxlength="200"><button class="btnl sm">${tx(en, 'Uložiť e-mail', 'Save e-mail')}</button></form></details>`;
    const sec = `<div class="card"><h2>⚙️ ${tx(en, 'Nastavenia účtu', 'Account settings')}</h2>${emailRow}<details><summary>${tx(en, 'Zmeniť heslo', 'Change password')}</summary><form method="post" action="/ucet/heslo" class="accf">${csrfField(req, res)}
<label for="op">${tx(en, 'Aktuálne heslo', 'Current password')}</label><input id="op" name="old" type="password" required autocomplete="current-password" maxlength="200">
<label for="np">${tx(en, 'Nové heslo', 'New password')}</label><input id="np" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">
<label for="np2">${tx(en, 'Nové heslo znova', 'Repeat new password')}</label><input id="np2" name="password2" type="password" required minlength="8" maxlength="72" autocomplete="new-password"><button class="btnl sm">${tx(en, 'Zmeniť heslo', 'Change password')}</button></form></details>
<details><summary>${tx(en, 'Zrušiť účet', 'Delete account')}</summary><form method="post" action="/ucet/zrusit" class="accf">${csrfField(req, res)}<p class="hint">${tx(en, 'Účet sa natrvalo zmaže. Predplatné na serveri tým nezaniká.', 'The account is deleted permanently. Your subscription itself stays.')}</p>
<label for="dp">${tx(en, 'Heslo na potvrdenie', 'Password to confirm')}</label><input id="dp" name="password" type="password" required autocomplete="current-password" maxlength="200"><button class="btnl sm">🗑️ ${tx(en, 'Zrušiť účet', 'Delete account')}</button></form></details>
<form method="post" action="/odhlasenie" class="accout">${csrfField(req, res)}<button class="btnl sm">🚪 ${tx(en, 'Odhlásiť sa', 'Log out')}</button></form></div>`;
    await pub(req, res, tx(en, 'Môj účet', 'My account'), `<h1 class="ph">👤 ${esc(u.username)}</h1>${msg(req)}${lic}${checkoutOrd}${aff}${panelBox}${ord}${sec}<script src="/static/acc.js?v=${ACC_V}" defer></script>`);
  }));
  app.get('/ucet/objednavka/:id/foto/:i', wrap(async (req, res) => {
    const u = await fromReq(req); if (!u) return res.status(401).end();
    const F = require('./pay/src/fulfill');
    const all = (global.__payOrders && global.__payOrders.load) ? global.__payOrders.load() : {};
    const o = all[req.params.id];
    if (!o || !((o.acct && o.acct.id === u.id) || (o.fulfill && o.fulfill.accountId === u.id))) return res.status(404).end();
    const m = o.fulfill && o.fulfill.messages && o.fulfill.messages[Number(req.params.i)];
    const ph = F.photoBytes(m);
    if (!ph) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.type(ph.mime).send(ph.buf);
  }));
    const needUser = async (req, res) => { const u = await fromReq(req); if (!u) { res.redirect(303, '/prihlasenie'); return null; } if (!csrfOk(req)) { res.redirect(303, '/ucet?m=csrf'); return null; } return u; };
  app.post('/ucet/heslo', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    if (L.hit('pwc:' + u.id, 10, 3600e3)) return res.redirect(303, '/ucet?m=locked');
    const pw = String(req.body.password || '');
    if (!(await bcrypt.compare(String(req.body.old || '').slice(0, 200), u.pw_hash))) return res.redirect(303, '/ucet?m=oldpw');
    if (pw.length < 8 || Buffer.byteLength(pw) > 72 || pw.toLowerCase() === u.username) return res.redirect(303, '/ucet?m=pw');
    if (pw !== String(req.body.password2 || '')) return res.redirect(303, '/ucet?m=pw2');
    await pool.query(`UPDATE acc_users SET pw_hash=$2 WHERE id=$1`, [u.id, await bcrypt.hash(pw, 12)]);
    await pool.query(`DELETE FROM acc_sessions WHERE user_id=$1`, [u.id]);
    await startSession(req, res, u.id);
    res.redirect(303, '/ucet?m=pwok');
  }));
  async function deleteUser(id) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(`DELETE FROM acc_sessions WHERE user_id=$1`, [id]); await c.query(`UPDATE acc_users SET referrer_id=NULL WHERE referrer_id=$1`, [id]); await c.query(`DELETE FROM acc_devices WHERE user_id=$1`, [id]); await c.query(`DELETE FROM acc_users WHERE id=$1`, [id]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  // „Zabudnuté heslo“ – same answer whether or not the e-mail exists; single-use hashed token, 1 hour
  app.get('/zabudnute-heslo', wrap(async (req, res) => {
    const en = req.lang === 'en';
    await pub(req, res, tx(en, 'Zabudnuté heslo', 'Forgot password'), `<h1 class="ph">🔐 ${tx(en, 'Zabudnuté heslo', 'Forgot password')}</h1>${msg(req)}
<form method="post" action="/zabudnute-heslo" class="card accf">${csrfField(req, res)}<input type="hidden" name="t" value="${esc(formTok())}"><div class="hp" aria-hidden="true"><label>Web</label><input name="web" tabindex="-1" autocomplete="off"></div>
<p class="hint">${tx(en, 'Zadajte e-mail, ktorý ste uviedli pri registrácii. Pošleme vám odkaz na nastavenie nového hesla (platí 1 hodinu).', 'Enter the e-mail you registered with. We will send you a link to set a new password (valid 1 hour).')}</p>
<label for="e">E-mail</label><input id="e" name="email" type="email" required maxlength="200" autocomplete="email" autocapitalize="none" spellcheck="false">
<button class="b">${tx(en, 'Poslať odkaz', 'Send link')}</button></form>
<p class="hint"><a href="/prihlasenie">${tx(en, 'Späť na prihlásenie', 'Back to log in')}</a></p>`);
  }));
  app.post('/zabudnute-heslo', wrap(async (req, res) => {
    const back = (m) => res.redirect(303, '/zabudnute-heslo?m=' + m);
    if (!csrfOk(req)) return back('csrf');
    if (req.body.web || !formTokOk(req.body.t, 1000)) return back('spam');
    const ip = ipKey(req.ip), em = normEmail(req.body.email);
    if (L.hit('fp:' + ip, 5, 3600e3) || L.hit('fpg', 200, 3600e3)) return back('locked');
    if (!EMAIL_RE.test(em)) return back('email');
    const throttled = L.hit('fpe:' + sha(em), 3, 3600e3);
    const u = throttled ? null : (await pool.query(`SELECT id,username,email,disabled FROM acc_users WHERE lower(email)=$1`, [em])).rows[0];
    if (u && !u.disabled) {
      const t = newTok();
      await pool.query(`UPDATE acc_users SET reset_hash=$2, reset_exp=now()+interval '1 hour' WHERE id=$1`, [u.id, sha(t)]);
      const link = `${origin(req)}/ucet/reset/${t}`, s = await getSettings();
      setImmediate(() => {
        if (!smtpOn()) { notify(`🔐 Zákazník ${u.username} žiada o obnovu hesla, ale e-mail odosielanie nie je nastavené – vygenerujte mu odkaz v admine (Zákazníci → ${u.username} → Odkaz na reset hesla).`); return; }
        sendMail(u.email, `${s.title || 'TV Software'} – obnova hesla`, `Dobrý deň ${u.username},\n\nniekto (pravdepodobne vy) požiadal o obnovu hesla. Nové heslo nastavíte tu (odkaz platí 1 hodinu a dá sa použiť len raz):\n${link}\n\nAk ste o obnovu nežiadali, tento e-mail ignorujte – heslo ostáva nezmenené.\n`)
          .catch((e) => { console.error('[acc] reset mail: ' + (e.code || 'ERR')); notify(`⚠️ Obnova hesla pre ${u.username}: e-mail sa nepodarilo odoslať – vygenerujte odkaz v admine.`); });
      });
    }
    back('sent');
  }));
  app.get('/ucet/overit-email/:t([A-Za-z0-9_-]{43})', wrap(async (req, res) => {
    if (L.hit('ve:' + ipKey(req.ip), 30, 3600e3)) return res.redirect(303, '/prihlasenie?m=locked');
    const r = await pool.query(`UPDATE acc_users SET email_verified=true, verify_hash=NULL, verify_exp=NULL WHERE verify_hash=$1 AND verify_exp>now() RETURNING id`, [sha(req.params.t)]);
    const to = (await fromReq(req)) ? '/ucet' : '/prihlasenie';
    res.redirect(303, to + '?m=' + (r.rowCount ? 'verified' : 'vbad'));
  }));
  app.post('/ucet/overit-email', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    if (!u.email || u.email_verified || L.hit('vs:' + u.id, 3, 3600e3)) return res.redirect(303, '/ucet?m=locked');
    try { await sendVerify(req, u); res.redirect(303, '/ucet?m=vsent'); } catch (e) { res.redirect(303, '/ucet?m=vfail'); }
  }));
  app.post('/ucet/email', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    if (L.hit('em:' + u.id, 5, 3600e3) || !(await bcrypt.compare(String(req.body.password || '').slice(0, 200), u.pw_hash))) return res.redirect(303, '/ucet?m=oldpw');
    const em = normEmail(req.body.email); if (!EMAIL_RE.test(em)) return res.redirect(303, '/ucet?m=emailreq');
    if (em === (u.email || '').toLowerCase()) return res.redirect(303, '/ucet');
    const r = await pool.query(`UPDATE acc_users SET email=$2, email_verified=false, verify_hash=NULL, verify_exp=NULL WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM acc_users x WHERE lower(x.email)=$2 AND x.id<>$1)`, [u.id, em]).catch(() => ({ rowCount: 0 }));
    if (!r.rowCount) return res.redirect(303, '/ucet?m=taken2');
    if (smtpOn()) sendVerify(req, { ...u, email: em }).catch(() => {});
    res.redirect(303, '/ucet?m=emailok');
  }));
  app.post('/ucet/zrusit', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    if (L.hit('del:' + u.id, 5, 3600e3) || !(await bcrypt.compare(String(req.body.password || '').slice(0, 200), u.pw_hash))) return res.redirect(303, '/ucet?m=oldpw');
    await deleteUser(u.id);
    clearCookie(res, C_SESS);
    res.redirect(303, '/prihlasenie?m=del');
  }));
  app.post('/ucet/volba', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    await pool.query(`UPDATE acc_users SET aff_choice=$2 WHERE id=$1`, [u.id, req.body.choice === 'device' ? 'device' : 'months']);
    res.redirect(303, '/ucet?m=choice');
  }));
  const panelUserOk = (s) => /^[A-Za-z0-9_.@+-]{1,64}$/.test(s);
  app.post('/ucet/panel', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    const pu = String(req.body.panel_user || '').trim(), pp = String(req.body.panel_pass || '');
    if (L.hit('pl:' + u.id, 5, 3600e3) || L.hit('pli:' + ipKey(req.ip), 10, 3600e3)) return res.redirect(303, '/ucet?m=locked');
    const c = await panelCfg(); if (!selfCheck(c)) return res.redirect(303, '/ucet?m=paneloff');
    if (!panelUserOk(pu) || !pp || pp.length > 128) return res.redirect(303, '/ucet?m=panelbad');
    const r = await panelApi.checkOwn(pcConf(c), pu, pp).catch(() => null);
    if (!r || r.error) return res.redirect(303, '/ucet?m=paneloff');
    if (!r.found) return res.redirect(303, '/ucet?m=panelbad');
    if ((await pool.query(`SELECT 1 FROM acc_users WHERE lower(panel_user)=lower($1) AND id<>$2`, [pu, u.id])).rowCount) return res.redirect(303, '/ucet?m=paneltaken');
    await pool.query(`UPDATE acc_users SET panel_user=$2, panel_verified='password', panel_expiry=$3, panel_synced_at=now(), panel_status=$4 WHERE id=$1`, [u.id, pu, r.expiry, r.active ? 'active' : 'expired']);
    res.redirect(303, '/ucet?m=panelok');
  }));
  app.post('/ucet/panel-meno', wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    const pu = String(req.body.panel_user || '').trim(); if (pu && !panelUserOk(pu)) return res.redirect(303, '/ucet?m=panelbad');
    await pool.query(`UPDATE acc_users SET panel_pending=$2 WHERE id=$1 AND panel_user IS NULL`, [u.id, pu || null]);
    res.redirect(303, '/ucet?m=choice');
  }));
  // password reset via one-time link generated by admin (24 h)
  const resetUser = async (t) => (await pool.query(`SELECT id,username FROM acc_users WHERE reset_hash=$1 AND reset_exp>now()`, [sha(t)])).rows[0];
  app.get('/ucet/reset/:t([A-Za-z0-9_-]{43})', wrap(async (req, res) => {
    const en = req.lang === 'en', u = await resetUser(req.params.t);
    if (!u) return pub(req, res, tx(en, 'Obnova hesla', 'Password reset'), `<h1 class="ph">${tx(en, 'Obnova hesla', 'Password reset')}</h1>${msgOf('reset', en)}`);
    await pub(req, res, tx(en, 'Obnova hesla', 'Password reset'), `<h1 class="ph">🔐 ${tx(en, 'Nové heslo pre', 'New password for')} ${esc(u.username)}</h1>${msg(req)}<form method="post" action="/ucet/reset/${esc(req.params.t)}" class="card accf">${csrfField(req, res)}
<label for="p">${tx(en, 'Nové heslo', 'New password')}</label><input id="p" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password"><label for="p2">${tx(en, 'Znova', 'Repeat')}</label><input id="p2" name="password2" type="password" required minlength="8" maxlength="72" autocomplete="new-password"><button class="b">${tx(en, 'Nastaviť heslo', 'Set password')}</button></form>`);
  }));
  app.post('/ucet/reset/:t([A-Za-z0-9_-]{43})', wrap(async (req, res) => {
    const back = (m) => res.redirect(303, `/ucet/reset/${req.params.t}?m=${m}`);
    if (!csrfOk(req)) return back('csrf');
    if (L.hit('rs:' + ipKey(req.ip), 10, 3600e3)) return back('locked');
    const u = await resetUser(req.params.t); if (!u) return res.redirect(303, '/prihlasenie?m=reset');
    const pw = String(req.body.password || '');
    if (pw.length < 8 || Buffer.byteLength(pw) > 72 || pw.toLowerCase() === u.username) return back('pw');
    if (pw !== String(req.body.password2 || '')) return back('pw2');
    await pool.query(`UPDATE acc_users SET pw_hash=$2, reset_hash=NULL, reset_exp=NULL, failed=0, locked_until=NULL WHERE id=$1`, [u.id, await bcrypt.hash(pw, 12)]);
    await pool.query(`DELETE FROM acc_sessions WHERE user_id=$1`, [u.id]);
    res.redirect(303, '/prihlasenie?m=resetok');
  }));

  // ---------- public subscription check (password entered by the customer is never stored/logged) ----------
  function statusCard(r, en) {
    const kind = LINES.statusKind(r);
    const lab = { active: ['Aktívne', 'Active'], expired: ['Vypršané', 'Expired'], disabled: ['Vypnuté', 'Disabled'], banned: ['Zablokované', 'Banned'], unknown: ['Neznámy stav', 'Unknown status'] };
    const cls = kind === 'active' ? 'ok' : (kind === 'disabled' ? 'warn' : 'bad');
    const [sk, eng] = lab[kind] || lab.unknown;
    const unlimited = !r.expiry || r.expiry >= PANEL.UNLIMITED;
    const until = unlimited ? tx(en, 'bez obmedzenia', 'unlimited') : LINES.fmtDateTime(r.expiry);
    const known = r.source === 'known' ? ` <span class="hint">(${tx(en, 'posledný známy dátum', 'last known date')})</span>` : '';
    const days = unlimited ? null : LINES.daysLeft(r.expiry);
    const daysTxt = days == null ? '' : `<li>${tx(en, 'Zostáva', 'Remaining')}: <b>${days} ${LINES.daysWord(days, en)}</b></li>`;
    const conn = r.connections && (r.connections.max > 0 || r.connections.active > 0)
      ? `<li>${tx(en, 'Pripojenia', 'Connections')}: <b>${r.connections.active} / ${r.connections.max} ${LINES.devicesWord(r.connections.max, en)}</b></li>` : '';
    const lead = kind === 'active' ? tx(en, 'Predplatné je aktívne.', 'Your subscription is active.')
      : kind === 'expired' ? tx(en, 'Predplatné vypršalo.', 'Your subscription has expired.')
      : kind === 'banned' ? tx(en, 'Účet je zablokovaný. Kontaktujte podporu.', 'The account is banned. Contact support.')
      : kind === 'disabled' ? tx(en, 'Účet je vypnutý. Kontaktujte podporu.', 'The account is disabled. Contact support.')
      : tx(en, 'Stav účtu sa nepodarilo určiť.', 'Account status could not be determined.');
    return `<div class="card accard"><p class="accst ${cls}"><span class="accbadge ${cls}">${esc(tx(en, sk, eng))}</span> ${lead}</p>
<ul class="accmeta"><li>${tx(en, 'Platí do', 'Valid until')}: <b>${esc(until)}</b>${known}</li>${daysTxt}${conn}</ul>
${kind !== 'active' ? `<p><a class="b" href="/platby">🔁 ${tx(en, 'Predĺžiť', 'Renew')}</a></p>` : ''}</div>`;
  }
  async function checkPage(req, res, r) {
    const en = req.lang === 'en', c = await panelCfg();
    const userOnly = canLookup(c) || (selfCheck(c) && await hasLines());
    const out = !r ? '' : r.err ? msgOf(r.err, en) : r.found ? statusCard(r, en) : msgOf('panelbad', en);
    const hint = userOnly && selfCheck(c)
      ? tx(en, 'Zadajte meno k predplatnému (z aplikácie v TV). Heslo je voliteľné – ak ho zadáte, overenie ide priamo na server. Heslo zadané tu sa nikde neukladá. Všetka komunikácia ide cez HTTPS.', 'Enter your subscription username (from the TV app). The password is optional – if you enter it, we check the server directly. A password typed here is never stored. All traffic uses HTTPS.')
      : canLookup(c)
        ? tx(en, 'Zadajte meno k predplatnému. Všetka komunikácia ide cez HTTPS.', 'Enter your subscription username. All traffic uses HTTPS.')
        : tx(en, 'Zadajte meno a heslo k predplatnému (z aplikácie v TV). Heslo sa nikde neukladá – slúži len na overenie, že predplatné je vaše.', 'Enter your subscription username and password (from the TV app). The password is never stored – it only proves the subscription is yours.');
    const needPw = selfCheck(c) && !userOnly;
    await pub(req, res, tx(en, 'Kontrola platnosti predplatného', 'Subscription validity check'), `<h1 class="ph">🔎 ${tx(en, 'Kontrola platnosti predplatného', 'Subscription validity check')}</h1>${out}
${`<form method="post" action="/overit-predplatne" class="card accf">${csrfField(req, res)}<input type="hidden" name="t" value="${esc(formTok())}"><div class="hp" aria-hidden="true"><label>Web</label><input name="web" tabindex="-1" autocomplete="off"></div>
<p class="hint">${hint}</p>
<label for="cu">${tx(en, 'Meno', 'Username')}</label><input id="cu" name="u" required maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false">
<label for="cp">${tx(en, 'Heslo', 'Password')}${needPw ? '' : ' (' + tx(en, 'voliteľné', 'optional') + ')'}</label><input id="cp" name="p" type="password"${needPw ? ' required' : ''} maxlength="128" autocomplete="off">
<button class="b">${tx(en, 'Overiť', 'Check')}</button></form>`}`);
  }
  app.get('/overit-predplatne', wrap(async (req, res) => checkPage(req, res, null)));
  app.post('/overit-predplatne', wrap(async (req, res) => {
    const fail = (k) => checkPage(req, res, { err: k });
    if (!csrfOk(req) || req.body.web || !formTokOk(req.body.t, 1500)) return fail('csrf');
    const ip = ipKey(req.ip), pu = String(req.body.u || '').trim(), pp = String(req.body.p || '');
    if (L.hit('ck:' + ip, 5, 10 * 60e3) || L.hit('ckd:' + ip, 30, 86400e3) || L.hit('ckg', 300, 3600e3)) return fail('locked');
    if (!panelUserOk(pu) || (pp && pp.length > 128)) return fail('panelbad');
    if (L.hit('cku:' + pu.toLowerCase(), 5, 3600e3)) return fail('locked');
    const c = await panelCfg();
    let r;
    if (pp && selfCheck(c)) r = await panelApi.checkOwn(pcConf(c), pu, pp, hmac('chk:' + pu.toLowerCase() + '\n' + pp)).catch(() => null);
    else if (!pp) {
      if (selfCheck(c)) {
        const stored = await linePass(pu);
        if (stored) r = await panelApi.checkOwn(pcConf(c), pu, stored, hmac('chkline:' + pu.toLowerCase())).catch(() => null);
      }
      if (!r && canLookup(c)) r = await panelApi.lookup(pcConf(c), pu).catch(() => null);
      else if (!r && selfCheck(c)) return fail('panelbad');
    }
    if (!r || r.error || !r.found) {
      const rec = await softwareByName(pu);
      if (rec && rec.until_at) {
        const exp = new Date(rec.until_at);
        return checkPage(req, res, { found: true, active: exp > new Date(), expiry: exp, status: exp > new Date() ? 'Active' : 'Expired', source: 'known' });
      }
    }
    if (!r || r.error) return fail('paneloff');
    const view = panelApi.publicView ? panelApi.publicView(r) : { found: r.found, active: r.active, expiry: r.expiry, status: r.status, connections: r.connections };
    return checkPage(req, res, view);
  }));

  // ---------- bonus info for checkout (/platby) + pricing ----------
  app.get('/api/ucet-bonus', wrap(async (req, res) => {
    noStore(res); const u = await fromReq(req); if (!u) return res.json({ logged: false });
    const bi = await bonusInfo(u), plans = await plansList(), en = req.lang === 'en';
    const dev = !!(bi && bi.device && u.aff_choice === 'device');
    let softwareUsers = [];
    try {
      const F = require('./pay/src/fulfill');
      const all = (global.__payOrders && global.__payOrders.load) ? global.__payOrders.load() : {};
      const rows = F.listAccountOrders(all, u, req);
      const set = new Set();
      if (u.panel_user) set.add(u.panel_user);
      if (u.panel_pending) set.add(u.panel_pending);
      for (const r of rows) for (const s of (r.slots || (r.username ? [{ username: r.username }] : []))) if (s.username) set.add(s.username);
      softwareUsers = [...set];
    } catch { /* */ }
    res.json({ logged: true, username: u.username, email: u.email || '', active: bi ? bi.active : 0, device: dev, softwareUsers,
      plans: Object.fromEntries(plans.map((p) => { const r = bi ? bi.reward(+p.period || 1) : { bonus: 0, device: false }; return [p.id, { months: +p.period || 1, bonus: r.bonus, device: r.device, label: r.device ? tx(en, '+ druhé zariadenie zadarmo', '+ second device free') : r.bonus ? `+${moLabel(r.bonus, en)} ${tx(en, 'zadarmo', 'free')}` : '' }]; })) });
  }));
  ctx.accBonusForReq = async (req) => { const u = await fromReq(req); if (!u) return null; const bi = await bonusInfo(u); if (!bi) return null; return (m) => { const r = bi.reward(+m || 1); return r.device ? tx(req.lang === 'en', '+ druhé zariadenie zadarmo', '+ second device free') : r.bonus ? `+${moLabel(r.bonus, req.lang === 'en')} ${tx(req.lang === 'en', 'zadarmo', 'free')}` : ''; }; };
  // public, non-secret facts for the AI customer assistant (sitekb.js) – no panel URL/credentials
  ctx.accKbInfo = async () => { const c = await panelCfg(); return { on: await accOn(), panel: !!selfCheck(c), panelLinked: panelReady(c), mail: smtpOn(), packages: await packages() }; };
  ctx.accNavItem = (req) => { const en = req.lang === 'en'; return cookies(req)[C_SESS] ? ['/ucet', '👤', tx(en, 'Môj účet', 'My account')] : ['/prihlasenie', '🔑', tx(en, 'Prihlásenie / Moja objednávka', 'Log in / My order')]; };

  // ================= admin =================
  const AB = '/admin/zakaznici', PB = '/admin/predplatne-server';
  const nav = `<p class="row"><a class="btnl sm" href="/admin">← Admin</a><a class="btnl sm" href="${AB}">👥 Zákazníci</a><a class="btnl sm" href="${AB}/ledger">📒 Bonusy (ledger)</a><a class="btnl sm" href="${AB}/nastavenia">🤝 Affiliate nastavenia</a><a class="btnl sm" href="${PB}">🖥️ Server predplatného</a></p>`;
  const apage = (t, b) => page(t, nav + b, 'a adm');
  const AM = { ok: 'Uložené.', bad: 'Neplatné údaje.', del: 'Účet zmazaný.', synced: 'Synchronizované.', syncfail: 'Synchronizácia zlyhala (server nenastavený, nedostupný alebo jeho typ nevie vyhľadať používateľa bez hesla).', tiers: 'Neplatná tabuľka úrovní (čísla 0–120, počty musia byť rôzne).', taken: 'Toto meno k predplatnému už má iný účet.', limit: 'Príliš veľa testov – počkajte pár minút.', lineok: 'Účet do zoznamu pridaný.', linedel: 'Účet zo zoznamu odstránený.', linebad: 'Neplatné meno alebo heslo k predplatnému.', bulkok: 'Zoznam účtov uložený.', syncch: 'Synchronizácia kanálov a programu spustená.', syncchfail: 'Synchronizácia kanálov zlyhala – skontrolujte M3U / XMLTV URL alebo prihlasovacie údaje servera.' };
  const amsg = (req) => (AM[req.query.m] ? `<div class="msg${['ok', 'del', 'synced', 'lineok', 'linedel', 'bulkok', 'syncch'].includes(req.query.m) ? '' : ' err'}">${esc(AM[req.query.m])}</div>` : '');
  admin.get('/zakaznici', needAuth, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 64);
    const r = await pool.query(`SELECT u.id,u.username,u.disabled,u.panel_user,u.panel_synced_at,u.ref_flag,u.ref_blocked,u.created_at, ${ACT('u.')} AS eff, ru.username AS ref_name,
      (SELECT count(*) FROM acc_users x WHERE x.referrer_id=u.id)::int AS refs,
      (SELECT count(*) FROM acc_users x WHERE x.referrer_id=u.id AND NOT x.disabled AND NOT x.ref_blocked AND ${ACT('x.')} > now())::int AS refs_active,
      (SELECT COALESCE(sum(bonus_months),0) FROM acc_ledger l WHERE l.user_id=u.id AND l.kind='bonus')::int AS earned
      FROM acc_users u LEFT JOIN acc_users ru ON ru.id=u.referrer_id
      WHERE $1='' OR strpos(u.username,$1)>0 OR strpos(lower(COALESCE(u.panel_user,'')),$1)>0 OR strpos(lower(COALESCE(u.email,'')),$1)>0 OR u.ref_code=$1
      ORDER BY u.id DESC LIMIT 300`, [q]);
    const now = new Date();
    const rows = r.rows.map((u) => `<tr><td><a href="${AB}/${u.id}"><b>${esc(u.username)}</b></a>${u.disabled ? ' 🚫' : ''}</td><td>${u.eff ? `${new Date(u.eff) > now ? '✅' : '⛔'} ${fmtDate(u.eff)}` : '–'}</td><td>${u.panel_user ? esc(u.panel_user) + (u.panel_synced_at ? `<br><span class="hint">${esc(fmtDT(u.panel_synced_at))}</span>` : '') : '–'}</td><td>${u.ref_name ? esc(u.ref_name) : '–'}${u.ref_flag ? ` <span class="hint">⚠️ ${esc(u.ref_flag)}${u.ref_blocked ? ' (blok.)' : ''}</span>` : ''}</td><td>${u.refs_active} / ${u.refs}</td><td>${u.earned ? '+' + u.earned + ' m' : '–'}</td><td>${fmtDate(u.created_at)}</td></tr>`).join('');
    res.send(apage('Zákazníci', `<h1>👥 Zákazníci (${r.rowCount})</h1>${amsg(req)}${smtpWarn()}<form method="get" action="${AB}" class="row"><input name="q" value="${esc(q)}" placeholder="Hľadať meno / predplatné / e-mail / kód" maxlength="64"><button class="sm">🔎 Hľadať</button></form>
<div class="tblw"><table class="tbl"><thead><tr><th>Účet</th><th>Predplatné do</th><th>Meno v paneli / sync</th><th>Odporučil</th><th>Odporučení akt./spolu</th><th>Získaný bonus</th><th>Registrácia</th></tr></thead><tbody>${rows || '<tr><td colspan="7">Zatiaľ žiadni zákazníci.</td></tr>'}</tbody></table></div>`));
  }));
  admin.get('/zakaznici/ledger', needAuth, wrap(async (req, res) => {
    const r = await pool.query(`SELECT l.*, u.username FROM acc_ledger l LEFT JOIN acc_users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 500`);
    res.send(apage('Bonusy – ledger', `<h1>📒 Bonusy (ledger)</h1><div class="tblw"><table class="tbl"><thead><tr><th>Kedy</th><th>Účet</th><th>Typ</th><th>Objednávka</th><th>Balík</th><th>Bonus</th><th>Aktívni odp.</th><th>Úroveň</th><th>Poznámka</th></tr></thead><tbody>${r.rows.map((l) => `<tr><td>${esc(fmtDT(l.created_at))}</td><td>${l.username ? `<a href="${AB}/${l.user_id}">${esc(l.username)}</a>` : '#' + l.user_id}</td><td>${esc(l.kind === 'bonus' ? 'bonus' : l.kind === 'device' ? '2. zariadenie' : 'ručne')}</td><td>${l.order_id ? `<code>${esc(l.order_id)}</code>` : '–'}</td><td>${l.package_months ? l.package_months + ' m' : '–'}</td><td>${l.bonus_months > 0 ? '+' : ''}${l.bonus_months} m</td><td>${l.active_count}</td><td>${l.kind === 'bonus' || l.kind === 'device' ? '≥' + l.tier_min : '–'}</td><td>${esc(l.note)}</td></tr>`).join('') || '<tr><td colspan="9">Zatiaľ nič.</td></tr>'}</tbody></table></div>`));
  }));
  // Affiliate tier editor: rows = threshold of ACTIVE referred people, columns = every package from Cenník (+ defaults),
  // explicit values (0 = none, no inheritance), per tier+package "2nd device free"; live preview in /static/affadm.js (CSP-safe).
  const AFF_V = (() => { try { return crypto.createHash('sha1').update(require('fs').readFileSync(require('path').join(__dirname, 'static', 'affadm.js'))).digest('hex').slice(0, 10); } catch { return '1'; } })();
  const TERR = { min: 'Počet aktívnych musí byť celé číslo 0 – 100000.', dup: 'Každá úroveň musí mať iný počet aktívnych.', val: 'Bonus musí byť celé číslo 0 – 120 mesiacov.', max: 'Najviac 20 úrovní.' };
  async function affEditor(req, res, form) {
    const s = await getSettings(), st = AFF.settings(s), pk = await packages(), byM = await priceByMonths();
    const rows = form ? form.rows : AFF.materialize(st.tiers, pk);
    const flags = form ? form.flags : { acc_on: s.acc_on !== '0', aff_on: st.on, aff_block_ip: st.blockIp };
    const prices = Object.fromEntries(pk.map((m) => [m, byM.has(m) ? Math.round(byM.get(m) * 100) / 100 : null]));
    const plan = new Map((await plansList()).map((p) => [+p.period || 1, p.name])); const nm = (m) => plan.get(m) || '';
    const rowHtml = (t, i) => `<tr class="afr"><td class="afmin"><label class="sr" for="t${i}_min">Aktívnych ≥</label><input id="t${i}_min" name="t${i}_min" value="${esc(t.min)}" type="number" min="0" max="100000" step="1" inputmode="numeric" placeholder="napr. 5" aria-label="Počet aktívnych odporučených (≥)"></td>${pk.map((m) => `<td><input name="t${i}_m${m}" value="${esc(t.bonus && t.bonus[m] != null ? t.bonus[m] : 0)}" type="number" min="0" max="120" step="1" inputmode="numeric" aria-label="Bonus mesiace zadarmo – ${m} m"><label class="afdev" title="Druhé zariadenie zadarmo"><input type="checkbox" name="t${i}_d${m}" value="1"${t.devPk && t.devPk[m] ? ' checked' : ''}> 🖥️ 2. zar.</label></td>`).join('')}<td><label class="ck afdel"><input type="checkbox" name="t${i}_del" value="1"> zmazať</label><button type="button" class="g sm afrm" aria-label="Odstrániť úroveň">🗑️</button></td></tr>`;
    const body = [...rows, { min: '', bonus: {}, devPk: {} }].map(rowHtml).join('');
    res.send(apage('Affiliate nastavenia', `<h1>🤝 Affiliate – nastavenia</h1>${amsg(req)}${form && form.err ? `<div class="msg err" role="alert">${esc(form.err)}</div>` : ''}<form method="post" action="${AB}/nastavenia" class="card" id="afform">${hid(req)}
<label class="chk"><input type="checkbox" name="acc_on" value="1"${flags.acc_on ? ' checked' : ''}> Registrácia zákazníkov zapnutá</label>
<label class="chk"><input type="checkbox" name="aff_on" value="1"${flags.aff_on ? ' checked' : ''}> Affiliate bonusy zapnuté</label>
<label class="chk"><input type="checkbox" name="aff_block_ip" value="1"${flags.aff_block_ip ? ' checked' : ''}> Blokovať odporúčanie z rovnakej IP ako odporúčateľ (rovnaké zariadenie sa blokuje vždy, rovnaká IP sa inak len označí)</label>
<h2>Tabuľka úrovní</h2><p class="hint">Riadok = úroveň podľa počtu <b>AKTÍVNYCH</b> odporučených (≥) v čase, keď si odporúčateľ sám kupuje balík (0 = platí pre každého prihláseného zákazníka). Stĺpec = balík z Cenníka (nové balíky sa pridajú automaticky). Číslo = <b>bonus mesiace zadarmo</b> navyše k balíku (0 = žiadny, cena sa nemení). <b>🖥️ 2. zar.</b> = druhé zariadenie zadarmo na rovnaké obdobie: ak je bonus 0, dostane ho automaticky; ak je aj bonus, zákazník si v účte vyberie mesiace alebo 2. zariadenie. Platí najvyššia dosiahnutá úroveň – čo vidíte v riadku, to dostane (nič sa nededí).</p>
<input type="hidden" name="pk" value="${pk.join(',')}"><input type="hidden" name="rows" value="${rows.length + 1}" id="afrows">
<div class="tblw"><table class="tbl afft" id="afft" data-prices="${esc(JSON.stringify(prices))}"><thead><tr><th>Aktívnych ≥</th>${pk.map((m) => `<th>${m} m${nm(m) ? `<br><span class="hint">${esc(nm(m))}</span>` : ''}${prices[m] == null ? '<br><span class="hint">nie je v Cenníku</span>' : ''}</th>`).join('')}<th></th></tr></thead><tbody>${body}</tbody></table></div>
<p class="row"><button type="button" class="btnl sm" id="afadd">➕ Pridať úroveň</button></p>
<p class="msg err" id="aferr" hidden role="alert"></p>
<h2>Živý náhľad – čo uvidí zákazník v „Prečo sa zaregistrovať“</h2><div class="tblw" id="afprev"><p class="hint">Náhľad sa zobrazí po načítaní stránky (vyžaduje JavaScript). Po uložení ho nájdete aj verejne v Cenníku.</p></div>
<p class="row"><button id="afsave">💾 Uložiť</button></p></form>
<script src="/static/affadm.js?v=${AFF_V}" defer></script>`));
  }
  admin.get('/zakaznici/nastavenia', needAuth, wrap(async (req, res) => affEditor(req, res, null)));
  admin.post('/zakaznici/nastavenia', needAuth, adminCsrf, wrap(async (req, res) => {
    const b = req.body, allPk = await packages();
    const pk = [...new Set(String(b.pk || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 120))].slice(0, 30);
    for (const m of allPk) if (!pk.includes(m)) pk.push(m);
    const n = Math.min(60, Math.max(0, parseInt(b.rows, 10) || 0)), rows = []; let err = '';
    for (let i = 0; i < n; i++) {
      const min = String(b[`t${i}_min`] == null ? '' : b[`t${i}_min`]).trim(); if (min === '' || b[`t${i}_del`] === '1') continue;
      const bonus = {}, devPk = {};
      for (const m of pk) {
        const v = String(b[`t${i}_m${m}`] == null ? '' : b[`t${i}_m${m}`]).trim() || '0';
        if (!/^\d{1,3}$/.test(v) || +v > 120) { err = err || TERR.val; bonus[m] = v.slice(0, 6); } else bonus[m] = +v;
        if (b[`t${i}_d${m}`] === '1') devPk[m] = true;
      }
      if (!/^\d{1,6}$/.test(min) || +min > 100000) err = err || TERR.min;
      rows.push({ min: /^\d{1,6}$/.test(min) ? +min : min.slice(0, 8), bonus, devPk });
    }
    const mins = rows.map((r) => String(r.min)); if (!err && new Set(mins).size !== mins.length) err = TERR.dup;
    if (!err && rows.length > 20) err = TERR.max;
    const t = err ? null : AFF.cleanTiers(rows);
    const flags = { acc_on: b.acc_on === '1', aff_on: b.aff_on === '1', aff_block_ip: b.aff_block_ip === '1' };
    if (!t) { res.status(400); return affEditor(req, res, { rows, flags, err: err || 'Neplatná tabuľka úrovní.' }); }
    await setSettings({ acc_on: flags.acc_on ? '1' : '0', aff_on: flags.aff_on ? '1' : '0', aff_block_ip: flags.aff_block_ip ? '1' : '0', aff_tiers: JSON.stringify(t) });
    audit(req, 'affiliate_settings', `${t.length} úrovní`);
    res.redirect(303, AB + '/nastavenia?m=ok');
  }));
  admin.get('/zakaznici/:id(\\d+)', needAuth, wrap(async (req, res) => {
    const u = (await pool.query(`SELECT u.*, ru.username ref_name FROM acc_users u LEFT JOIN acc_users ru ON ru.id=u.referrer_id WHERE u.id=$1`, [+req.params.id])).rows[0];
    if (!u) return res.redirect(303, AB);
    const refs = (await pool.query(`SELECT id,username,${ACT()} eff,ref_flag,ref_blocked,disabled FROM acc_users WHERE referrer_id=$1 ORDER BY id DESC LIMIT 200`, [u.id])).rows;
    const ords = (await pool.query(`SELECT * FROM acc_orders WHERE user_id=$1 ORDER BY paid_at DESC LIMIT 50`, [u.id])).rows;
    const led = (await pool.query(`SELECT * FROM acc_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [u.id])).rows;
    const devs = (await pool.query(`SELECT * FROM acc_devices WHERE user_id=$1 ORDER BY id DESC`, [u.id])).rows;
    const eff = AFF.effectiveUntil(u), bi = await bonusInfo(u);
    const rq = String(req.query.reset || ''), reset = /^[A-Za-z0-9_-]{43}$/.test(rq) ? `<div class="msg">🔐 Odkaz na nastavenie hesla (platí 24 h, pošlite ho zákazníkovi): <code>${esc(origin(req))}/ucet/reset/${esc(rq)}</code></div>` : '';
    const act = (a, label, cls = '') => `<form method="post" action="${AB}/${u.id}/akcia" class="inl">${hid(req)}<input type="hidden" name="a" value="${a}"><button class="sm ${cls}">${label}</button></form>`;
    res.send(apage('Zákazník ' + u.username, `<h1>👤 ${esc(u.username)}${u.disabled ? ' 🚫 (vypnutý)' : ''}</h1>${amsg(req)}${reset}
<div class="card"><p>Predplatné (platí): <b>${eff ? fmtDate(eff) : '–'}</b> ${eff ? (eff > new Date() ? '✅ aktívne' : '⛔ vypršané') : ''}</p>
<p class="hint">Z objednávok: ${u.licence_until ? fmtDate(u.licence_until) : '–'} · Z panelu: ${u.panel_expiry ? fmtDate(u.panel_expiry) : '–'} (${esc(u.panel_status || 'nesynchronizované')}${u.panel_synced_at ? ', ' + esc(fmtDT(u.panel_synced_at)) : ''}) · Ručne: ${u.override_until ? fmtDate(u.override_until) : '–'}. Poradie: ručne → panel → objednávky.</p>
<p>Meno v paneli: <b>${u.panel_user ? esc(u.panel_user) : '–'}</b>${u.panel_verified ? ` (overené: ${esc(u.panel_verified === 'password' ? 'heslom zákazníka' : u.panel_verified === 'order' ? 'objednávkou' : 'adminom')})` : ''}</p>
${smtpWarn()}<p>E-mail: ${u.email ? esc(u.email) + (u.email_verified ? ' ✅' : ' (neoverený)') : '–'} · Registrácia: ${esc(fmtDT(u.created_at))} · Posledné prihlásenie: ${esc(fmtDT(u.last_login_at))}</p>
<p>Affiliate kód: <code>${esc(u.ref_code)}</code> · Odporučil: ${u.ref_name ? `<a href="${AB}/${u.referrer_id}">${esc(u.ref_name)}</a>` : '–'}${u.ref_flag ? ` · ⚠️ ${esc(u.ref_flag)}${u.ref_blocked ? ' (zablokované)' : ''}` : ''}</p>
<p>Aktívni odporučení: <b>${bi ? bi.active : '–'}</b> / ${refs.length} · úroveň: ${bi && bi.tier ? '≥' + bi.tier.min : '–'} · voľba pri najvyššej úrovni: ${u.aff_choice === 'device' ? '2. zariadenie' : 'mesiace'}</p></div>
<div class="card"><h2>Úpravy</h2>
<form method="post" action="${AB}/${u.id}/akcia" class="row">${hid(req)}<input type="hidden" name="a" value="months"><label>Pridať / odobrať mesiace licencie (napr. 1 alebo -1)</label><input name="n" inputmode="numeric" size="4" maxlength="4" required><input name="note" placeholder="Poznámka" maxlength="200"><button class="sm">Uložiť</button></form>
<form method="post" action="${AB}/${u.id}/akcia" class="row">${hid(req)}<input type="hidden" name="a" value="override"><label>Ručne nastaviť „predplatné do“ (prázdne = zrušiť)</label><input name="d" type="date" value="${u.override_until ? new Date(u.override_until).toISOString().slice(0, 10) : ''}"><button class="sm">Uložiť</button></form>
<form method="post" action="${AB}/${u.id}/akcia" class="row">${hid(req)}<input type="hidden" name="a" value="panel"><label>Meno v paneli predplatného – potvrdené adminom (prázdne = odpojiť)</label><input name="pu" value="${esc(u.panel_user || '')}" maxlength="64"><button class="sm">Uložiť</button></form>
<p class="row">${act('sync', '🔄 Synchronizovať s panelom')}${act('reset', '🔐 Odkaz na reset hesla')}${u.disabled ? act('enable', '✅ Zapnúť účet') : act('disable', '🚫 Vypnúť účet')}${u.referrer_id ? (u.ref_blocked ? act('unblock', '🤝 Povoliť odporúčanie') : act('block', '⛔ Zablokovať odporúčanie')) : ''}</p>
<form method="post" action="${AB}/${u.id}/akcia" class="row">${hid(req)}<input type="hidden" name="a" value="delete"><label>Zmazať účet – napíšte ZMAZAT</label><input name="confirm" maxlength="10" required><button class="sm">🗑️ Zmazať</button></form></div>
${devs.length ? `<div class="card"><h2>2. zariadenia</h2>${devs.map((d) => `<form method="post" action="${AB}/${u.id}/akcia" class="row">${hid(req)}<input type="hidden" name="a" value="device"><input type="hidden" name="did" value="${d.id}"><span>${fmtDate(d.from_at)} – ${fmtDate(d.until_at)}</span><input name="pu" value="${esc(d.panel_user)}" placeholder="meno v paneli" maxlength="64"><button class="sm">Uložiť</button></form>`).join('')}</div>` : ''}
<div class="card"><h2>Odporučení (${refs.length})</h2><ul>${refs.map((x) => `<li><a href="${AB}/${x.id}">${esc(x.username)}</a> · ${x.eff ? fmtDate(x.eff) : '–'} ${x.eff && new Date(x.eff) > new Date() && !x.disabled && !x.ref_blocked ? '✅ aktívny' : '⛔'}${x.ref_flag ? ' ⚠️ ' + esc(x.ref_flag) : ''}</li>`).join('') || '<li>–</li>'}</ul></div>
<div class="card"><h2>Zaplatené objednávky</h2><ul>${ords.map((o) => `<li>${esc(fmtDT(o.paid_at))} · <code>${esc(o.order_id)}</code> · ${o.months} m · ${esc(String(o.amount))} €</li>`).join('') || '<li>–</li>'}</ul></div>
<div class="card"><h2>Ledger</h2><ul>${led.map((l) => `<li>${esc(fmtDT(l.created_at))} · ${esc(l.kind)} · ${l.bonus_months > 0 ? '+' : ''}${l.bonus_months} m${l.order_id ? ' · ' + esc(l.order_id) : ''}${l.note ? ' · ' + esc(l.note) : ''}</li>`).join('') || '<li>–</li>'}</ul></div>`));
  }));
  admin.post('/zakaznici/:id(\\d+)/akcia', needAuth, adminCsrf, wrap(async (req, res) => {
    const id = +req.params.id, a = String(req.body.a || ''), back = (m, extra = '') => res.redirect(303, `${AB}/${id}?m=${m}${extra}`);
    const u = (await pool.query(`SELECT * FROM acc_users WHERE id=$1`, [id])).rows[0]; if (!u) return res.redirect(303, AB);
    if (a === 'months') {
      const n = parseInt(req.body.n, 10); if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 120) return back('bad');
      const now = new Date(), cur = u.licence_until ? new Date(u.licence_until) : null, base = cur && (cur > now || n < 0) ? cur : now;
      await pool.query(`UPDATE acc_users SET licence_until=$2 WHERE id=$1`, [id, AFF.addMonths(base, n)]);
      await pool.query(`INSERT INTO acc_ledger (user_id,kind,bonus_months,note) VALUES ($1,'manual',$2,$3)`, [id, n, String(req.body.note || '').slice(0, 200)]);
      audit(req, 'acc_months', `${u.username} ${n}`);
    } else if (a === 'override') {
      const d = String(req.body.d || ''); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return back('bad');
      await pool.query(`UPDATE acc_users SET override_until=$2 WHERE id=$1`, [id, d ? new Date(d + 'T22:59:59Z') : null]);
      audit(req, 'acc_override', `${u.username} ${d || '-'}`);
    } else if (a === 'panel') {
      const pu = String(req.body.pu || '').trim(); if (pu && !panelUserOk(pu)) return back('bad');
      if (pu && (await pool.query(`SELECT 1 FROM acc_users WHERE lower(panel_user)=lower($1) AND id<>$2`, [pu, id])).rowCount) return back('taken');
      await pool.query(`UPDATE acc_users SET panel_user=$2, panel_verified=$3, panel_expiry=NULL, panel_synced_at=NULL, panel_status='' WHERE id=$1`, [id, pu || null, pu ? 'admin' : '']);
      if (pu) { const r = await syncUser({ ...u, panel_user: pu }); if (r && r.error) return back('syncfail'); }
    } else if (a === 'sync') { const r = await syncUser(u); return back(!r || r.error ? 'syncfail' : 'synced'); }
    else if (a === 'reset') {
      const t = crypto.randomBytes(32).toString('base64url');
      await pool.query(`UPDATE acc_users SET reset_hash=$2, reset_exp=now()+interval '24 hours' WHERE id=$1`, [id, sha(t)]);
      audit(req, 'acc_reset_link', u.username); return back('ok', '&reset=' + t);
    } else if (a === 'disable' || a === 'enable') { await pool.query(`UPDATE acc_users SET disabled=$2 WHERE id=$1`, [id, a === 'disable']); if (a === 'disable') await pool.query(`DELETE FROM acc_sessions WHERE user_id=$1`, [id]); audit(req, 'acc_' + a, u.username); }
    else if (a === 'block' || a === 'unblock') await pool.query(`UPDATE acc_users SET ref_blocked=$2 WHERE id=$1`, [id, a === 'block']);
    else if (a === 'device') { const pu = String(req.body.pu || '').trim(); if (pu && !panelUserOk(pu)) return back('bad'); await pool.query(`UPDATE acc_devices SET panel_user=$3 WHERE id=$2 AND user_id=$1`, [id, +req.body.did || 0, pu]); }
    else if (a === 'delete') { if (String(req.body.confirm || '') !== 'ZMAZAT') return back('bad'); await deleteUser(id); audit(req, 'acc_delete', u.username); return res.redirect(303, AB + '?m=del'); }
    else return back('bad');
    back('ok');
  }));

  // ---------- subscription server (panel) admin ----------
  let lastTest = null;
  admin.get('/predplatne-server', needAuth, wrap(async (req, res) => {
    const c = await panelCfg(), st = (k) => (c[k] ? '<b>(uložený)</b>' : '<span class="hint">(nenastavený)</span>');
    const lines = (await pool.query('SELECT id,username,updated_at FROM acc_panel_lines ORDER BY lower(username)')).rows;
    let chRep = null; try { chRep = c.last_chsync_report ? JSON.parse(c.last_chsync_report) : null; } catch { chRep = null; }
    const t = req.query.t === '1' && lastTest && Date.now() - lastTest.at < 600e3 ? lastTest : null;
    const types = [['', 'Automaticky zistiť (odporúčané)'], ...Object.values(panelApi.ADAPTERS).map((a) => [a.id, a.label])];
    const testBox = t ? `<div class="msg${t.ok ? '' : ' err'}">${t.ok ? `✅ Rozpoznaný adaptér: <b>${esc(t.label)}</b>${t.note ? ' – ' + esc(t.note) : ''}` : `❌ Server sa nepodarilo rozpoznať (skúšané: ${esc((t.tried || []).join(', ') || '–')}). Skontrolujte adresu servera a admin meno a heslo.`}${t.lookup ? `<br>Vyhľadanie „${esc(t.lookup.u)}“: ${t.lookup.error ? esc(t.lookup.error) : t.lookup.found ? `${t.lookup.active ? '✅ aktívne' : '⛔ neaktívne'} – do ${t.lookup.expiry && t.lookup.expiry < PANEL.UNLIMITED ? esc(fmtDate(t.lookup.expiry)) : 'bez obmedzenia'}` : 'používateľ sa nenašiel'}` : ''}</div>` : '';
    res.send(apage('Server predplatného', `<h1>🖥️ Server predplatného</h1>${amsg(req)}${testBox}
<form method="post" action="${PB}" class="card">${hid(req)}<p class="hint">Pripojenie na panel ide výhradne cez adresu servera a admin meno a heslo (uložené šifrovane, AES-256-GCM, DATA_ENC_KEY). Stav a dátum expirácie predplatného sa na verejnej stránke overujú na serveri – zákazník zadá len svoje meno (heslo je voliteľné). Adresa, heslá ani odpovede panela sa do prehliadača neposielajú. Streamy sa nikdy neukladajú. Záložné M3U/XMLTV odkazy sú tiež šifrované. Prázdne pole = ponechať uložené.</p>
<label for="pu">Adresa servera</label><input id="pu" name="url" value="${esc(c.url || '')}" maxlength="300" placeholder="http://ip-alebo-domena:port" autocomplete="off" inputmode="url" spellcheck="false">
<p class="hint">HTTP aj HTTPS sú plne podporované, vrátane IP adresy a vlastného portu (napr. <code>http://1.2.3.4:25500</code>). Ak schému nevyplníte, použije sa <code>http://</code>. Použije sa presne zadaná adresa, bez prepínania na HTTPS.</p>
<label for="pn">Admin / reseller meno ${st('user')}</label><input id="pn" name="user" maxlength="200" autocomplete="off">
<label for="pp">Admin heslo ${st('pass')}</label><input id="pp" name="pass" type="password" maxlength="200" autocomplete="new-password">
<label class="chk"><input type="checkbox" name="clear" value="1"> Vymazať uložené meno a heslo</label>
<label for="pt">Typ servera</label><select id="pt" name="type">${types.map(([v, l]) => `<option value="${esc(v)}"${(c.type_set || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
<details${c.tpl ? ' open' : ''}><summary>Vlastné API (URL šablóna + JSON pole s dátumom)</summary><label for="tp">URL šablóna – {username} sa nahradí menom zákazníka</label><input id="tp" name="tpl" value="${esc(c.tpl || '')}" maxlength="400" placeholder="https://api.example.com/users/{username}">
<label for="dp">JSON pole s dátumom expirácie</label><input id="dp" name="datepath" value="${esc(c.datepath || '')}" maxlength="100" placeholder="data.exp_date"><p class="hint">Uložené meno a heslo sa pošlú ako HTTP Basic auth.</p></details>
<p class="row"><button>💾 Uložiť</button></p></form>
<form method="post" action="${PB}/test" class="card">${hid(req)}<h2>Otestovať pripojenie</h2><p class="hint">Zistí typ servera (ukáže, ktorý adaptér sedí) a voliteľne vyhľadá jedného používateľa – iba stav a expirácia.</p><label for="tu">Meno používateľa na skúšku (nepovinné)</label><input id="tu" name="u" maxlength="64" autocomplete="off"><p class="row"><button>🔌 Otestovať pripojenie</button></p></form>
<form method="post" action="${PB}/sync" class="card">${hid(req)}<h2>Synchronizácia</h2><p>Aktívny adaptér: <b>${c.type ? esc((panelApi.ADAPTERS[c.type] || {}).label || c.type) : 'zatiaľ nezistený – spustite test'}</b> · Posledná synchronizácia: ${c.last_sync ? esc(fmtDT(c.last_sync)) : '–'}</p><p class="hint">Automaticky raz denne (po 4:00). Funguje s adaptérom, ktorý vie vyhľadať používateľa cez admin meno a heslo (Xtream UI / XUI.one admin API, panel_api.php, Ministra, vlastné API). Pri čistom player_api.php sa expirácia aktualizuje, keď zákazník overí heslo, alebo podľa účtov v zozname nižšie.</p><p class="row"><button>🔄 Synchronizovať expirácie teraz</button></p></form>
<form method="post" action="${PB}/katalog" class="card" id="katalog">${hid(req)}<h2>📺 Synchronizovať kanály a program</h2>
<p class="hint">Primárne sa kanály a kategórie načítajú cez <code>player_api.php?action=get_live_categories</code> a <code>get_live_streams</code> z adresy servera a admin mena/hesla vyššie (adresa panela sa upraví automaticky). Program „Teraz / Potom“ sa ťahá na požiadanie cez <code>get_short_epg&amp;stream_id=…</code> (len pre viditeľné kanály, s krátkou cache). <b>URL streamov a heslá sa nikdy neuložia ani neodošlú do prehliadača</b> – stream_id ostáva len na serveri. M3U a XMLTV sú záloha, ak player_api zlyhá alebo nie je nastavené. Existujúce kanály ostávajú, nové sa doplnia, prázdne logá sa doplnia. Prázdne pole = ponechať uloženú adresu.</p>
<label for="m3u">Záložný M3U playlist URL ${st('m3u_url')}</label><input id="m3u" name="m3u_url" type="text" inputmode="url" maxlength="600" placeholder="http://ip-alebo-domena:port/get.php?…" autocomplete="off" spellcheck="false">
<label for="xmltv">Záložný XMLTV (celý TV program) URL ${st('xmltv_url')}</label><input id="xmltv" name="xmltv_url" type="text" inputmode="url" maxlength="600" placeholder="http://ip-alebo-domena:port/xmltv.php" autocomplete="off" spellcheck="false">
<label class="chk"><input type="checkbox" name="clear_urls" value="1"> Vymazať uložené M3U a XMLTV odkazy</label>
<p class="row"><button name="save" value="1">💾 Uložiť odkazy</button><button name="sync" value="1">🔄 Synchronizovať kanály a program</button></p>
${chRep ? `<p class="hint">Posledná synchronizácia: ${esc(chRep.at ? fmtDT(chRep.at) : (c.last_chsync ? fmtDT(c.last_chsync) : '–'))}${chRep.err ? ' · ⚠ ' + esc(String(chRep.err).slice(0, 200)) : ` · zdroj ${esc(chRep.sourceLabel || chRep.source || '–')} · kanálov ${chRep.channels || 0} (nové ${chRep.added || 0}, doplnené ${chRep.updated || 0})${chRep.mapped != null ? ' · spárované s programom: ' + chRep.mapped : ''}${chRep.epg ? (chRep.epg.ok ? ' · XMLTV uložený' : ' · XMLTV: ' + esc(chRep.epg.err || 'chyba')) : ''}`}</p>` : (c.last_chsync ? `<p class="hint">Posledná synchronizácia: ${esc(fmtDT(c.last_chsync))}</p>` : '')}</form>
<div class="card" id="linky"><h2>👤 Účty na overenie podľa mena</h2>
<p class="hint">Uložte dvojice meno + heslo k predplatnému (šifrovane). Zákazník na stránke Overiť predplatné zadá len meno a stav sa overí na pozadí. Heslá sa v admine nikdy znova nezobrazia. Hromadne: jeden účet na riadok v tvare <code>meno:heslo</code> (alebo bodkočiarka / medzera).</p>
<form method="post" action="${PB}/linky" class="row">${hid(req)}<label for="lu">Meno</label><input id="lu" name="u" maxlength="64" required autocomplete="off" autocapitalize="none"><label for="lp">Heslo</label><input id="lp" name="p" type="password" maxlength="128" required autocomplete="new-password"><button class="sm">➕ Pridať</button></form>
<form method="post" action="${PB}/linky/bulk">${hid(req)}<label for="lb">Hromadne vložiť</label><textarea id="lb" name="bulk" rows="6" maxlength="20000" placeholder="jan:heslo1&#10;eva:heslo2"></textarea><p class="row"><button class="sm">💾 Uložiť zoznam</button></p></form>
<div class="tblw"><table class="tbl"><thead><tr><th>Meno</th><th>Aktualizované</th><th></th></tr></thead><tbody>${lines.map((x) => `<tr><td><code>${esc(x.username)}</code></td><td>${esc(fmtDT(x.updated_at))}</td><td><form method="post" action="${PB}/linky/${x.id}/delete" class="inl">${hid(req)}<button class="sm">🗑️ Odstrániť</button></form></td></tr>`).join('') || '<tr><td colspan="3">Zatiaľ žiadne účty. Bez nich (a keď panel nevie vyhľadať účet podľa mena) musí zákazník zadať aj heslo.</td></tr>'}</tbody></table></div></div>`));
  }));
  admin.post('/predplatne-server', needAuth, adminCsrf, wrap(async (req, res) => {
    const b = req.body; let url = String(b.url || '').trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;
    const saved = url ? PANEL.normBase(url) : null;
    if (url && !saved) return res.redirect(303, PB + '?m=bad');
    const prev = await panelCfg();
    await setPanel('url', saved);
    await setPanel('key', null);
    if (b.clear === '1') { await setPanel('user', null); await setPanel('pass', null); }
    else for (const k of ['user', 'pass']) { const v = String(b[k] || ''); if (v) await setPanel(k, v.slice(0, 300)); }
    const ty = String(b.type || ''), okTy = ty && panelApi.ADAPTERS[ty];
    await setPanel('type_set', okTy ? ty : null);
    if (okTy) await setPanel('type', ty); else if (PANEL.normBase(url) !== prev.base) await setPanel('type', null);
    const tpl = String(b.tpl || '').trim(); await setPanel('tpl', tpl && /^https?:\/\//i.test(tpl) && tpl.includes('{username}') ? tpl.slice(0, 400) : null);
    const dp = String(b.datepath || '').trim(); await setPanel('datepath', /^[A-Za-z0-9_.]{1,100}$/.test(dp) ? dp : null);
    audit(req, 'panel_cfg', 'updated');
    res.redirect(303, PB + '?m=ok');
  }));
  admin.post('/predplatne-server/test', needAuth, adminCsrf, wrap(async (req, res) => {
    if (L.hit('ptest', 20, 600e3)) return res.redirect(303, PB + '?m=limit');
    const c = await panelCfg(); if (!c.base) return res.redirect(303, PB + '?m=bad');
    const cc = pcConf(c);
    let d;
    if (c.type_set) { const a = panelApi.ADAPTERS[c.type_set]; const r = await a.detect(cc).catch(() => null); d = { type: c.type_set, label: a.label, note: r ? r.note : 'ručne zvolený typ neodpovedá', ok: !!r, canLookup: !!a.lookup, tried: [c.type_set] }; }
    else { d = await panelApi.detect(cc); d.ok = !!d.type; }
    if (d.ok) await setPanel('type', d.type);
    const out = { at: Date.now(), ok: d.ok, label: d.label, note: d.note, tried: d.tried };
    const tu = String(req.body.u || '').trim();
    if (tu && d.ok) {
      if (!panelUserOk(tu)) out.lookup = { u: tu.slice(0, 64), error: 'neplatné meno' };
      else if (!d.canLookup) out.lookup = { u: tu, error: 'tento typ servera nevie vyhľadať používateľa len podľa mena (uložte účty do zoznamu nižšie, alebo nechajte zákazníkov overiť sa aj heslom)' };
      else { const r = await panelApi.ADAPTERS[d.type].lookup({ ...cc, type: d.type }, tu).catch(() => ({ error: 'server neodpovedal' })); out.lookup = { u: tu, ...r }; }
    }
    lastTest = out;
    res.redirect(303, PB + '?t=1');
  }));
  admin.post('/predplatne-server/sync', needAuth, adminCsrf, wrap(async (req, res) => {
    const r = await syncAll(); res.redirect(303, PB + '?m=' + (r.ok ? 'synced' : 'syncfail'));
  }));
  function catalogUrlOk(u) {
    if (!u) return '';
    try { EPGFETCH.checkUrl(u); } catch (e) { return e.message || 'bad'; }
    return '';
  }
  function withHttp(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    return 'http://' + s;
  }
  async function saveCatalogUrls(b) {
    if (b.clear_urls === '1') { await setPanel('m3u_url', null); await setPanel('xmltv_url', null); return ''; }
    for (const k of ['m3u_url', 'xmltv_url']) {
      const v = PANEL.tidyFullUrl(String(b[k] || '').trim());
      if (!v) continue;
      const err = catalogUrlOk(v); if (err) return err;
      await setPanel(k, v.slice(0, 600));
    }
    return '';
  }
  function sourceLabel(out) {
    if (out.source === 'player_api') return 'player_api.php (JSON)';
    if (out.source === 'm3u') return 'M3U (záloha' + (out.fallback ? ', player_api: ' + String(out.fallback).slice(0, 80) : '') + ')';
    return out.source || '–';
  }
  async function syncCatalog() {
    const c = await panelCfg();
    const out = { at: new Date().toISOString(), channels: 0, added: 0, updated: 0, mapped: 0, source: null, sourceLabel: '', epg: null, err: null, fallback: null };
    let items = [];
    try {
      if (c.base && c.user && c.pass) {
        try {
          const p = await panelApi.liveCatalog(pcConf(c));
          if (!p.error && p.items && p.items.length) {
            out.source = 'player_api';
            items = p.items;
          } else {
            out.fallback = p.error || 'prázdny zoznam';
          }
        } catch (e) { out.fallback = String(e && e.message || e).slice(0, 120); }
      } else {
        out.fallback = 'player_api nie je nastavený (chýba adresa servera alebo meno/heslo)';
      }
      if (!items.length && c.m3u_url) {
        out.source = 'm3u';
        const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 75e3);
        try {
          const got = await EPGFETCH.openPlaylist(PANEL.tidyFullUrl(c.m3u_url) || c.m3u_url, { signal: ac.signal, maxBytes: 8 * 1024 * 1024 });
          const p = await CHS.parseM3u(got.text);
          items = p.items;
          out.skipped = p.skipped;
        } finally { clearTimeout(tm); ac.abort(); }
      }
      if (!items.length) {
        out.err = out.fallback ? ('player_api: ' + out.fallback + (c.m3u_url ? ' · M3U záloha tiež zlyhala alebo je prázdna' : ' · záložný M3U nie je nastavený')) : 'Chýba adresa servera s menom a heslom, alebo záložný M3U odkaz.';
        out.sourceLabel = sourceLabel(out);
        await setPanel('last_chsync_report', JSON.stringify(out));
        return out;
      }
      out.sourceLabel = sourceLabel(out);
      out.channels = items.length;
      out.sourceLabel = sourceLabel(out);
      if (typeof ctx.tvchUpsertMeta === 'function') {
        const r = await ctx.tvchUpsertMeta(items);
        out.added = r.added; out.updated = r.updated;
        if (c.xmltv_url && typeof ctx.epgUpsertSyncSource === 'function') {
          out.epg = await ctx.epgUpsertSyncSource(PANEL.tidyFullUrl(c.xmltv_url) || c.xmltv_url);
        }
        if (r.pairs && r.pairs.length && typeof ctx.epgApplyTvg === 'function') {
          out.mapped = await ctx.epgApplyTvg(r.pairs);
        }
      }
      await setPanel('last_chsync', out.at);
      await setPanel('last_chsync_report', JSON.stringify(out));
    } catch (e) {
      out.err = String(e && e.message || e).slice(0, 200);
      await setPanel('last_chsync_report', JSON.stringify(out));
    }
    return out;
  }
  admin.post('/predplatne-server/katalog', needAuth, adminCsrf, wrap(async (req, res) => {
    if (L.hit('chsync', 8, 600e3)) return res.redirect(303, PB + '?m=limit#katalog');
    const err = await saveCatalogUrls(req.body);
    if (err) return res.redirect(303, PB + '?m=bad#katalog');
    if (req.body.sync !== '1') return res.redirect(303, PB + '?m=ok#katalog');
    const r = await syncCatalog();
    res.redirect(303, PB + '?m=' + (r.err ? 'syncchfail' : 'syncch') + '#katalog');
  }));
  admin.post('/predplatne-server/linky', needAuth, adminCsrf, wrap(async (req, res) => {
    const u = String(req.body.u || '').trim(), pw = String(req.body.p || '');
    if (!panelUserOk(u) || !pw || pw.length > 128) return res.redirect(303, PB + '?m=linebad#linky');
    await saveLine(u, pw);
    audit(req, 'panel_line', u);
    res.redirect(303, PB + '?m=lineok#linky');
  }));
  admin.post('/predplatne-server/linky/bulk', needAuth, adminCsrf, wrap(async (req, res) => {
    const parsed = LINES.parseBulk(String(req.body.bulk || ''), panelUserOk);
    if (!parsed.items.length) return res.redirect(303, PB + '?m=linebad#linky');
    for (const x of parsed.items) await saveLine(x.user, x.pass);
    audit(req, 'panel_lines_bulk', String(parsed.items.length));
    res.redirect(303, PB + '?m=bulkok#linky');
  }));
  admin.post('/predplatne-server/linky/:id(\\d+)/delete', needAuth, adminCsrf, wrap(async (req, res) => {
    const r = (await pool.query('DELETE FROM acc_panel_lines WHERE id=$1 RETURNING username', [+req.params.id])).rows[0];
    if (r) audit(req, 'panel_line_del', r.username);
    res.redirect(303, PB + '?m=linedel#linky');
  }));

  ctx.accountsAdminCard = () => `<div class="card"><h2>👥 Zákazníci a affiliate</h2><p class="row"><a class="btnl sm" href="${AB}">👥 Zákazníci</a><a class="btnl sm" href="${AB}/nastavenia">🤝 Affiliate nastavenia</a><a class="btnl sm" href="${AB}/ledger">📒 Bonusy</a><a class="btnl sm" href="${PB}">🖥️ Server predplatného</a><a class="btnl sm" href="/admin/xpub">🔑 xpub – automatické adresy</a></p></div>`;
  ctx.accSweep = sweep;
  ctx.accSyncAll = syncAll;

  const shortApi = require('./shortepg').create({
    getConf: async () => pcConf(await panelCfg()),
    fetchShort: (c, sid) => panelApi.shortEpg(c, sid),
    streamIdsFor: (ids) => (ctx.tvchStreamIds ? ctx.tvchStreamIds(ids) : {}),
    appendLog: (m) => { try { console.warn(m); } catch { /* */ } },
  });
  ctx.shortEpgReady = async () => {
    const c = await panelCfg();
    if (!shortApi.ready(pcConf(c))) return false;
    try { return ctx.tvchHasPanelStreams ? await ctx.tvchHasPanelStreams() : true; } catch { return true; }
  };
  const shortHits = new Map();
  app.get('/api/tv/short-epg', wrap(async (req, res) => {
    const ip = String(req.ip || ''), now = Date.now();
    const q = (shortHits.get(ip) || []).filter((t) => now - t < 60e3); q.push(now); shortHits.set(ip, q);
    if (shortHits.size > 4000) shortHits.clear();
    if (q.length > 40) return res.status(429).set('Retry-After', '60').json({ error: 'rate_limited' });
    const ids = String(req.query.ids || '').split(/[,\s]+/).map((x) => +x).filter((n) => Number.isInteger(n) && n > 0);
    const body = await shortApi.forCatalogIds(ids);
    const dump = JSON.stringify(body);
    if (/player_api|get\.php|direct_source|username=|password=/i.test(dump)) {
      return res.status(500).json({ t: Math.round(Date.now() / 1000), c: {} });
    }
    res.set({ 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' });
    res.json(body);
  }));

  return ctx;
}
module.exports = { install, refMiddleware, fmtDate, REF_RE, USER_RE };
