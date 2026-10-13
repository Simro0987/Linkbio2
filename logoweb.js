'use strict';
// Online fallbacks for channel logos: Wikipedia page image of the channel article (sk/cs/en/de/hu), then the official website (Wikidata P856) favicon via Google s2. Images only.
const UA = { 'user-agent': 'lnkbio-logo-matcher/1.0 (+https://lnkbio.onrender.com)' };
const TVDESC = /tele|tv\b|tv |kan[aá]l|channel|stanic|sender|csatorn|broadcast|vysiela|network|sport|film|hudob|music|news|spravodaj/i;
const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\b(hd|fhd|uhd|4k|sd|tv|televizia|televize|channel)\b/g, '').replace(/[^a-z0-9]+/g, '');
const cache = new Map();
async function api(lang, params) { const r = await fetch(`https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ format: 'json', ...params }), { headers: UA, signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
async function find(name, langs) {
  const clean = String(name).replace(/\b(F?HD|UHD|4K|SD|HEVC)\b/gi, ' ').replace(/[|[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const nk = norm(clean); if (nk.length < 2) return null;
  if (cache.has(nk)) return cache.get(nk);
  let res = null, site = '';
  for (const lang of langs) {
    const j = await api(lang, { action: 'query', generator: 'search', gsrsearch: clean + ' ' + (lang === 'de' ? 'Fernsehsender' : lang === 'hu' ? 'televízió' : lang === 'en' ? 'TV channel' : 'televízia'), gsrlimit: '5', prop: 'pageimages|description|pageprops', piprop: 'thumbnail', pithumbsize: '330', pilicense: 'any', ppprop: 'wikibase_item', redirects: '1' }).catch(() => null);
    const ps = Object.values(((j || {}).query || {}).pages || {}).sort((a, b) => a.index - b.index);
    for (const p of ps) {
      const t = norm(p.title); if (!(t === nk || (t.startsWith(nk) && t.length - nk.length <= 6) || (nk.startsWith(t) && t.length >= 3 && nk.length - t.length <= 2))) continue;
      if (!TVDESC.test((p.description || '') + ' ' + p.title)) continue;
      if (p.thumbnail && /^https:\/\/upload\.wikimedia\.org\//.test(p.thumbnail.source)) { res = { url: p.thumbnail.source.split('?')[0], src: 'wikipedia', label: lang + ':' + p.title }; break; }
      if (!site && p.pageprops && p.pageprops.wikibase_item) site = p.pageprops.wikibase_item;
    }
    if (res) break;
  }
  if (!res && site) { // official website favicon
    try {
      const r = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${site}.json`, { headers: UA, signal: AbortSignal.timeout(8000) }); const j = await r.json();
      const w = (((j.entities || {})[site] || {}).claims || {}).P856; const u = w && w[0] && w[0].mainsnak.datavalue && w[0].mainsnak.datavalue.value;
      if (u) { const host = new URL(u).hostname; res = { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`, src: 'favicon', label: host }; }
    } catch { /* ignore */ }
  }
  cache.set(nk, res); return res;
}
module.exports = { find };
