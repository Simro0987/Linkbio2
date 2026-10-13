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
const CDN = `https://cdn.jsdelivr.net/gh/${REPO}@${BR}/`;
const UA = { 'user-agent': 'lnkbio-logo-matcher/1.0 (+https://lnkbio.onrender.com)' };
const st = { source: '', at: '', lastErr: '', refreshing: false, refreshedAt: 0 };
let tree = null, extra = null;
const PICONS = 'https://raw.githubusercontent.com/picons/picons/master/build-source/logos/';
const FOLDER_CC = Object.fromEntries(Object.entries(NAME_CC).map(([k, v]) => [v, k])); FOLDER_CC['united-kingdom'] = 'gb';
function loadExtra() {
  const j = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(require('path').join(__dirname, 'tvlogos-extra.json.gz'))).toString('utf8'));
  extra = { at: j.at, src: {} };
  for (const s of ['iptv', 'picons', 'wd']) { const m = new Map(); for (const [k, cc, u] of j[s]) { if (!m.has(k)) m.set(k, []); m.get(k).push({ cc, url: s === 'picons' ? PICONS + u : u }); } extra.src[s] = m; }
}
const SRC_LABEL = { tvlogo: 'tv-logo/tv-logos', iptv: 'iptv-org (logos)', picons: 'picons/picons', wd: 'Wikidata/Commons' };
// all candidates, priority: tv-logo/tv-logos → iptv-org → picons → Wikidata
function allCandidates(idx, name, category) {
  if (!extra) loadExtra();
  const out = candidates(idx, name, category).map((x) => ({ ...x, src: 'tvlogo' }));
  const { key, cc } = normName(name); if (!key) return out;
  const wantF = cc || (CAT_CC.find(([re]) => re.test(category || '')) || [])[1] || null, want = wantF ? (FOLDER_CC[wantF] || '') : '';
  for (const s of ['iptv', 'picons', 'wd']) {
    const m = extra.src[s]; const hits = m.get(key) || m.get(key.replace(/tv$/, '')) || m.get(key + 'tv') || [];
    const ord = hits.slice().sort((a, b) => (b.cc === want) - (a.cc === want) || (b.cc === 'sk' || b.cc === 'cz') - (a.cc === 'sk' || a.cc === 'cz'));
    if (want && ord.length && ord[0].cc && ord[0].cc !== want && s !== 'picons' && ord.every((h) => h.cc !== want) && hits.length > 1) { /* ambiguous foreign-only matches: keep but after others */ }
    for (const h of ord.slice(0, 2)) out.push({ url: h.url, country: h.cc || '', src: s });
  }
  const seen = new Set(); return out.filter((x) => !seen.has(x.url) && seen.add(x.url));
}
function loadSnapshot() {
  const j = JSON.parse(require('zlib').gunzipSync(require('fs').readFileSync(require('path').join(__dirname, 'tvlogos-tree.json.gz'))).toString('utf8'));
  tree = makeIndex(j.paths); st.source = 'snapshot'; st.at = j.at;
}
async function fetchList() {
  const errs = [];
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BR}?recursive=1`, { headers: { accept: 'application/vnd.github+json', ...UA }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.headers.get('x-ratelimit-remaining') === '0' ? ' (rate limit)' : ''}`);
    const j = await r.json(); const paths = (j.tree || []).filter((x) => x.type === 'blob').map((x) => x.path); if (paths.length < 1000) throw new Error('short list'); return { paths, source: 'github-api' };
  } catch (e) { errs.push('GitHub API: ' + e.message); }
  try {
    const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${REPO}@${BR}?structure=flat`, { headers: UA, signal: AbortSignal.timeout(25000) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !Array.isArray(j.files)) throw new Error(`HTTP ${r.status}${j.message ? ' ' + j.message : ''}`);
    return { paths: j.files.map((f) => String(f.name).replace(/^\//, '')), source: 'jsdelivr' };
  } catch (e) { errs.push('jsDelivr: ' + e.message); }
  throw new Error(errs.join('; '));
}
function refresh() {
  if (st.refreshing || Date.now() - st.refreshedAt < 24 * 3600e3) return;
  st.refreshing = true; st.refreshedAt = Date.now();
  fetchList().then(({ paths, source }) => { tree = makeIndex(paths); st.source = source; st.at = new Date().toISOString().slice(0, 16); st.lastErr = ''; })
    .catch((e) => { st.lastErr = e.message; console.error('tvlogos refresh failed (using snapshot):', e.message); })
    .finally(() => { st.refreshing = false; });
}
async function getIndex() { if (!tree) loadSnapshot(); refresh(); return tree; }
const okCache = new Map();
async function head(url) {
  const good = (r) => r.status >= 200 && r.status < 300 && /^image\//i.test(r.headers.get('content-type') || '') && r.url.startsWith('https://');
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: UA, signal: AbortSignal.timeout(6000) }); if (good(r)) return '';
    if (r.status === 404 || r.status === 410) return 'HTTP ' + r.status;
    const g = await fetch(url, { headers: { ...UA, range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(6000) }); g.body && g.body.cancel().catch(() => {}); return good(g) ? '' : 'HTTP ' + g.status;
  } catch (e) { return (e.cause && e.cause.code) || e.name || e.message; }
}
// returns a working URL (raw.githubusercontent, else jsDelivr CDN) or ''
async function verify(url) {
  if (!/^https:\/\//.test(url)) return '';
  if (okCache.has(url)) return okCache.get(url);
  let ok = '', e1 = await head(url);
  if (!e1) ok = url; else if (!url.startsWith(RAW)) { okCache.set(url, ''); return ''; } else { const alt = CDN + url.slice(RAW.length), e2 = await head(alt); if (!e2) ok = alt; else st.lastErr = `image check: raw ${e1}, cdn ${e2}`; }
  okCache.set(url, ok); return ok;
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
async function matchAll(chs, onProgress) {
  const idx = await getIndex(); let done = 0;
  return pool(chs, 12, async (c) => {
    let url = '', src = '';
    if (POSTER.isVod(c)) { const p = await POSTER.find(c).catch(() => null); if (p && await verify(p.url)) { url = p.url; src = 'poster'; } }
    if (!url) for (const x of allCandidates(idx, c.name, c.category).slice(0, 5)) { url = await verify(x.url); if (url) { src = x.src; break; } }
    done++; if (onProgress) onProgress(done, chs.length); return { ...c, url, src };
  });
}
async function suggest(name, category) { const idx = await getIndex(); const cs = allCandidates(idx, name, category).slice(0, 8); if (POSTER.isVod({ name, category })) { const p = await POSTER.find({ name, category }).catch(() => null); if (p) cs.unshift({ url: p.url, country: p.label, src: 'poster' }); } const ok = await pool(cs, 6, (x) => verify(x.url)); return cs.map((x, i) => ({ ...x, url: ok[i] })).filter((x) => x.url); }
const isRepoLogo = (u) => typeof u === 'string' && (u.startsWith(RAW) || u.startsWith(CDN)) && !/\.\.|[?#]/.test(u);
const short = (u) => u.replace(RAW, 'tv-logos/').replace(CDN, 'tv-logos(cdn)/').replace(PICONS, 'picons/').replace(/^https:\/\//, '').slice(0, 90);
const POSTER = require('./posters');
module.exports = { matchAll, suggest, normName, makeIndex, candidates, RAW, CDN, isRepoLogo, short, status: () => ({ ...st }), getIndex, allCandidates, SRC_LABEL: { ...SRC_LABEL, poster: 'Wikidata plagát' }, loadExtra };
