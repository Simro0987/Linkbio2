'use strict';
// Real film posters for local (SK/CZ) TV titles: Wikidata search in cs/sk/en → English Wikipedia lead image (poster),
// else Wikidata P3383 (film poster) / P18 on Commons. Also returns popularity (number of Wikipedia editions)
// and review score (P444) used to rank "Dnes v TV". Never generates images.
const crypto = require('crypto');
const UA = { 'user-agent': 'lnkbio-epg/1.0 (+https://lnkbio.onrender.com; schedule posters)' };
const FILM = new Set(['Q11424', 'Q506240', 'Q24869', 'Q202866', 'Q229390', 'Q93204', 'Q17517379', 'Q130232', 'Q157443', 'Q188473', 'Q319221', 'Q1054574', 'Q459290', 'Q842256', 'Q645928', 'Q2484376', 'Q622548', 'Q1361932', 'Q20667187', 'Q2143665', 'Q336144', 'Q1146335', 'Q471839', 'Q200092', 'Q860626', 'Q959790', 'Q1257444', 'Q2421031', 'Q2678111']);
const FILMDESC = /\bfilm\b|movie|\bfilmu\b|snímek|snímka|velkofilm/i;
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
const okUrl = (u) => { u = String(u || '').split('?')[0]; return /^https:\/\/upload\.wikimedia\.org\/wikipedia\/(en|commons)\/[^\s"'<>]+$/.test(u) ? u : ''; };
const commons = (fn) => { fn = String(fn).replace(/ /g, '_'); const h = crypto.createHash('md5').update(fn).digest('hex'), e = encodeURIComponent(fn); return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h[0]}/${h.slice(0, 2)}/${e}/330px-${e}${/\.(svg|tiff?|pdf)$/i.test(fn) ? '.png' : ''}`; };
async function get(url, params) { const r = await fetch(url + '?' + new URLSearchParams({ format: 'json', ...params }), { headers: UA, signal: AbortSignal.timeout(9000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
const wd = (p) => get('https://www.wikidata.org/w/api.php', p);
function rating(claims) {
  let best = 0;
  for (const c of claims.P444 || []) {
    const v = String((((c.mainsnak || {}).datavalue || {}).value) || ''); let m;
    if ((m = /^(\d{1,3})\s*%$/.exec(v))) best = Math.max(best, +m[1]);
    else if ((m = /^(\d+(?:[.,]\d+)?)\s*\/\s*(10|100|5)$/.exec(v))) best = Math.max(best, Math.round(parseFloat(m[1].replace(',', '.')) / +m[2] * 100));
  }
  return Math.min(100, best);
}
const year = (claims) => { const t = (((((claims.P577 || [])[0] || {}).mainsnak || {}).datavalue || {}).value || {}).time; return t ? +String(t).slice(1, 5) : 0; };
const cache = new Map();
async function find(title, yr) {
  title = String(title || '').replace(/\s*[-–:|]\s*(premiéra|premiera|repríza|repriza)\s*$/i, '').replace(/\s+/g, ' ').trim(); yr = +yr || 0;
  if (title.length < 2) return null;
  const ck = norm(title) + '|' + yr; if (cache.has(ck)) return cache.get(ck);
  const nt = norm(title), ids = [];
  for (const lang of ['cs', 'sk', 'en']) {
    const j = await wd({ action: 'wbsearchentities', search: title, language: lang, uselang: lang, type: 'item', limit: '7' }).catch(() => ({}));
    for (const x of j.search || []) if (!ids.includes(x.id) && (norm(x.label) === nt || (x.match && norm(x.match.text) === nt)) && (!x.description || FILMDESC.test(x.description))) ids.push(x.id);
    if (ids.length >= 3) break;
  }
  let best = null;
  if (ids.length) {
    const j = await wd({ action: 'wbgetentities', ids: ids.slice(0, 8).join('|'), props: 'claims|sitelinks|labels', languages: 'cs|sk|en' }).catch(() => ({}));
    for (const id of ids) {
      const e = (j.entities || {})[id]; if (!e) continue; const cl = e.claims || {};
      const p31 = (cl.P31 || []).map((c) => ((((c.mainsnak || {}).datavalue || {}).value) || {}).id); if (!p31.some((q) => FILM.has(q))) continue;
      const y = year(cl); const pop = Object.keys(e.sitelinks || {}).filter((k) => /wiki$/.test(k) && !/^(commons|species|wikidata)/.test(k)).length;
      let sc = pop / 10 + (yr && y ? (Math.abs(y - yr) <= 1 ? 50 : -50) : 0);
      if (!best || sc > best.sc) best = { sc, id, e, y, pop, rt: rating(cl) };
    }
  }
  let out = null;
  if (best && best.sc > -10) {
    let url = '', label = '';
    const en = (best.e.sitelinks || {}).enwiki;
    if (en) {
      const j = await get('https://en.wikipedia.org/w/api.php', { action: 'query', titles: en.title, prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '330', pilicense: 'any', redirects: '1' }).catch(() => ({}));
      const pg = Object.values((j.query || {}).pages || {})[0]; url = okUrl(pg && pg.thumbnail && pg.thumbnail.source); if (url) label = en.title + ' – en.wikipedia';
    }
    if (!url) { const cl = best.e.claims || {}; const fn = ((((cl.P3383 || cl.P18 || [])[0] || {}).mainsnak || {}).datavalue || {}).value; if (fn) { url = okUrl(commons(fn)); label = 'Wikimedia Commons'; } }
    out = { url, label: label || best.id, qid: best.id, pop: best.pop, rt: best.rt, year: best.y };
  }
  if (cache.size > 500) cache.clear(); cache.set(ck, out); return out;
}
module.exports = { find };
