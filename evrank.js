'use strict';
// Top udalosti týždňa – the ranking algorithm (pure functions, unit-tested in test/evrank.test.js).
//
// 1) BASE SCORE  (epgevents.js score(), unchanged): admin keywords (Liga majstrov 45, MS v hokeji 55, Oscary 50, SuperStar 40…)
//    + „veľký zápas“ detector (evbig.js: rivalries, big-club groups, SK/CZ stars, top-of-table, rules – the big-match tier boosts)
//    + live +15 / first-run premiere +10 / sports channel +3 / prime time +12 (19:30–23:00) … − rerun 30 − studio/magazine 15.
// 2) HARD FILTERS (this file + epghero.js): the event must still be ahead or on air (end > now), have a valid start/end,
//    not be a recording – „Záznam/Zostrih/Sestřih/Repríza/Highlights“ anywhere in title, subtitle or the EPG description
//    (JOJ/ČT put it only in the description) – and, for a match, not be a delayed re-broadcast: when the official fixture
//    (TheSportsDB) of the same pairing was already played > 4 h before the TV slot, the slot is a replay (Canal+ „PL“).
//    Also out: daily recaps („Denní souhrn“, „Súhrn dňa“) and Grand-Prix motorsport aired Mon–Thu (F1/MotoGP sessions run
//    Fri–Sun, so a weekday „Velká cena Mexika (kvalifikace)“ is always a re-run).
// 3) PRIORITY = base score + SOON (sooner = higher) + OFFICIAL (+6 when the official fixture confirms the kick-off)
//    + EDITOR (optional Gemini order, bounded: at most +10, so it re-orders near-ties but cannot invent an event).
//    SOON: on air / today +6, tomorrow +4, in 2 days +3, 3 days +2, 4 days +1, 5 days 0, 6 days −2, 7 days −3
//    (Bratislava calendar days, not 24-hour blocks); CLUBS: a team pairing in a UEFA cup +12, with a Slovak team/
//    Slovakia +8, a „veľký zápas“ gets its „ráno −10“ refunded; NIGHT −10 for a start 00:00–06:59; PRACTICE −12 (F1/MotoGP trénink).
//    FIRST AIRING: the same pairing / title+subtitle later in the week is a re-run → only the first airing stays.
// 4) MERGE: the same event on several SK/CZ channels (same match pairing, or same category + start ±30 min + similar
//    title) becomes one card listing all channels; the highest-priority airing is kept.
// 5) VARIETY (select()): walk the list by priority with caps – one card per series (title stem: F1 weekend, Olympics,
//    a show's episodes, a team pairing), ≤ perCat of one sport/genre (8 slides → 3), ≤ perDay
//    on one calendar day (8 → 3), sport overall ≤ 75 % (8 → 6) so at least ¼ of the slots go to non-sport TV events
//    (film premieres, shows, galas, concerts…) when such candidates exist (they may enter 10 points below the sport
//    threshold); remaining gaps are filled by the best skipped candidates. Final order = priority.
const TZ = 'Europe/Bratislava';
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (ms) => ymd.format(ms);
// calendar-day difference in Bratislava (DST-safe: compare the local dates as UTC midnights)
const dayDiff = (from, to) => { const a = Date.parse(dayKey(from) + 'T00:00:00Z'), b = Date.parse(dayKey(to) + 'T00:00:00Z'); return Math.round((b - a) / 86400e3); };
const wdf = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const wdfEn = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric' });
const hmf = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1);
// "So 7. 11." / "Sat 7/11"
const dateLbl = (ms, en) => cap((en ? wdfEn : wdf).format(ms).replace(/\s+/g, ' '));
const hmL = (ms) => hmf.format(ms);
// "So 7. 11. · 20:45" (+ "–22:45" when the end is known)
const whenLbl = (s, e, en) => dateLbl(s, en) + ' · ' + hmL(s) + (e ? '–' + hmL(e) : '');

// relative badge: ● NAŽIVO / o 25 min / dnes o 3 h / zajtra / o 5 dní (calendar days → always agrees with the date label)
function badge(s, now, en) {
  if (s <= now) return '● ' + (en ? 'LIVE' : 'NAŽIVO');
  const m = Math.max(1, Math.round((s - now) / 60e3)), dd = dayDiff(now, s), o = en ? 'in ' : 'o ';
  if (m < 60) return o + m + ' min';
  if (dd === 0) return (en ? 'today, in ' : 'dnes o ') + Math.floor(m / 60) + ' h';
  if (dd === 1) return en ? 'tomorrow' : 'zajtra';
  return o + dd + ' ' + (en ? 'days' : dd < 5 ? 'dni' : 'dní');
}

