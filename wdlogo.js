'use strict';
// Official channel/station logo from Wikidata (P154 "logo image" → Wikimedia Commons). Free source, images only, no API key.
// Sequential use only (caller paces requests); results are cached in memory for the process lifetime.
const crypto = require('crypto');
const UA = { 'user-agent': 'lnkbio-logo-matcher/1.0 (+https://lnkbio.onrender.com)' };
const BROAD = /tele|tv\b|kan[aá]l|channel|stanic|sender|csatorn|broadcast|vysiela|r[aá]di|radio|station|network|stream|music|hudob|sport/i;
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\b(hd|fhd|uhd|4k|sd|tv|televizia|televize|televizia|channel|radio|fm)\b/g, '').replace(/[^a-z0-9\u0400-\u04ff]+/g, '');
const commons = (fn) => { fn = String(fn).replace(/ /g, '_'); const h = crypto.createHash('md5').update(fn).digest('hex'); return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h[0]}/${h.slice(0, 2)}/${encodeURIComponent(fn)}/330px-${encodeURIComponent(fn)}${/\.(svg|tiff?)$/i.test(fn) ? '.png' : ''}`; };
const cache = new Map();
async function wd(params) {
  const r = await fetch('https://www.wikidata.org/w/api.php?' + new URLSearchParams({ format: 'json', ...params }), { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Wikidata HTTP ' + r.status); return r.json();
}
const clean = (n) => String(n).replace(/\b(F?HD|UHD|4K|SD|HEVC)\b/gi, ' ').replace(/\b(SK|CZ|HU|PL|DE|AT|CH|UK|UA|RU)$/i, ' ').replace(/[|[\]]/g, ' ').replace(/\s+/g, ' ').trim();
/** @returns {Promise<{url,src,label}|null>} */
async function find(name, langs = ['sk', 'cs', 'en']) {
  const q = clean(name), nk = norm(q); if (nk.length < 2) return null;
  if (cache.has(nk)) return cache.get(nk);
  let res = null; const seen = new Set();
  for (const lang of langs) {
    const s = await wd({ action: 'wbsearchentities', search: q, language: lang, uselang: lang, type: 'item', limit: '7' }).catch(() => null);
    const hits = ((s && s.search) || []).filter((h) => !seen.has(h.id) && seen.add(h.id)).filter((h) => { const t = norm(h.label || (h.match || {}).text); return t === nk || (t.startsWith(nk) && t.length - nk.length <= 4 && !/\d/.test(t.slice(nk.length))) || (nk.startsWith(t) && t.length >= 3 && nk.length - t.length <= 2); });
    if (!hits.length) continue;
    const e = await wd({ action: 'wbgetentities', ids: hits.map((h) => h.id).join('|'), props: 'claims|descriptions|labels', languages: 'en|sk|cs' }).catch(() => null);
    for (const h of hits) {
      const ent = e && e.entities && e.entities[h.id]; if (!ent) continue;
      const d = Object.values(ent.descriptions || {}).map((x) => x.value).join(' ') + ' ' + (h.description || '');
      if (!BROAD.test(d)) continue;
      const c = ((ent.claims || {}).P154 || []).find((x) => x.mainsnak && x.mainsnak.datavalue && x.rank !== 'deprecated');
      if (c) { res = { url: commons(c.mainsnak.datavalue.value), src: 'wikidata', label: h.id + ' ' + (h.label || '') }; break; }
    }
    if (res) break;
  }
  cache.set(nk, res); return res;
}
module.exports = { find, _test: { norm, clean, commons } };
