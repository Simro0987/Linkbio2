'use strict';
// Customer contact (required on every checkout): username, or Telegram / e-mail / Facebook.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

function clean(v, n) { return String(v == null ? '' : v).trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, n); }

function validateContact(b) {
  const src = (b && (b.contact || b)) || {};
  const username = clean(src.username, 64);
  const type = String(src.contactType || src.type || '').toLowerCase();
  const value = clean(src.contactValue || src.value, 200);
  if (username) {
    if (username.length < 2) return { error: 'Username je príliš krátky.' };
    return { contact: { username } };
  }
  if (!type || !value) return { error: 'Vyplňte Username, alebo kliknite „Nemám username“ a zadajte Telegram, e-mail alebo Facebook.' };
  if (type === 'email') {
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(value)) return { error: 'Zadajte platný e-mail.' };
    return { contact: { type, value } };
  }
  if (type === 'telegram') {
    const h = value.replace(/^https?:\/\/t\.me\//i, '').replace(/^@?/, '@');
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(h)) return { error: 'Zadajte Telegram v tvare @meno (5–32 znakov).' };
    return { contact: { type, value: h } };
  }
  if (type === 'facebook') {
    if (value.length < 3) return { error: 'Zadajte odkaz na Facebook profil alebo meno.' };
    if (/^https?:\/\//i.test(value) && !/^https?:\/\/(www\.|m\.)?(facebook|fb)\.com\//i.test(value)) return { error: 'Odkaz musí byť na facebook.com.' };
    return { contact: { type, value } };
  }
  return { error: 'Vyberte Telegram, E-mail alebo Facebook.' };
}

function contactText(c) {
  if (!c) return '—';
  if (c.username) return `username ${c.username}`;
  return `${c.type === 'email' ? 'E-mail' : c.type === 'telegram' ? 'Telegram' : 'Facebook'}: ${c.value}`;
}

// Express middleware for order-creating endpoints
function requireContact(req, res, next) {
  const r = validateContact(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error, field: 'contact' });
  als.run({ contact: r.contact, t: Date.now() }, () => next());
}

// Attach the request's contact to orders created during this request (called from saveOrders)
function attach(orders) {
  const st = als.getStore();
  if (!st || !orders) return;
  for (const o of Object.values(orders)) {
    if (o && !o.contact && o.createdAt && Date.parse(o.createdAt) >= st.t - 1000) o.contact = st.contact;
  }
}

module.exports = { validateContact, contactText, requireContact, attach, als };
