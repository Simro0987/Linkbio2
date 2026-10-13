'use strict';
// Logo matcher against the public GitHub repo tv-logo/tv-logos (images only; never touches streams/playlists/providers).
const REPO = 'tv-logo/tv-logos', BR = 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BR}/`;
const SUFFIX = /-(al|ar|au|at|tr|be|br|bg|ca|car|jm|cl|cr|hr|cz|ch|fr|de|gr|hk|hu|in|id|int|ie|il|it|lb|lt|lu|my|asi|mt|mx|nl|nz|dk|fi|is|no|se|ph|pl|pt|ro|ru|rs|sg|sk|si|za|es|ua|ae|uk|us|pr|afr|eu|lam|lat|mea)$/;
const NAME_CC = { sk: 'slovakia', cz: 'czech-republic', hu: 'hungary', pl: 'poland', de: 'germany', at: 'austria', uk: 'united-kingdom', us: 'united-states', hr: 'croatia', si: 'slovenia', rs: 'serbia', ro: 'romania', it: 'italy', fr: 'france', es: 'spain', ua: 'ukraine', ru: 'russia', bg: 'bulgaria', tr: 'turkey', nl: 'netherlands', ch: 'switzerland' };
const CAT_CC = [[/sloven(sk|ia)|\bsk\b|slovak/i, 'slovakia'], [/cesk|česk|czech|\bcz\b/i, 'czech-republic'], [/madar|maďar|hungar|\bhu\b/i, 'hungary'], [/polsk|poľsk|poland|polish|\bpl\b/i, 'poland'], [/nemec|german|deutsch|\bde\b/i, 'germany'], [/rakus|rakús|austria|\bat\b/i, 'austria'], [/anglic|britsk|\buk\b|english|british/i, 'united-kingdom'], [/\busa?\b|americk|united states/i, 'united-states'], [/chorvat|croat/i, 'croatia'], [/srb|serbia/i, 'serbia'], [/rumun|roman/i, 'romania'], [/talian|ital/i, 'italy'], [/franc/i, 'france'], [/ukraj|ukrain/i, 'ukraine']];
const PREF = ['slovakia', 'czech-republic', 'international', 'world-europe', 'united-kingdom', 'united-states', 'germany', 'hungary', 'poland', 'austria'];
const deacc = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function normName(name) {
  let s = deacc(name).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\+\s*1\b/g, ' ').replace(/&/g, ' and ');
  let cc = null; const m = /(?:^|[\s|:._-])(sk|cz|hu|pl|de|at|uk|us|hr|si|rs|ro|it|fr|es|ua|ru|bg|tr|nl|ch)(?:$|[\s|:._-])/.exec(s); if (m) { cc = NAME_CC[m[1]]; s = s.replace(m[0], ' '); }
  s = s.replace(/\b(fhd|uhd|hd|sd|4k|8k|hevc|h265|h\.265|50fps|hdr|raw|backup|vip)\b/g, ' ').replace(/\b(sk|cz)\s*$/g, ' ');
  return { key: s.replace(/[^a-z0-9]+/g, ''), cc };
}
function makeIndex(paths) {
  const idx = new Map();
  for (const p of paths) {
    const m = /^(countries\/([^/]+)|misc\/[^/]+)\/([^/]+)\.png$/i.exec(p); if (!m) continue;
    let base = m[3].toLowerCase(); while (SUFFIX.test(base)) base = base.replace(SUFFIX, '');
    base = base.replace(/-(uhd|fhd|hd)$/, '');
    const key = base.replace(/[^a-z0-9]+/g, ''); if (!key) continue;
    const country = m[2] || 'misc';
    if (!idx.has(key)) idx.set(key, []); idx.get(key).push({ path: p, country });
  }
  return idx;
}
function candidates(idx, name, category) {
  const { key, cc } = normName(name); if (!key) return [];
  const want = cc || (CAT_CC.find(([re]) => re.test(category || '')) || [])[1] || null;
  let hits = idx.get(key) || idx.get(key.replace(/tv$/, '')) || idx.get(key + 'tv') || idx.get(key.replace(/^tv/, '')) || [];
  if (want && key.length >= 4 && !hits.some((h) => h.country === want)) { // brand-prefixed variant in the wanted country, e.g. "Doma" -> markiza-doma-sk
    const ks = [...idx.entries()].filter(([k, v]) => k !== key && k.endsWith(key) && k.length - key.length <= 8 && v.some((h) => h.country === want));
    if (ks.length === 1) hits = ks[0][1].concat(hits);
  }
  if (!hits.length && key.length >= 5) { // unique brand-prefixed key e.g. "dajto" -> "markizadajto"
    const ks = [...idx.keys()].filter((k) => k.endsWith(key) && k.length - key.length <= 8); if (ks.length === 1) hits = idx.get(ks[0]);
  }
  const rank = (c) => (c.country === want ? -100 : 0) + (PREF.includes(c.country) ? PREF.indexOf(c.country) : 50);
  return hits.slice().sort((a, b) => rank(a) - rank(b)).map((c) => ({ url: RAW + c.path.split('/').map(encodeURIComponent).join('/'), country: c.country }));
}
let tree = null, treeAt = 0, treeP = null;
async function getIndex() {
  if (tree && Date.now() - treeAt < 24 * 3600e3) return tree;
  if (!treeP) treeP = (async () => {
    const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BR}?recursive=1`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'lnkbio-logo-matcher' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('GitHub tree ' + r.status);
    const j = await r.json(); tree = makeIndex((j.tree || []).filter((x) => x.type === 'blob').map((x) => x.path)); treeAt = Date.now(); return tree;
  })().finally(() => { treeP = null; });
  return treeP;
}
const okCache = new Map();
async function verify(url) {
  if (!url.startsWith(RAW)) return false;
  if (okCache.has(url)) return okCache.get(url);
  let ok = false;
  try { const r = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10000) }); ok = r.status === 200 && /^image\//i.test(r.headers.get('content-type') || ''); } catch { ok = false; }
  okCache.set(url, ok); return ok;
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
// best verified logo for each channel
async function matchAll(chs) {
  const idx = await getIndex();
  return pool(chs, 10, async (c) => { for (const x of candidates(idx, c.name, c.category).slice(0, 3)) if (await verify(x.url)) return { ...c, url: x.url }; return { ...c, url: '' }; });
}
async function suggest(name, category) { const idx = await getIndex(); const cs = candidates(idx, name, category).slice(0, 6); const ok = await pool(cs, 6, (x) => verify(x.url)); return cs.filter((_, i) => ok[i]); }
module.exports = { matchAll, suggest, normName, makeIndex, candidates, RAW };
