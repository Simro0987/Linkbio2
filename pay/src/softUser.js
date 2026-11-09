'use strict';
/** Software (TV) usernames vs site login, slot validation, date/credential text parsing. */
const crypto = require('crypto');

const GEN_ALPH = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i
const NEW_RE = /^[a-z0-9][a-z0-9_.-]{7,23}$/;
const RENEW_RE = /^[A-Za-z0-9._-]{8,64}$/;
const MONTHS = {
  januar: 1, január: 1, january: 1, jan: 1,
  februar: 2, február: 2, february: 2, feb: 2,
  marec: 3, march: 3, mar: 3,
  april: 4, apríl: 4, apr: 4,
  maj: 5, máj: 5, may: 5,
  jun: 6, jún: 6, june: 6,
  jul: 7, júl: 7, july: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, október: 10, october: 10, oct: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function planDevices(p) {
  if (!p) return 1;
  if (Number(p.devices) >= 2) return 2;
  const blob = [p.name, p.name_en, p.features, p.features_en, p.badge, p.badge_en, p.note, p.note_en].filter(Boolean).join(' ');
  return /2\s*zariad|2\s*device|two devices|2nd device/i.test(blob) ? 2 : 1;
}

function devicesForPlans(list) {
  const rows = (list || []).filter(Boolean);
  if (!rows.length) return 1;
  const ds = rows.map(planDevices);
  if (ds.every((d) => d >= 2)) return 2;
  if (rows.length === 1) return ds[0] >= 2 ? 2 : 1;
  return 1;
}

function generateSoftwareUser() {
  const buf = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += GEN_ALPH[buf[i] % GEN_ALPH.length];
  return s;
}

function cleanUser(v) {
  return String(v == null ? '' : v).trim().replace(/^@/, '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 64);
}

function validateSlot(s) {
  const intent = s && String(s.intent || '').toLowerCase() === 'renew' ? 'renew' : 'new';
  const username = cleanUser(s && s.username);
  if (intent === 'new') {
    const u = username.toLowerCase();
    if (!NEW_RE.test(u)) {
      return { error: 'Software username musí mať 8–24 znakov (malé písmená, číslice, . _ -) a začínať písmenom alebo číslicou. Alebo kliknite na Vygenerovať.' };
    }
    return { intent, username: u };
  }
  if (!RENEW_RE.test(username)) {
    return { error: 'Zadajte existujúce Software username, ktoré chcete predĺžiť (min. 8 znakov, bez medzier).' };
  }
  return { intent, username };
}

function validateSlots(raw, want) {
  const n = want >= 2 ? 2 : 1;
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < n) {
    return { error: n === 2 ? 'Tento balík je pre 2 zariadenia – zadajte dve rôzne Software username.' : 'Zadajte Software username.' };
  }
  const slots = [];
  for (let i = 0; i < n; i++) {
    const r = validateSlot(list[i] || {});
    if (r.error) return { error: (n === 2 ? `Zariadenie ${i + 1}: ` : '') + r.error };
    slots.push(r);
  }
  if (n === 2 && slots[0].username.toLowerCase() === slots[1].username.toLowerCase()) {
    return { error: 'Dve Software username pre 2 zariadenia musia byť rôzne.' };
  }
  return { slots };
}

function siteUsernameFromSlots(slots) {
  const u = slots && slots[0] && slots[0].username ? String(slots[0].username).toLowerCase() : '';
  return NEW_RE.test(u) ? u : '';
}

function ymd(y, m, d) {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (!yy || yy < 2020 || yy > 2100 || mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return '';
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let m = s.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return ymd(m[1], m[2], m[3]);
  m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (m) return ymd(m[3], m[2], m[1]);
  m = s.match(/\b(\d{1,2})\.\s*([A-Za-záäéíóúýôĺŕščťžňúÁÄÉÍÓÚÝÔĹŔŠČŤŽŇÚ]+)\s*(20\d{2})\b/);
  if (m) {
    const key = m[2].toLowerCase();
    const fold = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const months = MONTHS[key] || MONTHS[fold] || MONTHS[fold.slice(0, 3)];
    if (months) return ymd(m[3], months, m[1]);
  }
  return '';
}

function untilEnd(isoDay) {
  const day = parseDate(isoDay) || ( /^\d{4}-\d{2}-\d{2}$/.test(String(isoDay || '').slice(0, 10)) ? String(isoDay).slice(0, 10) : '');
  if (!day) return null;
  // End of that calendar day in Europe/Zurich ≈ 22:59 UTC in winter, 21:59 in summer; store noon UTC of that day is ambiguous.
  // Use 22:59:59Z as elsewhere in accounts (override_until).
  return new Date(day + 'T22:59:59Z');
}

function daysLeft(until) {
  if (!until) return null;
  const end = until instanceof Date ? until : untilEnd(until) || new Date(until);
  if (!end || Number.isNaN(+end)) return null;
  return Math.ceil((end - Date.now()) / 86400e3);
}

function foldSk(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function maskSecret(v, n) {
  const s = String(v == null ? '' : v);
  const k = n == null ? 2 : n;
  if (!s) return '';
  if (s.length <= k) return '**';
  return s.slice(0, k) + '…(' + s.length + ')';
}

function isExpiryPhrase(raw) {
  const f = foldSk(String(raw || '').trim());
  if (!f) return false;
  if (parseDate(f)) {
    const rest = f.replace(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g, ' ').replace(/\b\d{1,2}[./-]\d{1,2}[./-]20\d{2}\b/g, ' ').replace(/\b\d{1,2}\.\s*[a-z]+\s*20\d{2}\b/g, ' ').replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ').trim();
    if (!rest || /^(predlzene|predlzena|predlzeny|predlzenie|platne\s*do|do|until|valid|expir\w*|extended|:|-)?$/i.test(rest)) return true;
  }
  return /^(predlzene|predlzena|predlzeny|predlzenie|platne(\s+do)?|extended(\s+until)?|valid(\s+until)?|expir(?:y|es|ation)?|until|do)\b/.test(f);
}

function dateFromExpiryPhrase(raw) {
  const t = String(raw || '');
  const f = foldSk(t);
  const m = f.match(/(?:predlzene|predlzena|predlzeny|predlzenie|platne\s*do|valid\s*until|extended(?:\s+until)?|expir(?:y|es|ation)?|until|do\s*datumu)\s*(?:do|until)?\s*[:.]?\s*([^\n,;]+)/i);
  if (m) return parseDate(m[1]) || parseDate(t) || '';
  return parseDate(t) || '';
}

function looksUsernameLine(line) {
  const u = cleanUser(line);
  if (!u || /\s/.test(String(line || '').trim())) return false;
  return RENEW_RE.test(u);
}

function parseCredsFromText(raw) {
  const t = String(raw || '').replace(/\r/g, '');
  const out = { username: '', password: '', until: '', notes: '', expiryOnly: false };
  const until = parseDate(t) || (t.match(/(?:platn[ée]\s*do|valid until|expir(?:y|es|ation)?|do\s*d[áa]tumu)\s*[:.]?\s*([^\n,;]+)/i) || []);
  if (typeof until === 'string') out.until = until;
  else if (until[1]) out.until = parseDate(until[1]) || '';
  if (!out.until) out.until = dateFromExpiryPhrase(t) || parseDate(t) || '';
  const um = t.match(/(?:software\s*)?(?:username|používateľské meno|pouzivatelske meno|meno|user(?:name)?|login)\s*[:.\s]+([A-Za-z0-9._@+-]{3,64})/i);
  if (um) out.username = cleanUser(um[1]);
  const pm = t.match(/(?:password|heslo|pass(?:word)?|pwd)\s*[:.\s]+(\S{3,128})/i);
  if (pm) out.password = String(pm[1]).trim();
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!out.username && !out.password && lines.length) {
    const allExpiry = lines.every((l) => isExpiryPhrase(l) || !!parseDate(l));
    if (allExpiry && (out.until || dateFromExpiryPhrase(t))) {
      out.until = out.until || dateFromExpiryPhrase(t);
      out.expiryOnly = true;
      return out;
    }
    if (looksUsernameLine(lines[0]) && lines[1] && isExpiryPhrase(lines[1]) && !looksUsernameLine(lines[1])) {
      out.username = cleanUser(lines[0]);
      out.until = out.until || parseDate(lines[1]) || dateFromExpiryPhrase(lines[1]);
      out.notes = lines.slice(2).join('\n');
      out.expiryOnly = true;
      return out;
    }
    if (looksUsernameLine(lines[0]) && lines[1] && !isExpiryPhrase(lines[1]) && String(lines[1]).length <= 128 && String(lines[1]).split(/\s+/).length <= 3) {
      out.username = cleanUser(lines[0]);
      out.password = String(lines[1]);
      const rest = lines.slice(2);
      if (!out.until) out.until = parseDate(rest.join('\n')) || dateFromExpiryPhrase(rest.join('\n')) || parseDate(t) || '';
      out.notes = rest.filter((l) => !isExpiryPhrase(l) && !parseDate(l)).join('\n');
      return out;
    }
  }
  if (!out.username && !out.password && out.until) out.expiryOnly = true;
  if (out.username || out.password) {
    // Keep leftover non-label lines as notes when labeled creds were used
    if (!out.notes) {
      out.notes = lines.filter((l) => {
        if (/(?:software\s*)?(?:username|používateľské meno|pouzivatelske meno|meno|user(?:name)?|login)\s*[:.\s]+/i.test(l)) return false;
        if (/(?:password|heslo|pass(?:word)?|pwd)\s*[:.\s]+/i.test(l)) return false;
        if (isExpiryPhrase(l) || parseDate(l)) return false;
        return true;
      }).join('\n');
    }
  }
  return out;
}

function formatSlotsLine(slots) {
  return (slots || []).map((s) => `${s.intent === 'renew' ? 'predĺženie' : 'nový'}: ${s.username}`).join(', ');
}

function intentLabel(slots) {
  const a = (slots || []).map((s) => s.intent);
  if (!a.length) return '—';
  if (a.every((x) => x === 'renew')) return 'predĺženie existujúceho účtu';
  if (a.every((x) => x === 'new')) return 'nový zákazník';
  return 'zmiešané (predĺženie + nový)';
}

module.exports = {
  NEW_RE, RENEW_RE, planDevices, devicesForPlans, generateSoftwareUser, cleanUser,
  validateSlot, validateSlots, siteUsernameFromSlots, parseDate, untilEnd, daysLeft,
  parseCredsFromText, formatSlotsLine, intentLabel, maskSecret, isExpiryPhrase, dateFromExpiryPhrase, foldSk,
};