const RERUN_ANY = /(?<![\p{L}\d])(záznam\p{L}*|zaznam\p{L}*|zostrih\p{L}*|sestřih\p{L}*|sestrih\p{L}*|repríz\p{L}*|repriz\p{L}*|opakovan\p{L}*|highlights|best of|rewind)(?![\p{L}\d])/iu;
// „Premiérový záznam“ of a magazine is still a magazine – any of these words disqualifies a hero event
const RECAP = /(?<![\p{L}\d])(souhrn\p{L}*|súhrn\p{L}*|suhrn\p{L}*|sumár\p{L}*|magazín\p{L}*|magazin\p{L}*)(?![\p{L}\d])/iu;
const GP = /formul|formula|\bf1\b|motogp|moto ?gp|velk[aá] cena|ve[lľ]k[aá] cena|grand prix/i;
const wdNum = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const isRecording = (x) => RERUN_ANY.test([x.title, x.sub, String(x.descr || '').slice(0, 240)].join(' \n ')) || RECAP.test(x.title + ' \n ' + (x.sub || '')) ||
  (Number.isFinite(x.s) && /^(Mon|Tue|Wed|Thu)$/.test(wdNum.format(x.s)) && GP.test(x.title + ' ' + (x.sub || '')) && !/^(Fri|Sat|Sun)$/.test(wdNum.format(x.s)));

