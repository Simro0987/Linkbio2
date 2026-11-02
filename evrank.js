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
//    (Bratislava calendar days, not 24-hour blocks); NIGHT −10 for a start 00:00–06:59; PRACTICE −12 (F1/MotoGP trénink);
//    FILLER −30 for a generic sport programme without teams (bare „Curling“, magazín, štúdio, góly…) unless it is a major final/MS/olympics.
//    SPORT ORDER (clubBonus):
//    a) a Slovak OR Czech club / national team (Slovensko, Česko) +12 – both countries equal;
//    b) else a team or tennis player with Slovak/Czech players (curated LEGION list: NHL/football clubs → player, tennis
//       players by name) +8; the card names the player („V drese tímu Boston hrá David Pastrňák.“);
//    c) STRENGTH (strength()): curated ELITE tiers (football: Real, Barça, Bayern, City, Liverpool, Arsenal, PSG, Inter = 3;
//       Milan, Juventus, Dortmund, Atlético, Chelsea, United, Napoli, Tottenham, Leverkusen… = 2; NHL/NBA elites = 2; top
//       national teams = 2) + top-of-table (evbig „špička tabuľky“, TheSportsDB standings) + STAGE (finále +12, semifinále +8,
//       vyraďovacia fáza/play-off/štvrťfinále +5 > league phase). Top vs top (both ≥ 2) = „šláger“ +14 (+4 when both are
//       tier 3), one elite team +4. A UEFA-cup pairing gets +12 only when it has an SK/CZ team, SK/CZ players or an elite
//       club; a plain pairing without any of these (Sunderland – Dinamo Záhreb) gets NOBODY −14, so it only fills gaps.
//       A „veľký zápas“ gets its „ráno −10“ refunded.
//    YOUTH −15 (Youth Olympics, juniors, U15–U19 without a SK/CZ team) and HEATS −10 (rozjazdy/rozplavby/predkolá of
//    individual sports) – „OH mládeže – rozjazdy“ ranks below big films and shows.
//    NON-SPORT (nonSport, ≤ +24): channel weight (main SK/CZ channel +6, film/second channel +3), known entertainment
//    format (SuperStar, Farma, StarDance, Talent… +6), series/season premiere („1. epizoda“, „nová séria“ +8), TMDB
//    popularity (log scale, ≤ +10) + rating (≥ 7.5 with ≥ 300 votes +6 … weak < 5.5 −4) from the official TMDB API
//    (epghero tmdbScores, cached 7 days). First airing/premiere +10 and prime time +12 come from the base score;
//    candidates (epgevents wide mode): premieres in prime time, keyword formats, films ≥ 75 min and shows/concerts/
//    documentaries ≥ 45 min starting 19:30–22:44 on a weighted channel, series only as a season premiere. Gemini's editor
//    order (bounded +10) is told the list is for everyone (≈ 40 % non-sport). No IMDb/ČSFD.
//    REASON CHIP (reason()): every card shows one short Slovak line from its top factor („🔥 Šláger: Real vs. Bayern“,
//    „🇸🇰 Hrá Slovan Bratislava“, „🇸🇰 Hrá Lobotka“, „🏆 Finále“, „🎬 Filmová premiéra“, „🏎️ Kvalifikácia F1“…).
//    FIRST AIRING: the same pairing / title+subtitle later in the week is a re-run → only the first airing stays.
// 4) MERGE: the same event on several SK/CZ channels (same match pairing, or same category + start ±30 min + similar
//    title) becomes one card listing all channels; the highest-priority airing is kept.
// 5) VARIETY (select()): walk the list by priority with caps – one card per series (title stem: F1 weekend, Olympics,
//    a show's episodes, a team pairing), ≤ perCat of one sport/genre (10 slides → 3), ≤ perDay on one calendar day (10 → 4),
//    sport overall ≤ 60 % (10 → 6, 8 → 5), so at least 40 % (min 4 of 10; 3 of 8) of the cards are the best non-sport items (they may enter
//    25 points below the sport threshold). Gaps: first another series keeping the sport cap; the cap is relaxed only when
//    no non-sport candidate is left. Main cards in priority order, then opt.spare reserves (best remaining non-sport + sport).
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
const tsdbEvent = (e) => ({ venue: e.strVenue || '', city: e.strCity || '', ts: (() => { const t = e.strTimestamp ? Date.parse(String(e.strTimestamp).replace(/(\+00:?00|Z)?$/, 'Z')) : e.dateEvent && e.strTime ? Date.parse(e.dateEvent + 'T' + e.strTime + 'Z') : NaN; return t; })(), home: e.strHomeTeam || '', away: e.strAwayTeam || '', league: e.strLeague || '', round: e.intRound || '', hb: e.strHomeTeamBadge || '', ab: e.strAwayTeamBadge || '', status: e.strStatus || '' });

