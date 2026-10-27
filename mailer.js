'use strict';
// Outbound e-mail for lnkbio. Render FREE web services block outbound SMTP (25/465/587, since 2025-09-26),
// so the primary path is an HTTPS e-mail API: Brevo (free 300/day), optionally Resend or Mailjet. SMTP stays as an option
// (works on paid instances / elsewhere). API key is stored encrypted (settings key mail_key, AES-GCM via server isEncKey)
// and never shown back in full. Sender name defaults to the site name.
const PROVIDERS = {
  brevo: { label: 'Brevo (zadarmo 300 e-mailov/deň)', url: 'https://api.brevo.com/v3/smtp/email' },
  resend: { label: 'Resend (zadarmo 100/deň, vyžaduje vlastnú doménu)', url: 'https://api.resend.com/emails' },
  mailjet: { label: 'Mailjet (zadarmo 200/deň) – kľúč v tvare APIKEY:SECRETKEY', url: 'https://api.mailjet.com/v3.1/send' },
  smtp: { label: 'SMTP (na Render free nefunguje – porty sú blokované)' },
  off: { label: 'Vypnuté' },
};
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;
const badSender = (v) => /tokigo/i.test(String(v || ''));
const smtpSettings = () => { try { return require('./pay/src/sepaBotChain').smtpSettings({ allowNoFrom: true }); } catch { return null; } };

