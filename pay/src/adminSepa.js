'use strict';

/**
 * Private SEPA admin dashboard (Ryan only).
 * Backup when the customer cannot upload the payment screenshot on /bank-sepa-pay.
 * Login: ADMIN_EMAIL + ADMIN_PASSWORD (or SEPA_ADMIN_*). Session cookie signed with
 * ADMIN_SESSION_SECRET / SESSION_SECRET.
 */

const crypto = require('crypto');
const electrocoin = require('./electrocoin');
const sepaManual = require('./sepaManual');

const COOKIE_NAME = 'sepa_admin_sess';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 12;

/** @type {Map<string, { count: number, resetAt: number }>} */
const loginAttempts = new Map();

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function adminEmail() {
  return env('ADMIN_EMAIL') || env('SEPA_ADMIN_EMAIL');
}

function adminPassword() {
  return env('ADMIN_PASSWORD') || env('SEPA_ADMIN_PASSWORD');
}

function sessionSecret() {
  return (
    env('ADMIN_SESSION_SECRET') ||
    env('SESSION_SECRET') ||
    env('SEPA_ADMIN_SESSION_SECRET')
  );
}

function isConfigured() {
  return Boolean(adminEmail() && adminPassword() && sessionSecret());
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseCookies(req) {
  const out = Object.create(null);
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function signPayload(payloadB64) {
  return crypto
    .createHmac('sha256', sessionSecret())
    .update(payloadB64)
    .digest('base64url');
}

function encodeSession(data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}

function decodeSession(token) {
  if (!token || !sessionSecret()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = signPayload(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.email || !data.exp || Date.now() > Number(data.exp)) return null;
    return data;
  } catch {
    return null;
  }
}

function setSessionCookie(res, data) {
  const token = encodeSession(data);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function getSession(req) {
  const cookies = parseCookies(req);
  return decodeSession(cookies[COOKIE_NAME]);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown'; // trust proxy=1 → real client IP, not spoofable XFF[0]
}

function checkLoginRate(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still compare to avoid leaking length via early return timing of crypto
    crypto.timingSafeEqual(ba.length ? ba : Buffer.alloc(1), Buffer.alloc(ba.length || 1));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function credentialsMatch(email, password) {
  const wantEmail = adminEmail().toLowerCase();
  const wantPass = adminPassword();
  if (!wantEmail || !wantPass) return false;
  const emailOk = timingSafeEqualStr(String(email || '').trim().toLowerCase(), wantEmail);
  const passOk = timingSafeEqualStr(String(password || ''), wantPass);
  return emailOk && passOk;
}

function layout({ title, body, lang = 'sk', userEmail = null }) {
  const nav = userEmail
    ? `<nav class="top"><a href="/admin">← Admin</a>
       <a href="/admin/platby/sepa">SEPA objednávky</a>
       <a href="/admin/platby/sepa-chain">Reťaz SEPA botov</a>
       <a href="/admin/platby/kategorie">🗂️ Kategórie</a>
       <a href="/admin/platby/sumy">💶 Podľa sumy</a>
       <a href="/admin/platby/guides">📖 Návody platieb</a>
       <a href="/admin/platby/azteco">₿ Azteco (zákazníci)</a>
       <a href="/admin/platobne-metody">💳 Spôsoby platby</a>
       <a href="/admin/penazenky">👛 Peňaženky</a>
       <a href="/admin/odkazy-podla-sumy">🔗 Odkazy podľa sumy</a>
       </nav>`
    : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#0b1220;--card:#121a2b;--line:#243044;--text:#e8eef9;--muted:#94a3b8;--accent:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:980px;margin:0 auto;padding:1.25rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.25rem;margin-bottom:1rem}
h1{font-size:1.35rem;margin:0 0 .75rem}h2{font-size:1.05rem;margin:1rem 0 .5rem}
.muted{color:var(--muted);font-size:.9rem}
.top{display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem;padding:.75rem 0;border-bottom:1px solid var(--line)}
.who{color:var(--muted);font-size:.85rem;margin-right:auto}
label{display:block;font-size:.85rem;color:var(--muted);margin:.6rem 0 .25rem}
input[type=email],input[type=password],input[type=file],input[type=text],input[type=number],input[type=url],input:not([type]),select,textarea{width:100%;max-width:100%;font-size:16px;padding:.65rem .75rem;border-radius:10px;border:1px solid var(--line);background:#0d1524;color:var(--text)}
button,.btn{display:inline-block;border:0;border-radius:10px;padding:.65rem 1rem;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
button.secondary{background:#334155}
button.linkish{background:transparent;color:var(--accent);padding:0;font-weight:500}
button:disabled{opacity:.5;cursor:not-allowed}
.err{background:#3f1d1d;border:1px solid #7f1d1d;color:#fecaca;padding:.75rem;border-radius:10px;margin:.75rem 0}
.ok{background:#14532d;border:1px solid #166534;color:#bbf7d0;padding:.75rem;border-radius:10px;margin:.75rem 0}
.warnbox{background:#422006;border:1px solid #92400e;color:#fde68a;padding:.75rem;border-radius:10px;margin:.75rem 0}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.55rem .4rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.03em}
.badge{display:inline-block;padding:.15rem .45rem;border-radius:999px;font-size:.72rem;font-weight:600;background:#1e293b;color:#cbd5e1}
.badge.ok{background:#14532d;color:#bbf7d0}.badge.warn{background:#78350f;color:#fde68a}.badge.bad{background:#7f1d1d;color:#fecaca}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;word-break:break-all}
img{max-width:100%;height:auto}code{overflow-wrap:anywhere}
.tablewrap{overflow-x:auto}
@media(max-width:768px){.wrap{padding:.75rem}.card{padding:1rem}button,.btn{min-height:44px}button.linkish{min-height:44px;padding:0 .25rem}.top a{display:inline-flex;align-items:center;min-height:44px;white-space:nowrap}.top{flex-wrap:nowrap;overflow-x:auto;gap:.9rem;-webkit-overflow-scrolling:touch}.who{flex:0 0 auto}
 table.stack,table.stack thead,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}table.stack thead,table.stack tr.head{display:none}
 table.stack tr{border:1px solid var(--line);border-radius:12px;padding:.5rem .75rem;margin:0 0 .65rem;background:#0d1524}
 table.stack td{border:0;padding:.3rem 0;display:flex;gap:.75rem;justify-content:space-between;align-items:flex-start;overflow-wrap:anywhere}
 table.stack td::before{content:attr(data-label);color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.03em;flex:0 0 auto}
 table.stack td:not([data-label])::before,table.stack td[data-label=""]::before{display:none}}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1524;border:1px solid var(--line);border-radius:10px;padding:.75rem;font-size:.8rem;color:#cbd5e1}
</style>
</head>
<body>
<div class="wrap">
${nav}
${body}
</div>
</body>
</html>`;
}

function loginPage({ error = null, notice = null } = {}) {
  const body = `
<div class="card" style="max-width:420px;margin:3rem auto">
  <h1>SEPA admin</h1>
  <p class="muted">Súkromná oblasť len pre Ryana. Záloha, keď zákazník nevie nahrať screenshot na /bank-sepa-pay.</p>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  ${notice ? `<div class="ok">${escapeHtml(notice)}</div>` : ''}
  ${
    isConfigured()
      ? `<form method="post" action="/admin/login" autocomplete="on">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="username"/>
    <label for="password">Heslo</label>
    <input id="password" name="password" type="password" required autocomplete="current-password"/>
    <p style="margin-top:1rem"><button type="submit">Prihlásiť sa</button></p>
  </form>`
      : `<div class="err">Admin nie je nakonfigurovaný. Nastavte ADMIN_EMAIL, ADMIN_PASSWORD a ADMIN_SESSION_SECRET (alebo SEPA_ADMIN_* / SESSION_SECRET) v .env.</div>`
  }
</div>`;
  return layout({ title: 'SEPA admin — login', body });
}

function statusBadge(status) {
  const s = String(status || '');
  let cls = '';
  if (/confirmed|paid|awaiting_confirm/.test(s)) cls = 'ok';
  else if (/failed|canceled|cancelled/.test(s)) cls = 'bad';
  else if (/awaiting|automating|uploading|screenshot/.test(s)) cls = 'warn';
  return `<span class="badge ${cls}">${escapeHtml(s || '—')}</span>`;
}

function listSepaOrders(orders) {
  return Object.values(orders || {})
    .filter((o) => o && (o.provider === 'bank_sepa_manual' || o.gateway === 'bank_sepa_manual'))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 80);
}

/** Extra panels rendered on the admin landing dashboard (/admin/platby/sepa), e.g. payment-method switches. */
const dashboardPanels = [];
function addDashboardPanel(fn) { if (typeof fn === 'function') dashboardPanels.push(fn); }
function renderDashboardPanels(req) {
  return dashboardPanels.map((fn) => { try { return fn(req) || ''; } catch (e) { return `<div class="err">Panel sa nepodarilo načítať: ${escapeHtml(e.message)}</div>`; } }).join('');
}

function listPage(orders, userEmail, panelsHtml = '') {
  const rows = listSepaOrders(orders);
  const table =
    rows.length === 0
      ? `<p class="muted">Žiadne bank_sepa_manual / Electrocoin objednávky.</p>`
      : `<table class="stack">
<thead><tr>
<th>Order</th><th>Suma</th><th>Stav</th><th>Účel / ref</th><th>Deadline</th><th>Screenshot</th><th>EC proof</th>
</tr></thead>
<tbody>
${rows
  .map((o) => {
    const shot = o.screenshotUploadedAt
      ? `<span class="badge ok">áno</span>`
      : `<span class="badge warn">nie</span>`;
    const proof = o.electrocoinProofUpload
      ? `<span class="badge ${o.electrocoinProofUpload.ok ? 'ok' : 'bad'}">${escapeHtml(
          o.electrocoinProofUpload.ok ? 'ok' : o.electrocoinProofUpload.stage || 'fail'
        )}</span>`
      : `<span class="badge">—</span>`;
    const purpose = o.purpose || o.reference || o.electrocoinReference || '—';
    const deadline = o.deadlineAt
      ? new Date(o.deadlineAt).toLocaleString('sk-SK', { timeZone: 'Europe/Zurich' })
      : '—';
    return `<tr>
<td data-label="Order"><a class="mono" href="/admin/platby/sepa/${encodeURIComponent(o.orderId)}">${escapeHtml(o.orderId)}</a></td>
<td data-label="Suma">${escapeHtml(o.amountExact || o.amountEur || '—')} €</td>
<td data-label="Stav">${statusBadge(o.status)}</td>
<td data-label="Účel / ref" class="mono">${escapeHtml(purpose)}</td>
<td data-label="Deadline">${escapeHtml(deadline)}</td>
<td data-label="Screenshot">${shot}</td>
<td data-label="EC proof">${proof}</td>
</tr>`;
  })
  .join('\n')}
</tbody></table>`;

  const body = `${panelsHtml}
<div class="card">
  <h1>SEPA / Electrocoin — objednávky</h1>
  <p class="muted">Posledných ${rows.length} · upload screenshotu spustí rovnakú cestu ako zákazník (<code>uploadProofToElectrocoin</code>). Len pre Ryana.</p>
  ${table}
</div>`;
  return layout({ title: 'SEPA admin — zoznam', body, userEmail });
}

function detailPage(order, userEmail, { error = null, notice = null } = {}) {
  const purpose = order.purpose || order.reference || order.electrocoinReference || '—';
  const deadline = order.deadlineAt
    ? new Date(order.deadlineAt).toLocaleString('sk-SK', { timeZone: 'Europe/Zurich' })
    : '—';
  const ecDeadline = order.electrocoinDeadlineAt
    ? new Date(order.electrocoinDeadlineAt).toLocaleString('sk-SK', {
        timeZone: 'Europe/Zurich',
      })
    : '—';
  const proof = order.electrocoinProofUpload;
  const proofJson = proof ? JSON.stringify(proof, null, 2) : null;
  const bank = order.bank || {};

  const body = `
<div class="card">
  <p class="muted"><a href="/admin/platby/sepa">← Späť na zoznam</a></p>
  <h1>Objednávka ${escapeHtml(order.orderId)}</h1>
  ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
  ${notice ? `<div class="ok">${escapeHtml(notice)}</div>` : ''}
  <div class="grid">
    <div><span class="muted">Stav</span><div>${statusBadge(order.status)}</div></div>
    <div><span class="muted">Suma</span><div><strong>${escapeHtml(
      order.amountExact || order.amountEur
    )} €</strong></div></div>
    <div><span class="muted">Meno</span><div>${escapeHtml(
      order.fullName || `${order.firstName || ''} ${order.lastName || ''}`.trim() || '—'
    )}</div></div>
    <div><span class="muted">Poznámka</span><div class="mono">${escapeHtml(
      order.paymentNote || purpose
    )}</div></div>
    <div><span class="muted">VS</span><div class="mono">${escapeHtml(order.vs || '—')}</div></div>
    <div><span class="muted">Deadline (zákazník)</span><div>${escapeHtml(deadline)}</div></div>
    <div><span class="muted">Deadline Electrocoin</span><div>${escapeHtml(ecDeadline)}</div></div>
    <div><span class="muted">Screenshot u nás</span><div>${
      order.screenshotUploadedAt
        ? `<span class="badge ok">${escapeHtml(order.screenshotUploadedAt)}</span>`
        : `<span class="badge warn">nie</span>`
    }</div></div>
    <div><span class="muted">Zákazník potvrdil</span><div>${
      order.screenshotConfirmedByCustomer ? 'áno' : 'nie'
    }</div></div>
  </div>
  <h2>Bankové údaje</h2>
  <p class="mono">IBAN: ${escapeHtml(bank.iban || '—')}<br/>
  Príjemca: ${escapeHtml(bank.beneficiary || '—')}<br/>
  Suma: ${escapeHtml(order.amountExact || order.amountEur || '—')} EUR<br/>
  VS: ${escapeHtml(order.vs || '—')}<br/>
  Poznámka: ${escapeHtml(order.paymentNote || order.purpose || purpose || '—')}</p>
</div>
<div class="card">
  <h2>Zadať / upraviť platobné údaje (záloha)</h2>
  <p class="muted">Rovnaké polia ako Telegram. VS voliteľné (prázdne alebo „-“). Poznámka je povinná — ide do QR (SPD MSG / EPC) a zákazník ju kopíruje.</p>
  <form method="post" action="/admin/platby/sepa/${encodeURIComponent(order.orderId)}/bank">
    <label for="iban">IBAN</label>
    <input id="iban" name="iban" required value="${escapeHtml(bank.iban || '')}" autocomplete="off"/>
    <label for="amount">Suma EUR</label>
    <input id="amount" name="amount" required value="${escapeHtml(order.amountExact || order.amountEur || '')}" inputmode="decimal"/>
    <label for="vs">VS (voliteľné)</label>
    <input id="vs" name="vs" value="${escapeHtml(order.vs || '')}" placeholder="-"/>
    <label for="beneficiary">Meno príjemcu (voliteľné)</label>
    <input id="beneficiary" name="beneficiary" value="${escapeHtml(bank.beneficiary || '')}" placeholder="ak prázdne, QR SEPA (EPC) sa skryje"/>
    <label for="note">Poznámka / správa pre prijímateľa (povinná)</label>
    <input id="note" name="note" required value="${escapeHtml(order.paymentNote || order.purpose || '')}" placeholder="napr. Objednavka 123"/>
    <p style="margin-top:1rem"><button type="submit">Uložiť bankové údaje</button></p>
  </form>
</div>
<div class="card">
  <h2>Nahrať screenshot (admin záloha)</h2>
  <p class="muted">Uloží screenshot u nás. Proof na Electrocoin len ak existuje electrocoinOrderUrl (staršie objednávky).</p>
  <form method="post" action="/admin/platby/sepa/${encodeURIComponent(
    order.orderId
  )}/upload" enctype="multipart/form-data">
    <label for="screenshot">Screenshot / PDF</label>
    <input id="screenshot" name="screenshot" type="file" accept="image/*,.pdf" required/>
    <label><input type="checkbox" name="confirmed" value="1" required/> Potvrdzujem, že mám screenshot s viditeľnou poznámkou / správou a že SEPA už odišla.</label>
    <p style="margin-top:1rem"><button type="submit">Uložiť screenshot</button></p>
  </form>
</div>`;
  return layout({
    title: `SEPA admin — ${order.orderId}`,
    body,
    userEmail,
  });
}

/**
 * Lightweight multipart reader (same contract as server bank-sepa screenshot).
 */
function readMultipartScreenshot(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('multipart/form-data')) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => {
        body += c;
        if (body.length > 20_000_000) reject(new Error('too large'));
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          if (!j.dataBase64) return reject(new Error('Chýba screenshot'));
          const buf = Buffer.from(
            String(j.dataBase64).replace(/^data:[^;]+;base64,/, ''),
            'base64'
          );
          resolve({
            buffer: buf,
            filename: j.filename || 'screenshot.png',
            confirmed: Boolean(j.confirmed),
          });
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
      return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return reject(new Error('multipart boundary missing'));
    const bufs = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > 16_000_000) reject(new Error('Súbor je príliš veľký (max 15MB)'));
      bufs.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(bufs);
        const parts = buf.toString('binary').split('--' + boundary);
        let fileBuf = null;
        let filename = 'screenshot.png';
        let confirmed = false;
        for (const part of parts) {
          if (/name="confirmed"/i.test(part) && !/filename=/i.test(part)) {
            const v = part.split('\r\n\r\n')[1] || '';
            confirmed = /1|true|yes|on/i.test(v);
          }
          const fm = part.match(/filename="([^"]+)"/i);
          if (fm) {
            filename = fm[1];
            const idx = part.indexOf('\r\n\r\n');
            if (idx >= 0) {
              let binary = part.slice(idx + 4);
              if (binary.endsWith('\r\n')) binary = binary.slice(0, -2);
              fileBuf = Buffer.from(binary, 'binary');
            }
          }
        }
        if (!fileBuf || !fileBuf.length) return reject(new Error('Chýba screenshot súbor'));
        resolve({ buffer: fileBuf, filename, confirmed });
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('express').Express} app
 * @param {{ loadOrders: Function, saveOrders: Function, appendLog: Function }} deps
 */
/** /admin/platby/<rel> GET pages that lnkbio already has → its URL (null = served here). */
function lnkbioEquivalent(rel) {
  const p = String(rel || '').replace(/\/+$/, '') || '/';
  let m;
  if (p === '/methods') return '/admin/platobne-metody';
  if ((m = /^\/methods\/edit\/([^/]+)$/.exec(p))) return '/admin/platobne-metody/upravit/' + encodeURIComponent(decodeURIComponent(m[1]));
  if (p === '/wallets') return '/admin/penazenky';
  if ((m = /^\/wallets\/edit\/([^/]+)$/.exec(p))) return '/admin/penazenky/upravit/' + encodeURIComponent(decodeURIComponent(m[1]));
  if (p === '/amount-links') return '/admin/odkazy-podla-sumy';
  if ((m = /^\/amount-links\/edit\/([^/]+)$/.exec(p))) return '/admin/odkazy-podla-sumy/upravit/' + encodeURIComponent(decodeURIComponent(m[1]));
  return null;
}

function mount(app, { loadOrders, saveOrders, appendLog }) {
  // Merged into lnkbio: ONE admin login (lnkbio password + 2FA). lnkbio verifies its own session before it hands
  // /admin/platby/* to this app and marks the request object (req.lnkAdmin – set in code, never from a header).
  app.use('/admin/platby', (req, res, next) => {
    if (!req.lnkAdmin) {
      if (req.method === 'GET' || req.headers.accept?.includes('text/html')) return res.redirect(303, '/admin/login');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.adminSession = { email: 'admin' };
    // lnkbio's own pages are the single editor for payment methods / wallets / amount links
    if (req.method === 'GET' || req.method === 'HEAD') { const to = lnkbioEquivalent(req.path); if (to) return res.redirect(302, to); }
    next();
  });

  app.get('/admin/platby', (_req, res) => res.redirect('/admin/platby/sepa'));
  app.get('/admin/platby/', (_req, res) => res.redirect('/admin/platby/sepa'));

  app.get('/admin/platby/sepa', (req, res) => {
    const orders = loadOrders();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(listPage(orders, req.adminSession.email, renderDashboardPanels(req)));
  });

  app.get('/admin/platby/sepa/:orderId', (req, res) => {
    const orders = loadOrders();
    const order = orders[req.params.orderId];
    if (!order || order.provider !== 'bank_sepa_manual') {
      return res
        .status(404)
        .type('html')
        .send(
          layout({
            title: 'Nenájdené',
            userEmail: req.adminSession.email,
            body: `<div class="card"><h1>Objednávka nenájdená</h1><p><a href="/admin/platby/sepa">← Späť</a></p></div>`,
          })
        );
    }
    res.type('html').send(detailPage(order, req.adminSession.email));
  });

  app.post('/admin/platby/sepa/:orderId/bank', (req, res) => {
    const orderId = String(req.params.orderId || '').trim();
    const orders = loadOrders();
    const order = orders[orderId];
    const userEmail = req.adminSession.email;
    if (!order || order.provider !== 'bank_sepa_manual') {
      return res.status(404).type('html').send(
        layout({ title: 'Nenájdené', userEmail, body: `<div class="card"><div class="err">Objednávka sa nenašla</div></div>` })
      );
    }
    try {
      sepaManual.applyBankDetails(order, {
        iban: req.body?.iban,
        amount: req.body?.amount,
        vs: req.body?.vs,
        beneficiary: req.body?.beneficiary,
        note: req.body?.note,
        via: 'admin',
      });
      orders[orderId] = order;
      saveOrders(orders);
      appendLog(`ADMIN_SEPA_BANK ${orderId} by=${userEmail} iban=${order.bank.iban.slice(0, 4)}…`);
      return res.type('html').send(
        detailPage(order, userEmail, { notice: 'Bankové údaje uložené — zákazník ich uvidí na /bank-sepa-pay.' })
      );
    } catch (err) {
      return res.status(400).type('html').send(detailPage(order, userEmail, { error: err.message || String(err) }));
    }
  });

  app.post('/admin/platby/sepa/:orderId/upload', async (req, res) => {
    const orderId = String(req.params.orderId || '').trim();
    const orders = loadOrders();
    const order = orders[orderId];
    const userEmail = req.adminSession.email;

    const fail = (status, error) => {
      if (!order) {
        return res
          .status(status)
          .type('html')
          .send(
            layout({
              title: 'Chyba',
              userEmail,
              body: `<div class="card"><div class="err">${escapeHtml(
                error
              )}</div><p><a href="/admin/platby/sepa">← Späť</a></p></div>`,
            })
          );
      }
      return res
        .status(status)
        .type('html')
        .send(detailPage(order, userEmail, { error }));
    };

    if (!order || order.provider !== 'bank_sepa_manual') {
      return fail(404, 'Objednávka sa nenašla');
    }
    if (!(order.bank && order.bank.iban)) {
      return fail(409, 'Bankové údaje ešte nie sú pripravené');
    }

    try {
      const parsed = await readMultipartScreenshot(req);
      if (!parsed.confirmed) {
        return fail(
          400,
          'Potvrďte, že máte screenshot s viditeľnou referenciou, potom nahrajte súbor.'
        );
      }
      const saved = electrocoin.saveScreenshot(orderId, parsed.buffer, parsed.filename);
      order.screenshotPath = saved.path;
      order.screenshotUploadedAt = new Date().toISOString();
      order.screenshotConfirmedByCustomer = false;
      order.screenshotUploadedByAdmin = true;
      order.screenshotAdminEmail = userEmail;
      order.paidMarkedAt = order.screenshotUploadedAt;
      order.status = 'uploading_proof';
      orders[orderId] = order;
      saveOrders(orders);
      appendLog(`ADMIN_SEPA_SCREENSHOT ${orderId} file=${saved.filename} by=${userEmail}`);

      let notice = 'Screenshot uložený u nás.';
      if (order.electrocoinOrderUrl) {
        const upload = await electrocoin.uploadProofToElectrocoin(order, saved.path);
        order.electrocoinProofUpload = upload;
        order.status = upload.ok ? 'awaiting_confirm' : 'screenshot_uploaded';
        appendLog(
          `ADMIN_SEPA_EC_PROOF ${orderId} ok=${upload.ok} stage=${upload.stage} by=${userEmail}`
        );
        notice = upload.ok
          ? 'Screenshot uložený a odoslaný na Electrocoin (proof OK).'
          : `Screenshot uložený u nás. Electrocoin proof: ${upload.detail || upload.stage}`;
      } else {
        order.status = 'screenshot_uploaded';
        appendLog(`ADMIN_SEPA_SCREENSHOT_ONLY ${orderId} by=${userEmail}`);
        notice = 'Screenshot uložený u nás (bez Electrocoin proof — manuálna SEPA).';
      }
      orders[orderId] = order;
      saveOrders(orders);
      return res
        .type('html')
        .send(detailPage(order, userEmail, { notice }));
    } catch (err) {
      return fail(500, err.message || String(err));
    }
  });
}

module.exports = {
  lnkbioEquivalent,
  mount,
  layout,
  addDashboardPanel,
  escapeHtml,
  isConfigured,
  adminEmail,
  COOKIE_NAME,
};