// ---------- Czech → Slovak names (EPG of ČT/Nova Sport is Czech; the site is Slovak) ----------
// phrase map, longest first; applied to competition lines, team names (countries) and programme titles/subtitles
const CZSK = [
  ['Liga mistrů UEFA', 'Liga majstrov UEFA'], ['Liga mistrů', 'Liga majstrov'], ['Evropská liga', 'Európska liga'], ['Evropská konferenční liga', 'Európska konferenčná liga'], ['Konferenční liga', 'Konferenčná liga'],
  ['Mistrovství světa', 'Majstrovstvá sveta'], ['Mistrovství Evropy', 'Majstrovstvá Európy'], ['Mistrovství', 'Majstrovstvá'], ['MS v ledním hokeji', 'MS v ľadovom hokeji'], ['v ledním hokeji', 'v ľadovom hokeji'],
  ['lední hokej', 'ľadový hokej'], ['Lední hokej', 'Ľadový hokej'], ['Světový pohár', 'Svetový pohár'], ['Český pohár', 'Český pohár'], ['Velká cena', 'Veľká cena'], ['Formule 1', 'Formula 1'], ['Formule', 'Formula'],
  ['kvalifikace', 'kvalifikácia'], ['Kvalifikace', 'Kvalifikácia'], ['závod', 'pretek'], ['Závod', 'Pretek'], ['sprint', 'šprint'], ['volný trénink', 'voľný tréning'], ['trénink', 'tréning'],
  ['rozjížďky', 'rozjazdy'], ['rozjížděk', 'rozjazdov'], ['parkouru', 'parkoure'], ['fotbal', 'futbal'], ['Fotbal', 'Futbal'], ['házená', 'hádzaná'], ['Házená', 'Hádzaná'], ['lyžování', 'lyžovanie'], ['Lyžování', 'Lyžovanie'],
  ['krasobruslení', 'krasokorčuľovanie'], ['Krasobruslení', 'Krasokorčuľovanie'], ['plavání', 'plávanie'], ['Plavání', 'Plávanie'], ['cyklistika', 'cyklistika'], ['skoky na lyžích', 'skoky na lyžiach'],
  ['Olympijské hry', 'Olympijské hry'], ['utkání', 'zápas'], ['Utkání', 'Zápas'], ['přímý přenos', 'priamy prenos'], ['Přímý přenos', 'Priamy prenos'], ['skupina', 'skupina'], ['čtvrtfinále', 'štvrťfinále'], ['Čtvrtfinále', 'Štvrťfinále'],
  ['semifinále', 'semifinále'], ['o 3. místo', 'o 3. miesto'], ['kolo', 'kolo'], ['muži', 'muži'], ['mužů', 'mužov'], ['žen', 'žien'], ['ženy', 'ženy'], ['junioři', 'juniori'], ['juniorů', 'juniorov'],
  ['Švýcarsko', 'Švajčiarsko'], ['Německo', 'Nemecko'], ['Rakousko', 'Rakúsko'], ['Polsko', 'Poľsko'], ['Itálie', 'Taliansko'], ['Francie', 'Francúzsko'], ['Španělsko', 'Španielsko'], ['Anglie', 'Anglicko'],
  ['Nizozemsko', 'Holandsko'], ['Belgie', 'Belgicko'], ['Finsko', 'Fínsko'], ['Norsko', 'Nórsko'], ['Chorvatsko', 'Chorvátsko'], ['Řecko', 'Grécko'], ['Brazílie', 'Brazília'], ['Japonsko', 'Japonsko'],
  ['Dánsko', 'Dánsko'], ['Praha', 'Praha'], ['Mnichov', 'Mníchov'], ['Vídeň', 'Viedeň'], ['Sao Paula', 'São Paula'], ['Sao Paulo', 'São Paulo'],
].filter(([a, b]) => a !== b).sort((x, y) => y[0].length - x[0].length);
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CZRE = CZSK.map(([a, b]) => [new RegExp('(?<![\\p{L}])' + esc(a) + '(?![\\p{L}])', 'gu'), b]);
const sk = (t) => { let v = String(t || ''); for (const [re, b] of CZRE) v = v.replace(re, b); return v; };
// Czech-only letters/words – a Slovak teaser must not contain them
const CZECH = /[ěřůĚŘŮ]|(?<![\p{L}])(který|která|které|kteří|jsou|také|není|nejlepší|utkání|mistrovství|zápasu se|hráčů|mužů|týmu|týmy|tým|letošní|bude hrát|přenos|proti sobě|žen|velká|evropsk\p{L}*|kvalifikace|trénink|závod\p{L}*|fotbal\p{L}*|házen\p{L}*|lední\p{L}*|rozjížď\p{L}*|soutěž\p{L}*)(?![\p{L}])/iu;
const isCzech = (t) => CZECH.test(String(t || ''));