let cfg = { provider: 'auto', key: '', from: '', fromName: '', title: '' };
function setCfg(s) {
  cfg = { provider: String(s.mail_provider || 'auto'), key: String(s.mail_key || ''), from: String(s.mail_from || ''), fromName: String(s.mail_from_name || ''), title: String(s.title || '') };
}
// effective provider: explicit choice, or auto = API (by key format) if a key is stored, else SMTP if configured
function provider(c = cfg) {
  if (c.provider && c.provider !== 'auto') return c.provider;
  if (c.key) return /^re_/.test(c.key) ? 'resend' : c.key.includes(':') ? 'mailjet' : 'brevo';
  return smtpSettings() ? 'smtp' : 'off';
}
const senderEmail = (c = cfg) => { const f = c.from || (smtpSettings() || {}).from || process.env.MAIL_FROM || ''; return EMAIL_RE.test(f) && !badSender(f) ? f : ''; };
const senderName = (c = cfg) => { const n = (c.fromName || c.title || 'TV Software').replace(/[\r\n<>"]/g, '').slice(0, 80); return badSender(n) ? (c.title && !badSender(c.title) ? c.title : 'TV Software') : n; };
function apiReady(c = cfg) { const p = provider(c); return ['brevo', 'resend', 'mailjet'].includes(p) && !!c.key && !!senderEmail(c); }
function ready(c = cfg) { const p = provider(c); return p === 'smtp' ? !!(smtpSettings() && senderEmail(c)) : apiReady(c); }
const mask = (k) => (k ? (k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-3) : '••••') : '');

/** pure: build the HTTPS request for a provider (unit-tested) */
function buildRequest(p, c, m) {
  const from = senderEmail(c), name = senderName(c), to = String(m.to).trim(), subject = String(m.subject || '').slice(0, 200), text = String(m.text || '').slice(0, 20000);
  const att = (m.attachments || []).filter((a) => a && a.content && a.filename).map((a) => ({ filename: String(a.filename).slice(0, 180), b64: Buffer.from(a.content).toString('base64'), type: a.contentType || 'application/octet-stream' }));
  if (p === 'brevo') return { url: PROVIDERS.brevo.url, headers: { 'api-key': c.key, 'content-type': 'application/json', accept: 'application/json' },
    body: { sender: { email: from, name }, to: [{ email: to }], subject, textContent: text, ...(att.length ? { attachment: att.map((a) => ({ name: a.filename, content: a.b64 })) } : {}) } };
  if (p === 'resend') return { url: PROVIDERS.resend.url, headers: { authorization: 'Bearer ' + c.key, 'content-type': 'application/json' },
    body: { from: `${name} <${from}>`, to: [to], subject, text, ...(att.length ? { attachments: att.map((a) => ({ filename: a.filename, content: a.b64 })) } : {}) } };
  if (p === 'mailjet') { const [u, s] = c.key.split(':'); return { url: PROVIDERS.mailjet.url, headers: { authorization: 'Basic ' + Buffer.from(u + ':' + (s || '')).toString('base64'), 'content-type': 'application/json' },
    body: { Messages: [{ From: { Email: from, Name: name }, To: [{ Email: to }], Subject: subject, TextPart: text, ...(att.length ? { Attachments: att.map((a) => ({ ContentType: a.type, Filename: a.filename, Base64Content: a.b64 })) } : {}) }] } }; }
  return null;
}

async function send(m, c = cfg) {
  if (!m || !EMAIL_RE.test(String(m.to || ''))) { const e = new Error('Neplatný príjemca'); e.code = 'BAD_TO'; throw e; }
  const p = provider(c);
  if (p === 'smtp') {
    const s = smtpSettings(); if (!s) { const e = new Error('SMTP nie je nastavený'); e.code = 'NO_SMTP'; throw e; }
    const t = require('nodemailer').createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user || s.pass ? { user: s.user, pass: s.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000 });
    const from = senderEmail(c) || s.from;
    const i = await t.sendMail({ from: `"${senderName(c)}" <${from}>`, to: m.to, subject: String(m.subject || '').slice(0, 200), text: String(m.text || '').slice(0, 20000),
      attachments: (m.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) });
    return { provider: 'smtp', id: i.messageId };
  }
  if (!apiReady(c)) { const e = new Error('E-mail nie je nastavený (chýba kľúč alebo odosielateľ)'); e.code = 'NO_SMTP'; throw e; }
  const rq = buildRequest(p, c, m);
  const r = await fetch(rq.url, { method: 'POST', headers: rq.headers, body: JSON.stringify(rq.body), signal: AbortSignal.timeout(15000) });
  const txt = await r.text().catch(() => '');
  if (!r.ok) { const e = new Error(`${p} HTTP ${r.status}: ${txt.replace(/[A-Za-z0-9_-]{24,}/g, '…').slice(0, 300)}`); e.code = 'API_' + r.status; throw e; }
  let id = ''; try { const j = JSON.parse(txt); id = j.messageId || j.id || (j.Messages && j.Messages[0] && j.Messages[0].To && j.Messages[0].To[0] && j.Messages[0].To[0].MessageID) || ''; } catch { /* */ }
  return { provider: p, id: String(id) };
}

function install(ctx) {
  const { admin, getSettings, setSettings, page, esc, hid, csrf, needAuth, wrap } = ctx;
  const refresh = async () => { try { setCfg(await getSettings()); } catch { /* db not ready */ } };
  ctx.mailerInit = refresh;
  setInterval(refresh, 60e3).unref();
  const M = { send: (m) => send(m), ready: () => ready(), apiReady: () => apiReady(), provider: () => provider(), refresh };
  global.__lnkMailer = M;
  const MSG = { ok: 'Uložené.', sent: 'Testovací e-mail odoslaný ✅ – skontrolujte schránku (aj spam).', bad: 'Neplatný e-mail odosielateľa.', tokigo: 'Odosielateľ nesmie obsahovať TokiGO.', to: 'Zadajte platný e-mail príjemcu.', limit: 'Príliš veľa testov – počkajte pár minút.' };
  let tests = [];
  admin.get('/email', needAuth, wrap(async (req, res) => {
    const s = await getSettings(); setCfg(s);
    const p = provider(), on = ready(), fail = String(req.query.err || '').slice(0, 300);
    const opt = ['auto', ...Object.keys(PROVIDERS)].map((k) => `<option value="${k}"${(s.mail_provider || 'auto') === k ? ' selected' : ''}>${esc(k === 'auto' ? 'Automaticky (podľa kľúča, inak SMTP)' : PROVIDERS[k].label)}</option>`).join('');
    let notify = ''; try { notify = require('./pay/src/sepaBotChain').getConfig().notifyEmail || ''; } catch { /* */ }
    res.send(page('E-mail odosielanie', `<p class="row"><a class="btnl sm" href="/admin">← Admin</a><a class="btnl sm" href="/admin/platby/sepa-chain">SEPA reťaz (SMTP)</a></p>
<h1>📧 E-mail odosielanie</h1>${MSG[req.query.m] ? `<div class="msg${['ok', 'sent'].includes(req.query.m) ? '' : ' err'}">${esc(MSG[req.query.m])}</div>` : ''}${fail ? `<div class="msg err">Odoslanie zlyhalo: ${esc(fail)}</div>` : ''}
<div class="card"><p>Stav: ${on ? `✅ aktívne – <b>${esc(p)}</b>` : '⚠️ e-maily sa NEODOSIELAJÚ'} · Odosielateľ: <b>${esc(senderName())}</b> &lt;${esc(senderEmail() || '–')}&gt;</p>
<p class="hint">Používa sa na: zabudnuté heslo, overenie e-mailu, pripomienku konca predplatného (7 dní vopred) a doklady SEPA platby pre vás. Render free tier blokuje SMTP porty – odporúčame <b>Brevo</b> (zadarmo 300 e-mailov/deň, bez karty).</p>
<details><summary>Ako získať Brevo API kľúč (5 minút)</summary><ol><li>Zaregistrujte sa zadarmo na <a href="https://www.brevo.com" rel="noopener noreferrer" target="_blank">brevo.com</a> (plán Free).</li><li><b>Senders, Domains &amp; Dedicated IPs → Senders → Add a sender</b>: zadajte e-mail odosielateľa a potvrďte ho cez odkaz v schránke.</li><li><b>SMTP &amp; API → API keys → Generate a new API key</b>, skopírujte kľúč (zobrazí sa len raz) a vložte ho nižšie.</li><li>Ak test hlási „unrecognised IP“: <b>Security → Authorised IPs</b> → vypnite blokovanie neznámych IP (Render nemá pevnú IP).</li></ol></details></div>
<form method="post" action="/admin/email" class="card">${hid(req)}
<label for="mp">Poskytovateľ</label><select id="mp" name="mail_provider">${opt}</select>
<label for="mk">API kľúč ${s.mail_key ? `(uložený: ${esc(mask(s.mail_key))})` : ''}</label><input id="mk" name="mail_key" type="password" autocomplete="new-password" maxlength="300" placeholder="${s.mail_key ? '•••• nechať bez zmeny' : 'xkeysib-…'}">
<label class="chk"><input type="checkbox" name="clear_key" value="1"> Vymazať uložený kľúč</label>
<label for="mf">E-mail odosielateľa (overený u poskytovateľa)</label><input id="mf" name="mail_from" type="email" maxlength="200" value="${esc(s.mail_from || '')}" placeholder="napr. vas.email@gmail.com">
<label for="mn">Meno odosielateľa</label><input id="mn" name="mail_from_name" maxlength="80" value="${esc(s.mail_from_name || '')}" placeholder="${esc(s.title || 'TV Software')}">
<p class="row"><button>💾 Uložiť</button></p></form>
<form method="post" action="/admin/email/test" class="card">${hid(req)}<h2>Poslať testovací e-mail</h2><label for="tt">Príjemca</label><input id="tt" name="to" type="email" required maxlength="200" value="${esc(notify)}"><p class="row"><button>📨 Poslať testovací e-mail</button></p></form>`, 'a adm'));
  }));
  admin.post('/email', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body, s = await getSettings(), up = {};
    const prov = ['auto', ...Object.keys(PROVIDERS)].includes(b.mail_provider) ? b.mail_provider : 'auto';
    const from = String(b.mail_from || '').trim().slice(0, 200), name = String(b.mail_from_name || '').replace(/[\r\n<>"]/g, '').trim().slice(0, 80);
    if (badSender(from) || badSender(name)) return res.redirect(303, '/admin/email?m=tokigo');
    if (from && !EMAIL_RE.test(from)) return res.redirect(303, '/admin/email?m=bad');
    Object.assign(up, { mail_provider: prov, mail_from: from, mail_from_name: name });
    const k = String(b.mail_key || '').trim();
    if (b.clear_key === '1') up.mail_key = '';
    else if (k && !/[…•]/.test(k) && /^[\x21-\x7e]{8,300}$/.test(k)) up.mail_key = k;
    await setSettings(up); setCfg({ ...s, ...up });
    if (ctx.audit) try { ctx.audit(req, 'mail_settings', prov); } catch { /* */ }
    res.redirect(303, '/admin/email?m=ok');
  }));
  admin.post('/email/test', needAuth, csrf, wrap(async (req, res) => {
    const now = Date.now(); tests = tests.filter((x) => now - x < 10 * 60e3); if (tests.length >= 5) return res.redirect(303, '/admin/email?m=limit'); tests.push(now);
    const to = String(req.body.to || '').trim(); if (!EMAIL_RE.test(to)) return res.redirect(303, '/admin/email?m=to');
    await refresh();
    try { await send({ to, subject: `${senderName()} – testovací e-mail`, text: `Toto je testovací e-mail z administrácie ${senderName()}.\nOdosielanie e-mailov (${provider()}) funguje.` }); res.redirect(303, '/admin/email?m=sent'); }
    catch (e) { res.redirect(303, '/admin/email?err=' + encodeURIComponent(String(e.message || e.code || 'chyba').slice(0, 250))); }
  }));
  return M;
}
module.exports = { install, send, ready, apiReady, provider, buildRequest, senderName, senderEmail, setCfg, mask, PROVIDERS };
