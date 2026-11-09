'use strict';
/**
 * After a paid order: customer enters a username (min. 8) and at least one contact
 * (e-mail OR Telegram OR Facebook). A private page (token link) is where Ryan sends
 * encrypted login credentials. Return later via the private link, or username + the same contact.
 */
const crypto = require('crypto');
const sealed = require('./sealedStore');

const USER_RE = /^[A-Za-z0-9._-]{8,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const TG_RE = /^@[A-Za-z0-9_]{5,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const PAID = new Set(['paid', 'confirmed', 'completed', 'settled', 'complete', 'success']);
const SEAL = 'order-creds';

const clean = (v, n) => String(v == null ? '' : v).trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normUser = (v) => clean(v, 64).replace(/^@/, '');
const normEmail = (v) => clean(v, 254).toLowerCase();
const normTg = (v) => {
  let x = clean(v, 200).replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
  return x ? '@' + x : '';
};
const normFb = (v) => clean(v, 200);

function validateContact({ email, telegram, facebook } = {}) {
  const out = {};
  if (email) {
    const e = normEmail(email);
    if (!EMAIL_RE.test(e)) return { error: 'Zadajte platný e-mail, alebo nechajte pole prázdne a vyplňte Telegram či Facebook.' };
    out.email = e;
  }
  if (telegram) {
    const t = normTg(telegram);
    if (!TG_RE.test(t)) return { error: 'Zadajte Telegram v tvare @meno (5–32 znakov), alebo vyplňte e-mail či Facebook.' };
    out.telegram = t;
  }
  if (facebook) {
    const f = normFb(facebook);
    if (f.length < 3) return { error: 'Zadajte odkaz na Facebook alebo meno (min. 3 znaky).' };
    if (/^https?:\/\//i.test(f) && !/^https?:\/\/(www\.|m\.)?(facebook|fb)\.com\//i.test(f)) return { error: 'Odkaz musí byť na facebook.com.' };
    out.facebook = f;
  }
  if (!out.email && !out.telegram && !out.facebook) return { error: 'Vyplňte aspoň jeden kontakt: e-mail, Telegram alebo Facebook.' };
  return { contact: out };
}

function validateFulfill(b) {
  const username = normUser(b && b.username);
  if (!USER_RE.test(username)) return { error: 'Používateľské meno musí mať 8–64 znakov (písmená, číslice, . _ -) a bez medzier.' };
  const c = validateContact(b || {});
  if (c.error) return c;
  return { username, contact: c.contact };
}

function isPaid(o) {
  if (!o) return false;
  const st = String(o.status || '').toLowerCase();
  return PAID.has(st) || o.chainStatus === 'confirmed' || !!o.paidAt;
}

function ensure(order) {
  if (!order) return null;
  if (!order.fulfill || typeof order.fulfill !== 'object') order.fulfill = {};
  if (!TOKEN_RE.test(order.fulfill.token)) order.fulfill.token = crypto.randomBytes(16).toString('hex');
  return order.fulfill;
}

function contactMatches(stored, given) {
  if (!stored || !given) return false;
  if (given.email && stored.email && given.email === stored.email) return true;
  if (given.telegram && stored.telegram && given.telegram.toLowerCase() === stored.telegram.toLowerCase()) return true;
  if (given.facebook && stored.facebook && given.facebook.toLowerCase() === stored.facebook.toLowerCase()) return true;
  return false;
}

function findByReturn(orders, { username, email, telegram, facebook }) {
  const v = validateFulfill({ username, email, telegram, facebook });
  if (v.error) return { error: v.error };
  const hits = Object.values(orders || {}).filter((o) => {
    const f = o && o.fulfill;
    return f && f.submittedAt && normUser(f.username) === v.username && contactMatches(f, v.contact);
  });
  if (!hits.length) return { error: 'Nenašli sme objednávku s týmto menom a kontaktom. Skontrolujte údaje, alebo použite súkromný odkaz.' };
  hits.sort((a, b) => String(b.fulfill.submittedAt).localeCompare(String(a.fulfill.submittedAt)));
  return { order: hits[0] };
}

function sealCreds(text) { return sealed.seal(SEAL, String(text || '')); }
function openCreds(enc) { return enc ? sealed.open(SEAL, enc) : ''; }

function publicBase(req) {
  const env = (process.env.LNKBIO_PUBLIC_URL || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (env) return env.startsWith('http') ? env : 'https://' + env;
  const fwd = String((req && req.get && req.get('x-forwarded-proto')) || '').split(',')[0].trim();
  const proto = fwd || (req && req.protocol) || 'https';
  const host = (req && req.get && (req.get('x-forwarded-host') || req.get('host'))) || '';
  return (proto + '://' + host).replace(/\/$/, '');
}
function pathFor(order) { const f = ensure(order); return '/objednavka/' + f.token; }
function urlFor(order, req) { return publicBase(req) + pathFor(order); }

function paidUrl(order, req) {
  if (!order || !isPaid(order)) return '';
  return urlFor(order, req);
}

function notify(text) { try { if (global.__notifyAdmin) global.__notifyAdmin(text); } catch { /* */ } }

function mailReady() { try { return !!(global.__lnkMailer && global.__lnkMailer.ready && global.__lnkMailer.ready()); } catch { return false; } }
async function sendMail(to, subject, text) {
  if (!mailReady() || !to) return false;
  await global.__lnkMailer.send({ to, subject, text });
  return true;
}

function pageShell(title, body) {
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<link rel="stylesheet" href="/tv-theme.css?v=20261109"/>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b1220;color:#e8eef9}
.w{max-width:560px;margin:0 auto;padding:20px 14px 40px}
.card{background:#121a2b;border:1px solid #243044;border-radius:16px;padding:18px;margin:0 0 14px}
h1{font-size:1.35rem;margin:0 0 10px}label{display:block;margin:10px 0 4px;color:#93a0b8;font-size:.9rem}
input,textarea{width:100%;box-sizing:border-box;background:#0b1220;border:1px solid #334155;border-radius:10px;color:#e8eef9;padding:10px 12px;font:16px/1.4 system-ui}
button,.btn{display:inline-block;margin-top:12px;padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,#e50914,#b20710);color:#fff;font-weight:700;cursor:pointer;text-decoration:none}
button.g{background:#334155}.hint{color:#93a0b8;font-size:.88rem;line-height:1.45}.err{background:#4c0d12;border:1px solid #e50914;border-radius:10px;padding:10px;margin:0 0 12px}
.ok{background:#0f3d2e;border:1px solid #166534;border-radius:10px;padding:10px;margin:0 0 12px}
.msgs{display:flex;flex-direction:column;gap:10px;margin:12px 0}.msg{padding:10px 12px;border-radius:12px;border:1px solid #334155;background:#0b1220;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.admin{border-color:#1d4ed8;background:#0f1b33}.msg.creds{border-color:#166534;background:#0c2418;font-family:ui-monospace,monospace}
.link{word-break:break-all;color:#93c5fd}
</style></head><body><main class="w">${body}</main></body></html>`;
}

function formHtml(order, err, req) {
  const f = (order && order.fulfill) || {};
  return pageShell('Údaje k predplatnému', `<div class="card"><h1>Predplatné je zaplatené</h1>
<p>Zadajte používateľské meno (min. 8 znakov), ktoré chcete používať, a aspoň jeden kontakt – e-mail, Telegram alebo Facebook. Tam vám pošleme prihlasovacie údaje. K tomuto oknu sa viete vrátiť cez súkromný odkaz, alebo zadaním mena a toho istého kontaktu.</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
<form method="post" action="${esc(pathFor(order))}">
<label for="u">Používateľské meno (min. 8 znakov)</label>
<input id="u" name="username" required minlength="8" maxlength="64" pattern="[A-Za-z0-9._\\-]{8,64}" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(f.username || '')}">
<p class="hint">Povolené sú písmená, číslice, bodka, podčiarkovník a pomlčka. Bez medzier.</p>
<p class="hint"><b>Aspoň jeden kontakt</b> (nemusí to byť e-mail):</p>
<label for="em">E-mail</label><input id="em" name="email" type="email" maxlength="254" value="${esc(f.email || '')}" autocomplete="email">
<label for="tg">Telegram</label><input id="tg" name="telegram" maxlength="200" placeholder="@meno" value="${esc(f.telegram || '')}" autocapitalize="none">
<label for="fb">Facebook</label><input id="fb" name="facebook" maxlength="200" placeholder="odkaz alebo meno" value="${esc(f.facebook || '')}">
<button>Odoslať a otvoriť okno s údajmi</button>
</form>
<p class="hint">Súkromný odkaz na túto stránku si môžete uložiť:<br><a class="link" href="${esc(urlFor(order, req))}">${esc(urlFor(order, req))}</a></p>
<p class="hint"><a href="/objednavka/navrat">Už mám odoslané údaje – chcem sa vrátiť</a></p>
</div>`);
}

function chatHtml(order, req, flash) {
  const f = order.fulfill || {};
  const msgs = (f.messages || []).map((m) => {
    if (m.type === 'creds') {
      const t = openCreds(m.credEnc) || '(údaje sa nepodarilo zobraziť – použite súkromný odkaz ešte raz, alebo nám napíšte)';
      return `<div class="msg creds"><b>Prihlasovacie údaje</b>\n${esc(t)}</div>`;
    }
    return `<div class="msg ${m.from === 'admin' ? 'admin' : ''}">${esc(m.text || '')}</div>`;
  }).join('');
  return pageShell('Vaše údaje k predplatnému', `<div class="card"><h1>Okno k objednávke</h1>
${flash ? `<div class="ok">${esc(flash)}</div>` : ''}
<p>Meno: <b>${esc(f.username)}</b></p>
<p class="hint">Uložte si tento súkromný odkaz – kedykoľvek sa sem viete vrátiť (funguje aj s menom a kontaktom, ktorý ste zadali):<br><a class="link" href="${esc(urlFor(order, req))}">${esc(urlFor(order, req))}</a></p>
<div class="msgs">${msgs || '<p class="hint">Zatiaľ tu nie sú prihlasovacie údaje. Akonáhle ich odošleme, uvidíte ich na tomto mieste.</p>'}</div>
<form method="post" action="${esc(pathFor(order))}/sprava">
<label for="t">Správa pre podporu (voliteľné)</label>
<textarea id="t" name="text" rows="3" maxlength="2000" required></textarea>
<button class="g">Odoslať správu</button>
</form>
</div>`);
}

function returnHtml(err) {
  return pageShell('Návrat k údajom', `<div class="card"><h1>Vrátiť sa k oknu s údajmi</h1>
<p>Zadajte to isté používateľské meno a ten istý kontakt ako pri odoslaní po platbe.</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
<form method="post" action="/objednavka/navrat">
<label>Používateľské meno</label><input name="username" required minlength="8" maxlength="64" pattern="[A-Za-z0-9._\\-]{8,64}" autocapitalize="none" spellcheck="false">
<label>E-mail</label><input name="email" type="email" maxlength="254">
<label>Telegram</label><input name="telegram" maxlength="200" placeholder="@meno" autocapitalize="none">
<label>Facebook</label><input name="facebook" maxlength="200">
<button>Otvoriť okno</button>
</form>
</div>`);
}

function findByToken(orders, token) {
  if (!TOKEN_RE.test(token)) return null;
  return Object.values(orders || {}).find((o) => o && o.fulfill && o.fulfill.token === token) || null;
}

function mount(app, { loadOrders, saveOrders, appendLog = () => {} }) {
  const load = () => loadOrders();
  const save = (o) => saveOrders(o);

  app.get('/objednavka/navrat', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(returnHtml()); });
  app.post('/objednavka/navrat', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = findByReturn(load(), req.body || {});
    if (r.error) return res.status(400).type('html').send(returnHtml(r.error));
    res.redirect(303, pathFor(r.order));
  });

  app.get('/objednavka/:token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const o = findByToken(load(), req.params.token);
    if (!o) return res.status(404).type('html').send(pageShell('Nenájdené', '<div class="card"><h1>Odkaz je neplatný</h1><p>Skúste <a href="/objednavka/navrat" style="color:#93c5fd">návrat cez meno a kontakt</a>.</p></div>'));
    if (!isPaid(o)) return res.status(403).type('html').send(pageShell('Čaká sa na platbu', '<div class="card"><h1>Platba ešte nie je potvrdená</h1><p>Toto okno sa otvorí po potvrdení platby.</p></div>'));
    const f = ensure(o);
    if (!f.submittedAt) return res.type('html').send(formHtml(o, '', req));
    res.type('html').send(chatHtml(o, req));
  });

  app.post('/objednavka/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const orders = load(); const o = findByToken(orders, req.params.token);
    if (!o || !isPaid(o)) return res.status(404).type('html').send(pageShell('Nenájdené', '<div class="card"><p>Objednávka sa nenašla alebo ešte nie je zaplatená.</p></div>'));
    const v = validateFulfill(req.body || {});
    if (v.error) return res.status(400).type('html').send(formHtml(o, v.error, req));
    const f = ensure(o);
    if (!f.submittedAt) {
      Object.assign(f, { username: v.username, ...v.contact, submittedAt: new Date().toISOString(), messages: f.messages || [] });
      f.messages.push({ id: crypto.randomBytes(8).toString('hex'), at: f.submittedAt, from: 'system', type: 'text', text: 'Údaje boli odoslané. Prihlasovacie údaje sa tu zobrazia, ako ich odošleme.' });
      save(orders);
      appendLog('FULFILL_SUBMIT ' + o.orderId);
      const who = [v.contact.email, v.contact.telegram, v.contact.facebook].filter(Boolean).join(', ');
      notify(`✅ Po platbe zadané údaje\nObjednávka: ${o.orderId}\nUsername: ${v.username}\nKontakt: ${who}\nOdošlite prihlásenie v admine: /admin/objednavky/${o.orderId}`);
      if (v.contact.email) {
        const link = urlFor(o, req);
        try { await sendMail(v.contact.email, 'Váš odkaz k predplatnému', `Dobrý deň,\n\nďakujeme za platbu. K oknu s prihlasovacími údajmi sa viete kedykoľvek vrátiť cez tento súkromný odkaz:\n${link}\n\nalebo na ${publicBase(req)}/objednavka/navrat zadaním používateľského mena (${v.username}) a tohto e-mailu.\n`); } catch (e) { appendLog('FULFILL_MAIL_FAIL ' + (e && e.message)); }
      }
    }
    res.redirect(303, pathFor(o));
  });

  app.post('/objednavka/:token/sprava', (req, res) => {
    const orders = load(); const o = findByToken(orders, req.params.token);
    if (!o || !o.fulfill || !o.fulfill.submittedAt) return res.status(404).send('Nenájdené');
    const text = clean(req.body && req.body.text, 2000);
    if (text.length < 2) return res.redirect(303, pathFor(o));
    o.fulfill.messages = o.fulfill.messages || [];
    o.fulfill.messages.push({ id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), from: 'customer', type: 'text', text });
    save(orders);
    notify(`💬 Správa od ${o.fulfill.username} (${o.orderId}):\n${text.slice(0, 500)}`);
    res.redirect(303, pathFor(o));
  });

  // Redirect leftover ?paid= landing to the fulfill page
  app.get('/', (req, res, next) => {
    const id = String(req.query.paid || '');
    if (!ID_RE.test(id)) return next();
    const o = load()[id];
    if (o && isPaid(o)) { ensure(o); save(load()); return res.redirect(302, pathFor(o)); }
    next();
  });
}

function deliver({ order, text, alsoEmail }, req) {
  const body = clean(text, 4000);
  if (!body) return { error: 'Napíšte prihlasovacie údaje.' };
  if (!order || !order.fulfill || !order.fulfill.submittedAt) return { error: 'Zákazník ešte neodoslal meno a kontakt.' };
  let enc;
  try { enc = sealCreds(body); } catch (e) { return { error: e.message || 'Chýba šifrovací kľúč (DATA_ENC_KEY).' }; }
  order.fulfill.messages = order.fulfill.messages || [];
  order.fulfill.messages.push({ id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), from: 'admin', type: 'creds', credEnc: enc });
  order.fulfill.credSentAt = new Date().toISOString();
  if (alsoEmail && order.fulfill.email) {
    const link = urlFor(order, req);
    sendMail(order.fulfill.email, 'Prihlasovacie údaje k predplatnému', `Dobrý deň ${order.fulfill.username},\n\nprihlasovacie údaje nájdete v súkromnom okne (odporúčame otvoriť tento odkaz):\n${link}\n\nÚdaje:\n${body}\n`).catch(() => {});
    order.fulfill.credEmailedAt = new Date().toISOString();
  }
  notify(`🔑 Prihlasovacie údaje odoslané pre ${order.fulfill.username} (${order.orderId})`);
  return { ok: true };
}

function adminList(orders) {
  return Object.values(orders || {}).filter((o) => isPaid(o) || (o && o.fulfill && o.fulfill.submittedAt))
    .sort((a, b) => String((b.fulfill && (b.fulfill.submittedAt || b.fulfill.token)) || b.paidAt || b.createdAt || '').localeCompare(String((a.fulfill && a.fulfill.submittedAt) || a.paidAt || a.createdAt || '')))
    .slice(0, 200);
}

module.exports = {
  USER_RE, validateFulfill, validateContact, isPaid, ensure, findByReturn, findByToken,
  sealCreds, openCreds, pathFor, urlFor, paidUrl, deliver, adminList, mount, contactMatches,
};

function mountAdmin(admin, { needAuth, csrf, wrap, page, hid, esc, loadOrders, saveOrders }) {
  const listPage = (req, res) => {
    const rows = adminList(loadOrders());
    const tr = rows.map((o) => {
      const f = o.fulfill || {};
      const st = f.credSentAt ? 'údaje odoslané' : f.submittedAt ? 'čaká na údaje' : isPaid(o) ? 'zaplatené – bez formulára' : (o.status || '');
      const contact = [f.email, f.telegram, f.facebook].filter(Boolean).join(' · ') || '—';
      return `<tr><td><a href="/admin/objednavky/${esc(o.orderId)}">${esc(o.orderId)}</a></td><td>${esc(o.amountExact || o.amountEur || '—')} €</td><td>${esc(f.username || '—')}</td><td>${esc(contact)}</td><td>${esc(st)}</td></tr>`;
    }).join('') || '<tr><td colspan="5">Zatiaľ žiadne zaplatené objednávky.</td></tr>';
    res.send(page('Objednávky a prihlásenie', `<h1>📦 Objednávky a prihlásenie</h1>
<p class="hint">Po zaplatení zákazník zadá meno (min. 8 znakov) a aspoň jeden kontakt. Tu mu odošlete prihlasovacie údaje – uložia sa šifrovane a uvidí ich len v súkromnom okne (prípadne e-mailom, ak je vyplnený a odosielanie je nastavené).</p>
<div class="card" style="overflow:auto"><table class="tbl"><thead><tr><th>Objednávka</th><th>Suma</th><th>Meno</th><th>Kontakt</th><th>Stav</th></tr></thead><tbody>${tr}</tbody></table></div>`, 'a adm'));
  };
  admin.get('/objednavky', needAuth, wrap(async (req, res) => listPage(req, res)));
  admin.get('/objednavky/:id', needAuth, wrap(async (req, res) => {
    const o = loadOrders()[req.params.id];
    if (!o) return res.status(404).send(page('Nenájdené', '<h1>Objednávka sa nenašla</h1><p><a href="/admin/objednavky">← Zoznam</a></p>', 'a adm'));
    const f = o.fulfill || {};
    const m = req.query.m === 'ok' ? '<div class="msg">Údaje boli odoslané do okna zákazníka.</div>' : (req.query.m && req.query.m !== 'ok' ? `<div class="msg err">${esc(req.query.m)}</div>` : '');
    const contact = [f.email, f.telegram, f.facebook].filter(Boolean).join(' · ') || '—';
    const mailOpt = (f.email && (global.__lnkMailer && global.__lnkMailer.ready && global.__lnkMailer.ready())) ? `<label class="ck"><input type="checkbox" name="alsoEmail" value="1"> Poslať aj e-mailom na ${esc(f.email)}</label>` : (f.email ? '<p class="hint">E-mail je vyplnený, ale odosielanie e-mailov nie je nastavené (Admin → Odosielanie e-mailov).</p>' : '<p class="hint">Zákazník e-mail nevyplnil – údaje uvidí v súkromnom okne (odkaz / meno + kontakt).</p>');
    res.send(page('Objednávka ' + o.orderId, `<h1>Objednávka ${esc(o.orderId)}</h1>${m}
<p class="row"><a class="btnl" href="/admin/objednavky">← Zoznam</a></p>
<div class="card"><p>Suma: <b>${esc(o.amountExact || o.amountEur || '—')} €</b> · Stav: ${esc(o.status || '')}</p>
<p>Meno: <b>${esc(f.username || '—')}</b><br>Kontakt: ${esc(contact)}</p>
${f.submittedAt ? `<p class="hint">Formulár odoslaný ${esc(f.submittedAt)}. Súkromné okno: <a href="${esc(pathFor(o))}" target="_blank" rel="noopener">${esc(pathFor(o))}</a></p>
<form method="post" action="/admin/objednavky/${esc(o.orderId)}/udaje">${hid(req)}
<label>Prihlasovacie údaje pre zákazníka (uložia sa šifrovane)</label>
<textarea name="text" rows="6" maxlength="4000" required placeholder="Napr. meno a heslo k predplatnému"></textarea>
${mailOpt}
<button>Odoslať do okna zákazníka</button>
</form>${f.credSentAt ? `<p class="hint">Naposledy odoslané: ${esc(f.credSentAt)}</p>` : ''}` : '<p class="hint">Zákazník ešte nevyplnil meno a kontakt – okno sa otvorí po potvrdení platby.</p>'}
</div>`, 'a adm'));
  }));
  admin.post('/objednavky/:id/udaje', needAuth, csrf, wrap(async (req, res) => {
    const orders = loadOrders(); const o = orders[req.params.id];
    if (!o) return res.redirect(303, '/admin/objednavky');
    const r = deliver({ order: o, text: req.body && req.body.text, alsoEmail: !!(req.body && req.body.alsoEmail) }, req);
    if (r.error) return res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent(r.error));
    saveOrders(orders);
    res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=ok');
  }));
}

module.exports.mountAdmin = mountAdmin;