// ---------- priority, merge, variety ----------
const SOON = [6, 4, 3, 2, 1, 0, -2, -3];
const soon = (s, now) => SOON[Math.max(0, Math.min(7, dayDiff(now, Math.max(s, now))))];
const SPORTCAT = new Set(['football', 'hockey', 'tennis', 'basketball', 'athletics', 'f1', 'mma', 'boxing', 'stadium']);
const isSport = (x) => SPORTCAT.has(x.cat) || x.kind === 'sport';
// club matches: the EPG often lacks the „live“ flag on them, so named pairings get a bounded boost
const EUROCUP = /liga (majstrov|mistr[uů])|champions league|európsk[aá] liga|evropsk[aá] liga|europa league|konferen[cč]n|conference league|\buefa\b/i;
// SK/CZ clubs and national teams (Slovensko/Česko, also in the EPG's Czech/English forms) – one tier, same bonus
const SKTEAM = /slovan bratislava|spartak trnava|[žz]ilina|\bdac\b|dunajsk[aá] streda|ko[šs]ice|slovensk|slovakia|ru[žz]omberok|podbrezov|michalovce|zvolen|nitra|bansk[aá] bystrica|poprad/i;
const CZTEAM = /sparta praha|ac sparta|\bsparta\b|slavia|plze[nň]|ban[ií]k ostrava|sigma olomouc|slov[aá]cko|bohemians|mlad[aá] boleslav|jablonec|liberec|hradec kr[aá]lov|teplice|karvin[aá]|pardubice|kometa|t[řr]inec|v[ií]tkovice|litv[ií]nov|mountfield|karlovy vary|budějovic|budejovic|česk|cesk|czech/i;
const SKCZ_BONUS = 12, LEGION_BONUS = 8;
// SK/CZ players abroad – curated, easy to extend: [team pattern, sport (evrank cat) or '' = any, player, nation].
// Only long-standing, well-known facts (checked 11/2026); remove a line when a player moves. Tennis players are matched
// by name in the title/subtitle (no team).
const LEGION = [
  [/boston bruins|\bbruins\b|\bboston\b/i, 'hockey', 'David Pastrňák', 'CZ'],
  [/boston bruins|\bbruins\b|\bboston\b/i, 'hockey', 'Pavel Zacha', 'CZ'],
  [/montr[eé]al|canadiens/i, 'hockey', 'Juraj Slafkovský', 'SK'],
  [/vegas|golden knights/i, 'hockey', 'Tomáš Hertl', 'CZ'],
  [/vancouver|canucks/i, 'hockey', 'Filip Hronek', 'CZ'],
  [/anaheim|\bducks\b/i, 'hockey', 'Lukáš Dostál', 'CZ'],
  [/napoli|neapol/i, 'football', 'Stanislav Lobotka', 'SK'],
  [/leverkusen/i, 'football', 'Patrik Schick', 'CZ'],
  [/west ham/i, 'football', 'Tomáš Souček', 'CZ'],
  [/atl[eé]tic\p{L}* madrid|atl[eé]tico/iu, 'football', 'Dávid Hancko', 'SK'],
  [/fenerbah/i, 'football', 'Milan Škriniar', 'SK'],
  [/men[šs][ií]k/i, 'tennis', 'Jakub Menšík', 'CZ'], [/lehe[čc]k/i, 'tennis', 'Jiří Lehečka', 'CZ'], [/mach[aá][čc]/i, 'tennis', 'Tomáš Macháč', 'CZ'],
  [/muchov/i, 'tennis', 'Karolína Muchová', 'CZ'], [/krej[čc][ií]kov/i, 'tennis', 'Barbora Krejčíková', 'CZ'], [/vondrou[šs]ov/i, 'tennis', 'Markéta Vondroušová', 'CZ'],
  [/noskov/i, 'tennis', 'Linda Nosková', 'CZ'], [/siniakov/i, 'tennis', 'Kateřina Siniaková', 'CZ'], [/bouzkov/i, 'tennis', 'Marie Bouzková', 'CZ'],
  [/schmiedlov/i, 'tennis', 'Anna Karolína Schmiedlová', 'SK'], [/[šs]ramkov/i, 'tennis', 'Rebecca Šramková', 'SK'], [/mol[čc]an/i, 'tennis', 'Alex Molčan', 'SK'],
];
const skczTeam = (x) => !!(x.teams && x.teams.some((t) => SKTEAM.test(t) || CZTEAM.test(t)));
// players named for a card: team-matched for team sports, name-matched (title/subtitle) for tennis
function legion(x) {
  const txt = (x.teams || []).join(' | '), all = txt + ' ' + (x.title || '') + ' ' + (x.sub || ''), out = [];
  for (const [re, sp, who, nat] of LEGION) {
    if (sp && x.cat && x.cat !== sp) continue;
    if (sp === 'tennis' ? re.test(all) : txt && x.teams.some((t) => re.test(t))) { const team = sp === 'tennis' ? '' : x.teams.find((t) => re.test(t)); if (!out.some((o) => o.who === who)) out.push({ who, nat, team }); }
  }
  return out;
}
// one sentence for the card: „Za Boston nastúpi David Pastrňák.“ / „Hrá Jakub Menšík.“
function legionLine(l) {
  if (!l || !l.length) return '';
  const byTeam = new Map(); for (const o of l) { const k = o.team || ''; if (!byTeam.has(k)) byTeam.set(k, []); byTeam.get(k).push(o.who); }
  const and = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' a ' + a[a.length - 1] : a[0]);
  return [...byTeam].map(([t, w]) => (t ? `V drese tímu ${t} ${w.length > 1 ? 'hrajú' : 'hrá'} ${and(w)}.` : `Na kurte ${and(w)}.`)).join(' ');
}
// ELITE clubs / teams – curated, easy to extend: [pattern, sport, tier (3 = absolute top, 2 = elite), short name]
const ELITE = [
  [/real madrid/i, 'football', 3, 'Real'], [/barcelona|barça|barca/i, 'football', 3, 'Barcelona'], [/bayern/i, 'football', 3, 'Bayern'],
  [/manchester city|man\.? city/i, 'football', 3, 'Man City'], [/liverpool/i, 'football', 3, 'Liverpool'], [/arsenal/i, 'football', 3, 'Arsenal'],
  [/paris saint|paríž saint|paris sg|paríž sg|\bpsg\b/i, 'football', 3, 'PSG'], [/\binter\b(?!.*miami)|internazionale/i, 'football', 3, 'Inter'],
  [/\bac mil[aá]n|^mil[aá]n[o]?$|\bmil[aá]n[o]?$(?<!inter mil[aá]n[o]?)/i, 'football', 2, 'AC Miláno'], [/juventus/i, 'football', 2, 'Juventus'],
  [/dortmund/i, 'football', 2, 'Dortmund'], [/atl[eé]tic\p{L}* madrid|atl[eé]tico/iu, 'football', 2, 'Atlético'], [/chelsea/i, 'football', 2, 'Chelsea'],
  [/manchester united|man\.? utd|man\.? united/i, 'football', 2, 'Man United'], [/napoli|neapol/i, 'football', 2, 'Neapol'], [/tottenham/i, 'football', 2, 'Tottenham'],
  [/leverkusen/i, 'football', 2, 'Leverkusen'], [/benfica/i, 'football', 2, 'Benfica'], [/\bporto\b/i, 'football', 2, 'Porto'], [/newcastle/i, 'football', 2, 'Newcastle'],
  [/^(španielsko|španělsko|spain)$/i, 'football', 2, 'Španielsko'], [/^(francúzsko|francie|france)$/i, 'football', 2, 'Francúzsko'], [/^(anglicko|anglie|england)$/i, 'football', 2, 'Anglicko'],
  [/^(nemecko|německo|germany)$/i, 'football', 2, 'Nemecko'], [/^(portugalsko|portugal)$/i, 'football', 2, 'Portugalsko'], [/^(brazília|brazílie|brazil)$/i, 'football', 2, 'Brazília'],
  [/^(argentína|argentina)$/i, 'football', 2, 'Argentína'], [/^(taliansko|itálie|italy)$/i, 'football', 2, 'Taliansko'], [/^(holandsko|nizozemsko|netherlands)$/i, 'football', 2, 'Holandsko'],
  [/edmonton|oilers/i, 'hockey', 2, 'Edmonton'], [/florida panthers|\bpanthers\b/i, 'hockey', 2, 'Florida'], [/colorado|avalanche/i, 'hockey', 2, 'Colorado'],
  [/dallas stars/i, 'hockey', 2, 'Dallas'], [/vegas|golden knights/i, 'hockey', 2, 'Vegas'], [/carolina|hurricanes/i, 'hockey', 2, 'Carolina'],
  [/toronto|maple leafs/i, 'hockey', 2, 'Toronto'], [/tampa/i, 'hockey', 2, 'Tampa Bay'], [/winnipeg/i, 'hockey', 2, 'Winnipeg'],
  [/^(kanada|canada)$/i, 'hockey', 2, 'Kanada'], [/^(usa|spojené štáty|spojené státy)$/i, 'hockey', 2, 'USA'], [/^(švédsko|švédsko|sweden)$/i, 'hockey', 2, 'Švédsko'], [/^(fínsko|finsko|finland)$/i, 'hockey', 2, 'Fínsko'],
  [/celtics/i, 'basketball', 2, 'Boston Celtics'], [/lakers/i, 'basketball', 2, 'Lakers'], [/warriors/i, 'basketball', 2, 'Golden State'], [/nuggets/i, 'basketball', 2, 'Denver'],
  [/thunder/i, 'basketball', 2, 'Oklahoma City'], [/knicks/i, 'basketball', 2, 'Knicks'], [/cavaliers/i, 'basketball', 2, 'Cleveland'], [/real madrid/i, 'basketball', 2, 'Real'],
];
const STAGE = [[/(?<![\p{L}])(fin[aá]le|final)(?![\p{L}])(?!.*(štvrť|čtvrt|semi|osemi))/iu, 12, 'Finále'], [/semifin[aá]l\p{L}*|semi-final/iu, 8, 'Semifinále'],
  [/štvrťfin[aá]l\p{L}*|čtvrtfin[aá]l\p{L}*|quarter-?final|vyraďovac\p{L}*|vyřazovac\p{L}*|play-?off|osemifin[aá]l\p{L}*|knockout/iu, 5, 'Vyraďovacia fáza']];
