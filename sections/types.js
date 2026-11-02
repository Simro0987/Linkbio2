'use strict';
// Section kinds + pure helpers (no DB, no Express) – unit-tested in test/sections.test.js.
// one = max one per place; home = home page only; b = built-in block (renders existing site feature).
const KINDS = {
  banner: { l: 'Stav služieb (banner)', i: '📡', b: 1, one: 1, home: 1 },
  evhero: { l: 'Top udalosti – hlavný banner', i: '🏟️', b: 1, one: 1, home: 1 },
  hero: { l: 'Hlavička (logo, názov, popis)', i: '🏠', b: 1, one: 1, home: 1 },
  events: { l: 'Top udalosti', i: '⚽', b: 1, one: 1 },
  dnes: { l: 'Program / EPG – dnes v TV', i: '🗓️', b: 1, one: 1, home: 1 },
  buttons: { l: 'Tlačidlá (odkazy z admin › Tlačidlá)', i: '🔘', b: 1, one: 1, home: 1 },
  social: { l: 'Kontakty / sociálne siete', i: '💬', b: 1 },
  channels: { l: 'Kanály (zoznam + EPG)', i: '📺', b: 1 },
  pricing: { l: 'Cenník (vybrané balíky)', i: '🏷️', b: 1 },
  payments: { l: 'Platobné metódy', i: '💳', b: 1 },
  auth: { l: 'Prihlásenie / Registrácia', i: '🔑', b: 1 },
  why: { l: 'Prečo sa zaregistrovať', i: '✨', b: 1, one: 1 },
  affiliate: { l: 'Affiliate výhody (tabuľka)', i: '🤝', b: 1 },
  subcheck: { l: 'Over predplatné', i: '🔎', b: 1 },
  chat: { l: 'AI chat podpory', i: '🤖', b: 1, one: 1, home: 1 },
  text: { l: 'Text / HTML (+ obrázok)', i: '📝' },
  gallery: { l: 'Obrázok / galéria', i: '🖼️' },
  video: { l: 'Video', i: '🎬' },
  links: { l: 'Tlačidlá / zoznam odkazov', i: '🔗' },
  faq: { l: 'FAQ (rozbaľovacie otázky)', i: '❓' },
  countdown: { l: 'Odpočítavanie', i: '⏳' },
};
const GROUPS = [['Obsah', ['text', 'gallery', 'video', 'links', 'faq', 'countdown']], ['Funkcie webu', ['pricing', 'payments', 'channels', 'social', 'auth', 'why', 'affiliate', 'subcheck', 'events', 'dnes']], ['Hlavná stránka', ['hero', 'banner', 'evhero', 'buttons', 'chat']]];
const RESERVED_IDS = new Set(['nt', 'cennik', 'epgcfg', 'reflink', 'top', 'main', 'pn', 'afft', 'afprev']);
const ANCHOR = /^[a-z][a-z0-9-]{0,39}$/;
const HEX = /^#[0-9a-f]{6}$/;
const VIS = ['all', 'in', 'out', 'mobile', 'desktop'];

const slugify = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const ids = (v, n = 60) => [...new Set((Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter((x) => /^[a-z0-9_.:-]{1,80}$/i.test(x)))].slice(0, n);

// Europe/Bratislava wall-clock "YYYY-MM-DDTHH:MM" <-> epoch ms (DST-safe, no deps).
const TZ = 'Europe/Bratislava';
function offsetAt(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function zonedToEpoch(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || '')); if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (!isFinite(wall) || +m[2] > 12 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59) return null;
  let t = wall - offsetAt(wall); t = wall - offsetAt(t); return t;
}
function epochToZoned(ms) {
  if (!isFinite(ms)) return '';
  const d = new Date(ms + offsetAt(ms)); return d.toISOString().slice(0, 16);
}

