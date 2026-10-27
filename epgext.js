'use strict';
// External sport schedules for SK/CZ channels that have no TV-guide (EPG) data:
// Oneplay Sport / MD, Prima Sport, Niké liga 1–5, Voyo Sport… Program info only (title, time, channel) – never stream links.
// Public pages only, robots.txt respected, ~4×/day, polite pauses between requests (Niké liga: crawl-delay 10 s).
//  · exact sources name the numbered channel (oneplay.cz sport pages: „Vysílá Oneplay Sport 2“)
//  · platform-only sources name the platform (nikeliga.sk → Voyo, chanceliga.cz → Oneplay, hokej.cz → O2 TV Sport MD)
//    → the most likely numbered channel is PREDICTED (learned history + fill 1,2,3… by importance, never overlapping)
//    and marked fl 'q' („predpokladaný kanál“). An exact source / admin correction replaces the prediction automatically.
// Rows go into epg_prog as epg_id 'ext:<channel_id>' (fl 'x' / 'xq'), only for channels that have no real EPG.
const OFFICIAL = require('./epgoff');
const BIG = require('./evbig');

const UA = 'lnkbio-tvprogram/1.0 (+https://lnkbio.onrender.com; schedule only, 4x/day)';
const MAX = 4 * 1048576;
const HOURS = 6; // re-read every 6 h
// default durations (min) per sport when the source gives only the start; NHL/F1/… refined by durOf()
const DUR = { hokej: 150, fotbal: 120, mma: 300, tenis: 180, basketbal: 135, motorsport: 120, volejbal: 120, hadzana: 105, florbal: 120, cyklistika: 240, zimne: 120, sport: 120 };
const durOf = (x) => (/\bnhl\b/i.test(x.comp + ' ' + x.title) ? 165 : /\bnba\b/i.test(x.comp + ' ' + x.title) ? 150 : /motogp|superbike|rall/i.test(x.comp + ' ' + x.title) ? 150 : DUR[x.kind] || 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ent = (s) => String(s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
// channel / source-name key: no diacritics, „MD2“→„md 2“, „Kanal1“→„kanal 1“, no (…) notes, no HD/FHD/TV
const nkey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\([^)]*\)?/g, ' ').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\b(hd|fhd|uhd|4k|hevc|tv)\b/g, ' ').replace(/\s+/g, ' ').trim();
const tnorm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['fc', 'fk', 'hc', 'sk', 'mfk', 'afc', 'bk', 'ac', 'sc', 'club', 'klub', 'elh', 'chl', 'live', 'helmet', 'cam', 'tipsport', 'extraliga', 'liga', 'chance', 'nike', 'zapas', 'studio', 'hokej', 'fotbal']);
const toks = (s) => [...new Set(tnorm(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)))];
const nums = (k) => (k.match(/\d+/g) || []).map(Number);
const cmpNum = (a, b) => { const x = nums(a.k), y = nums(b.k); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return a.k < b.k ? -1 : 1; };

// platform pools (by normalized Kanály name) – predicted channels are picked from these, lowest number first
const POOLS = {
  nike: { label: 'Niké liga (Voyo)', re: /^nike liga \d+$/ },
  voyo: { label: 'Voyo Sport', re: /^voyo sport \d+$/ },
  'oneplay-md': { label: 'Oneplay Sport MD', re: /^oneplay sport \d+ md \d+$/ },
  oneplay: { label: 'Oneplay Sport', re: /^oneplay sport \d+$/ },
  joj: { label: 'JOJ Play Sport', re: /^joj play sport \d+$/ },
};

async function get(url, signal) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30e3), on = () => ac.abort();
  if (signal) signal.addEventListener('abort', on, { once: true });
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rd = r.body.getReader(), parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > MAX) { ac.abort(); throw new Error('príliš veľké'); } parts.push(value); }
    return Buffer.concat(parts).toString('utf8');
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', on); }
}
const ymd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const local = OFFICIAL._local;
// „28.10.“ (no year) → the nearest future-ish date
function dm(d, m, now) { const y = +ymd(now).slice(0, 4); let s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; if (Date.parse(s) < now - 200 * 86400e3) s = `${y + 1}${s.slice(4)}`; return s; }