// strength of a pairing: { tiers:[h,a], names:[h,a], stage:{pts,label}|null, top: top-of-table clash, slager }
function strength(x) {
  const T = x.teams || [], cat = x.cat === 'stadium' ? '' : x.cat;
  const tier = T.map((t) => { const e = ELITE.find(([re, sp]) => (!cat || sp === cat) && re.test(String(t).trim())); return e ? [e[2], e[3]] : [0, side(t)]; });
  const txt = (x.title || '') + ' ' + (x.sub || '') + ' ' + (x.comp || '') + ' ' + (x.big || []).join(' ');
  const st = STAGE.find(([re]) => re.test(txt)), top = /špička tabuľky/.test((x.why || []).join(' ') + ' ' + (x.big || []).join(' '));
  const ti = tier.map((z) => z[0]);
  return { tiers: ti, names: tier.map((z) => z[1]), stage: st ? { pts: st[1], label: st[2] } : null, top, slager: T.length === 2 && ti[0] >= 2 && ti[1] >= 2 };
}
function strengthBonus(x) {
  if (!x.teams || x.teams.length < 2) return 0;
  const g = strength(x), elite = g.tiers.some((t) => t >= 2);
  return (g.slager ? 14 + (g.tiers[0] === 3 && g.tiers[1] === 3 ? 4 : 0) : elite ? 4 : 0) + (g.top ? 6 : 0) + (g.stage ? g.stage.pts : 0);
}
// a pairing with nothing for the SK/CZ viewer: no SK/CZ team or player, no elite club, no stage, no big-match label
function nobody(x) {
  if (!x.teams || x.teams.length < 2 || !isSport(x)) return false;
  const g = strength(x);
  return !skczTeam(x) && !legion(x).length && !g.tiers.some((t) => t >= 2) && !g.stage && !g.top && !(x.big || []).length && !/veľký zápas/.test((x.why || []).join(' '));
}
function clubBonus(x) {
  const l = legion(x);
  if (!x.teams) return l.length ? LEGION_BONUS : 0; // tennis: a Czech/Slovak player named in the title
  const w = (x.why || []).join(' '), big = /veľký zápas/.test(w), nb = nobody(x);
  return (EUROCUP.test(x.comp || x.sub || '') && !nb ? 12 : 0) + (skczTeam(x) ? SKCZ_BONUS : l.length ? LEGION_BONUS : 0) + strengthBonus(x) + (nb ? -14 : 0)
    + (big && /ráno -10/.test(w) ? 10 : 0); // a big derby at 11:45 is not a „morning“ filler
}
// YOUTH −15 (youth/junior events without a SK/CZ team: Youth Olympics, U18…) and HEATS −10 (heats/qualifying rounds of
// individual sports): „Olympijské hry mládeže – rozjazdy“ must rank below a prime-time film or show
const YOUTH = /olympijsk\p{L}* hr\p{L}* mládeže|olympijsk\p{L}* hr\p{L}* mladeze|youth olympic|\beyof\b|juniorsk\p{L}*|junior\p{L}*|dorast\p{L}*|\bU ?1[5-9]\b|mládež|mladez/iu;
const HEATS = /rozjazd\p{L}*|rozjížď\p{L}*|rozjizd\p{L}*|rozplavb\p{L}*|\bheats?\b|predkol\p{L}*|předkol\p{L}*/iu;
function minorSport(x) {
  if (!isSport(x)) return 0;
  const all = (x.title || '') + ' ' + (x.sub || '') + ' ' + (x.comp || '');
  return (YOUTH.test(all) && !skczTeam(x) ? -15 : 0) + (!x.teams && HEATS.test(all) ? -10 : 0);
}
// NON-SPORT quality (films, series, shows, concerts, documentaries): channel weight, known format, series/season
// premiere, TMDB popularity + rating (official API, x.tmdb = { pop, vote, n }); capped at +24
const CH1 = /^(markíza|markiza|joj|jednotka|čt ?1|ct ?1|nova|prima|tv nova|tv markíza|tv joj)(\s+(fhd|hd|sk|cz))*$/i;
const CH2 = /dvojka|čt ?2|ct ?2|čt art|ct art|joj plus|joj cinema|jojko|wau|dajto|doma|nova cinema|nova action|nova fun|prima max|prima cool|prima love|prima show|prima krimi|markíza klasik|markiza klasik|hbo|cinemax|film europe|filmbox|amc|axn|óčko|ocko|voyo|ta3|čt24|ct24/i;
const chTier = (name) => { const n = String(name || '').replace(/\s+(fhd|hd|uhd|sd)\b/gi, '').trim(); return CH1.test(n) ? 2 : CH2.test(n) ? 1 : 0; };
const SEASON = /(?<![\p{L}\d])(1\. (epizoda|epizóda|díl|diel|časť|část|séria|série|řada)|epizoda 1|diel 1|premiéra seriálu|nová séria|nová série|nová řada|\d+\. (série|séria|řada), 1\. (epizoda|epizóda|díl|diel))(?![\p{L}\d])/iu;
function tmdbPts(t) {
  if (!t || !(t.pop >= 0)) return 0;
  const pop = Math.min(10, Math.round(Math.log10(t.pop + 1) * 5)), v = t.vote || 0, n = t.n || 0;
  return pop + (n >= 300 && v >= 7.5 ? 6 : n >= 200 && v >= 7 ? 4 : n >= 100 && v >= 6.5 ? 2 : n >= 100 && v < 5.5 ? -4 : 0);
}
function nonSport(x) {
  if (isSport(x)) return 0;
  const all = (x.title || '') + ' ' + (x.sub || ''), tier = chTier(x.chName || (x.ch && x.ch.name));
  const fmt = SHOWS.some(([re]) => re.test(all)) ? 6 : 0, prem = SEASON.test(all) ? 8 : 0;
  return Math.min(24, (tier === 2 ? 6 : tier === 1 ? 3 : 0) + fmt + prem + tmdbPts(x.tmdb));
}
const hourOf = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const PRACTICE = /tr[eé]nin[gk]|practice|\bfp[123]\b|voľn[yý] tr|volný tr/i;
// FILLER −30: a generic sport slot with no specific event or teams – the title is just a sport („Curling“, „Hokej“), a
// magazine/studio/news show („Góly a body“, „Štúdio“, „Športové noviny“) – unless the title/subtitle names a major final or
// championship (Olympics, world championship, Champions League final, Grand Slam, Super Bowl, Stanley Cup…)
const BARE = /^(curling|hokej|ľadový hokej|ladovy hokej|lední hokej|futbal|fotbal|tenis|basketbal|volejbal|hádzaná|házená|hadzana|florbal|futsal|atletika|biatlon|lyžovanie|lyžování|plávanie|plavání|cyklistika|snooker|šípky|sipky|darts|golf|box|mma|motorsport|motoristický šport|motoristický sport|krasokorčuľovanie|krasobruslení|sport|šport|športy|sporty|rally|rallye|jachting|veslovanie|veslování|stolný tenis|stolní tenis|bedminton|badminton|squash|zápasenie|zápas|gymnastika|triatlon|triathlon|motocross|tenis wta|tenis atp)$/i;
const STUDIO = /(?<![\p{L}])(magazín\p{L}*|magazin\p{L}*|štúdio|studio|športové noviny|sportovní noviny|šport v |sport v |správy|zprávy|noviny|góly a body|gól[y]?|branky|best of|prehľad|přehled|rozhovor\p{L}*|talk|preview|predzápasov\p{L}*|pozápasov\p{L}*|předzápasov\p{L}*|analýz\p{L}*|diskusi\p{L}*|relácia|pořad)(?![\p{L}])/iu;
const MAJOR = /olympi(?!jské hry mládeže)|majstrovstv\p{L}* sveta|mistrovství světa|\bms\b|world championship|finále (ligy majstrov|ligy mistrů|ms|mistrovství světa|majstrovstiev sveta)|champions league final|super bowl|stanley|wimbledon|roland|us open|australian open|grand slam/iu;
function filler(x) {
  if (x.teams || x.src === 'okt' || /okt/.test(x.src || '')) return 0;
  const t = String(x.title || '').trim(), all = t + ' ' + (x.sub || '');
  if (!(BARE.test(t) || STUDIO.test(t))) return 0;
  return MAJOR.test(all) ? 0 : -30;
}
function priority(x, now, gemIdx) {
  const g = gemIdx == null || gemIdx < 0 ? 0 : Math.max(0, 10 - gemIdx * 1.5);
  const night = +hourOf.format(x.s) < 7 && x.s > now ? -10 : 0; // 00:00–06:59 start: few viewers (and mostly re-runs)
  const practice = PRACTICE.test(x.title + ' ' + (x.sub || '')) ? -12 : 0; // F1/MotoGP practice is not the event of the weekend
  return Math.round(x.score + soon(x.s, now) + (x.official === 'ok' ? 6 : 0) + g + night + practice + clubBonus(x) + filler(x) + minorSport(x) + nonSport(x));
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
  const perCat = opt.perCat || Math.max(2, Math.ceil(n * 0.3)), perDay = opt.perDay || Math.max(2, Math.ceil(n * 0.35)), maxSport = opt.maxSport || Math.max(1, Math.round(n * 0.6));
  const out = [], cc = new Map(), dc = new Map(), sk = new Set(); let sp = 0;
  const add = (x) => { const c = x.cat || 'x', d = dayKey(x.s); out.push(x); sk.add(stemKey(x)); cc.set(c, (cc.get(c) || 0) + 1); dc.set(d, (dc.get(d) || 0) + 1); if (isSport(x)) sp++; };
  // 1) all caps; 2) another series keeping the sport cap (≥ 40 % non-sport); 3) sport cap relaxed (no non-sport left); 4) repeats
  for (const x of list) { if (out.length >= n) break; const c = x.cat || 'x', d = dayKey(x.s); if (sk.has(stemKey(x)) || (cc.get(c) || 0) >= perCat || (dc.get(d) || 0) >= perDay || (isSport(x) && sp >= maxSport)) continue; add(x); }
  for (const x of list) { if (out.length >= n) break; if (!out.includes(x) && !sk.has(stemKey(x)) && !(isSport(x) && sp >= maxSport)) add(x); }
  for (const x of list) { if (out.length >= n) break; if (!out.includes(x) && !sk.has(stemKey(x))) add(x); }
  for (const x of list) { if (out.length >= n) break; if (!out.includes(x)) add(x); }
  const main = out.sort((a, b) => list.indexOf(a) - list.indexOf(b));
  if (!opt.spare) return main;
  // reserves (shown when a main card ends): best remaining non-sport first, then best remaining sport
  const left = list.filter((x) => !main.includes(x) && !main.some((y) => stemKey(y) === stemKey(x)));
  const sp1 = [left.find((x) => !isSport(x)), left.find(isSport)].filter(Boolean);
  for (const x of left) { if (sp1.length >= opt.spare) break; if (!sp1.includes(x)) sp1.push(x); }
  return main.concat(sp1.slice(0, opt.spare));
}

