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
let tree = null;
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
  try { const r = await fetch(url, { method: 'HEAD', redirect: 'error', headers: UA, signal: AbortSignal.timeout(6000) }); if (r.status === 200 && /^image\//i.test(r.headers.get('content-type') || '')) return ''; return 'HTTP ' + r.status; }
  catch (e) { return (e.cause && e.cause.code) || e.name || e.message; }
}
// returns a working URL (raw.githubusercontent, else jsDelivr CDN) or ''
async function verify(url) {
  if (!url.startsWith(RAW)) return '';
  if (okCache.has(url)) return okCache.get(url);
  let ok = '', e1 = await head(url);
  if (!e1) ok = url; else { const alt = CDN + url.slice(RAW.length), e2 = await head(alt); if (!e2) ok = alt; else st.lastErr = `image check: raw ${e1}, cdn ${e2}`; }
  okCache.set(url, ok); return ok;
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
async function matchAll(chs, onProgress) {
  const idx = await getIndex(); let done = 0;
  return pool(chs, 12, async (c) => {
    let url = ''; for (const x of candidates(idx, c.name, c.category).slice(0, 3)) { url = await verify(x.url); if (url) break; }
    done++; if (onProgress) onProgress(done, chs.length); return { ...c, url };
  });
}
async function suggest(name, category) { const idx = await getIndex(); const cs = candidates(idx, name, category).slice(0, 6); const ok = await pool(cs, 6, (x) => verify(x.url)); return cs.map((x, i) => ({ ...x, url: ok[i] })).filter((x) => x.url); }
const isRepoLogo = (u) => typeof u === 'string' && (u.startsWith(RAW) || u.startsWith(CDN)) && !/\.\.|[?#]/.test(u);
const short = (u) => u.replace(RAW, '').replace(CDN, '');
module.exports = { matchAll, suggest, normName, makeIndex, candidates, RAW, CDN, isRepoLogo, short, status: () => ({ ...st }), getIndex };
