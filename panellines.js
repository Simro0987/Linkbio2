'use strict';
// Bulk parse of admin-supplied panel usernames + passwords (user:pass / user;pass / user<tab or space>pass).
function parseBulk(text, userOk) {
  const rawItems = [], errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s[0] === '#') continue;
    let u = '', p = '';
    const colon = s.indexOf(':'), semi = s.indexOf(';'), tab = s.indexOf('\t');
    if (colon > 0 && (semi < 0 || colon < semi) && (tab < 0 || colon < tab)) { u = s.slice(0, colon).trim(); p = s.slice(colon + 1).trim(); }
    else if (semi > 0 && (tab < 0 || semi < tab)) { u = s.slice(0, semi).trim(); p = s.slice(semi + 1).trim(); }
    else if (tab > 0) { u = s.slice(0, tab).trim(); p = s.slice(tab + 1).trim(); }
    else {
      const sp = s.search(/\s/);
      if (sp > 0) { u = s.slice(0, sp).trim(); p = s.slice(sp + 1).trim(); }
    }
    if (!u || !p || p.length > 128 || (typeof userOk === 'function' && !userOk(u))) { errors.push(s.slice(0, 48)); continue; }
    rawItems.push({ user: u, pass: p });
  }
  const seen = new Map();
  for (const x of rawItems) seen.set(x.user.toLowerCase(), x);
  return { items: [...seen.values()], errors, dropped: rawItems.length - seen.size };
}

function fmtDateTime(d, zone = 'Europe/Bratislava') {
  if (!d) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}
function daysLeft(exp, now = Date.now()) {
  if (!exp) return null;
  const t = new Date(exp).getTime();
  if (!Number.isFinite(t)) return null;
  if (t >= Date.parse('2099-12-31T00:00:00.000Z')) return null;
  if (t <= now) return 0;
  return Math.ceil((t - now) / 86400e3);
}
function statusKind(r) {
  const s = String((r && r.status) || '').trim().toLowerCase();
  if (s === 'banned') return 'banned';
  if (s === 'disabled') return 'disabled';
  if (s === 'expired' || (r && r.found && !r.active)) return 'expired';
  if (r && r.found && r.active) return 'active';
  return 'unknown';
}
function devicesWord(n, en) {
  n = Math.abs(+n || 0);
  if (en) return n === 1 ? 'device' : 'devices';
  return n === 1 ? 'zariadenie' : (n >= 2 && n <= 4 ? 'zariadenia' : 'zariadení');
}
function daysWord(n, en) {
  n = Math.abs(+n || 0);
  if (en) return n === 1 ? 'day' : 'days';
  return n === 1 ? 'deň' : (n >= 2 && n <= 4 ? 'dni' : 'dní');
}

module.exports = { parseBulk, fmtDateTime, daysLeft, statusKind, devicesWord, daysWord };
