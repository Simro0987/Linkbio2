'use strict';
// Customer Software guide gate + TOTP helpers (never log secrets).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const totp = require('./totp');
const { sanitize } = require('./sanitize');
const soft = require('./pay/src/softUser');

function mdLite(src, max = 20000) {
  let t = String(src || '').replace(/\r/g, '').slice(0, max);
  if (!t.trim()) return '';
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
  return sanitize(t, max);
}

/** Paid (auto on-chain or Ryan-confirmed) AND Software credentials/expiry already sent. */
function isGuideOrder(o, F) {
  if (!o || !F) return false;
  if (!F.isPaid(o)) return false;
  const f = o.fulfill;
  if (!f || !f.credSentAt) return false;
  return true;
}

function ordersForUser(all, u) {
  return Object.values(all || {}).filter((o) => o && ((o.acct && o.acct.id === u.id) || (o.fulfill && o.fulfill.accountId === u.id)));
}

function userMaySeeGuide(u, all, F) {
  if (!u || !u.id) return false;
  return ordersForUser(all, u).some((o) => isGuideOrder(o, F));
}

function collectSoftwareSlots(u, all, F, linePass, fulfillPass) {
  const names = [];
  const push = (n) => {
    const k = String(n || '').trim();
    if (!k) return;
    if (names.some((x) => x.toLowerCase() === k.toLowerCase())) return;
    names.push(k);
  };
  if (u.panel_user) push(u.panel_user);
  for (const o of ordersForUser(all, u)) {
    const f = o.fulfill || {};
    for (const s of [...(f.lines || []), ...(f.slots || [])]) if (s && s.username) push(s.username);
    for (const m of f.messages || []) if (m && m.card && m.card.username) push(m.card.username);
  }
  return names.map((username) => {
    let password = '';
    try { password = linePass(username) || ''; } catch { password = ''; }
    if (!password) {
      try { password = fulfillPass(username) || ''; } catch { password = ''; }
    }
    let until = '';
    if (F && typeof F.latestUntilForUser === 'function') until = F.latestUntilForUser(all, username) || '';
    return { username, password, until, hasPass: !!password };
  });
}

function genRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const r = crypto.randomBytes(8);
    let o = '';
    for (const b of r) o += 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31];
    return o;
  });
}

function fmtRecovery(c) { return c.slice(0, 4) + '-' + c.slice(4); }

async function hashCodes(codes) {
  return Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
}

async function consumeRecovery(list, code) {
  const norm = String(code || '').toLowerCase().replace(/-/g, '').trim();
  if (!/^[a-z0-9]{8}$/.test(norm)) return null;
  const out = list.slice();
  for (let i = 0; i < out.length; i++) {
    if (await bcrypt.compare(norm, out[i])) { out.splice(i, 1); return out; }
  }
  return null;
}

function softUserOk(name) {
  const r = soft.validateSlot({ intent: 'new', username: name });
  return !r.error;
}

module.exports = {
  mdLite, isGuideOrder, ordersForUser, userMaySeeGuide, collectSoftwareSlots,
  genRecoveryCodes, fmtRecovery, hashCodes, consumeRecovery, softUserOk, totp, soft,
};
