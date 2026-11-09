'use strict';
/**
 * Before payment: contact + site password, then Software username(s) (renew vs new; 2 for
 * two-device packages). Site login = e-mail or the first Software username + password.
 * Ryan is notified on the payments Telegram bot (reply with text/photo to fulfil).
 * Credentials + screenshots are sealed (AES-256-GCM) and shown on /ucet and the token link.
 */
const crypto = require('crypto');
const sealed = require('./sealedStore');
const soft = require('./softUser');
const panelOcr = require('./panelOcr');

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

const CHECKOUT_USER_RE = soft.NEW_RE;
function slotsFromBody(b) {
  if (Array.isArray(b && b.slots) && b.slots.length) return b.slots;
  const intent = b && String(b.intent || '').toLowerCase() === 'renew' ? 'renew' : 'new';
  const a = [];
  if (b && (b.username || b.softwareUsername)) a.push({ intent: b.intent1 || intent, username: b.softwareUsername || b.username });
  if (b && (b.username2 || b.softwareUsername2)) a.push({ intent: b.intent2 || intent, username: b.softwareUsername2 || b.username2 });
  return a;
}

function validateCheckout(b, opts = {}) {
  const want = (opts && opts.devices >= 2) ? 2 : 1;
  const sl = soft.validateSlots(slotsFromBody(b || {}), want);
  if (sl.error) return sl;
  const c = validateContact(b || {});
  if (c.error) return c;
  const username = soft.siteUsernameFromSlots(sl.slots) || sl.slots[0].username.toLowerCase();
  if (!CHECKOUT_USER_RE.test(username)) {
    return { error: 'Prvé Software username slúži aj ako prihlásenie na stránku (8–24 znakov, malé písmená). U nového mena použite Vygenerovať, alebo zadajte aj e-mail.' };
  }
  return { username, slots: sl.slots, intent: sl.slots[0].intent, contact: c.contact };
}

function validatePassword(pw, pw2, username) {
  const p = String(pw == null ? '' : pw);
  const u = String(username || '').toLowerCase();
  if (p.length < 8 || Buffer.byteLength(p) > 72 || (u && p.toLowerCase() === u)) {
    return { error: 'Heslo musí mať 8–72 znakov a nesmie byť rovnaké ako používateľské meno.' };
  }
  if (String(pw2 == null ? '' : pw2) !== p) return { error: 'Heslá sa nezhodujú.' };
  return { ok: true };
}

function isPaid(o) {
  if (!o) return false;
  const st = String(o.status || '').toLowerCase();
  return PAID.has(st) || o.chainStatus === 'confirmed' || !!o.paidAt;
}

/** Auto-confirmed by a detected payment, or confirmed by Ryan in admin. */
function isConfirmed(o) {
  if (!o) return false;
  if (o.confirmedAt || o.adminConfirmed || (o.fulfill && o.fulfill.confirmedAt)) return true;
  return isPaid(o);
}

function confirm(order, by) {
  if (!order) return order;
  const at = new Date().toISOString();
  order.confirmedAt = order.confirmedAt || at;
  order.adminConfirmed = true;
  order.confirmedBy = by || 'admin';
  const f = ensure(order);
  f.confirmedAt = f.confirmedAt || at;
  return order;
}