// "Text | URL | emoji" per line. URL must pass safeHref (https/mailto/tel or /path) or be #anchor.
function parseLinks(raw, safeHref) {
  const out = [];
  for (const line of String(raw || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 30)) {
    const [t, u, e] = line.split('|').map((x) => x.trim());
    const url = /^#[a-z][a-z0-9-]{0,39}$/.test(u || '') ? u : safeHref(u || '');
    if (!t || !url) continue;
    out.push({ t: str(t, 80), u: url, e: str(e, 8).replace(/[<>&"'`]/g, '') });
  }
  return out;
}
// FAQ: blocks separated by a blank line; first line = question, rest = answer.
function parseFaq(raw) {
  return String(raw || '').replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).slice(0, 40).map((b) => {
    const [q, ...a] = b.split('\n'); return { q: str(q, 300), a: a.join('\n').trim().slice(0, 4000) };
  }).filter((x) => x.q);
}

// Apply a saved key order: known keys in saved order; new keys keep their natural position after their natural predecessor.
function orderKeys(natural, saved) {
  const sv = (Array.isArray(saved) ? saved : []).filter((k, i, a) => natural.includes(k) && a.indexOf(k) === i);
  const out = sv.slice();
  natural.forEach((k, i) => {
    if (out.includes(k)) return;
    let j = i - 1; while (j >= 0 && !out.includes(natural[j])) j--;
    if (j < 0) out.unshift(k); else out.splice(out.indexOf(natural[j]) + 1, 0, k);
  });
  return out;
}
const move = (arr, k, dir) => { const a = arr.slice(), i = a.indexOf(k), j = i + (dir === 'up' ? -1 : 1); if (i < 0 || j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; };

// Common + per-kind config, from a form body. Unknown/invalid values are dropped.
function cleanCfg(kind, b, old = {}) {
  const c = {};
  const on = (k) => b[k] === '1' || b[k] === 'on';
  if (on('bg_on') && HEX.test(String(b.bg || '').toLowerCase())) c.bg = String(b.bg).toLowerCase();
  if (on('fg_on') && HEX.test(String(b.fg || '').toLowerCase())) c.fg = String(b.fg).toLowerCase();
  if (VIS.includes(b.vis) && b.vis !== 'all') c.vis = b.vis;
  const an = String(b.anchor || '').trim().toLowerCase(); if (ANCHOR.test(an) && !RESERVED_IDS.has(an)) c.anchor = an;
  if (on('showTitle')) c.showTitle = 1;
  if (on('box')) c.box = 1;
  switch (kind) {
    case 'social': c.grp = ['g', 'p'].includes(b.grp) ? b.grp : 'all'; c.style = ['buttons', 'groups'].includes(b.style) ? b.style : 'icons'; break;
    case 'channels': { const n = parseInt(b.limit, 10); if (n > 0 && n <= 500) c.limit = n; if (on('status')) c.status = 1; if (on('epg')) c.epg = 1; break; }
    case 'pricing': c.plans = ids(b.plans); if (on('why')) c.why = 1; if (on('notes')) c.notes = 1; if (on('intro')) c.intro = 1; break;
    case 'payments': c.methods = ids(b.methods, 200); if (on('btn')) c.btn = 1; break;
    case 'links': c.links = str(b.links, 6000); c.style = b.style === 'list' ? 'list' : 'buttons'; break;
    case 'faq': c.src = b.src === 'list' ? 'list' : 'own'; c.faq = str(b.faq, 30000); break;
    case 'countdown': { const t = zonedToEpoch(b.at); if (t) { c.at = String(b.at); c.t = t; } c.done = str(b.done, 200); break; }
    case 'gallery': c.cols = ['1', '2', '3', '4'].includes(String(b.cols)) ? +b.cols : 3; break;
    case 'subcheck': case 'auth': case 'affiliate': case 'text': case 'video': c.note = str(b.note, 500); if (!c.note) delete c.note; break;
    default: break;
  }
  if (old && old.seed) c.seed = old.seed;
  return c;
}
// Only rows with colours get a CSS rule; served from /sekcie.css (CSP style-src 'self').
const cssFor = (rows) => rows.filter((r) => r.cfg && (HEX.test(r.cfg.bg || '') || HEX.test(r.cfg.fg || ''))).map((r) => `.xs-${r.id}{${HEX.test(r.cfg.bg || '') ? `background:${r.cfg.bg};` : ''}${HEX.test(r.cfg.fg || '') ? `color:${r.cfg.fg};` : ''}}`).join('\n')
  + '\n.xs-c{border-radius:14px;padding:14px 16px;margin:14px 0}.xs-c a:not(.b):not(.btn){color:inherit;text-decoration:underline}';
const needsWrap = (c) => !!(c && (c.bg || c.fg || c.vis || c.anchor || c.box));

module.exports = { KINDS, GROUPS, RESERVED_IDS, ANCHOR, HEX, VIS, slugify, str, ids, zonedToEpoch, epochToZoned, parseLinks, parseFaq, orderKeys, move, cleanCfg, cssFor, needsWrap };