// ---------- match: Home – Away ----------
const SPORTWORD = /^(futbal|fotbal|hokej|ľadový hokej|basketbal|volejbal|h[aá]dzan[aá]|h[aá]zen[aá]|tenis|florbal|futsal|reprezent\p{L}*|liga|extraliga|magaz\p{L}*|štúdio|studio|ženy|muži|zeny|muzi|kvalifik\p{L}*|program|formul\p{L}*|ve[lľ]k[aá] cena|velká cena|mma|box)$/iu;
const TEAMSPORT = /^(football|hockey|basketball|stadium|tennis)$/;
const side = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const okSide = (v) => v.length >= 2 && v.length <= 48 && /^[\p{Lu}\d]/u.test(v) && !/,/.test(v) && !/^\d+\.?\s/.test(v) && !SPORTWORD.test(v) && /\p{L}{2}/u.test(v);
function pairIn(text) {
  for (const seg0 of String(text || '').split(/:\s+/).reverse()) {
    // cut trailing EPG prose: „… Záznam zápasu …“, „ (CZ)“, sentence end
    const seg = seg0.replace(/\s+(Záznam|Zaznam|Priamy|Přímý|Zápas|Utkání|Stretnutie|Premiérov\p{L}*|Live|Naživo)\b.*$/u, '').replace(/[.(].*$/, '').trim();
    const m = /^(.+?)\s+(?:[-–—]|vs\.?|v\.?)\s+(.+)$/iu.exec(seg); if (!m) continue;
    const a = side(m[1]), b = side(m[2]); if (okSide(a) && okSide(b) && a.toLowerCase() !== b.toLowerCase()) return [a, b];
  }
  return null;
}
// teams of a candidate (team sports + tennis only): subtitle → title → start of the EPG description
function teamsOf(x, cat) {
  if (!TEAMSPORT.test(cat || '')) return null;
  return pairIn(x.sub) || (/^\p{L}+ [-–] /u.test(x.title) && SPORTWORD.test(x.title.split(/ [-–] /)[0]) ? null : pairIn(x.title)) || (!x.sub ? pairIn(String(x.descr || '').split(/\n/)[0].slice(0, 120)) : null);
}
// competition line: „PL“ → Premier League; „Futbal - Európska liga“ → Európska liga; + „9. kolo“ from subtitle/description
const COMP_ALIAS = { pl: 'Premier League', epl: 'Premier League', lm: 'Liga majstrov', el: 'Európska liga', ucl: 'Liga majstrov', nhl: 'NHL', nba: 'NBA' };
function compOf(x, teams) {
  let t = side(x.title); const a = COMP_ALIAS[t.toLowerCase()]; if (a) t = a;
  if (teams && pairIn(t)) t = x.sub && !pairIn(x.sub) ? side(x.sub) : ''; // title = „LASK Linz - Slovan“, sub = „Liga mistrů UEFA“
  t = t.replace(/^(futbal|fotbal|hokej|basketbal|volejbal|h[aá]dzan[aá]|h[aá]zen[aá]|tenis)\s+[-–]\s+/iu, (m0) => m0); // keep „Hokej - Reprezentácia“ readable
  t = t.replace(/\s+[-–]\s+/g, ' · ');
  const r = /(\d{1,2})\.\s*(kolo|kola|kolo:)/i.exec(String(x.sub || '') + ' ' + String(x.descr || '').slice(0, 160));
  const pre = teams && x.sub ? side(String(x.sub).split(/:\s+/).slice(0, -1).join(': ')) : '';
  const extra = r ? r[1] + '. kolo' : pre && !/\d+\.\s*kolo/i.test(pre) ? pre : '';
  return [t, extra].filter(Boolean).join(' · ').slice(0, 90);
}

// ---------- official fixture (TheSportsDB) ----------
const STRIP = /\b(fc|afc|cf|sc|ac|as|ss|hc|hk|gnk|nk|fk|sk|bc|mbk|kk|bk|vk|tj|ofk|msk|mfk|sfc|fbc|1\.|cd|ud|rc|sv|vfb|vfl|tsg|bsc)\b\.?/gi;
const EXONYM = { 'záhreb': 'Zagreb', 'mníchov': 'Munich', 'neapol': 'Napoli', 'rím': 'Roma', 'řím': 'Roma', 'miláno': 'Milan', 'turín': 'Torino', 'lisabon': 'Lisbon', 'atény': 'Athens', 'kodaň': 'Copenhagen', 'belehrad': 'Belgrade', 'bělehrad': 'Belgrade', 'varšava': 'Warsaw', 'praha': 'Prague', 'viedeň': 'Vienna', 'vídeň': 'Vienna', 'lipsko': 'Leipzig' };
const qName = (n) => side(String(n).replace(STRIP, ' ').split(' ').map((w) => EXONYM[w.toLowerCase()] || w).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 &'-]/g, ' '));
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// does an official event name a team like the EPG does? („Sunderland AFC“ ~ „Sunderland“, „Dinamo Záhreb“ ~ „Dinamo Zagreb“)
const sameTeam = (epg, off) => { const a = fold(qName(epg)), b = fold(off); if (!a || !b) return false; return a === b || b.includes(a) || a.includes(b) || a.split(' ').filter((w) => w.length >= 4).some((w) => b.split(' ').includes(w)); };
// classify one EPG slot against official fixtures of the same pairing
// → { st: 'ok'|'replay'|'none', ev } ; ok = kick-off within −4 h…+1 h of the slot (pre-match studio up to 1 h earlier)
function classify(slotS, teams, events) {
  let best = null;
  for (const e of events || []) {
    const ts = e.ts; if (!Number.isFinite(ts)) continue;
    if (!(sameTeam(teams[0], e.home) && sameTeam(teams[1], e.away)) && !(sameTeam(teams[0], e.away) && sameTeam(teams[1], e.home))) continue;
    const d = ts - slotS;
    if (d >= -4 * 3600e3 && d <= 3600e3) return { st: 'ok', ev: e };
    if (d < -4 * 3600e3 && d > -14 * 86400e3 && (!best || ts > best.ts)) best = e;
  }
  return best ? { st: 'replay', ev: best } : { st: 'none', ev: null };
}
const tsdbEvent = (e) => ({ ts: (() => { const t = e.strTimestamp ? Date.parse(String(e.strTimestamp).replace(/(\+00:?00|Z)?$/, 'Z')) : e.dateEvent && e.strTime ? Date.parse(e.dateEvent + 'T' + e.strTime + 'Z') : NaN; return t; })(), home: e.strHomeTeam || '', away: e.strAwayTeam || '', league: e.strLeague || '', round: e.intRound || '', hb: e.strHomeTeamBadge || '', ab: e.strAwayTeamBadge || '', status: e.strStatus || '' });

// ---------- priority, merge, variety ----------
const SOON = [6, 4, 3, 2, 1, 0, -2, -3];
const soon = (s, now) => SOON[Math.max(0, Math.min(7, dayDiff(now, Math.max(s, now))))];
const SPORTCAT = new Set(['football', 'hockey', 'tennis', 'basketball', 'athletics', 'f1', 'mma', 'boxing', 'stadium']);
const isSport = (x) => SPORTCAT.has(x.cat) || x.kind === 'sport';
// club matches: the EPG often lacks the „live“ flag on them, so named pairings get a bounded boost
const EUROCUP = /liga (majstrov|mistr[uů])|champions league|európsk[aá] liga|evropsk[aá] liga|europa league|konferen[cč]n|conference league|\buefa\b/i;
const SKTEAM = /slovan bratislava|spartak trnava|[žz]ilina|\bdac\b|dunajsk[aá] streda|ko[šs]ice|slovensk|slovakia|ru[žz]omberok|podbrezov|michalovce|zvolen|nitra|bansk[aá] bystrica|poprad/i;
function clubBonus(x) {
  if (!x.teams) return 0;
  const w = (x.why || []).join(' '), big = /veľký zápas/.test(w);
  return (EUROCUP.test(x.comp || x.sub || '') ? 12 : 0) + (SKTEAM.test(x.teams.join(' ')) ? 8 : 0) + (big && /ráno -10/.test(w) ? 10 : 0); // a big derby at 11:45 is not a „morning“ filler
}
const hourOf = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const PRACTICE = /tr[eé]nin[gk]|practice|\bfp[123]\b|voľn[yý] tr|volný tr/i;
function priority(x, now, gemIdx) {
  const g = gemIdx == null || gemIdx < 0 ? 0 : Math.max(0, 10 - gemIdx * 1.5);
  const night = +hourOf.format(x.s) < 7 && x.s > now ? -10 : 0; // 00:00–06:59 start: few viewers (and mostly re-runs)
  const practice = PRACTICE.test(x.title + ' ' + (x.sub || '')) ? -12 : 0; // F1/MotoGP practice is not the event of the weekend
  return Math.round(x.score + soon(x.s, now) + (x.official === 'ok' ? 6 : 0) + g + night + practice + clubBonus(x));
}
// the same broadcast again later in the week (handball Thu live → Sat/Sun re-runs; „Triatlon“ Thu → Fri 02:25):
// key = team pairing, or title + subtitle; only the first airing (by start) survives – later ones are re-runs
const airKey = (x) => (x.teams ? 'p:' + pairKey(x.teams) : x.sub ? 't:' + fold(x.title) + '|' + fold(x.sub) : '');
function firstAirings(list) {
  const first = new Map();
  for (const x of list) { const k = airKey(x); if (k && (!first.has(k) || x.s < first.get(k).s)) first.set(k, x); }
  return list.filter((x) => { const k = airKey(x); if (!k) return true; const f = first.get(k); return f === x || Math.abs(x.s - f.s) <= 30 * 60e3; });
}
// one card per „series“: the same title stem (years, brackets, episode numbers removed) or team pairing
const stemKey = (x) => (x.teams ? 'p:' + pairKey(x.teams) : 's:' + fold(String(x.title).replace(/\([^)]*\)/g, ' ').replace(/\b(19|20)\d\d\b/g, ' ').replace(/\b[ivx]+\.|\b\d+\./gi, ' ')));
const stems = (t) => new Set(fold(t).split(' ').filter((w) => w.length >= 4).map((w) => w.slice(0, 4)));
const sim = (a, b) => { const A = stems(a), B = stems(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
const pairKey = (t) => (t ? t.map((v) => fold(qName(v))).sort().join('|') : '');
function sameEvent(a, b) {
  if (Math.abs(a.s - b.s) > (a.teams && b.teams ? 3 * 3600e3 : 30 * 60e3)) return false;
  if (a.teams || b.teams) return !!(a.teams && b.teams) && pairKey(a.teams) === pairKey(b.teams);
  return a.cat === b.cat && sim(a.title + ' ' + (a.sub || ''), b.title + ' ' + (b.sub || '')) >= 0.5;
}
// list sorted by priority → merged list; merged airings add their channel to .alt (names, max 3)
function merge(list) {
  const out = [];
  for (const x of list) {
    const m = out.find((y) => sameEvent(y, x));
    if (!m) { out.push(Object.assign(x, { alt: x.alt || [] })); continue; }
    const nm = x.chName; if (nm && nm !== m.chName && !m.alt.includes(nm) && m.alt.length < 3) m.alt.push(nm);
  }
  return out;
}
function select(list, n, opt = {}) {
  const perCat = opt.perCat || Math.max(2, Math.ceil(n * 0.3)), perDay = opt.perDay || Math.max(2, Math.ceil(n * 0.35)), maxSport = opt.maxSport || Math.max(1, Math.ceil(n * 0.75));
  const out = [], rest = [], cc = new Map(), dc = new Map(), sk = new Set(); let sp = 0;
  for (const x of list) {
    if (out.length >= n) break;
    const c = x.cat || 'x', d = dayKey(x.s), s = isSport(x), k = stemKey(x);
    if (sk.has(k) || (cc.get(c) || 0) >= perCat || (dc.get(d) || 0) >= perDay || (s && sp >= maxSport)) { rest.push(x); continue; }
    out.push(x); sk.add(k); cc.set(c, (cc.get(c) || 0) + 1); dc.set(d, (dc.get(d) || 0) + 1); if (s) sp++;
  }
  // gaps: best skipped candidates – first a different series, only then repeats
  for (const x of list) { if (out.length >= n) break; if (!out.includes(x) && !sk.has(stemKey(x))) { out.push(x); sk.add(stemKey(x)); } }
  for (const x of list) { if (out.length >= n) break; if (!out.includes(x)) out.push(x); }
  return out.sort((a, b) => list.indexOf(a) - list.indexOf(b));
}

module.exports = { clubBonus, firstAirings, stemKey, airKey, TZ, dayKey, dayDiff, dateLbl, hmL, whenLbl, badge, isRecording, pairIn, teamsOf, compOf, qName, sameTeam, classify, tsdbEvent, soon, priority, merge, select, isSport, sameEvent, pairKey, fold };