// ---------- readers ----------
// oneplay.cz public sport pages (robots: allowed). aria-label „<title> <competition>, Vysílá <Channel>[, Živě]“ + text: time | title | competition
const OP_PAGES = [['sport', 'sport'], ['sport/fotbal', 'fotbal'], ['sport/hokej', 'hokej'], ['sport/tenis', 'tenis'], ['sport/basketbal', 'basketbal'], ['sport/motorsport', 'motorsport'], ['sport/bojove-sporty', 'mma'], ['sport/ostatne-sporty', 'sport']];
function parseOneplay(h, kind, now) {
  const re = /aria-label="([^"]*?),\s*Vysílá\s+([^",]+?)(,\s*Živě)?"/g, idx = [], out = []; let m;
  while ((m = re.exec(h))) idx.push([m.index, m[2].trim()]);
  const today = ymd(now), tomorrow = ymd(now + 86400e3);
  for (let i = 0; i < idx.length; i++) {
    const seg = h.slice(idx[i][0], Math.min(idx[i][0] + 12000, i + 1 < idx.length ? idx[i + 1][0] : h.length));
    const txt = seg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[^>]*>/, '').replace(/<[^>]+>/g, '\n').split('\n').map(ent).filter(Boolean);
    const tl = txt[0] || ''; let s = NaN, e = NaN, x;
    const full = txt.find((t) => /^\d{1,2}\.\d{1,2}\.\d{4} \d{1,2}:\d{2}$/.test(t));
    if ((x = /^(\d{1,2}):(\d{2}) - (\d{1,2}):(\d{2})$/.exec(tl))) { // today (or archive with a full date)
      let day = today; if (full) { const f = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(full); day = `${f[3]}-${f[2].padStart(2, '0')}-${f[1].padStart(2, '0')}`; }
      s = local(day, `${x[1]}:${x[2]}`); e = local(day, `${x[3]}:${x[4]}`); if (e <= s) e += 86400e3;
    } else if ((x = /^(?:Dnes\s+)?(\d{1,2}):(\d{2})$/.exec(tl))) s = local(today, `${x[1]}:${x[2]}`);
    else if ((x = /^Zítra\s+(\d{1,2}):(\d{2})$/.exec(tl))) s = local(tomorrow, `${x[1]}:${x[2]}`);
    else if ((x = /^(\d{1,2})\.(\d{1,2})\.\s+(\d{1,2}):(\d{2})$/.exec(tl))) s = local(dm(+x[1], +x[2], now), `${x[3]}:${x[4]}`);
    if (!Number.isFinite(s) || !txt[1] || txt[1].length > 160) continue; // „Živě“ (already running, start unknown) / league tiles
    const comp = txt[2] && !/^(\d|https?:)/.test(txt[2]) && txt[2].length < 80 ? txt[2] : '';
    out.push({ src: 'oneplay', title: txt[1], comp, s, e: Number.isFinite(e) ? e : 0, kind: kindOf(kind, comp + ' ' + txt[1]), raw: idx[i][1], cc: 'cz' });
  }
  return out;
}
// sport of an item: league names first („CHL: … | Chance Liga“ is football, not the Champions Hockey League), then keywords, else the page
const KINDS = [
  ['hokej', /hokej|hockey/i], ['fotbal', /fotbal|futbal|football|soccer/i],
  ['volejbal', /volejbal|volleyball/i], ['hadzana', /h[aá]dzan|h[aá]zen|handball/i], ['florbal', /florbal|floorball|unihokej/i],
  ['basketbal', /basket|\bnba\b|eurolig|euroleague|eurocup|\bnbl\b|\bsbl\b/i],
  ['tenis', /tenis|tennis|\batp\b|\bwta\b|davis cup|billie jean|wimbledon|roland garros|us open|australian open/i],
  ['mma', /oktagon|\bufc\b|\bmma\b|\bbox|kickbox|bojov|\brfa\b|\bxfn\b|\bksw\b/i],
  ['motorsport', /formul|motogp|\bf1\b|grand prix|rally|rallye|motorsport|nascar|superbike|indycar|dakar/i],
  ['cyklistika', /cyklist|tour de|giro d|vuelta|paris-roubaix/i],
  ['zimne', /biatlon|biathlon|ly[žz]ov|slalom|zjazd|sjezd|skoky na ly|beh na ly|krasokor|krasobrus|alpine|\bski\b/i],
  ['fotbal', /chance liga|nik[eé] liga|fortuna liga|premier league|laliga|la liga|serie a|bundesliga|ligue 1|liga mistr|liga majstr|champions league|europa league|konferen[čc]n|evropsk[aá] liga|eur[oó]psk[aá] liga|uefa|fifa/i],
  ['hokej', /extralig|\bnhl\b|\bkhl\b|\bchl\b|\belh\b|tipsport liga|\bshl\b/i],
];
const kindOf = (k, t) => { if (k && k !== 'sport') return k; if (/(^|\s)chl:/i.test(t)) return 'fotbal'; for (const [n, re] of KINDS) if (re.test(t)) return n; return k; };
// nikeliga.sk „všetky zápasy“: TV column (linear channels – they have EPG) + ONLINE (Voyo → Niké liga 1–5)
function parseNike(h, now) {
  const out = [];
  for (const r of h.split(/<tr[\s>]/).slice(1)) {
    const tm = [...r.matchAll(/schedule_table__team__name"><a[^>]*>([^<]+)</g)].map((x) => ent(x[1])), d = /date--full">\s*\S+\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(r), t = /schedule_table__time">\s*(\d{1,2}):(\d{2})/.exec(r);
    if (tm.length < 2 || !d || !t || /schedule_table__score"><a[^>]*>\s*\d+\s*:\s*\d+/.test(r)) continue;
    const s = local(`${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`, `${t[1]}:${t[2]}`); if (s < now - 3 * 3600e3) continue;
    const tv = [...r.matchAll(/ico-tv-([a-z0-9-]+)/g)].map((x) => x[1]);
    out.push({ src: 'nikeliga', title: `${tm[0]} – ${tm[1]}`, comp: 'Niké liga', s, e: 0, kind: 'fotbal', plat: tv.includes('voyo') || !tv.length ? 'nike' : 'nike', tv: tv.filter((x) => x !== 'voyo') });
  }
  return out;
}
// chanceliga.cz /zapasy: date dd/mm/yy + „so 15:00“ + TV logos (Oneplay → Oneplay Sport / MD)
function parseChance(h, now) {
  const out = [];
  for (const li of h.split(/<li[\s>]/).slice(1)) {
    const d = /class="date"><b>#\d+<\/b>\s*(\d{1,2})\/(\d{1,2})\/(\d{2})/.exec(li), t = /class="time"><a[^>]*>\s*\S+\s+(\d{1,2}):(\d{2})/.exec(li);
    if (!d || !t) continue;
    const tm = [...li.matchAll(/<span class="team">\s*<a[^>]*>\s*<img[^>]*alt="([^"]+)"/g)].map((x) => ent(x[1])); if (tm.length < 2) continue;
    const tv = [...li.matchAll(/\/tv\/[^"]*"\s+alt="([^"]+)"/g)].map((x) => ent(x[1]));
    const s = local(`20${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}`, `${t[1]}:${t[2]}`); if (s < now - 3 * 3600e3) continue;
    out.push({ src: 'chanceliga', title: `${tm[0]} – ${tm[1]}`, comp: 'Chance Liga', s, e: 0, kind: 'fotbal', plat: tv.some((x) => /oneplay|o2/i.test(x)) ? 'oneplay-any' : '', tv: tv.filter((x) => !/oneplay|o2/i.test(x)) });
  }
  return out;
}
// hokej.cz Tipsport extraliga: „O2 TV Sport MD“ → Oneplay Sport MD, „O2TV“ → Oneplay Sport 1–4
function parseHokej(h, now) {
  const out = [], y = +ymd(now).slice(0, 4);
  for (const r of h.split(/<tr[\s>]/).slice(1)) {
    if (!/preview/.test(r.slice(0, 200))) continue;
    const tm = [...r.matchAll(/preview__name--long">([^<]+)</g)].map((x) => ent(x[1])), d = /<div class="col-1_3">[^<]*<\/div>\s*<div class="col-1_3">\s*(\d{1,2})\.\s*(\d{1,2})\.\s*<\/div>\s*<div class="col-1_3">\s*(\d{1,2}):(\d{2})/.exec(r);
    const tv = [...r.matchAll(/preview-tvlogo"[^>]*>\s*<img[^>]*alt="([^"]*)"/g)].map((x) => ent(x[1]));
    if (tm.length < 2 || !d) continue;
    const s = local(dm(+d[1], +d[2], now), `${d[3]}:${d[4]}`); if (s < now - 3 * 3600e3 || !y) continue;
    const md = tv.some((x) => /o2 ?tv sport md|oneplay sport md/i.test(x)), op = tv.some((x) => /^(o2 ?tv|oneplay)/i.test(x));
    out.push({ src: 'hokej.cz', title: `${tm[0]} – ${tm[1]}`, comp: 'Tipsport extraliga', s, e: 0, kind: 'hokej', plat: md ? 'oneplay-md' : op ? 'oneplay' : '', tv: tv.filter((x) => !/^(o2|oneplay)/i.test(x)) });
  }
  return out;
}
// TheSportsDB (free public API, key „123“; /api allowed by robots.txt): fixtures of leagues whose TV platform is known from the
// 2026/27 rights – Tipsport liga, Tipos SHL, Tipos SBL → JOJ Play (all games), Tipsport extraliga → Oneplay (fallback when
// hokej.cz blocks us), Európska/Konferenčná liga → JOJ Play, NHL → Voyo (selected games). Free key returns whole rounds via
// eventsround.php, so we walk rounds from the cached current one. sel: only games that are NOT already in a real EPG.
const TSDB_API = 'https://www.thesportsdb.com/api/v1/json/123/';
const TSDB = [
  { id: 4932, comp: 'Hokej – Tipsport liga', kind: 'hokej', plat: 'joj', cc: 'sk' },
  { id: 4929, comp: 'Hokej – Tipos SHL', kind: 'hokej', plat: 'joj', cc: 'sk' },
  { id: 5122, comp: 'Basketbal – Tipos SBL', kind: 'basketbal', plat: 'joj', cc: 'sk' },
  { id: 4923, comp: 'Hokej – Tipsport extraliga', kind: 'hokej', plat: 'oneplay-any', cc: 'cz', fb: 'hokej.cz' },
  { id: 4481, comp: 'Futbal – Európska liga UEFA', kind: 'fotbal', plat: 'joj', sel: 1 },
  { id: 5071, comp: 'Futbal – Konferenčná liga UEFA', kind: 'fotbal', plat: 'joj', sel: 1 },
  // NHL on Voyo: ~11 games/week, not named in advance → teams with Slovak/Czech stars, max 2 per day, best-ranked team first
  { id: 4380, comp: 'Hokej – NHL', kind: 'hokej', plat: 'voyo', sel: 1, perDay: 2, team: ['montreal', 'boston', 'new jersey', 'colorado', 'vegas', 'washington', 'tampa', 'st louis', 'calgary', 'philadelphia', 'pittsburgh', 'seattle'] },
];
const seasonOf = (now) => { const d = new Date(now), y = d.getUTCFullYear(); return d.getUTCMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`; };
// one TheSportsDB event → item (null for postponed / finished / unusable)
function tsdbItem(ev, L) {
  if (!ev || !ev.strHomeTeam || !ev.strAwayTeam || /^yes$/i.test(ev.strPostponed || '') || /^(ft|aot|ap|pst|canc|aban|postponed|cancelled|match finished)$/i.test(ev.strStatus || '')) return null;
  const ts = ev.strTimestamp ? String(ev.strTimestamp).replace(/\+00:00$/, '') : ev.dateEvent && ev.strTime ? `${ev.dateEvent}T${String(ev.strTime).slice(0, 8)}` : '';
  const s = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + 'Z'); if (!Number.isFinite(s)) return null;
  const x = { src: 'thesportsdb', title: `${ev.strHomeTeam} – ${ev.strAwayTeam}`, comp: L.comp, s, e: 0, kind: L.kind, plat: L.plat, lg: L.id };
  if (L.cc) x.cc = L.cc; if (L.sel) x.sel = 1; if (L.fb) x.fb = L.fb;
  return x;
}
// NHL-style pick: only listed teams, ≤ perDay games per Bratislava day, best team rank first
function tsdbPick(list, L) {
  if (!L.team) return list;
  const rank = (x) => { const t = tnorm(x.title); const i = L.team.findIndex((n) => t.includes(n)); return i < 0 ? 99 : i; };
  const byDay = new Map();
  for (const x of list) { const r = rank(x); if (r === 99) continue; const d = ymd(x.s - 6 * 3600e3); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push([r, x]); }
  const out = []; for (const l of byDay.values()) out.push(...l.sort((a, b) => a[0] - b[0] || a[1].s - b[1].s).slice(0, L.perDay || 99).map((z) => z[1]));
  return out.sort((a, b) => a.s - b.s);
}
// walk rounds from the cached one: skip finished rounds, collect until the round starts after the window; ≤ maxReq requests
async function tsdbLeague(L, { now, signal, getJson, rounds, maxReq = 18, pause = 3500 }) {
  const season = seasonOf(now), end = now + 8 * 86400e3, from = now - 4 * 3600e3;
  let r = rounds[L.id], req = 0;
  if (!r) { const j = await getJson(`${TSDB_API}eventsnextleague.php?id=${L.id}`); req++; r = +(j && j.events && j.events[0] && j.events[0].intRound) || 1; await sleep(pause); }
  const out = []; let first = 0, empty = 0;
  while (req < maxReq) {
    const j = await getJson(`${TSDB_API}eventsround.php?id=${L.id}&r=${r}&s=${season}`); req++;
    const evs = (j && j.events) || [];
    if (!evs.length) { if (++empty >= 2) break; r++; await sleep(pause); continue; }
    empty = 0;
    const its = evs.map((e) => tsdbItem(e, L)).filter(Boolean), live = its.filter((x) => x.s > from);
    if (live.length && !first) first = r;
    out.push(...live.filter((x) => x.s < end));
    const starts = evs.map((e) => Date.parse(String(e.strTimestamp || e.dateEvent || '').replace(/\+00:00$/, '') + (/T/.test(e.strTimestamp || '') ? 'Z' : 'T00:00:00Z'))).filter(Number.isFinite);
    if (starts.length && Math.min(...starts) > end) break;
    r++; await sleep(pause);
  }
  if (first) rounds[L.id] = first; else delete rounds[L.id];
  return tsdbPick(out, L);
}
async function readTsdb(signal, now, ctx = {}) {
  const kv = ctx.kv, rounds = JSON.parse((kv && (await kv.get('ext_tsdb_r'))) || '{}'), all = [], errs = [];
  const getJson = async (u) => { try { return JSON.parse(await get(u, signal)); } catch (e) { if (!/429/.test(e.message)) throw e; await sleep(65e3); return JSON.parse(await get(u, signal)); } }; // free key ≈30 req/min
  for (const L of TSDB) {
    try { all.push(...await tsdbLeague(L, { now, signal, getJson, rounds })); } catch (e) { errs.push(L.comp + ': ' + (e.message || e)); }
    await sleep(3500);
  }
  if (kv) await kv.set('ext_tsdb_r', JSON.stringify(rounds));
  if (!all.length && errs.length) throw new Error(errs[0]);
  return all;
}
const SOURCES = [
  { id: 'oneplay', label: 'oneplay.cz – športový program (presné kanály)', exact: true, url: 'https://www.oneplay.cz/sport',
    async read(signal, now) { const all = []; for (const [p, k] of OP_PAGES) { all.push(...parseOneplay(await get('https://www.oneplay.cz/' + p, signal), k, now)); await sleep(3000); } return all; } },
  { id: 'nikeliga', label: 'nikeliga.sk – rozpis (platforma Voyo → Niké liga 1–5)', url: 'https://www.nikeliga.sk/zapasy',
    async read(signal, now) { const h = await get('https://www.nikeliga.sk/zapasy', signal), a = /href="(\/zapasy\/\d{4}\?id_round=999&(?:amp;)?id_stage=\d+)"/.exec(h); let out = parseNike(h, now); if (a) { await sleep(11e3); out = parseNike(await get('https://www.nikeliga.sk' + a[1].replace(/&amp;/g, '&'), signal), now); } return out; } },
  { id: 'chanceliga', label: 'chanceliga.cz – rozpis (platforma Oneplay)', url: 'https://www.chanceliga.cz/zapasy', read: async (signal, now) => parseChance(await get('https://www.chanceliga.cz/zapasy', signal), now) },
  { id: 'hokej.cz', label: 'hokej.cz – Tipsport extraliga (O2 TV Sport MD → Oneplay MD)', url: 'https://www.hokej.cz/tipsport-extraliga/zapasy',
    async read(signal, now) { const u = 'https://www.hokej.cz/tipsport-extraliga/zapasy'; let h; try { h = await get(u, signal); } catch (e) { await sleep(20e3); h = await get(u, signal); } return parseHokej(h, now); } }, // one polite retry; if still blocked, TheSportsDB covers the extraliga
  { id: 'thesportsdb', label: 'TheSportsDB – hokej SK/CZ + NHL, basketbal SBL, Európska/Konferenčná liga (platforma podľa práv 2026/27)', url: 'https://www.thesportsdb.com/', read: readTsdb },
];

// ---------- channel matching ----------
function chanIndex(rows, aliasTxt) {
  const list = rows.map((r) => ({ id: r.id, name: r.name, k: nkey(r.name), real: r.real }));
  const alias = new Map(); for (const l of String(aliasTxt || '').split(/\r?\n/)) { const m = /^\s*(.+?)\s*=\s*(.+?)\s*$/.exec(l); if (m && !/^#/.test(l)) alias.set(nkey(m[1]), nkey(m[2])); }
  return { list, alias, byId: new Map(list.map((c) => [c.id, c])) };
}
// → { ch } exact, { cands:[…] } partial (predict among them), or null (unmapped)
function resolve(ix, raw, cc) {
  let k = nkey(raw); if (!k) return null; if (ix.alias.has(k)) k = ix.alias.get(k);
  const strip = (x) => x.replace(/\b(cz|sk)\b/g, ' ').replace(/\s+/g, ' ').trim();
  let c = ix.list.filter((x) => x.k === k); if (c.length === 1) return { ch: c[0] };
  c = ix.list.filter((x) => strip(x.k) === strip(k));
  if (c.length > 1 && cc) { const p = c.filter((x) => x.k.split(' ').includes(cc)); if (p.length) c = p; }
  if (c.length === 1) return { ch: c[0] };
  if (c.length > 1) return { cands: c.sort(cmpNum) };
  // „Oneplay Sport MD2“ ⊂ „Oneplay Sport 1 MD 2“ (only extra numbers allowed) → which one is not stated → predict
  const st = strip(k).split(' ');
  c = ix.list.filter((x) => { const ct = strip(x.k).split(' '); let i = 0; for (const w of ct) { if (w === st[i]) i++; else if (!/^\d+$/.test(w)) return false; } return i === st.length && ct.length > st.length; });
  return c.length ? { cands: c.sort(cmpNum) } : null;
}
const overlaps = (busy, s, e) => (busy || []).some((b) => s < b.e && e > b.s);
const sameMatch = (a, b) => Math.abs(a.s - b.s) <= 150 * 60e3 && // studio/pre-show can start >1 h before the face-off
  (() => { const x = toks(a.title), y = new Set(toks(b.title)); return x.filter((w) => y.has(w)).length >= 2; })();

const DOM = { oneplay: 'oneplay.cz', nikeliga: 'nikeliga.sk', chanceliga: 'chanceliga.cz', 'hokej.cz': 'hokej.cz', thesportsdb: 'TheSportsDB' };
function install({ pool, kv, channels, loadMap, onChange, imp }) {
  let busy = null; const st = { runs: {} };
  const learnKeys = (it) => [it.comp ? 'c:' + tnorm(it.comp) : '', ...toks(it.title.replace(/^[^:]{1,12}:\s*/, '')).map((w) => 't:' + w)].filter(Boolean);
  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ext_learn (k TEXT NOT NULL, channel_id INT NOT NULL, n INT NOT NULL DEFAULT 1, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (k, channel_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ext_fix (k TEXT PRIMARY KEY, channel_id INT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  }
  async function learn(pairs) { // [[key, channel_id]]
    for (const [k, id] of pairs.slice(0, 400)) await pool.query('INSERT INTO ext_learn (k,channel_id) VALUES ($1,$2) ON CONFLICT (k,channel_id) DO UPDATE SET n = LEAST(ext_learn.n + 1, 1000), at = now()', [k.slice(0, 120), id]);
  }
  const ikey = (it) => it.src + '|' + Math.round(it.s / 60e3) + '|' + toks(it.title).slice(0, 4).join('-');
  // network: read all sources (sequential, small), store raw items in kv; per-source failure keeps the previous items
  async function fetchAll(signal) {
    const now = Date.now(), prev = JSON.parse((await kv.get('ext_items')) || '{}'), runs = JSON.parse((await kv.get('ext_runs')) || '{}');
    for (const S of SOURCES) {
      try { const l = (await S.read(signal, now, { kv })).filter((x) => x.s > now - 4 * 3600e3 && x.s < now + 8 * 86400e3).slice(0, 600); prev[S.id] = l; runs[S.id] = { ok: 1, n: l.length, t: now }; }
      catch (e) { runs[S.id] = { ok: 0, err: String(e.message || e).slice(0, 120), n: (prev[S.id] || []).length, t: now }; console.error('EXT', S.id, e.message); }
      await sleep(2000);
    }
    await kv.set('ext_items', JSON.stringify(prev)); await kv.set('ext_runs', JSON.stringify(runs)); await kv.set('ext_at', new Date(now).toISOString());
    return prev;
  }
  // DB only: match → dedupe → learn → predict → write epg_prog 'ext:<id>' for channels without real EPG
  async function apply(opt = {}) {
    const now = Date.now(), items = JSON.parse((await kv.get('ext_items')) || '{}'), m = await loadMap();
    const realIds = new Set((await pool.query(`SELECT DISTINCT epg_id FROM epg_prog WHERE e > now() AND s < now() + interval '7 days' AND epg_id NOT LIKE 'ext:%'`)).rows.map((r) => r.epg_id));
    const rows = (await channels()).filter((r) => r.visible).map((r) => ({ ...r, real: !!(m.get(r.id) && m.get(r.id).epg_id && realIds.has(m.get(r.id).epg_id)) }));
    const ix = chanIndex(rows, await kv.get('ext_alias')), unm = new Map(), fix = new Map((await pool.query('SELECT k,channel_id FROM ext_fix')).rows.map((r) => [r.k, r.channel_id]));
    const hist = new Map(); for (const r of (await pool.query('SELECT k,channel_id,n FROM ext_learn')).rows) { if (!hist.has(r.k)) hist.set(r.k, new Map()); hist.get(r.k).set(r.channel_id, r.n); }
    const all = []; const pairs = [];
    // real-EPG sport rows (next 8 days): „sel“ items (UEFA, NHL…) that a real TV guide already lists are not duplicated
    const realSport = (await pool.query(`SELECT s, title FROM epg_prog WHERE epg_id NOT LIKE 'ext:%' AND kind = 'sport' AND s > now() - interval '4 hours' AND s < now() + interval '8 days'`)).rows.map((r) => ({ s: +new Date(r.s), title: r.title }));
    const fbOk = new Set(Object.keys(items).filter((k) => (items[k] || []).length)); // fallback items only while the primary source has nothing
    for (const [src, l] of Object.entries(items)) for (const it of l || []) {
      if (it.fb && fbOk.has(it.fb)) continue;
      if (it.sel && realSport.some((r) => sameMatch(it, r))) continue;
      const x = { ...it, src, e: it.e || it.s + durOf(it) * 60e3, k: '' }; x.k = ikey(x);
      if (x.raw) { const r = resolve(ix, x.raw, x.cc); if (!r) { unm.set(x.raw, (unm.get(x.raw) || 0) + 1); continue; } if (r.ch) { x.ch = r.ch; x.exact = 1; } else x.cands = r.cands; }
      else if (x.plat) { const P = POOLS[x.plat === 'oneplay-any' ? 'oneplay' : x.plat], c = ix.list.filter((c) => P.re.test(c.k) || (x.plat === 'oneplay-any' && POOLS['oneplay-md'].re.test(c.k))).sort((a, b) => (POOLS['oneplay-md'].re.test(a.k) - POOLS['oneplay-md'].re.test(b.k)) || cmpNum(a, b)); if (!c.length) continue; x.cands = c; x.platOnly = 1; }
      else continue;
      if (fix.has(x.k) && ix.byId.has(fix.get(x.k))) { x.ch = ix.byId.get(fix.get(x.k)); x.exact = 1; x.admin = 1; }
      all.push(x);
    }
    // exact first; a platform/partial item for the same match is dropped (the exact channel replaces the prediction)
    all.sort((a, b) => (b.exact || 0) - (a.exact || 0) || (a.platOnly ? 1 : 0) - (b.platOnly ? 1 : 0) || (a.src === 'thesportsdb') - (b.src === 'thesportsdb') || a.s - b.s); // partial (e.g. MD number known) beats platform-only
    const keep = [];
    for (const x of all) {
      // exact+exact: same channel only (a simulcast on Oneplay Sport 3 and 4 stays on both); anything else: same match
      const dup = keep.find((y) => (x.exact && y.exact ? x.ch.id === y.ch.id && Math.abs(x.s - y.s) < 30 * 60e3 : sameMatch(x, y)));
      if (dup) { if (dup.exact && !x.exact && x.platOnly) for (const k of learnKeys(x)) pairs.push([k, dup.ch.id]); if (!dup.exact && x.exact) Object.assign(dup, { ch: x.ch, exact: 1 }); continue; }
      keep.push(x);
    }
    for (const x of keep) if (x.exact && !x.admin && x.src === 'oneplay') for (const k of learnKeys(x)) pairs.push([k, x.ch.id]);
    // predict: busy map from exact items; then by start, more important first
    const busyCh = new Map(), occupy = (id, s, e) => { if (!busyCh.has(id)) busyCh.set(id, []); busyCh.get(id).push({ s, e }); };
    for (const x of keep) if (x.exact) occupy(x.ch.id, x.s, x.e);
    const pred = keep.filter((x) => !x.exact); for (const x of pred) x.imp = imp ? imp(x) : 0;
    pred.sort((a, b) => a.s - b.s || b.imp - a.imp);
    for (const x of pred) {
      const hk = learnKeys(x), sc = (c) => hk.reduce((a, k) => a + ((hist.get(k) && hist.get(k).get(c.id)) || 0), 0);
      const free = x.cands.filter((c) => !overlaps(busyCh.get(c.id), x.s, x.e)); if (!free.length) { x.ch = null; continue; }
      const best = free.map((c, i) => ({ c, i, h: sc(c) })).sort((a, b) => b.h - a.h || a.i - b.i)[0];
      x.ch = best.c; x.pred = 1; x.hist = best.h; occupy(x.ch.id, x.s, x.e);
    }
    if (pairs.length && !opt.dry) await learn(pairs);
    const out = keep.filter((x) => x.ch && x.e > now - 6 * 3600e3);
    if (opt.dry) return out;
    // write (only channels without real EPG – a channel that gets real EPG drops its external rows on the next apply)
    const w = out.filter((x) => !x.ch.real);
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN'); await cl.query(`DELETE FROM epg_prog WHERE epg_id LIKE 'ext:%'`);
      const seen = new Set();
      for (const x of w) {
        const id = 'ext:' + x.ch.id, key = id + '|' + x.s; if (seen.has(key)) continue; seen.add(key);
        const descr = x.src === 'thesportsdb' ? `Podľa verejného rozpisu TheSportsDB; platforma podľa vysielacích práv (${POOLS[x.plat === 'oneplay-any' ? 'oneplay' : x.plat]?.label || x.plat}), číslo kanála je odhad.` : `Podľa verejného rozpisu ${DOM[x.src] || x.src}${x.pred ? (x.platOnly ? ' – uvádza len platformu, číslo kanála je odhad' : ' – bez presného čísla kanála, je odhad') : ''}.`;
        await cl.query('INSERT INTO epg_prog (epg_id,s,e,title,sub,cat,kind,descr,fl) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING', [id, new Date(x.s), new Date(x.e), x.title.slice(0, 200), (x.comp || '').slice(0, 120), 'Šport', 'sport', descr, x.pred ? 'xq' : 'x']);
      }
      await cl.query('COMMIT');
    } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
    extSet = new Set(w.map((x) => x.ch.id));
    await kv.set('ext_view', JSON.stringify({ t: now, unm: [...unm].sort((a, b) => b[1] - a[1]).slice(0, 40), list: out.filter((x) => x.s < now + 8 * 86400e3).slice(0, 300).map((x) => ({ k: x.k, s: x.s, e: x.e, title: x.title, comp: x.comp, src: x.src, ch: x.ch.id, chName: x.ch.name, real: x.ch.real ? 1 : 0, pred: x.pred ? 1 : 0, admin: x.admin ? 1 : 0, raw: x.raw || POOLS[x.plat === 'oneplay-any' ? 'oneplay' : x.plat]?.label || '', cands: (x.cands || []).map((c) => c.id).slice(0, 40) })) }));
    if (onChange) onChange();
    return { n: w.length, all: out.length, pred: w.filter((x) => x.pred).length };
  }
  let extSet = null;
  const extIds = async () => { if (!extSet) extSet = new Set((await pool.query(`SELECT DISTINCT epg_id FROM epg_prog WHERE epg_id LIKE 'ext:%'`)).rows.map((r) => +r.epg_id.slice(4))); return extSet; };
  async function run(force) {
    if (busy) return busy;
    busy = (async () => { const last = Date.parse((await kv.get('ext_at')) || 0) || 0; if (force || Date.now() - last > HOURS * 3600e3 - 60e3) { await fetchAll(); await backtest().catch(() => {}); } return apply(); })()
      .then((r) => { console.log(`EXT schedules ${JSON.stringify(r)} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`); return r; })
      .catch((e) => { console.error('EXT', e.message); }).finally(() => { busy = null; });
    return busy;
  }
  const due = async () => !busy && Date.now() - (Date.parse((await kv.get('ext_at')) || 0) || 0) > HOURS * 3600e3 - 60e3;
  // ---------- admin (/admin/udalosti#ext): sources, predictions with correction, unmapped names → aliases ----------
  const fmtT = (ms) => new Intl.DateTimeFormat('sk-SK', { timeZone: 'Europe/Bratislava', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  function mountAdmin({ admin, needAuth, csrf, wrap, esc, hid }) {
    const back = (res, m) => res.redirect(303, '/admin/udalosti?m=' + m + '#ext');
    const html = async (req) => {
      const v = await (async () => JSON.parse((await kv.get('ext_view')) || '{}'))(), runs = JSON.parse((await kv.get('ext_runs')) || '{}'), bt = JSON.parse((await kv.get('ext_bt')) || 'null');
      const chs = new Map((await channels()).map((r) => [r.id, r.name])), list = (v.list || []).filter((x) => x.e > Date.now()), alias = (await kv.get('ext_alias')) || '';
      const filled = new Map(); for (const x of list) if (!x.real) filled.set(x.chName, (filled.get(x.chName) || 0) + 1);
      const row = (x) => `<div class="row"><span><b>${esc(fmtT(x.s))}</b> ${esc(x.title)}${x.comp ? ' <span class="hint">· ' + esc(x.comp) + '</span>' : ''}<br><span class="hint">zdroj <b>${esc(x.src)}</b> uvádza: <b>${esc(x.raw || '—')}</b> → ${esc(x.chName)}${x.pred ? ' <i>(predpokladaný kanál)</i>' : x.admin ? ' <i>(opravené v admine)</i>' : ' <i>(presne)</i>'}${x.real ? ' · kanál má vlastný TV program – nezapisuje sa' : ''}</span></span>${x.pred || x.admin ? `<form method="post" action="/admin/udalosti/ext/fix">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><select name="ch">${[...new Set([x.ch, ...x.cands])].map((id) => `<option value="${id}"${id === x.ch ? ' selected' : ''}>${esc(chs.get(id) || '#' + id)}</option>`).join('')}</select><button>${x.admin ? 'Zmeniť' : 'Potvrdiť / opraviť'}</button>${x.admin ? '<button name="undo" value="1">Zrušiť opravu</button>' : ''}</form>` : ''}</div>`;
      const pred = list.filter((x) => x.pred || x.admin), exact = list.filter((x) => !x.pred && !x.admin);
      return `<div class="card extadm" id="ext"><h2>📡 Rozpisy pre kanály bez TV programu (${filled.size} kanálov · ${list.length} zápasov na 7 dní)</h2>
<p class="hint">Verejné rozpisy súťaží a platforiem (len názov, čas a kanál – žiadne odkazy na stream), načítané každých ${HOURS} h. Zápasy sa zapíšu do TV programu kanála (štítok „podľa rozpisu“) a idú aj do výberu Top udalostí. Keď zdroj uvádza len platformu (Voyo, Oneplay), kanál sa <b>predpovedá</b> (história + poradie 1, 2, 3… podľa dôležitosti, bez prekrytia) a označí „predpokladaný kanál“. Presný zdroj alebo oprava tu predpoveď automaticky nahradí; opravy sa systém učí. Kanál, ktorý dostane vlastný TV program, sa prestane plniť.</p>
${SOURCES.map((S) => { const r = runs[S.id]; return `<div class="row"><span><b>${esc(S.label)}</b><br><span class="hint">${r ? (r.ok ? '✅ ' + r.n + ' položiek · ' : '⚠ ' + esc(r.err) + ' (ponechaných ' + r.n + ') · ') + esc(fmtT(r.t)) + ' CET' : 'zatiaľ nenačítané'} · <a href="${esc(S.url)}" rel="noopener noreferrer" target="_blank">zdroj</a></span></span></div>`; }).join('')}
<form method="post" action="/admin/udalosti/ext/refresh">${hid(req)}<button>🔄 Načítať rozpisy teraz</button></form>
<p><b>Naplnené kanály:</b> ${[...filled].map(([n, c]) => esc(n) + ' (' + c + ')').join(', ') || '—'}</p>
${bt ? `<p class="hint">🎯 Backtest predpovede (presné dáta Oneplay so skrytým číslom kanála): <b>${bt.ok}/${bt.n}</b> správne (${bt.n ? Math.round((100 * bt.ok) / bt.n) : 0} %) · ${esc(fmtT(bt.t))} CET</p>` : ''}
<h3>🔮 Predpokladané kanály – potvrďte alebo opravte (${pred.length})</h3>${pred.slice(0, 60).map(row).join('') || '<p class="hint">Žiadne.</p>'}
<details class="evlog"><summary>✅ Presné kanály zo zdroja (${exact.length})</summary>${exact.slice(0, 80).map(row).join('')}</details>
<h3>❓ Nespárované názvy kanálov zo zdrojov</h3><p class="hint">${(v.unm || []).map(([n, c]) => esc(n) + ' (' + c + '×)').join(', ') || '—'}</p>
<form method="post" action="/admin/udalosti/ext/alias">${hid(req)}<label>Aliasy názvov: <code>názov v zdroji = názov v Kanáloch</code> (jeden na riadok; diakritika, medzery a HD sa ignorujú)</label><textarea name="alias" rows="4" maxlength="4000" placeholder="Oneplay Sport MD2 = Oneplay Sport 1 MD 2">${esc(alias)}</textarea><button>Uložiť aliasy</button></form></div>`;
    };
    admin.post('/udalosti/ext/refresh', needAuth, csrf, wrap(async (req, res) => { run(true); back(res, 'ok'); }));
    admin.post('/udalosti/ext/alias', needAuth, csrf, wrap(async (req, res) => { await kv.set('ext_alias', String(req.body.alias || '').replace(/[<>]/g, '').slice(0, 4000)); await apply().catch(() => {}); back(res, 'ok'); }));
    admin.post('/udalosti/ext/fix', needAuth, csrf, wrap(async (req, res) => {
      const k = String(req.body.k || '').slice(0, 300), id = parseInt(req.body.ch, 10), v = JSON.parse((await kv.get('ext_view')) || '{}'), x = (v.list || []).find((y) => y.k === k);
      if (!x) return back(res, 'bad');
      if (req.body.undo === '1') await pool.query('DELETE FROM ext_fix WHERE k=$1', [k]);
      else { if (!(await channels()).some((r) => r.id === id)) return back(res, 'bad'); await pool.query('INSERT INTO ext_fix (k,channel_id) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET channel_id=$2, at=now()', [k, id]); const ks = learnKeys(x); await learn([...ks, ...ks, ...ks].map((kk) => [kk, id])); }
      await apply(); back(res, 'ok');
    }));
    return html;
  }
  // backtest: Oneplay items with an exact numbered channel – hide the number, predict from the same family with the same heuristics
  async function backtest() {
    const items = JSON.parse((await kv.get('ext_items')) || '{}'), l = (items.oneplay || []).filter((x) => /^oneplay sport (md )?\d+$/.test(nkey(x.raw)));
    const seen = new Set(), ev = []; for (const x of l.sort((a, b) => a.s - b.s)) { const k = x.raw + '|' + x.s; if (!seen.has(k)) { seen.add(k); ev.push({ ...x, e: x.e || x.s + durOf(x) * 60e3 }); } }
    const hist = new Map(), busyB = new Map(); let ok = 0, n = 0;
    for (const x of ev) {
      const fam = /md/.test(nkey(x.raw)) ? 'md' : 'op', cands = [...new Set(ev.filter((y) => (/md/.test(nkey(y.raw)) ? 'md' : 'op') === fam).map((y) => nkey(y.raw)))].sort((a, b) => nums(a)[0] - nums(b)[0]);
      const ks = learnKeys(x), sc = (c) => ks.reduce((a, k) => a + ((hist.get(k) && hist.get(k).get(c)) || 0), 0);
      const free = cands.filter((c) => !(busyB.get(c) || []).some((b) => x.s < b.e && x.e > b.s)); if (!free.length) continue;
      const best = free.map((c, i) => ({ c, i, h: sc(c) })).sort((a, b) => b.h - a.h || a.i - b.i)[0].c, truth = nkey(x.raw);
      n++; if (best === truth) ok++;
      if (!busyB.has(truth)) busyB.set(truth, []); busyB.get(truth).push({ s: x.s, e: x.e });
      for (const k of ks) { if (!hist.has(k)) hist.set(k, new Map()); hist.get(k).set(truth, (hist.get(k).get(truth) || 0) + 1); }
    }
    const r = { ok, n, t: Date.now() }; await kv.set('ext_bt', JSON.stringify(r)); return r;
  }
  return { init, run, apply, due, extIds, mountAdmin, backtest, SOURCES, POOLS, view: async () => JSON.parse((await kv.get('ext_view')) || '{}'), runs: async () => JSON.parse((await kv.get('ext_runs')) || '{}'), learn, nkey, isBusy: () => !!busy };
}
module.exports = { install, parseOneplay, parseNike, parseChance, parseHokej, tsdbItem, tsdbPick, tsdbLeague, TSDB, kindOf, durOf, resolve, chanIndex, nkey, sameMatch, POOLS, DUR, BIG };