// ---------- card descriptions (facts → 1–2 Slovak sentences; never invented) ----------
// Matches: competition, round, venue (TheSportsDB fixture), table position/points/form (TheSportsDB table, top 5 only on the
// free key), rivalry / big-club / final context from the „veľký zápas“ tier labels. Other events: the EPG programme text,
// cleaned and cut to 1–2 sentences. Template variants rotate per card so no two cards read the same; Gemini may rewrite the
// same facts into a teaser (accepted only if it names a team for matches and adds no number missing from the facts).
const FORM = { W: 'V', D: 'R', L: 'P' };
// table row of a team; words shared by several rows („Prague“ in Slavia/Sparta Prague) do not identify a team
function tblRow(rows, team) {
  const R = rows || [], cnt = new Map(); for (const r of R) for (const w of new Set(fold(r.name).split(' '))) cnt.set(w, (cnt.get(w) || 0) + 1);
  const mine = new Set(fold(qName(team)).split(' ').concat(fold(team).split(' ')).filter((w) => w.length >= 4));
  let best = null, bn = 0;
  for (const r of R) { const n = fold(r.name).split(' ').filter((w) => mine.has(w) && cnt.get(w) === 1).length + (fold(r.name) === fold(qName(team)) ? 5 : 0); if (n > bn) { bn = n; best = r; } }
  return best;
}
// big-match labels („Derby d'Italia +40“) → { rival, clubs, stake }
function bigCtx(big, rivals) {
  const o = { rival: '', clubs: false, stake: '' };
  for (const w of big || []) {
    const l = String(w).replace(/\s*[+−-]\d+\s*$/, '').replace(/\s*½$/, '').trim();
    if (!o.rival && rivals && rivals.has(l) && /derby|cl[aá]sico|classique|klassi[ek]|old firm/i.test(l)) o.rival = l.replace(/\s*\((?:hokej|S–S)\)$/, '');
    else if (/top kluby|veľkokluby|top tímy|original six/i.test(l)) o.clubs = true;
    else if (/^semifinále/i.test(l)) o.stake = o.stake || 'semifinále';
    else if (/^finále/i.test(l)) o.stake = 'finále';
    else if (/vyraďovacia fáza|play-off|štvrťfinále/i.test(l)) o.stake = o.stake || 'vyraďovacia fáza';
  }
  return o;
}
// structured facts for one match card (also fed to Gemini)
function matchFacts(x, ctx) {
  const c = ctx || {}, b = bigCtx(x.big, c.rivals), [h, a] = x.teams;
  const SPORTW = /^(futbal|fotbal|hokej|ľadový hokej|basketbal|hádzaná|házená|tenis|volejbal|florbal)$/i;
  const seg = String(x.comp || '').split(/\s*·\s*/).map((z) => z.trim()).filter(Boolean), sport = seg.find((z) => SPORTW.test(z)) || '';
  let comp = seg.filter((z) => !SPORTW.test(z) && !/^reprezent[aá]c/i.test(z)).join(' · ').replace(/\s*\b(19|20)\d\d\/(19|20)?\d\d\b/g, '').trim() || x.league || '';
  if (sport && !/^f[uo]tbal$/i.test(sport)) comp += ' (' + sport.toLowerCase() + ')';
  const hasRound = /\bkolo\b|\bkola\b|round|matchday/i.test(comp);
  const cup = /uefa|liga (majstrov|mistr)|európsk|evropsk|konferen|pohár|pohar|cup|kvalifik/i.test(comp + ' ' + (x.league || ''));
  const L = !cup && x.official === 'ok' ? (c.tables || []).find((t) => tblRow(t.rows, h) || tblRow(t.rows, a)) : null;
  const ph = L && tblRow(L.rows, h), pa = L && tblRow(L.rows, a);
  return { h, a, comp, round: !hasRound && x.official === 'ok' && +x.round > 0 && +x.round < 60 ? +x.round : 0, venue: x.official === 'ok' ? side(x.venue || '') : '', rival: b.rival, clubs: b.clubs, stake: b.stake, ph, pa, cup, players: legionLine(legion(x)) };
}
const formSk = (f) => String(f || '').toUpperCase().replace(/[^WDL]/g, '').slice(-5).split('').map((z) => FORM[z]).join('');
const hsh = (s) => { let n = 7; for (const ch of String(s)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return n; };
function matchDesc(f, v) {
  const at = f.venue ? [' (' + f.venue + ')', ', dejisko: ' + f.venue, ' – hrá sa v dejisku ' + f.venue, ''][v % 4] : '';
  const lead = [`${f.h} privíta ${f.a}${at}.`, `${f.h} a ${f.a} sa stretnú${at}.`, `Proti sebe nastúpia ${f.h} a ${f.a}${at}.`, `${f.h} vyzve na domácej pôde tím ${f.a}${at}.`][v % 4];
  const s1 = f.rival ? `${f.rival}: ${/^Proti/.test(lead) ? lead[0].toLowerCase() + lead.slice(1) : lead}` : lead;
  const parts = [];
  if (f.ph && f.pa) parts.push(`V tabuľke je ${f.h} ${f.ph.rank}. (${f.ph.pts} b.), ${f.a} ${f.pa.rank}. (${f.pa.pts} b.)`);
  else if (f.ph || f.pa) { const p = f.ph || f.pa, n = f.ph ? f.h : f.a, fm = formSk(p.form); parts.push(`${n} je v tabuľke ${p.rank}. s ${p.pts} bodmi${fm ? ', forma ' + fm : ''}`); }
  const cr = f.comp ? (f.round ? [`${f.round}. kolo – ${f.comp}`, `${f.comp}, ${f.round}. kolo`, `Zápas ${f.round}. kola: ${f.comp}`][v % 3] : [f.comp, `Súťaž: ${f.comp}`, `V hre je ${f.comp}`][v % 3]) : '';
  if (f.stake) parts.push((cr ? cr + ', ' : '') + f.stake);
  else if (cr) parts.unshift(cr);
  if (!f.rival && f.clubs && !(f.ph && f.pa)) parts.push(['súboj veľkých klubov', 'stretnutie dvoch veľkoklubov', 'duel favoritov'][v % 3]);
  const s2 = parts.map((z) => z.replace(/^./, (c) => c.toUpperCase()) + '.').join(' ');
  const base = (s1 + (s2 ? ' ' + s2 : '')).replace(/\.\./g, '.').slice(0, 220);
  return f.players ? base + ' ' + f.players : base;
}
// EPG programme text → 1–2 clean sentences (no cast lists, ratings, years-in-brackets boilerplate, „Záznam.“ …)
function cleanEpg(t, title) {
  let s = String(t || '').replace(/\s+/g, ' ').replace(/https?:\/\/\S+/g, '').trim();
  s = s.replace(/^((záznam|priamy prenos|live|premiéra|repríza|reprise|nové|nový diel|r\.)\s*[.:,]?\s*)+/i, '').replace(/\((?:r\.|réž\.|hrajú|hrají|\d{4})[^)]*\)/gi, '');
  s = s.replace(/\b(hrajú|hrají|réžia|režie|scenár|scénář|moderuje|moderátor)\s*:.*$/i, '').trim();
  if (title && fold(s).startsWith(fold(title))) s = s.slice(String(title).length).replace(/^[\s:.\-–]+/, '');
  const sent = s.match(/[^.!?…]+[.!?…]+(\s|$)/g) || (s ? [s] : []);
  let out = '';
  for (const z of sent) { if ((out + z).length > 200) break; out += z; if (out.length > 90) break; }
  if (!out && s) out = s.slice(0, 197).replace(/\s+\S*$/, '') + '…';
  return out.trim().length >= 25 ? out.trim() : '';
}
// Gemini teaser accepted only if it passes a strict check, else the template stays:
//  · for matches a team is named; no digit-group absent from the facts; an ordinal fact („16. storočí“, „4. kole“) whose
//    word appears in the teaser must keep its number (dropped numbers → „do storočia“)
//  · Slovak only (no ě/ř/ů or Czech-only words), no truncated/imperative verb forms („stretávaj“, „sleduj“),
//    proper sentence end, no doubled words, balanced brackets, no stock phrases
const IMPER = /(?<![\p{L}])\p{L}{2,}(áva|ava|ieva|íva|ýva)j(?![\p{L}])|(?<![\p{L}])\p{L}{3,}uj(?![\p{L}])/iu;
function okTeaser(txt, facts, teams) {
  const t = String(txt || '').trim(); if (t.length < 25 || t.length > 260) return false;
  const src = facts.join(' '), nums = t.match(/\d+/g) || [];
  if (nums.some((n) => !src.includes(n))) return false;
  for (const m of src.matchAll(/(\d{1,3})\.\s+(\p{L}{5,})/gu)) { const st = fold(m[2]).slice(0, 5); if (new RegExp('(^| )' + st).test(fold(t)) && !t.includes(m[1])) return false; }
  if (teams && !teams.some((n) => fold(qName(n)).split(' ').concat(fold(n).split(' '), fold(sk(n)).split(' ')).filter((w) => w.length >= 4).some((w) => fold(t).includes(w)))) return false;
  if (isCzech(t) || IMPER.test(t)) return false;
  if (!/[.!…]$/.test(t) || /\s[,.]|\s{2}|\.\./.test(t) || /(?<![\p{L}])(\p{L}+) \1(?![\p{L}])/iu.test(t) || (t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length) return false;
  return !/^(sledujte|pripravte sa|nenechajte si ujsť|príďte|nalaďte|vstúpte|zažite|objavte|pozrite)|podrobnosti o|nezabudnuteľn|nenechajte si|športový prenos|prináša(jú)? (športov|zábav|program)/i.test(t);
}

// ---------- deterministic category templates (never an empty card) ----------
// built only from the title, subtitle, competition, channel and the official calendar place; variant v rotates the wording
const GPINFO = [ // GP name (folded) → circuit, country
  [/sao paul|brazil|interlagos/, 'Interlagos', 'Brazília'], [/las vegas/, 'Las Vegas Strip Circuit', 'USA'], [/katar|qatar|lusail/, 'Lusail', 'Katar'], [/abu dhab|yas marina/, 'Yas Marina', 'SAE'],
  [/mexik|mexic/, 'Autódromo Hermanos Rodríguez', 'Mexiko'], [/spojen[yy]ch stat|usa|austin|ameri/, 'Circuit of the Americas', 'USA'], [/singapur/, 'Marina Bay', 'Singapur'], [/japonsk|suzuka/, 'Suzuka', 'Japonsko'],
  [/monak|monaco|monte carlo/, 'Monte Carlo', 'Monako'], [/britan|silverstone/, 'Silverstone', 'Veľká Británia'], [/talian|ital|monza/, 'Monza', 'Taliansko'], [/belgi|spa/, 'Spa-Francorchamps', 'Belgicko'],
  [/madars|hungar/, 'Hungaroring', 'Maďarsko'], [/rakus|austri|spielberg/, 'Red Bull Ring', 'Rakúsko'], [/holand|dutch|zandvoort/, 'Zandvoort', 'Holandsko'], [/bahrajn|bahrain/, 'Sachír', 'Bahrajn'],
  [/saudsk|dzidd|jeddah/, 'Džidda', 'Saudská Arábia'], [/austral|melbourne/, 'Albert Park', 'Austrália'], [/cin|chin|sanghaj/, 'Šanghaj', 'Čína'], [/miami/, 'Miami', 'USA'], [/kanad|canad|montreal/, 'Montreal', 'Kanada'],
  [/spaniel|spanel|spain|barcelon|madrid/, 'Barcelona', 'Španielsko'], [/azerbajd|baku/, 'Baku', 'Azerbajdžan'], [/emilia|imola/, 'Imola', 'Taliansko'],
];
const SHOWS = [ // known entertainment formats → one factual sentence about the format
  [/superstar/i, 'česko-slovenská spevácka súťaž podľa svetového formátu Idol'], [/let'?s dance/i, 'tanečná šou, v ktorej známe osobnosti tancujú s profesionálmi'],
  [/tvoja tv[aá]r|tvoje tv[aá][řr]/i, 'šou, v ktorej sa známe osobnosti menia na slávnych spevákov'], [/x factor/i, 'spevácka talentová súťaž'], [/talent/i, 'talentová šou'],
  [/survivor/i, 'reality šou o prežití na opustenom ostrove'], [/farma/i, 'reality šou zo života na farme'], [/masterchef/i, 'kuchárska súťaž amatérov'], [/love island/i, 'zoznamovacia reality šou'],
  [/hotel paradise/i, 'zoznamovacia reality šou'], [/ninja/i, 'súťaž na prekážkovej dráhe'], [/inkognito/i, 'zábavná šou s hádaním identity hostí'], [/eurov/i, 'súťaž piesní Eurovision'],
  [/stardance/i, 'tanečná šou Českej televízie, v ktorej známe osobnosti tancujú s profesionálmi'], [/všechnopárty|vsechnoparty/i, 'talkshow Karla Šípa'],
  [/silvest/i, 'silvestrovský zábavný program'], [/hlas [čc]esko|the voice/i, 'spevácka súťaž The Voice'], [/big brother/i, 'reality šou zo spoločného domu'],
];
const lc1 = (v) => v.charAt(0).toLowerCase() + v.slice(1);
const end = (v) => side(v).replace(/[\s.:;,–-]+$/, '') + '.';
function catDesc(x, v = 0) {
  const dash = (z) => z.replace(/\s+-\s+/g, ' – ');
  const ttl = dash(side(sk(x.title)).replace(/^(tenis|futbal|hokej|atletika|box|mma)\s*[:–-]\s+/i, '')), sub = dash(side(sk(x.sub || '')).replace(/^(live|naživo|priamy prenos)$/i, '')), ch = x.chName || (x.ch && x.ch.name) || 'TV', all = ttl + ' ' + sub;
  const subOk = sub && !fold(ttl).includes(fold(sub)) && sub.length >= 4 ? sub : '';
  const live = (x.live ? ['Priamy prenos na ', 'Naživo na ', 'Prenos v priamom vysielaní na '] : ['Prenos na ', 'Vysielanie na ', 'Na obrazovke '])[v % 3] + ch;
  const c = x.cat || '';
  if (c === 'f1' || GP.test(all)) {
    const series = /motogp/i.test(all) ? 'MotoGP' : /formula 2|\bf2\b/i.test(all) ? 'Formula 2' : /rall/i.test(all) ? 'Rally' : /nascar|indycar/i.test(all) ? (/nascar/i.test(all) ? 'NASCAR' : 'IndyCar') : 'Formula 1';
    const sess = /kvalifik|qualif/i.test(all) ? (/šprint|sprint/i.test(all) ? 'kvalifikácia na šprint' : 'kvalifikácia') : /šprint|sprint/i.test(all) ? 'šprint' : /tréning|trénink|practice/i.test(all) ? 'voľný tréning' : /pretek|závod|race|\bgp\b|veľká cena/i.test(all) ? 'hlavný pretek' : '';
    const gpm = /(veľk[aá] cen[ay]|grand prix)\s+(.+?)(?:\s+(?:19|20)\d\d|\s*\(|\s*$)/i.exec(ttl + ' ' + sub), gp = gpm ? side(gpm[1].replace(/^grand prix$/i, 'Veľká cena') + ' ' + gpm[2].replace(/^MSC Cruises\s+/i, '')) : '';
    const gi = GPINFO.find(([re]) => re.test(fold(gp || all))), where = gi ? `${gi[1]}, ${gi[2]}` : '';
    const what = { 'kvalifikácia': 'rozhodne o štartovom poradí', 'kvalifikácia na šprint': 'určí poradie na štarte šprintu', 'šprint': 'prináša body za kratšie preteky', 'voľný tréning': 'ukáže prvé tempo jazdcov', 'hlavný pretek': 'je vyvrcholením víkendu' }[sess] || '';
    const head = `${series}${gp ? ' – ' + gp : ''}${where ? ' (' + where + ')' : ''}`;
    return sess ? [`${head}: ${sess} ${what}.`, `${cap(sess)} ${what} – ${head}.`, `${head}. ${cap(sess)} ${what}.`][v % 3] : end(`${head}. ${live}`);
  }
  if (c === 'mma' || c === 'boxing') {
    const m = /^(.+?):\s*(.+?\s+vs\.?\s+.+)$/i.exec(ttl);
    if (m) return end(`${[`Hlavný zápas večera ${m[1]}: ${m[2]}`, `${m[1]} – v hlavnom zápase večera ${m[2]}`, `${m[2]} je hlavným zápasom turnaja ${m[1]}`][v % 3]}${x.place ? ' (' + x.place + ')' : ''}`);
    return end(`${c === 'mma' ? 'Galavečer MMA' : 'Boxerský galavečer'} ${ttl}${subOk ? ' – ' + subOk : ''}${x.place ? ', ' + x.place : ''}`);
  }
  if (c === 'tennis') { const pl = legionLine(legion(x)); return end([`Tenis – ${ttl}${subOk ? ': ' + lc1(subOk) : ''}. ${live}`, `${ttl}${subOk ? ' (' + subOk + ')' : ''}: tenisový turnaj. ${live}`][v % 2]) + (pl ? ' ' + pl : ''); }
  if (c === 'film' || x.kind === 'film') return end([`Film ${ttl}${subOk ? ' – ' + subOk : ''} na ${ch}`, `Filmový večer na ${ch}: ${ttl}${subOk ? ' (' + subOk + ')' : ''}`][v % 2]);
  if (/koncert|concert|festival/i.test(all) || x.kind === 'music') return end(`Koncert: ${ttl}${subOk ? ' – ' + subOk : ''}. Hudobný večer na ${ch}`);
  const show = SHOWS.find(([re]) => re.test(all));
  if (show || c === 'show' || c === 'reality' || x.kind === 'show') {
    const fin = /finále|finale/i.test(all) ? (v % 2 ? 'Finálový večer: ' : 'Finále: ') : '';
    return end(show ? `${fin}${ttl} – ${show[1]}${subOk && !fin ? '; ' + lc1(subOk) : ''}` : `${fin}${ttl}${subOk ? ' – ' + subOk : ''}: zábavný program na ${ch}`);
  }
  if (isSport(x)) return end([`${ttl}${subOk ? ': ' + subOk : ''}. ${live}`, `${live}: ${ttl}${subOk ? ' – ' + lc1(subOk) : ''}`, `${ttl}${subOk ? ' (' + subOk + ')' : ''} – športový prenos na ${ch}`][v % 3]);
  return end(`${ttl}${subOk ? ' – ' + subOk : ''}${ch ? ' na ' + ch : ''}`);
}

// TMDB (official API): query title (no „(r.)“/episode suffix) and a strict match of the result title
const tmdbQuery = (t) => side(String(t || '').replace(/\(.*?\)/g, '').replace(/[:–-]\s*(\d+\.\s*)?(diel|díl|časť|část|epizoda|epizóda|séria|série|řada)\b.*$/i, '').replace(/\s+[IVX]+\.?$/, ''));
function tmdbMatch(q, r) {
  const a = fold(q); if (!a || !r) return false;
  return [r.title, r.name, r.original_title, r.original_name].some((z) => z && (fold(z) === a || (a.length >= 8 && (fold(z).startsWith(a) || a.startsWith(fold(z)) && fold(z).length >= 8))));
}
// admin „prečo“ lines for the bonuses above
function bonusWhy(x) {
  const o = [], l = legion(x), m = minorSport(x), ns = nonSport(x), sb = strengthBonus(x);
  if (skczTeam(x)) o.push('SK/CZ tím +' + SKCZ_BONUS); else if (l.length) o.push('SK/CZ hráči (' + l.map((z) => z.who).join(', ') + ') +' + LEGION_BONUS);
  if (sb) o.push('sila zápasu (elita/tabuľka/fáza) +' + sb); if (nobody(x)) o.push('bez SK/CZ väzby a elity −14');
  if (m) o.push('mládež/rozjazdy ' + m); if (ns) o.push('nešport (kanál, formát, premiéra série, TMDB) +' + ns);
  return o;
}
// one-line visible reason for a card (Slovak, emoji + short text) from the strongest factor
const FLAG = { SK: '🇸🇰', CZ: '🇨🇿' };
const surname = (n) => String(n).split(' ').slice(-1)[0];
function reason(x) {
  const all = (x.title || '') + ' ' + (x.sub || ''), c = [];
  const push = (w, t) => c.push([w, t]);
  if (isSport(x)) {
    const T = x.teams || [], g = T.length === 2 ? strength(x) : null, l = legion(x);
    const sk = T.find((t) => SKTEAM.test(t)), cz = T.find((t) => CZTEAM.test(t));
    if (sk || cz) push(30, `${sk ? FLAG.SK : FLAG.CZ} Hrá ${side(sk || cz)}`);
    else if (l.length) push(20, `${FLAG[l[0].nat]} ${l.length > 1 ? 'Hrajú ' + l.slice(0, 2).map((z) => surname(z.who)).join(' a ') : 'Hrá ' + surname(l[0].who)}`);
    if (g && g.slager) push(26, `🔥 Šláger: ${g.names[0]} vs. ${g.names[1]}`);
    const rv = bigCtx(x.big, null), rvl = (x.big || []).map((w) => String(w).replace(/\s*[+−-]\d+\s*$/, '').trim()).find((w) => /derby|cl[aá]sico|classique|klassiker|old firm/i.test(w));
    if (rvl) push(27, `🔥 ${rvl.replace(/\s*\((?:hokej|S–S)\)$/, '')}`);
    const st = (g && g.stage) || (STAGE.find(([re]) => re.test(all)) ? { label: STAGE.find(([re]) => re.test(all))[2] } : null);
    if (st) push(st.label === 'Finále' ? 28 : 18, `🏆 ${st.label}`);
    if (g && g.top) push(17, '📈 Súboj špičky tabuľky');
    if (g && !g.slager && g.tiers.some((t) => t >= 2)) { const i = g.tiers[0] >= g.tiers[1] ? 0 : 1; push(12, `⭐ Hrá ${g.names[i]}`); }
    if (x.cat === 'f1' || GP.test(all)) { const f = /motogp/i.test(all) ? 'MotoGP' : 'F1'; push(22, `🏎️ ${/kvalifik|qualif/i.test(all) ? 'Kvalifikácia ' + f : /šprint|sprint/i.test(all) ? 'Šprint ' + f : /tréning|trénink|practice/i.test(all) ? 'Tréning ' + f : 'Veľká cena ' + f}`); }
    if (x.cat === 'mma' || x.cat === 'boxing') push(16, /oktagon/i.test(all) ? '🥊 Galavečer OKTAGON' : '🥊 Galavečer');
    if (/ms |majstrovstv|mistrovstv|olymp|world cup|svetov/i.test(all + ' ' + (x.comp || '')) && !YOUTH.test(all)) push(14, '🌍 Veľký turnaj');
    if (EUROCUP.test((x.comp || '') + ' ' + (x.sub || ''))) push(8, '⚽ Európsky pohár');
    if (x.live) push(5, '🔴 Naživo');
    push(1, '🏅 Športový tip týždňa');
  } else {
    const prem = /p/.test(x.fl || '') || (x.why || []).some((w) => /premiéra/.test(w)), t = x.tmdb, k = x.kind || x.cat;
    if (/fin[aá]le/i.test(all)) push(26, '🏆 Finále šou');
    if (SEASON.test(all)) push(24, '📺 Premiéra novej série');
    if (k === 'film' && prem) push(25, '🎬 Filmová premiéra');
    if (t && t.vote >= 7 && t.n >= 200) push(20, `🎬 Hodnotenie ${String(t.vote.toFixed(1)).replace('.', ',')}/10 (TMDB)`);
    if (SHOWS.some(([re]) => re.test(all))) push(19, '⭐ Obľúbená veľká šou');
    if (k === 'music' || /koncert|concert/i.test(all)) push(18, '🎤 Koncert');
    if (k === 'doc') push(15, prem ? '🎥 Dokument v premiére' : '🎥 Dokument');
    if (k === 'film') push(12, '🎬 Film v hlavnom čase');
    if (prem) push(10, '✨ Premiéra');
    push(1, '📺 Tip na večer');
  }
  return c.sort((a, b) => b[0] - a[0])[0][1];
}

module.exports = { reason, strength, strengthBonus, nobody, ELITE, bonusWhy, tmdbQuery, tmdbMatch, SEASON, legion, legionLine, chTier, nonSport, minorSport, tmdbPts, skczTeam, LEGION, sk, isCzech, catDesc, filler, bigCtx, matchFacts, matchDesc, cleanEpg, okTeaser, hsh, formSk, clubBonus, firstAirings, stemKey, airKey, TZ, dayKey, dayDiff, dateLbl, hmL, whenLbl, badge, isRecording, pairIn, teamsOf, compOf, qName, sameTeam, classify, tsdbEvent, soon, priority, merge, select, isSport, sameEvent, pairKey, fold };
