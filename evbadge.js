'use strict';
// Team logos for match cards – a chain of free, legal sources, cached persistently (epg_kv „evh_tb“) because crests rarely
// change; the image itself is downloaded once, resized and served from our own /ev-img/c/b-… path (CSP: img-src 'self').
//  1) national teams → the country flag from Wikimedia Commons (public domain, curated map below)
//  2) curated map of top SK/CZ and big European clubs → their Wikidata item (P154 logo on Commons)
//  3) TheSportsDB searchteams (free key 123; on HTTP 429 the source is skipped for this run, never cached as „none“)
//  4) ESPN public team lists (site.api.espn.com, no key): UEFA cups, top leagues, NHL, NBA → a.espncdn.com crest
//  5) Wikidata search → the club item's P154 logo (Commons) – filtered to sports clubs/teams of the right sport
//  6) Wikidata item without P154 → its English Wikipedia lead image (club crest) via the pageimages API
// Lookups are throttled (≥ 1.2 s apart, max N per run); positive results are kept 60 days, „not found“ 3 days.
const RK = require('./evrank');
const FILE = (f) => 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(f.replace(/ /g, '_')) + '?width=128';
// SK/CZ country names (folded) → Commons flag file
const FLAGS = {
  slovensko: 'Slovakia', cesko: 'the Czech Republic', 'ceska republika': 'the Czech Republic', taliansko: 'Italy', italie: 'Italy', svajciarsko: 'Switzerland', svycarsko: 'Switzerland',
  nemecko: 'Germany', rakusko: 'Austria', polsko: 'Poland', madarsko: 'Hungary', francuzsko: 'France', francie: 'France', spanielsko: 'Spain', spanelsko: 'Spain',
  anglicko: 'England', anglie: 'England', holandsko: 'the Netherlands', nizozemsko: 'the Netherlands', belgicko: 'Belgium', belgie: 'Belgium', portugalsko: 'Portugal',
  svedsko: 'Sweden', finsko: 'Finland', norsko: 'Norway', dansko: 'Denmark', kanada: 'Canada', usa: 'the United States', rusko: 'Russia', lotyssko: 'Latvia',
  chorvatsko: 'Croatia', srbsko: 'Serbia', slovinsko: 'Slovenia', rumunsko: 'Romania', ukrajina: 'Ukraine', grecko: 'Greece', recko: 'Greece', turecko: 'Turkey',
  island: 'Iceland', skotsko: 'Scotland', wales: 'Wales', irsko: 'Ireland', kazachstan: 'Kazakhstan', japonsko: 'Japan', brazilia: 'Brazil', brazilie: 'Brazil', argentina: 'Argentina',
  bielorusko: 'Belarus', estonsko: 'Estonia', litva: 'Lithuania', albansko: 'Albania', gruzinsko: 'Georgia', kosovo: 'Kosovo', izrael: 'Israel', egypt: 'Egypt', faersko: 'the Faroe Islands', 'faerske ostrovy': 'the Faroe Islands',
};
const flagOf = (name) => { const k = RK.fold(name).replace(/\s+(u\d\d|zeny|zien|zen|women|muzi)$/, ''); const c = FLAGS[k]; return c ? FILE('Flag of ' + c + '.svg') : ''; };
// curated: big clubs often shown on SK/CZ TV → Wikidata items (P154 read live, so a new crest is picked up)
const CLUBS = [
  [/slovan bratislava/, 'Q192253'], [/spartak trnava/, 'Q459218'], [/dac|dunajska streda/, 'Q841378'], [/msk zilina|^zilina/, 'Q209640'], [/slavia (praha|prague)/, 'Q194393'],
  [/sparta (praha|prague)/, 'Q193481'], [/viktoria plzen/, 'Q206838'], [/banik ostrava/, 'Q329471'], [/lask/, 'Q392310'], [/dinamo (zagreb|zahreb)/, 'Q172803'],
  [/real madrid/, 'Q8682'], [/barcelona/, 'Q7156'], [/bayern/, 'Q15789'], [/dortmund/, 'Q41420'], [/juventus/, 'Q1422'], [/inter\b|internazionale/, 'Q631'], [/\bac milan|^milan/, 'Q1543'],
  [/liverpool/, 'Q1130849'], [/arsenal/, 'Q9617'], [/manchester united/, 'Q18656'], [/manchester city/, 'Q50602'], [/chelsea/, 'Q9616'], [/tottenham/, 'Q18741'], [/paris saint|^psg$/, 'Q483020'],
  [/sunderland/, 'Q18739'], [/newcastle/, 'Q18716'], [/aston villa/, 'Q18711'], [/ajax/, 'Q81888'], [/celtic/, 'Q19593'], [/atletico madrid/, 'Q8701'], [/napoli/, 'Q2641'], [/leverkusen/, 'Q104761'],
];
const CV = 3; // bump when the source chain / curated map grows
const ESPN = { football: ['soccer/uefa.champions', 'soccer/uefa.europa', 'soccer/uefa.europa.conf', 'soccer/eng.1', 'soccer/esp.1', 'soccer/ger.1', 'soccer/ita.1', 'soccer/fra.1', 'soccer/ned.1', 'soccer/por.1', 'soccer/aut.1', 'soccer/sco.1'],
  hockey: ['hockey/nhl'], basketball: ['basketball/nba'] };
