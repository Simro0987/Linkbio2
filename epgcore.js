'use strict';
// EPG core: streaming XMLTV parser, fuzzy channel matching, programme classification.
// Only schedule metadata (channel id/name, time, title, category) – never stream URLs.
const zlib = require('zlib');

const xdec = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] || (e[1] === 'x' || e[1] === 'X' ? String.fromCodePoint(parseInt(e.slice(2), 16) || 32) : String.fromCodePoint(parseInt(e.slice(1), 10) || 32)));
const attr = (tag, n) => { const m = new RegExp('\\s' + n + '\\s*=\\s*"([^"]*)"').exec(tag) || new RegExp('\\s' + n + "\\s*=\\s*'([^']*)'").exec(tag); return m ? xdec(m[1]) : ''; };
const inner = (x, t) => { const m = new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>').exec(x); return m ? xdec(m[1]).replace(/\s+/g, ' ').trim() : ''; };
const inners = (x, t) => [...x.matchAll(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>', 'g'))].map((m) => xdec(m[1]).replace(/\s+/g, ' ').trim()).filter(Boolean);
// "20261021000200 +0200" → ms
function xtime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}):?(\d{2})?/.exec(String(v || '').trim()); if (!m) return NaN;
  const off = (Math.abs(+m[7]) * 60 + +(m[8] || 0)) * (m[7][0] === '-' ? -1 : 1);
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - off * 60e3;
}
const clip = (s, n) => { s = String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const NOURL = (s) => String(s || '').replace(/\b[a-z][a-z0-9+.-]{1,10}:\/\/\S+/gi, '').trim();

/**
 * Stream-parse an XMLTV (optionally gzipped) web stream.
 * onChannel({id,names}) for every <channel>; onProg(raw parsed programme) for every <programme>.
 * If onProg returns the string 'stop' (or channelsOnly is set) the download is aborted early.
 */
async function parseStream(body, { gz, onChannel, onProg, channelsOnly, maxBytes = 400 * 1024 * 1024 }) {
  const src = body.getReader ? require('stream').Readable.fromWeb(body) : body;
  const inp = gz ? src.pipe(zlib.createGunzip()) : src;
  let buf = '', total = 0, stop = false;
  const dec = new (require('string_decoder').StringDecoder)('utf8');
  try {
    for await (const chunk of inp) {
      total += chunk.length; if (total > maxBytes) throw new Error('feed too large');
      buf += dec.write(chunk);
      let pos = 0;
      for (;;) {
        const a = buf.indexOf('<', pos); if (a < 0) { pos = buf.length; break; }
        if (buf.startsWith('<programme', a)) {
          if (channelsOnly) { stop = true; break; }
          const e = buf.indexOf('</programme>', a); if (e < 0) { pos = a; break; }
          const x = buf.slice(a, e + 12); pos = e + 12;
          const tag = x.slice(0, x.indexOf('>') + 1);
          const p = { ch: attr(tag, 'channel'), start: xtime(attr(tag, 'start')), stop: xtime(attr(tag, 'stop')), x };
          if (onProg && onProg(p) === 'stop') { stop = true; break; }
        } else if (buf.startsWith('<channel', a) && /[\s>]/.test(buf[a + 8] || '')) {
          const e = buf.indexOf('</channel>', a); if (e < 0) { pos = a; break; }
          const x = buf.slice(a, e + 10); pos = e + 10;
          const tag = x.slice(0, x.indexOf('>') + 1);
          if (onChannel) onChannel({ id: attr(tag, 'id'), names: inners(x, 'display-name') });
        } else {
          const e = buf.indexOf('>', a); if (e < 0) { pos = a; break; } pos = e + 1;
        }
      }
      buf = buf.slice(pos);
      if (buf.length > 4 * 1024 * 1024) throw new Error('malformed XMLTV (element too large)');
      if (stop) break;
    }
  } finally { if (inp.destroy) inp.destroy(); if (src !== inp && src.destroy) src.destroy(); }
  return { bytes: total, aborted: stop };
}
function progDetails(p) {
  const x = p.x;
  const cats = inners(x, 'category');
  return {
    title: clip(NOURL(inner(x, 'title')), 160), sub: clip(NOURL(inner(x, 'sub-title')), 160), desc: clip(NOURL(inner(x, 'desc')), 280),
    cat: clip(cats.slice(0, 3).join(', '), 120), year: (/(19|20)\d\d/.exec(inner(x, 'date')) || [''])[0],
    premiere: /<premiere[\s/>]/.test(x), rerun: /<previously-shown[\s/>]/.test(x), live: /<live[\s/>]/.test(x),
  };
}

// ---------- channel name normalization & fuzzy matching ----------
const strip = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const QUAL = new Set(['fhd', 'hd', 'uhd', '4k', '8k', 'sd', 'hevc', 'h265', 'h264', 'hdr', 'fullhd', 'tv', 'hq', 'raw', 'backup', 'live', 'channel', 'kanal', 'telewizja', 'televizia', 'televize', 'televizio']);
const CC = new Set(['sk', 'cz', 'hu', 'pl', 'de', 'at', 'ch', 'uk', 'gb', 'nl', 'ua', 'it', 'fr', 'es', 'ru', 'us', 'mx', 'eu', 'int', 'intl', 'cee', 'ro', 'hr', 'rs', 'si', 'ba', 'esp', 'cze', 'svk', 'ger', 'pol', 'hun']);
const ALIAS = [[/\bct\s*:?\s*d\b/g, 'ct d'], [/\bct\s*art\b/g, 'ct art'], [/\bmarkiza\b/g, 'markiza'], [/\bjoj\s*\+/g, 'joj plus'], [/\+\s*1\b/g, ' plus1 '], [/\bstv\s*1\b/g, 'jednotka'], [/\bstv\s*2\b/g, 'dvojka'], [/\bstv\s*24\b/g, 'rtvs 24'], [/\b:24\b/g, 'rtvs 24'], [/\b:sport\b/g, 'rtvs sport'], [/\bstvr\b/g, 'rtvs'], [/\bnatgeo\b/g, 'national geographic'], [/\bnat\s*geo\b/g, 'national geographic'], [/\bdiscovery\s*:\s*/g, ''], [/\bcanal\s*\+/g, 'canal plus '], [/\bfilmbox\s*\+/g, 'filmbox plus '], [/\bfilm\s*\+/g, 'film plus '], [/\bfilm europe\s*\+/g, 'film europe plus '], [/&/g, ' and '], [/\bsport(s)?\b/g, 'sport'], [/\bsport\s*1\b/g, 'sport 1'], [/\bcnn intl\.?/g, 'cnn international'], [/\bintl\.?\b/g, 'international'], [/\bnick\s*jr\b\.?/g, 'nick jr'], [/\bjr\b\.?/g, 'jr'], [/\bbarandov\b/g, 'barrandov'], [/\bdeluxe music (?=[a-z])/g, 'deluxe '], [/\bzwei\b/g, '2']];
function nameKey(name) {
  let s = strip(name).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  for (const [r, v] of ALIAS) s = s.replace(r, v);
  s = s.replace(/[^\p{L}\p{N}+]+/gu, ' ');
  const toks = s.split(' ').filter(Boolean);
  const cc = toks.filter((t) => CC.has(t));
  let core = toks.filter((t) => !QUAL.has(t) && !CC.has(t)).map((t) => (t.length > 4 && /[a-z]tv$/.test(t) ? t.slice(0, -2) : t));
  if (!core.some((t) => /\p{L}/u.test(t))) core = toks.filter((t) => !CC.has(t) && !/^(f?hd|uhd|4k|sd|hevc)$/.test(t));
  if (!core.some((t) => /\p{L}/u.test(t))) core = [];
  const k = core.join(' ');
  return { key: k.replace(/ /g, ''), skey: [...core].sort().join(''), toks: core, digits: (k.match(/\d+/g) || []).join(','), cc };
}
function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); m.set(b, (m.get(b) || 0) + 1); } return m; }
function dice(a, b) {
  if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b); let n = 0; for (const [k, v] of A) n += Math.min(v, B.get(k) || 0);
  return (2 * n) / (a.length - 1 + b.length - 1);
}
const idCountry = (id) => { const m = /\.([a-z]{2})$/i.exec(String(id || '')); return m ? m[1].toLowerCase() : ''; };
// site category → preferred EPG countries
const CAT_CC = [[/sloven|lokál|lokal/i, ['sk', 'cz']], [/česk|cesk/i, ['cz', 'sk']], [/maďar|madar|hungar/i, ['hu']], [/poľs|pols|poland/i, ['pl']], [/nemec|german|deutsch/i, ['de', 'at', 'ch']], [/švajč|svajc|swiss/i, ['ch', 'de', 'at']], [/rakús|rakus|austri/i, ['at', 'de']], [/ukraj/i, ['ua']], [/rusk|russ/i, ['ru']], [/zahrani|správy|spravy|news/i, ['uk', 'sk', 'cz', 'de', 'nl', 'fr', 'it', 'es', 'pl']]];
function prefCountries(name, category) {
  const n = nameKey(name).cc; const out = [];
  const add = (c) => { c = c === 'gb' ? 'uk' : c; if (!out.includes(c)) out.push(c); };
  n.forEach(add);
  for (const [r, l] of CAT_CC) if (r.test(category || '')) { l.forEach(add); break; }
  ['sk', 'cz', 'hu', 'pl', 'de', 'at', 'uk', 'nl', 'ch'].forEach(add);
  return out;
}
/** Build an index of EPG channels: [{id, name, feed, n}] → matcher */
function buildIndex(epgChans) {
  const byKey = new Map(), list = [];
  for (const c of epgChans) {
    const keys = new Set();
    for (const nm of [...(c.names || [c.name]), String(c.id).replace(/^src\d+:/, '').replace(/\.[a-z]{2}$/i, '').replace(/[._]+/g, ' ')]) { const k = nameKey(nm); if (k.key) { keys.add(k.key + '|' + k.digits); if (k.skey !== k.key) keys.add(k.skey + '|' + k.digits); } }
    for (const kd of keys) { if (!byKey.has(kd)) byKey.set(kd, []); byKey.get(kd).push(c); }
    list.push({ c, keys: [...keys].map((x) => x.split('|')) });
  }
  return { byKey, list };
}
/** best candidates for a site channel: [{id, name, score}] sorted */
function candidates(ix, name, category, limit = 5) {
  const k = nameKey(name); if (!k.key) return [];
  const pref = prefCountries(name, category);
  const ccScore = (id) => { const i = pref.indexOf(idCountry(id)); return i < 0 ? 0 : (pref.length - i) / pref.length; };
  const res = new Map();
  const put = (c, sim) => { const sc = sim + ccScore(c.id) * 0.08 + (c.n > 0 ? 0.05 : c.n === 0 ? -0.3 : 0); const o = res.get(c.id); if (!o || o.score < sc) res.set(c.id, { id: c.id, name: (c.names || [c.name])[0] || c.id, sim: +sim.toFixed(3), score: +sc.toFixed(3), feed: c.feed, n: c.n }); };
  for (const c of ix.byKey.get(k.key + '|' + k.digits) || []) put(c, 1);
  if (k.skey !== k.key) for (const c of ix.byKey.get(k.skey + '|' + k.digits) || []) put(c, 0.99);
  // "Cinemax 1" ≈ "Cinemax", "Setanta Sports" ≈ "Setanta Sports 1"
  if (k.digits === '1') for (const c of ix.byKey.get(k.key.replace(/1(?!.*1)/, '') + '|') || []) put(c, 0.95);
  if (k.digits === '') for (const c of ix.byKey.get(k.key + '1|1') || []) put(c, 0.94);
  const shortT = k.toks.filter((t) => t.length <= 3 && /\p{L}/u.test(t));
  if (res.size < limit) {
    for (const { c, keys } of ix.list) {
      let best = 0;
      for (const [kk, dd] of keys) {
        if (dd !== k.digits) continue;
        if (shortT.some((t) => !kk.includes(t))) continue;
        let d = dice(k.key, kk);
        if (d < 1 && (kk.startsWith(k.key) || k.key.startsWith(kk)) && Math.min(kk.length, k.key.length) >= 4) d = Math.max(d, 0.88 - Math.abs(kk.length - k.key.length) * 0.015);
        if (d > best) best = d;
      }
      if (best >= 0.84) put(c, best * 0.97);
    }
  }
  return [...res.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
// Built-in manual mappings for channels whose names differ too much from the feed (verified against epgshare01 data).
// [regex on the lower-cased site channel name, EPG id, time shift in minutes]
const KNOWN = [
  [/^markiza \+ ?1\b/, 'Markíza.HD.sk', 60], [/^ct :?d\b.*ct art/, 'ČT.art.cz', 0], [/^cs horror/, 'CS.Film-CS.Horror.HD.sk', 0],
  [/^deluxe music dance by kontor/, 'Deluxe.Dance.by.Kontor.be', 0], [/^deluxe music rap/, 'Deluxe.Rap.be', 0],
  [/^первый( hd)?$/, 'Первый.канал.HD.[RU].ua', 0], [/^тв ?-?3( hd)?$/, 'ТВ-3.Россия.[RU].ua', 0], [/^твц( hd)?$/, 'ТВ.Центр.[RU].ua', 0],
  [/^gagsnetwork/, 'Gagsnetwork.Україна.[UA-RU].ua', 0], [/^россия ?24/, 'RUSSIA.24.tr', 0], [/^рбк/, 'РБК.ТВ.[RU].ua', 0],
  [/^srf ?(2|zwei)\b/, 'SRF.zwei.ch', 0], [/^3\+/, '3+.ch', 0], [/^4\+/, '4+.ch', 0], [/^5\+/, '5+.ch', 0], [/^6\+/, '6+.ch', 0], [/^7\+/, '7+./.Nickelodeon.ch', 0],
  [/^film ?ua live/, 'FILMUA.Live.[UA-UA].ua', 0], [/^uatv|freeдом|freedom/, 'FREEDOM.sk', 0], [/^cine friki/, 'Cine.Friki.es', 0],
  [/^polsat sport 2\b/, 'Polsat.Sport.Extra.HD.pl', 0], [/^polsat sport 3\b/, 'Polsat.Sport.News.HD.pl', 0], [/^rtm ?\+/, 'RTM.cz', 0],
  [/^red bull tv/, 'DE:.Red.Bull.TV.be', 0],
];
function known(name) { const l = String(name || '').toLowerCase().trim(), st = strip(l); for (const [r, id, sh] of KNOWN) if (r.test(l) || r.test(st)) return { id, shift: sh }; return null; }
// guard against look-alike channels from far away countries (e.g. Czech "TN Live" ≠ Uruguayan "TN")
const EU = new Set(['sk', 'cz', 'hu', 'pl', 'de', 'at', 'ch', 'uk', 'nl', 'ua', 'it', 'fr', 'es', 'be', 'lu', 'ro', 'hr', 'rs', 'si', 'ba', 'bg', 'gr', 'lt', 'lv', 'pt', 'ie', 'dk', 'se', 'no', 'fi', 'al', 'mt', 'cy', 'tr', 'ru']);
function allowed(category, id) {
  const cc = idCountry(id); const cat = String(category || '');
  if (/lokáln|lokaln/i.test(cat)) return cc === 'sk' || cc === 'cz';
  if (/sloven|česk|cesk/i.test(cat)) return !cc || EU.has(cc);
  return true;
}
const MATCH_MIN = 0.88; // on raw name similarity (exact = 1)
const isMatch = (c) => !!c && c.sim >= MATCH_MIN && c.n !== 0;

// ---------- programme classification ----------
const B = '(?<![\\p{L}\\p{N}])'; // word start that also works before š/č/ž… (\\b does not)
const kre = (src) => new RegExp(B + '(' + src + ')', 'iu');
const K = {
  film: kre('film|filmy|movie|spielfilm|kino|thriller|horor|horror|krimi ?film|komédi|komedi|vígjáték|játékfilm|dráma|drám|drama|western|akčn|akcni|akció|sci-?fi|romantick|rodinn[ýy] film|fantasy|animovan[ýy] film|melodr|fabularn|fabularny'),
  sport: kre('šport|sport|futbal|fotbal|football|soccer|hokej|hockey|tenis|tennis|basketbal|basketball|kosárlabda|labdarúgás|jégkorong|piłka|siatk|kolarst|volejbal|volleyball|motošport|motorsport|formula|f1|motogp|box|mma|ufc|golf|cyklist|cycling|atletik|athletic|biatlon|lyžov|ski|handball|hádzan|házená|wrestling|darts|snooker|nfl|nba|nhl|khl|fußball|fussball|calcio|deporte|rugby|cricket'),
  news: kre('správy|zprávy|spravodajs|zpravodajs|news|nachrichten|híradó|wiadomo|informac|aktuality|tagesschau|journal|nieuws|notizie|noticias|actualit|publicistik|publicisti'),
  kids: kre('detsk|dětsk|deti|děti|kids|kinder|gyerek|rozprávk|pohádk|kreslen|animovan|animáci|animation|zeichentrick|cartoon|bajk|dla dzieci|children|jeugd|enfant|infantil'),
  doc: kre('dokument|documen|doku|ismeretterjeszt|príroda|přírod|nature|natur|cestopis|cestovateľ|cestovatel|travel|reise|histor|vedeck|vědeck|science|wissenschaft|rybár|rybář|lovec|lovecké|zvierat|zvířat|animals'),
  series: kre('seriál|serial|series|serie|sorozat|telenovel|sitcom|soap|krimiserie|comedyserie|animationsserie|zeichentrickserie|filmsorozat|detektív|detektiv'),
  show: kre('zábav|zabav|show|šou|reality|súťaž|soutěž|quiz|kvíz|talk|entertainment|unterhaltung|szórakoz|vetélked|rozrywk|divertissement|magazín|magazin|magazine|magazyn|lifestyle|voľnočas|volnočas|varenie|vaření|kuchyn|cooking|bývanie|bydlení|móda|fashion|relácia|pořad|show'),
  music: kre('hudb|music|musik|zene|koncert|concert|muzyk|muzyc|rock|pop\\b|hip-?hop|jazz|klasick[áa] hudba|opera'),
};
const LIVE = /(\blive\b|naživo|nazivo|naživo|priamy prenos|přímý přenos|p\.p\.|élő|na żywo|\blive:|\bvs\.?\b|\bv\.? ?s\b| – .+ – |\bfinále|\bfinal\b|semifin|štvrťfin|čtvrtfin|playoff|play-off|\bzápas\b|grand prix|\bgp\b|liga majstrov|liga mistrů|champions league|europa league|konferenčn|premier league|bundesliga|la liga|serie a|ligue 1|niké liga|nike liga|tipsport liga|tipos extraliga|extraliga|fortuna liga|chance liga|\bnhl\b|\bnba\b|\bufc\b|\bms v\b|\bme v\b|majstrovstvá sveta|mistrovství světa|majstrovstvá európy|mistrovství evropy|olymp|wimbledon|roland garros|us open|australian open|tour de france|derby|dakar|\bf1\b|formula 1|formule 1|motogp|el clasico)/i;
const NOTLIVE = /(magaz[ií]n|štúdio|studio|highlight|zostrih|sestřih|záznam|zaznam|repríza|repriza|preview|predstavenie|téma|news|správy|zprávy|góly|goly|týždeň|tyden|kolo ve|sport\s*\d*\s*:|sportovní noviny|športové noviny|ríša|klasik|legendy|best of|top 10)/i;
const BIGSHOW = /(superstar|let'?s dance|tvoja tvár|tvoje tvář|survivor|farma|inkognito|milionár|milionář|chcem byť milionár|česko slovensko má talent|got talent|x factor|masterchef|hlas česko|the voice|ruža pre|love island|výmena manželiek|silvest|oscar|eurovízia|eurovize|koncert roka|nedeľa so|na chalupe|zlatý slávik|dancing with)/i;
function classify(cat, title) {
  const c = String(cat || ''), t = String(title || '');
  if (K.sport.test(c)) return 'sport';
  if (K.news.test(c)) return 'news';
  if (K.kids.test(c)) return 'kids';
  if (K.series.test(c)) return 'series';
  if (K.film.test(c)) return 'film';
  if (K.doc.test(c)) return 'doc';
  if (K.show.test(c) || BIGSHOW.test(t)) return 'show';
  if (K.music.test(c)) return 'music';
  if (LIVE.test(t) && K.sport.test(t)) return 'sport';
  return '';
}
const KIND_LABEL = { film: 'Film', sport: 'Šport', news: 'Správy', kids: 'Deti', series: 'Seriál', doc: 'Dokument', show: 'Zábava', music: 'Hudba' };
const KIND_LABEL_EN = { film: 'Movie', sport: 'Sport', news: 'News', kids: 'Kids', series: 'Series', doc: 'Documentary', show: 'Show', music: 'Music' };
const KIND_ICON = { film: '🎬', sport: '⚽', news: '📰', kids: '🧸', series: '📺', doc: '🌍', show: '🎤', music: '🎵' };

module.exports = { known, allowed, KNOWN, parseStream, progDetails, xtime, nameKey, dice, buildIndex, candidates, isMatch, prefCountries, idCountry, classify, MATCH_MIN, LIVE, NOTLIVE, BIGSHOW, KIND_LABEL, KIND_LABEL_EN, KIND_ICON, clip };
