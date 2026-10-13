'use strict';
// Film/series poster lookup via Wikidata (P3383 film poster, else P18 image) → Wikimedia Commons thumbnail. No API key, no streams.
const crypto = require('crypto');
const UA = { 'user-agent': 'lnkbio-logo-matcher/1.0 (+https://lnkbio.onrender.com)' };
const VODCAT = /film|seri[aá]l|series|vod|movie|kino|cinema|dokument[aá]rn.*film|rozpr[aá]vk/i;
const YEAR = /\b(19[2-9]\d|20[0-4]\d)\b/;
const isVod = (c) => VODCAT.test(c.category || '') || /[([]\s*(19[2-9]\d|20[0-4]\d)\s*[)\]]/.test(c.name || '');
const WORK = new Set(['Q11424', 'Q5398426', 'Q24856', 'Q506240', 'Q1259759', 'Q202866', 'Q24862', 'Q21191270', 'Q526877', 'Q581714', 'Q1366112', 'Q229390', 'Q93204', 'Q17517379', 'Q117467246', 'Q63952888']);
const commons = (fn) => { fn = String(fn).replace(/ /g, '_'); const h = crypto.createHash('md5').update(fn).digest('hex'), e = encodeURIComponent(fn); return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h[0]}/${h.slice(0, 2)}/${e}/300px-${e}${/\.(svg|tiff?|pdf)$/i.test(fn) ? '.png' : ''}`; };
const cache = new Map();
async function wd(params) { const r = await fetch('https://www.wikidata.org/w/api.php?' + new URLSearchParams({ format: 'json', origin: '*', ...params }), { headers: UA, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error('Wikidata HTTP ' + r.status); return r.json(); }
function parse(name) {
  const y = (YEAR.exec(name) || [])[1] || '';
  const title = String(name).replace(/[([]\s*(19|20)\d\d\s*[)\]]/g, ' ').replace(/\b(19|20)\d\d\b\s*$/, ' ').replace(/\b(4k|uhd|fhd|hd|sd|cz|sk|en|dabing|titulky|tit)\b/gi, ' ').replace(/[|:–-]\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title, year: y };
}
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^a-z0-9]+/g, '');
const WORKDESC = /film|movie|series|seri[aá]l|sitcom|miniseri|anim|drama|comedy|kom[eé]di|thriller|dokument|documentary|telenovel|anime|cartoon|rozpr[aá]vk|show/i;
async function wiki(lang, q) {
  const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: q, gsrlimit: '6', prop: 'pageimages|description|langlinks', lllang: 'en', piprop: 'thumbnail', pithumbsize: '300', pilicense: 'any', redirects: '1' }), { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Wikipedia HTTP ' + r.status); const j = await r.json();
  return Object.values((j.query || {}).pages || {}).sort((x, y) => x.index - y.index);
}
async function find(c) {
  const { title, year } = parse(c.name); if (title.length < 2) return null;
  const ck = title.toLowerCase() + '|' + year; if (cache.has(ck)) return cache.get(ck);
  const nt = norm(title); let best = null;
  for (const lang of ['en', 'cs', 'sk']) {
    const ps = await wiki(lang, `${title}${year ? ' ' + year : ''} ${/seri|series/i.test(c.category || '') ? (lang === 'en' ? 'TV series' : 'seriál') : 'film'}`).catch(() => []);
    for (const p of ps) {
      const d = p.description || '', nT = norm(p.title);
      if ((!p.thumbnail || !p.thumbnail.source) && lang !== 'en' && p.langlinks && p.langlinks[0] && (nT === nt || nT.startsWith(nt)) && (WORKDESC.test(d) || WORKDESC.test(p.title))) { // cs/sk article without image → its English article's poster
        const en = await fetch('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ action: 'query', format: 'json', titles: p.langlinks[0]['*'], prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '300', pilicense: 'any', redirects: '1' }), { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({}));
        const ep = Object.values((en.query || {}).pages || {})[0]; if (ep && ep.thumbnail) p.thumbnail = ep.thumbnail;
      }
      if (!p.thumbnail || !p.thumbnail.source || !/^https:\/\/upload\.wikimedia\.org\//.test(p.thumbnail.source)) continue;
      p.thumbnail.source = p.thumbnail.source.split('?')[0];
      if (!WORKDESC.test(d) && !WORKDESC.test(p.title)) continue;
      let sc = nT === nt ? 6 : nT.startsWith(nt) ? 3 : nT.includes(nt) ? 1 : -1; if (sc < 0) continue;
      if (year) { if (d.includes(year) || p.title.includes(year)) sc += 5; else if (YEAR.test(d)) sc -= 6; }
      if (sc > 0 && (!best || sc > best.sc)) best = { sc, url: p.thumbnail.source, label: `${p.title} – ${lang}.wikipedia` };
    }
    if (best && best.sc >= 6) break;
  }
  cache.set(ck, best); return best;
}
module.exports = { isVod, find, parse };