const SPORTDESC = { football: /football|soccer/i, hockey: /ice hockey/i, basketball: /basketball/i, handball: /handball/i, volleyball: /volleyball/i };
const TSDBSPORT = { football: 'Soccer', hockey: 'Ice Hockey', basketball: 'Basketball', handball: 'Handball', volleyball: 'Volleyball' };
const sportOf = (cat, comp) => (/h[aá]dzan|h[aá]zen|handball/i.test(comp || '') ? 'handball' : /volejbal|volley/i.test(comp || '') ? 'volleyball' : cat === 'hockey' ? 'hockey' : cat === 'basketball' ? 'basketball' : 'football');
const keyOf = (name, sport) => RK.fold(RK.qName(name)) + '|' + sport;

module.exports = function badges({ kv, get }) {
  const UA = { 'user-agent': 'lnkbio-tvguide/1.0 (https://lnkbio.onrender.com/tv; TV guide team logos)' };
  const json = async (u) => JSON.parse((await get(u, 'application/json', 2e6, UA)).buf.toString('utf8'));
  let cache = null, saving = Promise.resolve(), tsdbOff = 0; const espn = {};
  const load = async () => { if (!cache) { try { cache = JSON.parse((await kv.get('evh_tb')) || '{}') || {}; } catch { cache = {}; } } return cache; };
  const save = () => (saving = saving.then(() => kv.set('evh_tb', JSON.stringify(cache)).catch(() => {})));
  async function wdLogo(ids, sport) {
    const e = await json(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|descriptions|sitelinks&languages=en&sitefilter=enwiki&ids=${ids.join('|')}`);
    for (const id of ids) {
      const en = (e.entities || {})[id]; if (!en) continue;
      const d = ((en.descriptions || {}).en || {}).value || '';
      if (ids.length > 1 && !(/club|team/i.test(d) && (SPORTDESC[sport] || /./).test(d))) continue;
      const p = en.claims && en.claims.P154 && en.claims.P154[0].mainsnak.datavalue;
      if (p && p.value) return { b: FILE(p.value), src: 'Wikidata/Commons (' + id + ')' };
      const wl = en.sitelinks && en.sitelinks.enwiki && en.sitelinks.enwiki.title;
      if (wl) {
        const w = await json(`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=128&titles=${encodeURIComponent(wl)}`);
        const pg = Object.values((w.query && w.query.pages) || {})[0], th = pg && pg.thumbnail && pg.thumbnail.source;
        if (th && /^https:\/\/upload\.wikimedia\.org\//.test(th)) return { b: th, src: 'Wikipedia EN (' + wl + ')' };
      }
      if (ids.length === 1) return null;
    }
    return null;
  }
  async function lookup(name, sport, women) {
    const f = flagOf(name); if (f) return { b: f, src: 'Wikimedia Commons – vlajka' };
    const fn = RK.fold(RK.qName(name)) + ' ' + RK.fold(name);
    const cur = !women && sport === 'football' && CLUBS.find(([re]) => re.test(fn));
    if (cur) { const r = await wdLogo([cur[1]], sport); if (r) return r; }
    const q = RK.qName(name) + (women ? ' Women' : '');
    if (Date.now() > tsdbOff) {
      try {
        const j = await json(`https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=${encodeURIComponent(q)}`);
        const t = ((j && j.teams) || []).find((x) => x.strSport === TSDBSPORT[sport] && x.strBadge && RK.sameTeam(name, x.strTeam));
        if (t) return { b: t.strBadge, src: 'TheSportsDB' };
      } catch (e) { if (/429/.test(e.message)) tsdbOff = Date.now() + 20 * 60e3; }
      await new Promise((r) => setTimeout(r, 1200));
    }
    // ESPN public team lists (no key): UEFA cups + top leagues, NHL, NBA – fetched lazily, kept in memory 12 h
    if (!women) for (const lg of ESPN[sport] || []) {
      let L = espn[lg];
      if (!L || Date.now() - L.t > 12 * 3600e3) {
        try { const j = JSON.parse((await get(`https://site.api.espn.com/apis/site/v2/sports/${lg}/teams`, 'application/json', 4e6, { 'user-agent': 'lnkbio-tvguide/1.0' })).buf.toString('utf8')); L = espn[lg] = { t: Date.now(), teams: ((((j.sports || [])[0] || {}).leagues || [{}])[0] || {}).teams || [] }; }
        catch { L = espn[lg] = { t: Date.now(), teams: [] }; }
      }
      const t = L.teams.map((z) => z.team || {}).find((z) => z.displayName && RK.sameTeam(name, z.displayName));
      const href = t && ((t.logos || [])[0] || {}).href;
      if (href && /^https:\/\/a\.espncdn\.com\//.test(href)) return { b: href, src: 'ESPN (' + lg + ')' };
    }
    for (const qq of [...new Set([q, String(name).trim() + (women ? ' women' : '')])]) {
      const s = await json(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=7&search=${encodeURIComponent(qq)}`);
      const ids = ((s && s.search) || []).filter((x) => RK.sameTeam(name, x.label || '')).map((x) => x.id).slice(0, 7);
      const r = ids.length ? await wdLogo(ids, sport) : null; if (r) return r;
    }
    return null;
  }
  // ensure logos for [{name, sport, women}] – at most `max` network lookups, ≥ 1.2 s apart; returns nothing (read with get())
  async function ensure(list, max = 8, now = Date.now()) {
    const c = await load(); let n = 0, ch = false;
    for (const t of list) {
      const k = keyOf(t.name, t.sport) + (t.women ? '|w' : ''), h = c[k];
      if (h && (h.b || h.v === CV) && now - h.t < (h.b ? 60 : 3) * 86400e3) continue; // misses from an older chain version are retried
      if (n >= max) break;
      if (n++) await new Promise((r) => setTimeout(r, 1200));
      try { const r = await lookup(t.name, t.sport, t.women); c[k] = { t: now, v: CV, b: r ? r.b : '', src: r ? r.src : '' }; ch = true; }
      catch (e) { console.error('evhero logo', RK.qName(t.name), e.message); if (/429|too many/i.test(e.message)) break; }
    }
    if (ch) await save();
  }
  const getB = (name, sport, women) => { const h = cache && cache[keyOf(name, sport) + (women ? '|w' : '')]; return h && h.b ? h : null; };
  return { ensure, get: getB, sportOf, flagOf };
};
module.exports.flagOf = flagOf;
module.exports.sportOf = sportOf;