function statusLabel(o) {
  if (o && o.fulfill && o.fulfill.credSentAt) return { key: 'sent', sk: 'údaje odoslané', en: 'login details sent' };
  if (isConfirmed(o)) return { key: 'confirmed', sk: 'potvrdená', en: 'confirmed' };
  return { key: 'pending', sk: 'čaká na platbu', en: 'awaiting payment' };
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

function applyCheckout(order, v, extra = {}) {
  if (!order || !v || !v.username || !v.contact) return null;
  const f = ensure(order);
  const first = !f.submittedAt;
  const slots = (v.slots && v.slots.length) ? v.slots : [{ intent: v.intent || 'new', username: v.username }];
  Object.assign(f, {
    username: slots[0].username,
    slots,
    intent: slots[0].intent,
    email: v.contact.email || f.email,
    telegram: v.contact.telegram || f.telegram,
    facebook: v.contact.facebook || f.facebook,
    submittedAt: f.submittedAt || new Date().toISOString(),
    source: f.source || 'checkout',
    messages: f.messages || [],
  });
  if (v.contact.email && !order.email) order.email = v.contact.email;
  if (extra.acct && extra.acct.id) {
    if (!order.acct) order.acct = { id: extra.acct.id, u: extra.acct.u || extra.acct.username };
    f.accountId = extra.acct.id;
  }
  if (first) {
    const who = [f.email, f.telegram, f.facebook].filter(Boolean).join(', ');
    const amt = extra.amount != null ? extra.amount : (order.amountExact || order.amountEur || '');
    const method = extra.provider || order.providerAlias || order.provider || order.methodId || '';
    const typ = soft.intentLabel(slots);
    const users = soft.formatSlotsLine(slots);
    const text = `🆕 Nová objednávka (pred platbou)\nObjednávka: ${order.orderId}\nTyp: ${typ}\nSoftware username: ${users}\nKontakt: ${who}\nSuma: ${amt} €\nMetóda: ${method}\n\nOdpovedzte na túto správu textom (údaje, dátum, pokyny) a/alebo fotkou z panela – zákazník to uvidí vo svojom účte.\nAlebo /admin/objednavky/${order.orderId}`;
    // Prefer the payments bot so Ryan can Reply on the same message (inline Potvrdiť / Zamietnuť).
    const sent = (() => { try { const b = global.__telegramBot; if (b && b.notifyFulfillOrder) { Promise.resolve(b.notifyFulfillOrder(order, text)).catch(() => notify(text)); return true; } } catch {} return false; })();
    if (!sent) notify(text);
  }
  return f;
}

function ordersForEmail(orders, email) {
  const e = normEmail(email);
  if (!EMAIL_RE.test(e)) return [];
  return Object.values(orders || {}).filter((o) => o && o.fulfill && o.fulfill.email === e);
}

function linkToVerifiedAccount(orders, user) {
  if (!user || !user.email_verified || !user.email) return { list: [], changed: 0 };
  const list = ordersForEmail(orders, user.email);
  let changed = 0;
  for (const o of list) {
    if (!o.acct || !o.acct.id) { o.acct = { id: user.id, u: user.username }; changed++; }
    if (o.fulfill) o.fulfill.accountId = user.id;
  }
  return { list, changed };
}

function accountOrderView(order, req) {
  if (!order) return null;
  const f = order.fulfill || {};
  const st = statusLabel(order);
  const confirmed = isConfirmed(order);
  return {
    orderId: order.orderId,
    amount: order.amountExact || order.amountEur || null,
    status: st.sk,
    statusEn: st.en,
    statusKey: st.key,
    paid: isPaid(order),
    confirmed,
    username: f.username || '',
    slots: Array.isArray(f.slots) ? f.slots : (f.username ? [{ intent: f.intent || 'new', username: f.username }] : []),
    intent: f.intent || '',
    path: pathFor(order),
    url: urlFor(order, req),
    createdAt: order.createdAt || f.submittedAt || '',
    credSent: !!f.credSentAt,
  };
}

function listAccountOrders(orders, user, req) {
  if (!user || !user.id) return [];
  return Object.values(orders || {}).filter((o) => o && ((o.acct && o.acct.id === user.id) || (o.fulfill && o.fulfill.accountId === user.id)))
    .sort((a, b) => String(b.createdAt || (b.fulfill && b.fulfill.submittedAt) || '').localeCompare(String(a.createdAt || (a.fulfill && a.fulfill.submittedAt) || '')))
    .map((o) => accountOrderView(o, req));
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
  return pageShell('Údaje k predplatnému', `<div class="card"><h1>Doplňte meno a kontakt</h1>
<p>Pri tejto staršej objednávke ešte chýba používateľské meno (min. 8 znakov) a aspoň jeden kontakt – e-mail, Telegram alebo Facebook. Sem ti pošleme prihlasovacie údaje. K oknu sa viete vrátiť cez súkromný odkaz, alebo zadaním mena a toho istého kontaktu.</p>
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

function slotList(order) {
  const f = order && order.fulfill;
  if (f && Array.isArray(f.slots) && f.slots.length) return f.slots;
  if (f && f.username) return [{ intent: f.intent || 'new', username: f.username }];
  return [];
}

function daysPhrase(until) {
  const n = soft.daysLeft(until);
  if (n == null) return '';
  if (n < 0) return `Vypršalo pred ${-n} d.`;
  if (n === 0) return 'Platí do dnes';
  return `Zostáva ${n} d.`;
}

function cardHtml(card, shotUrl) {
  if (!card) return '';
  const pw = card.password || (card.passEnc ? openCreds(card.passEnc) : '');
  const until = card.until || '';
  const days = until ? daysPhrase(until) : '';
  return `<div class="msg creds"><b>Prihlasovacie údaje do Software (TV)</b>
${card.username ? `Username: <b>${esc(card.username)}</b>\n` : ''}${pw ? `Heslo / password: <b>${esc(pw)}</b>\n` : ''}${until ? `Platné do: <b>${esc(until)}</b>${days ? ' · ' + esc(days) : ''}\n` : ''}${shotUrl ? `</div><p><img src="${esc(shotUrl)}" alt="Screenshot z panela" style="max-width:100%;border-radius:12px;border:1px solid #243044">` : ''}</div>`;
}

function renderMessages(order, req) {
  const f = order.fulfill || {};
  const base = pathFor(order);
  return (f.messages || []).map((m, i) => {
    if (m.type === 'creds') {
      const t = openCreds(m.credEnc) || '(údaje sa nepodarilo zobraziť)';
      return `<div class="msg creds"><b>Prihlasovacie údaje</b>\n${esc(t)}</div>`;
    }
    if (m.type === 'credsCard' || m.type === 'shot') {
      const card = Object.assign({}, m.card || {}, { password: m.card && m.card.passEnc ? openCreds(m.card.passEnc) : (m.card && m.card.password) || '' });
      const shotUrl = (m.type === 'shot' && m.shotEnc) ? `${base}/foto/${i}` : '';
      return cardHtml(card, shotUrl);
    }
    const text = m.textEnc ? (openCreds(m.textEnc) || '') : (m.text || '');
    return `<div class="msg ${m.from === 'admin' ? 'admin' : ''}">${esc(text)}</div>`;
  }).join('');
}

function chatHtml(order, req, flash) {
  const f = order.fulfill || {};
  const msgs = renderMessages(order, req);
  const st = statusLabel(order);
  const softLine = slotList(order).map((s) => `${s.username} (${s.intent === 'renew' ? 'predĺženie' : 'nový'})`).join(', ') || f.username || '';
  return pageShell('Vaše údaje k predplatnému', `<div class="card"><h1>Okno k objednávke</h1>
${flash ? `<div class="ok">${esc(flash)}</div>` : ''}
<p>Stav: <b>${esc(st.sk)}</b> <span class="hint">/ ${esc(st.en)}</span></p>
<p>Software username: <b>${esc(softLine)}</b></p>
<p class="hint">Tieto údaje sú do TV Software, nie na prihlásenie na našu stránku. Na stránku sa hlásite e-mailom alebo týmto menom a heslom, ktoré ste si nastavili pred platbou.</p>
<p class="hint">Uložte si tento súkromný odkaz – kedykoľvek sa sem viete vrátiť:<br><a class="link" href="${esc(urlFor(order, req))}">${esc(urlFor(order, req))}</a></p>
<div class="msgs">${msgs || '<p class="hint">Zatiaľ tu nie sú prihlasovacie údaje. Akonáhle ich odošleme (alebo príde odpoveď v Telegrame), uvidíte ich na tomto mieste.</p>'}</div>
<form method="post" action="${esc(pathFor(order))}/sprava">
<label for="t">Správa pre podporu (voliteľné)</label>
<textarea id="t" name="text" rows="3" maxlength="2000" required></textarea>
<button class="g">Odoslať správu</button>
</form>
</div>`);
}

function returnHtml(err, flash) {
  return pageShell('Návrat k údajom', `<div class="card"><h1>Vrátiť sa k oknu s údajmi</h1>
<p>Zadajte to isté používateľské meno a ten istý kontakt, ktorý ste zadali pred platbou.</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
${flash ? `<div class="ok">${esc(flash)}</div>` : ''}
<form method="post" action="/objednavka/navrat">
<label>Používateľské meno</label><input name="username" required minlength="8" maxlength="64" pattern="[A-Za-z0-9._\\-]{8,64}" autocapitalize="none" spellcheck="false">
<label>E-mail</label><input name="email" type="email" maxlength="254">
<label>Telegram</label><input name="telegram" maxlength="200" placeholder="@meno" autocapitalize="none">
<label>Facebook</label><input name="facebook" maxlength="200">
<p class="hint">Pre Telegram alebo Facebook je meno + tento kontakt povinné (alebo použite súkromný odkaz).</p>
<button>Otvoriť okno</button>
</form>
${mailReady() ? `<hr style="border:0;border-top:1px solid #243044;margin:22px 0">
<p>Máte e-mail? Pošleme vám jednorazový kód a odkaz – samotný e-mail na otvorenie okna nestačí.</p>
<form method="post" action="/objednavka/navrat-email">
<label>E-mail z objednávky</label><input name="email" type="email" required maxlength="254" autocomplete="email">
<button class="g">Poslať jednorazový odkaz / kód</button>
</form>
<form method="post" action="/objednavka/navrat-kod" style="margin-top:12px">
<label>Už máte kód z e-mailu?</label><input name="email" type="email" required maxlength="254" placeholder="ten istý e-mail">
<input name="code" inputmode="numeric" maxlength="6" minlength="6" pattern="[0-9]{6}" placeholder="6-miestny kód">
<button class="g">Overiť kód</button>
</form>` : '<p class="hint">Odosielanie e-mailov nie je nastavené – návrat je možný menom a kontaktom, alebo súkromným odkazom.</p>'}
</div>`);
}

function findByToken(orders, token) {
  if (!TOKEN_RE.test(token)) return null;
  return Object.values(orders || {}).find((o) => o && o.fulfill && o.fulfill.token === token) || null;
}

function mount(app, { loadOrders, saveOrders, appendLog = () => {} }) {
  const load = () => loadOrders();
  const save = (o) => saveOrders(o);
  startShotSweep({ loadOrders: load, saveOrders: save, appendLog });

  app.get('/objednavka/navrat', (req, res) => { res.set('Cache-Control', 'no-store'); res.redirect(302, '/prihlasenie?next=/ucet'); });
  app.post('/objednavka/navrat', (req, res) => { res.set('Cache-Control', 'no-store'); res.redirect(303, '/prihlasenie?next=/ucet'); });

  app.get('/objednavka/:token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const o = findByToken(load(), req.params.token);
    if (!o) return res.status(404).type('html').send(pageShell('Nenájdené', '<div class="card"><h1>Odkaz je neplatný</h1><p>Skúste <a href="/objednavka/navrat" style="color:#93c5fd">návrat cez meno a kontakt</a>.</p></div>'));
    const f = ensure(o);
    if (!isPaid(o)) {
      const st = statusLabel(o);
      const who = f.submittedAt ? `<p>Meno: <b>${esc(f.username || '')}</b></p>` : '';
      return res.status(403).type('html').send(pageShell('Čaká sa na platbu', `<div class="card"><h1>Platba ešte nie je potvrdená</h1><p>Stav: <b>${esc(st.sk)}</b> <span class="hint">/ ${esc(st.en)}</span></p>${who}<p>Toto okno s prihlasovacími údajmi sa otvorí po potvrdení platby. Uložte si súkromný odkaz, alebo sa prihláste na stránke (Prihlásenie / Moja objednávka).</p><p class="hint"><a class="link" href="${esc(urlFor(o, req))}">${esc(urlFor(o, req))}</a></p><p class="hint"><a class="link" href="/prihlasenie?next=/ucet">Prihlásenie</a></p></div>`));
    }
    if (!f.submittedAt) return res.type('html').send(formHtml(o, '', req));
    res.type('html').send(chatHtml(o, req));
  });

  app.get('/objednavka/:token/foto/:i', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    const o = findByToken(load(), req.params.token);
    if (!o || !isConfirmed(o)) return res.status(404).end();
    const m = (o.fulfill && o.fulfill.messages || [])[Number(req.params.i)];
    const ph = photoBytes(m);
    if (!ph) return res.status(404).end();
    res.type(ph.mime).send(ph.buf);
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


function photoBytes(m) {
  if (!m || !m.shotEnc) return null;
  const raw = openCreds(m.shotEnc);
  if (!raw) return null;
  return { mime: m.mime || 'image/jpeg', buf: Buffer.from(raw, 'base64') };
}

function applyExpiry(order, card) {
  if (!card || !card.until) return;
  const until = soft.untilEnd(card.until);
  if (!until) return;
  const user = card.username || (order.fulfill && order.fulfill.username);
  try {
    const A = global.__lnkAccounts;
    if (A && typeof A.applySoftwareExpiry === 'function') {
      Promise.resolve(A.applySoftwareExpiry({
        username: user,
        until,
        userId: (order.acct && order.acct.id) || (order.fulfill && order.fulfill.accountId) || null,
        orderId: order.orderId,
      })).catch(() => {});
    }
  } catch { /* accounts optional */ }
}

function customerNotify(order, req, summary) {
  const f = order && order.fulfill;
  if (f && f.email) {
    const link = urlFor(order, req);
    sendMail(f.email, 'Prihlasovacie údaje k predplatnému', `Dobrý deň ${f.username || ''},\n\nprihlasovacie údaje (a prípadný screenshot) sú vo vašom účte a v súkromnom okne:\n${link}\n\n${summary || ''}\n`).catch(() => {});
    f.credEmailedAt = new Date().toISOString();
  }
  // Telegram to the customer only if they already started the payments/support bot (we have a chat id).
}

function latestUntilForUser(orders, username) {
  const u = String(username || '').toLowerCase();
  if (!u) return '';
  let best = '';
  const consider = (until) => {
    const day = soft.parseDate(until) || (String(until || '').slice(0, 10));
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day > best) best = day;
  };
  for (const o of Object.values(orders || {})) {
    const f = o && o.fulfill;
    if (!f) continue;
    for (const s of [...(f.lines || []), ...(f.slots || [])]) {
      if (s && s.username && String(s.username).toLowerCase() === u) consider(s.until);
    }
    for (const m of f.messages || []) {
      const c = m && m.card;
      if (c && c.username && String(c.username).toLowerCase() === u) consider(c.until);
    }
  }
  try {
    const A = global.__lnkAccounts;
    if (A && typeof A.softwareByName === 'function') {
      const row = A.softwareByName(u);
      if (row && typeof row.then !== 'function') consider(row.until_at || row.until);
    }
  } catch { /* optional */ }
  return best;
}

function findLatestCreds(orders, username) {
  const u = String(username || '').toLowerCase();
  const out = { username: username || '', password: '', passEnc: '', until: '' };
  if (!u) return out;
  let bestAt = '';
  const take = (c, at) => {
    if (!c) return;
    const when = String(at || '');
    if (c.until) {
      const day = soft.parseDate(c.until) || String(c.until).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= (out.until || '')) out.until = day;
    }
    const hasPw = !!(c.passEnc || c.password);
    if (hasPw && when >= bestAt) {
      bestAt = when;
      if (c.passEnc) { out.passEnc = c.passEnc; out.password = ''; }
      else if (c.password) { out.password = c.password; out.passEnc = ''; }
    }
  };
  for (const o of Object.values(orders || {})) {
    const f = o && o.fulfill;
    if (!f) continue;
    for (const s of [...(f.lines || []), ...(f.slots || [])]) {
      if (s && s.username && String(s.username).toLowerCase() === u) take(s, f.credSentAt || o.updatedAt || '');
    }
    for (const m of f.messages || []) {
      const c = m && m.card;
      if (c && c.username && String(c.username).toLowerCase() === u) take(c, m.at || '');
    }
  }
  return out;
}

function shotUsername(order, m) {
  if (m && m.card && m.card.username) return String(m.card.username).trim();
  const slots = slotList(order);
  if (slots.length === 1 && slots[0].username) return String(slots[0].username).trim();
  return '';
}

function removeShotBlobsForUser(orders, username, except) {
  const u = String(username || '').toLowerCase();
  if (!u) return 0;
  let n = 0;
  const exId = except && except.id;
  const exOrder = except && except.orderId;
  for (const o of Object.values(orders || {})) {
    const msgs = o && o.fulfill && o.fulfill.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!m || m.type !== 'shot' || !m.shotEnc) continue;
      if (exId && m.id === exId && o.orderId === exOrder) continue;
      const mu = String(shotUsername(o, m) || '').toLowerCase();
      if (mu !== u) continue;
      delete m.shotEnc;
      delete m.mime;
      m.shotReplacedAt = new Date().toISOString();
      n++;
    }
  }
  return n;
}

function scrubDrafts(order) {
  const d = order && order.fulfill && order.fulfill.drafts;
  if (!d) return false;
  let changed = false;
  for (const k of Object.keys(d)) {
    const row = d[k];
    if (!row || typeof row !== 'object') continue;
    if (row.password) {
      try { row.passEnc = sealCreds(row.password); row.hasPass = true; } catch { /* keep drop */ }
      delete row.password;
      changed = true;
    }
  }
  return changed;
}

const fulfillCfg = sealed.create('fulfill-settings', { shotRetainDays: 90, lastSweepAt: '' });
let retainDaysVal = 90;
function clampRetain(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 90;
  return Math.min(90, Math.max(60, v));
}
function retainDays() { return retainDaysVal; }
function setRetainDays(n) { retainDaysVal = clampRetain(n == null ? 90 : n); return retainDaysVal; }

function sweepExpiredShots(orders, now) {
  const when = now instanceof Date ? now : new Date(now || Date.now());
  const days = retainDays();
  const ms = days * 86400e3;
  let n = 0;
  const latest = Object.create(null);
  const bump = (username, until) => {
    const u = String(username || '').toLowerCase();
    const day = soft.parseDate(until) || String(until || '').slice(0, 10);
    if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (!latest[u] || day > latest[u]) latest[u] = day;
  };
  for (const o of Object.values(orders || {})) {
    const f = o && o.fulfill;
    if (!f) continue;
    for (const s of [...(f.lines || []), ...(f.slots || [])]) if (s) bump(s.username, s.until);
    for (const m of f.messages || []) if (m && m.card) bump(m.card.username, m.card.until);
  }
  for (const o of Object.values(orders || {})) {
    const msgs = o && o.fulfill && o.fulfill.messages;
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      if (!m || m.type !== 'shot' || !m.shotEnc) continue;
      const u = shotUsername(o, m);
      const until = (u && latest[String(u).toLowerCase()]) || (m.card && m.card.until) || '';
      const end = soft.untilEnd(until);
      if (!end) continue;
      if (when.getTime() < end.getTime() + ms) continue;
      delete m.shotEnc;
      delete m.mime;
      m.shotPurgedAt = when.toISOString();
      n++;
    }
  }
  return { n, days };
}

function startShotSweep({ loadOrders, saveOrders, appendLog = () => {} } = {}) {
  const tick = async () => {
    try {
      await fulfillCfg.load().catch(() => {});
      retainDaysVal = clampRetain((fulfillCfg.get() || {}).shotRetainDays);
      const last = (fulfillCfg.get() || {}).lastSweepAt;
      if (last && Date.now() - Date.parse(last) < 20 * 3600e3) return;
      const orders = loadOrders ? loadOrders() : {};
      const r = sweepExpiredShots(orders);
      if (r.n) {
        if (saveOrders) saveOrders(orders);
        appendLog('SHOT_SWEEP purged=' + r.n + ' days=' + r.days);
      }
      await fulfillCfg.save({ lastSweepAt: new Date().toISOString(), shotRetainDays: retainDaysVal }).catch(() => {});
    } catch (e) { appendLog('SHOT_SWEEP_ERR ' + ((e && e.message) || 'fail')); }
  };
  fulfillCfg.load().then(() => { retainDaysVal = clampRetain((fulfillCfg.get() || {}).shotRetainDays); }).catch(() => {});
  setTimeout(tick, Number(process.env.SHOT_SWEEP_FIRST_MS) || 180e3).unref();
  setInterval(tick, 6 * 3600e3).unref();
}

async function attachDelivery(order, { text, photo, extracted, via, autoConfirm, orders } = {}, req) {
  if (!order) return { error: 'Objednávka sa nenašla.' };
  const f = ensure(order);
  if (autoConfirm || via === 'telegram') confirm(order, via || 'telegram');
  if (!isConfirmed(order)) return { error: 'Objednávka ešte nie je potvrdená.' };
  const at = new Date().toISOString();
  f.messages = f.messages || [];
  const bag = orders && typeof orders === 'object' ? orders : { [order.orderId]: order };
  if (!bag[order.orderId]) bag[order.orderId] = order;
  const cap = String(text || '').trim();
  let card = extracted ? { username: extracted.username || '', password: extracted.password || '', until: extracted.until || extracted.expiry || '' } : { username: '', password: '', until: '' };
  const fromText = cap ? soft.parseCredsFromText(cap) : { username: '', password: '', until: '', notes: '', expiryOnly: false };
  if (!card.username) card.username = fromText.username;
  if (!card.password) card.password = fromText.password;
  if (!card.until) card.until = fromText.until;
  let expiryOnly = !!(fromText.expiryOnly && !card.password && !(extracted && extracted.password));
  if (photo && !extracted && !card.username && !card.password && card.until) expiryOnly = true;
  if (!card.username) {
    const slots = slotList(order);
    if (slots.length === 1) card.username = slots[0].username || '';
    else if (expiryOnly && slots[0]) card.username = slots[0].username || f.username || '';
  }
  if (expiryOnly || (card.until && !card.password && !fromText.password && !(extracted && extracted.password))) {
    const prev = findLatestCreds(bag, card.username || (f.username || ''));
    if (!card.username && prev.username) card.username = prev.username;
    if (!card.password && !card.passEnc) {
      if (prev.passEnc) card.passEnc = prev.passEnc;
      else if (prev.password) card.password = prev.password;
    }
    if (!card.password && !extracted) expiryOnly = true;
  }
  const textToStore = (fromText.username || fromText.password || fromText.expiryOnly) ? String(fromText.notes || '').trim() : cap;
  if (textToStore) {
    f.messages.push({ id: crypto.randomBytes(8).toString('hex'), at, from: 'admin', type: 'text', textEnc: sealCreds(textToStore) });
  }
  let newShot = null;
  if (photo && photo.buf && photo.buf.length) {
    if (!extracted) {
      try {
        const got = await panelOcr.extractFromImage(photo.buf, photo.mime, cap);
        if (!card.username) card.username = got.username;
        if (!card.password) card.password = got.password;
        if (!card.until) card.until = got.until;
        card.source = got.source;
        card.ocrError = got.error || '';
        if (!card.username && !card.password && card.until) {
          expiryOnly = true;
          const slots = slotList(order);
          if (!card.username && slots[0]) card.username = slots[0].username || '';
          const prev = findLatestCreds(bag, card.username);
          if (prev.passEnc) card.passEnc = prev.passEnc;
          else if (prev.password) card.password = prev.password;
        }
      } catch (e) { card.ocrError = e.message; }
    }
    const c = await panelOcr.compress(photo.buf, photo.mime || panelOcr.sniff(photo.buf));
    newShot = {
      id: crypto.randomBytes(8).toString('hex'), at, from: 'admin', type: 'shot',
      mime: c.mime, shotEnc: sealCreds(c.buf.toString('base64')),
      card: { username: card.username || '', until: card.until || '', passEnc: card.password ? sealCreds(card.password) : (card.passEnc || '') },
    };
    f.messages.push(newShot);
    const u = card.username || shotUsername(order, newShot);
    if (u) removeShotBlobsForUser(bag, u, { id: newShot.id, orderId: order.orderId });
  } else if (card.username || card.password || card.passEnc || card.until) {
    f.messages.push({
      id: crypto.randomBytes(8).toString('hex'), at, from: 'admin', type: 'credsCard',
      card: { username: card.username || '', until: card.until || '', passEnc: card.password ? sealCreds(card.password) : (card.passEnc || '') },
    });
  }
  if (card.until || card.username || card.password || card.passEnc) {
    f.lines = slotList(order).map((s) => ({ ...s }));
    const hit = f.lines.find((s) => card.username && s.username.toLowerCase() === String(card.username).toLowerCase()) || f.lines[0];
    if (hit) {
      if (card.username) hit.username = card.username;
      if (card.until) hit.until = card.until;
      if (card.password) hit.passEnc = sealCreds(card.password);
      else if (card.passEnc) hit.passEnc = card.passEnc;
    }
  }
  f.credSentAt = at;
  if (card.until) applyExpiry(order, card);
  customerNotify(order, req, [card.username && ('Username: ' + card.username), card.until && ('Platné do: ' + card.until)].filter(Boolean).join('\n'));
  notify(`🔑 Údaje odoslané pre ${f.username || order.orderId} (${order.orderId})` + (via ? ' cez ' + via : ''));
  return { ok: true, card, confirmed: isConfirmed(order), expiryOnly: !!expiryOnly };
}


function setLineUntil(order, until, username) {
  const day = soft.parseDate(until) || (String(until || '').slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'Neplatný dátum. Použite napr. 15.11.2026.' };
  const f = ensure(order);
  for (const m of f.messages || []) {
    if (m.card && (!username || !m.card.username || m.card.username.toLowerCase() === String(username).toLowerCase())) m.card.until = day;
  }
  applyExpiry(order, { username: username || f.username, until: day });
  return { ok: true, until: day };
}

function deliver({ order, text, alsoEmail }, req) {
  const body = clean(text, 4000);
  if (!body) return { error: 'Napíšte prihlasovacie údaje.' };
  if (!isConfirmed(order)) return { error: 'Objednávka ešte nie je potvrdená.' };
  if (!order || !order.fulfill || !order.fulfill.submittedAt) return { error: 'Zákazník ešte neodoslal meno a kontakt.' };
  let enc;
  try { enc = sealCreds(body); } catch (e) { return { error: e.message || 'Chýba šifrovací kľúč (DATA_ENC_KEY).' }; }
  order.fulfill.messages = order.fulfill.messages || [];
  order.fulfill.messages.push({ id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), from: 'admin', type: 'creds', credEnc: enc });
  const parsed = soft.parseCredsFromText(body);
  if (parsed.username || parsed.password || parsed.until) {
    order.fulfill.messages.push({
      id: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString(), from: 'admin', type: 'credsCard',
      card: { username: parsed.username || '', until: parsed.until || '', passEnc: parsed.password ? sealCreds(parsed.password) : '' },
    });
    if (parsed.until) applyExpiry(order, parsed);
  }
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
  USER_RE, CHECKOUT_USER_RE, EMAIL_RE, validateFulfill, validateCheckout, validateContact, validatePassword,
  isPaid, isConfirmed, confirm, statusLabel, ensure, findByReturn, findByToken,
  applyCheckout, ordersForEmail, linkToVerifiedAccount, accountOrderView, listAccountOrders,
  mailReady, sealCreds, openCreds, pathFor, urlFor, paidUrl, deliver, attachDelivery, setLineUntil,
  slotList, renderMessages, cardHtml, photoBytes, daysPhrase, applyExpiry,
  adminList, mount, contactMatches,
  findLatestCreds, latestUntilForUser, removeShotBlobsForUser, sweepExpiredShots,
  retainDays, setRetainDays, clampRetain, scrubDrafts, startShotSweep,
};

function mountAdmin(admin, { needAuth, csrf, wrap, page, hid, esc, loadOrders, saveOrders }) {
  const listPage = (req, res) => {
    const rows = adminList(loadOrders());
    const tr = rows.map((o) => {
      const f = o.fulfill || {};
      const st = statusLabel(o).sk;
      const contact = [f.email, f.telegram, f.facebook].filter(Boolean).join(' · ') || '—';
      const names = (Array.isArray(f.slots) && f.slots.length ? f.slots.map((s)=>s.username) : [f.username]).filter(Boolean).join(', ') || '—';
      return `<tr><td><a href="/admin/objednavky/${esc(o.orderId)}">${esc(o.orderId)}</a></td><td>${esc(o.amountExact || o.amountEur || '—')} €</td><td>${esc(names)}</td><td>${esc(contact)}</td><td>${esc(st)}</td></tr>`;
    }).join('') || '<tr><td colspan="5">Zatiaľ žiadne objednávky s údajmi.</td></tr>';
    res.send(page('Objednávky a prihlásenie', `<h1>📦 Objednávky a prihlásenie</h1>
<p class="hint">Meno, kontakt a heslo zadá zákazník ešte pred platbou. Hlavný spôsob plnenia: odpoveď v Telegrame na notifikáciu objednávky. Prihlasovacie údaje odošlete až po potvrdení. Údaje sú šifrované. Snímka sa u zákazníka zobrazí, kým predplatné nepredĺži – potom sa fotka zmaže až po nastavenom počte dní od dátumu expirácie (text a údaje ostávajú).</p>
<form method="post" action="/admin/objednavky/nastavenia" class="card" style="margin-bottom:14px">${hid(req)}
<label>Zmazať snímky predplatného (len fotky) toľko dní po expirácii, ak účet nie je predĺžený (60–90, predvolené 90)</label>
<input name="shotRetainDays" type="number" min="60" max="90" step="1" value="${esc(String(retainDays()))}" style="max-width:8rem">
<button class="sm">Uložiť</button>
</form>
<div class="card" style="overflow:auto"><table class="tbl"><thead><tr><th>Objednávka</th><th>Suma</th><th>Meno</th><th>Kontakt</th><th>Stav</th></tr></thead><tbody>${tr}</tbody></table></div>`, 'a adm'));
  };
  admin.get('/objednavky', needAuth, wrap(async (req, res) => listPage(req, res)));
  admin.get('/objednavky/:id', needAuth, wrap(async (req, res) => {
    const orders = loadOrders();
    const o = orders[req.params.id];
    if (!o) return res.status(404).send(page('Nenájdené', '<h1>Objednávka sa nenašla</h1><p><a href="/admin/objednavky">← Zoznam</a></p>', 'a adm'));
    if (scrubDrafts(o)) saveOrders(orders);
    const f = o.fulfill || {};
    const st = statusLabel(o);
    const m = req.query.m === 'ok' ? '<div class="msg">Údaje boli odoslané do okna zákazníka.</div>' : (req.query.m === 'conf' ? '<div class="msg">Objednávka bola potvrdená.</div>' : (req.query.m && req.query.m !== 'ok' && req.query.m !== 'conf' ? `<div class="msg err">${esc(req.query.m)}</div>` : ''));
    const contact = [f.email, f.telegram, f.facebook].filter(Boolean).join(' · ') || '—';
    const mailOpt = (f.email && (global.__lnkMailer && global.__lnkMailer.ready && global.__lnkMailer.ready())) ? `<label class="ck"><input type="checkbox" name="alsoEmail" value="1"> Poslať aj e-mailom na ${esc(f.email)}</label>` : (f.email ? '<p class="hint">E-mail je vyplnený, ale odosielanie e-mailov nie je nastavené (Admin → Odosielanie e-mailov).</p>' : '<p class="hint">Zákazník e-mail nevyplnil – údaje uvidí v súkromnom okne alebo po prihlásení.</p>');
    const confirmForm = !isConfirmed(o) ? `<form method="post" action="/admin/objednavky/${esc(o.orderId)}/potvrdit">${hid(req)}<p class="hint">Najprv objednávku potvrďte (ručne, ak ju systém ešte automaticky nepotvrdil po platbe). Až potom môžete odoslať prihlasovacie údaje.</p><button>Potvrdiť</button></form>` : '';
    const slots = slotList(o);
    const typ = soft.intentLabel(slots);
    const gem = panelOcr.geminiReady() ? 'Gemini OCR je zapnuté (kľúč v Admin → API kľúče).' : 'GEMINI_API_KEY nie je nastavený – snímku môžete nahrať, údaje dopíšte ručne (alebo doplňte kľúč; systém je autonómny na Renderi).';
    const slotForms = slots.map((s, i) => {
      const draft = (f.drafts && f.drafts[i]) || {};
      return `<div class="card" style="margin-top:12px"><h3>Zariadenie ${slots.length>1 ? (i+1)+' · ' : ''}${esc(s.username)}</h3>
<p class="hint">${s.intent === 'renew' ? 'Predĺženie existujúceho Software účtu' : 'Nový Software účet'} · toto je meno do TV Software, nie na prihlásenie na stránku.</p>
<form method="post" action="/admin/objednavky/${esc(o.orderId)}/udaje-slot" enctype="multipart/form-data">${hid(req)}
<input type="hidden" name="slot" value="${i}">
<label>Software username</label><input name="username" value="${esc(draft.username || s.username)}" maxlength="64" autocomplete="off">
<label>Heslo / password do Software</label>
<input type="hidden" name="passEnc" value="${esc(draft.passEnc || '')}">
<input name="password" type="password" maxlength="128" autocomplete="new-password" value="" placeholder="${draft.hasPass || draft.passEnc ? 'načítané z fotky (ponechajte prázdne alebo prepíšte)' : ''}">
${draft.hasPass || draft.passEnc ? '<p class="hint">Heslo z fotky je uložené šifrovane – pole nechajte prázdne, ak ho chcete ponechať.</p>' : ''}
<label>Platné do</label><input name="until" type="date" value="${esc((draft.until || s.until || '').slice(0,10))}">
<label>Screenshot z panela (voliteľné) – systém sa pokúsi vyčítať meno, heslo a dátum</label>
<input type="file" name="image" accept="image/png,image/jpeg,image/webp">
<p class="hint">${esc(gem)}</p>
<button name="act" value="ocr">Načítať z fotky</button>
<button name="act" value="send">Uložiť a odoslať zákazníkovi</button>
</form></div>`;
    }).join('');
    const sendForm = isConfirmed(o) && f.submittedAt ? `${slotForms}
<form method="post" action="/admin/objednavky/${esc(o.orderId)}/udaje">${hid(req)}
<label>Alebo voľný text (pokyny, údaje) – uloží sa šifrovane a uvidí ho zákazník</label>
<textarea name="text" rows="4" maxlength="4000" placeholder="Napr. inštalácia, meno, heslo, platné do 15.11.2027"></textarea>
${mailOpt}
<button>Odoslať text do okna zákazníka</button>
</form>${f.credSentAt ? `<p class="hint">Naposledy odoslané: ${esc(f.credSentAt)}</p>` : ''}
<p class="hint">Hlavný spôsob: odpoveď v Telegrame na notifikáciu objednávky (text a/alebo fotka). Tento formulár je záložný.</p>` : (isConfirmed(o) ? '<p class="hint">Pri tejto objednávke ešte chýba meno a kontakt (starší záznam).</p>' : '');
    res.send(page('Objednávka ' + o.orderId, `<h1>Objednávka ${esc(o.orderId)}</h1>${m}
<p class="row"><a class="btnl" href="/admin/objednavky">← Zoznam</a></p>
<div class="card"><p>Suma: <b>${esc(o.amountExact || o.amountEur || '—')} €</b> · Stav: <b>${esc(st.sk)}</b> (${esc(o.status || '')}) · Typ: ${esc(typ)}</p>
<p>Software username: <b>${esc(slots.map((s)=>s.username).join(', ') || f.username || '—')}</b><br>Kontakt: ${esc(contact)}</p>
${f.submittedAt ? `<p class="hint">Údaje zadané ${esc(f.submittedAt)}. Súkromné okno: <a href="${esc(pathFor(o))}" target="_blank" rel="noopener">${esc(pathFor(o))}</a></p>` : ''}
${confirmForm}${sendForm}
</div>`, 'a adm'));
  }));
  admin.post('/objednavky/nastavenia', needAuth, csrf, wrap(async (req, res) => {
    const v = setRetainDays(req.body && req.body.shotRetainDays);
    try { await fulfillCfg.save({ shotRetainDays: v }); } catch { /* file/db optional */ }
    res.redirect(303, '/admin/objednavky?m=ok');
  }));
  admin.post('/objednavky/:id/potvrdit', needAuth, csrf, wrap(async (req, res) => {
    const orders = loadOrders(); const o = orders[req.params.id];
    if (!o) return res.redirect(303, '/admin/objednavky');
    confirm(o, (req.adminSession && req.adminSession.email) || 'admin');
    saveOrders(orders);
    res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=conf');
  }));
  admin.post('/objednavky/:id/udaje', needAuth, csrf, wrap(async (req, res) => {
    const orders = loadOrders(); const o = orders[req.params.id];
    if (!o) return res.redirect(303, '/admin/objednavky');
    const r = deliver({ order: o, text: req.body && req.body.text, alsoEmail: !!(req.body && req.body.alsoEmail) }, req);
    if (r.error) return res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent(r.error));
    saveOrders(orders);
    res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=ok');
  }));
  const up = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 12, fieldSize: 8000 } }).single('image');
  admin.post('/objednavky/:id/udaje-slot', needAuth, (req, res, next) => up(req, res, (e) => (e ? res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent('Súbor je príliš veľký alebo neplatný (max 2 MB, PNG/JPEG/WebP).')) : next())), csrf, wrap(async (req, res) => {
    const orders = loadOrders(); const o = orders[req.params.id];
    if (!o) return res.redirect(303, '/admin/objednavky');
    const i = Number(req.body && req.body.slot) || 0;
    const act = String((req.body && req.body.act) || 'send');
    const username = String((req.body && req.body.username) || '');
    const password = String((req.body && req.body.password) || '');
    const until = String((req.body && req.body.until) || '');
    const file = req.file && req.file.buffer && req.file.buffer.length ? { buf: req.file.buffer, mime: require('./panelOcr').sniff(req.file.buffer) || req.file.mimetype } : null;
    if (file && file.mime === '') return res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent('Povolené sú len PNG, JPEG, WebP.'));
    if (act === 'ocr') {
      let extracted = { username, password, until: soft.parseDate(until) || until };
      if (file) {
        const got = await require('./panelOcr').extractFromImage(file.buf, file.mime, '');
        extracted = {
          username: got.username || username,
          password: got.password || password,
          until: got.until || soft.parseDate(until) || until,
        };
        if (got.error && !got.username && !got.password && !got.until) {
          return res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent(got.error));
        }
      }
      o.fulfill = o.fulfill || {};
      o.fulfill.drafts = o.fulfill.drafts || {};
      const draft = { username: extracted.username || '', until: extracted.until || '', hasPass: false };
      if (extracted.password) {
        try { draft.passEnc = sealCreds(extracted.password); draft.hasPass = true; } catch { /* drop plaintext */ }
      }
      o.fulfill.drafts[i] = draft;
      saveOrders(orders);
      return res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent('Načítané z fotky – skontrolujte a odošlite.'));
    }
    const draft = (o.fulfill && o.fulfill.drafts && o.fulfill.drafts[i]) || {};
    const pw = password || (draft.passEnc ? openCreds(draft.passEnc) : '') || ((req.body && req.body.passEnc) ? openCreds(req.body.passEnc) : '');
    const extracted = { username, password: pw, until: soft.parseDate(until) || until };
    const r = await attachDelivery(o, { text: '', photo: file, extracted, via: 'admin', autoConfirm: false, orders }, req);
    if (r.error) return res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=' + encodeURIComponent(r.error));
    if (o.fulfill && o.fulfill.drafts) delete o.fulfill.drafts[i];
    saveOrders(orders);
    res.redirect(303, '/admin/objednavky/' + encodeURIComponent(req.params.id) + '?m=ok');
  }));
  admin.get('/objednavky/:id/foto/:i', needAuth, wrap(async (req, res) => {
    const o = loadOrders()[req.params.id];
    const m = o && o.fulfill && o.fulfill.messages && o.fulfill.messages[Number(req.params.i)];
    const ph = photoBytes(m);
    if (!ph) return res.status(404).end();
    res.type(ph.mime).send(ph.buf);
  }));
}


module.exports.mountAdmin = mountAdmin;
