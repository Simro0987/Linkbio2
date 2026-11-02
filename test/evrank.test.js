// evrank: Slovak date labels, calendar-day badges, recordings, team pairing, official fixture check, merge, variety
const assert = require('assert');
const R = require('../evrank');
const at = (iso) => Date.parse(iso);
// Saturday 7 Nov 2026 20:45 CET = 19:45 UTC
assert.strictEqual(R.whenLbl(at('2026-11-07T19:45:00Z'), 0), 'So 7. 11. · 20:45');
assert.strictEqual(R.whenLbl(at('2026-11-07T19:45:00Z'), at('2026-11-07T21:45:00Z')), 'So 7. 11. · 20:45–22:45');
const mon = at('2026-11-02T05:00:00Z'); // Mon 06:00 CET
assert.strictEqual(R.badge(at('2026-11-07T19:45:00Z'), mon), 'o 5 dní');
assert.strictEqual(R.badge(at('2026-11-03T00:30:00Z'), at('2026-11-02T22:00:00Z')), 'zajtra'); // 23:00 → 01:30 next day: calendar, not 24 h
assert.strictEqual(R.badge(at('2026-11-02T10:00:00Z'), mon), 'dnes o 5 h');
assert.strictEqual(R.badge(at('2026-11-02T05:20:00Z'), mon), 'o 20 min');
assert.ok(/NAŽIVO/.test(R.badge(mon - 1e3, mon)));
assert.strictEqual(R.dayDiff(mon, at('2026-11-02T22:59:00Z')), 0);
assert.strictEqual(R.dayDiff(mon, at('2026-11-02T23:01:00Z')), 1);
// recordings: „Záznam“ deep in the description
assert.ok(R.isRecording({ title: 'Futbal', sub: '', descr: 'Niké liga, 14. kolo: Slovan Bratislava - Spartak Trnava. Záznam zápasu.' }));
assert.ok(!R.isRecording({ title: 'Futbal', sub: 'Slovan - Trnava', descr: 'Priamy prenos' }));
// teams + competition
const pl = { title: 'PL', sub: 'Liverpool - Arsenal', descr: '10. kolo', kind: 'sport' };
assert.deepStrictEqual(R.teamsOf(pl, 'football'), ['Liverpool', 'Arsenal']);
assert.ok(/Premier League/.test(R.compOf(pl, ['Liverpool', 'Arsenal'])));
assert.strictEqual(R.qName('GNK Dinamo Záhreb'), 'Dinamo Zagreb');
// official fixture check: replay of a match played days before the slot
const ev = [R.tsdbEvent({ strHomeTeam: 'Liverpool', strAwayTeam: 'Arsenal', strTimestamp: '2026-11-01T16:30:00', strStatus: 'FT' })];
assert.strictEqual(R.classify(at('2026-11-03T21:00:00Z'), ['Liverpool', 'Arsenal'], ev).st, 'replay');
assert.strictEqual(R.classify(at('2026-11-01T16:15:00Z'), ['Liverpool', 'Arsenal'], ev).st, 'ok');
assert.strictEqual(R.classify(at('2026-11-01T16:15:00Z'), ['Liverpool', 'Arsenal'], []).st, 'none');
// merge: same match on two channels → one card with alt channel
const a = { k: 'a', title: 'PL', teams: ['Liverpool', 'Arsenal'], s: mon + 36e5, e: mon + 2 * 36e5, chName: 'Canal+ Sport', cat: 'football', prio: 50, score: 50, kw: [] };
const b = Object.assign({}, a, { k: 'b', chName: 'Voyo Sport', prio: 40, score: 40 });
const m = R.merge([a, b]);
assert.strictEqual(m.length, 1); assert.deepStrictEqual(m[0].alt, ['Voyo Sport']);
// variety: 10 football + 3 other sports + 3 non-sport → non-sport gets slots, ≤ 3 football out of 8
const L = [];
for (let i = 0; i < 10; i++) L.push({ k: 'f' + i, title: 'F' + i, teams: ['A' + i, 'B' + i], s: mon + i * 864e5 / 2, e: mon + i * 864e5 / 2 + 7e6, cat: 'football', kind: 'sport', prio: 90 - i, score: 90 - i, kw: [] });
for (const [i, c] of [[0, 'hockey'], [1, 'tennis'], [2, 'f1']]) L.push({ k: 'o' + i, title: c, s: mon + i * 864e5 + 3e6, e: mon + i * 864e5 + 1e7, cat: c, kind: 'sport', prio: 60 - i, score: 60 - i, kw: [] });
for (let i = 0; i < 3; i++) L.push({ k: 'n' + i, title: 'Show ' + i, s: mon + i * 864e5, e: mon + i * 864e5 + 7e6, cat: 'show' + i, kind: 'show', prio: 40 - i, score: 40 - i, kw: [] });
const sel = R.select(L, 8);
assert.ok(sel.filter((x) => x.cat === 'football').length <= 3, 'football capped');
assert.ok(sel.some((x) => x.kind === 'show'), 'non-sport included');
console.log('evrank ok');
assert.ok(R.isRecording({ title: 'Formule 1 - Velká cena Mexika 2026 (kvalifikace)', sub: '', s: Date.parse('2026-11-03T13:30:00Z') }), 'weekday GP = re-run');
assert.ok(!R.isRecording({ title: 'Formule 1 - Velká cena Sao Paula 2026 (kvalifikace)', sub: '', s: Date.parse('2026-11-07T17:50:00Z') }), 'Saturday GP live');
assert.ok(R.isRecording({ title: 'Olympijské hry mládeže', sub: 'Denní souhrn', s: Date.parse('2026-11-05T10:00:00Z') }));
console.log('evrank recordings ok');

// first airing / series / club bonus
{
  const assert = require('assert'); const RK = require('../evrank');
  const H = 3600e3, t0 = Date.parse('2026-11-05T18:20:00Z');
  const a = { title: 'Taliansko - Slovensko', teams: ['Taliansko', 'Slovensko'], s: t0 }, b = Object.assign({}, a, { s: t0 + 41 * H }), c = Object.assign({}, a, { s: t0 + 10 * 60e3 });
  const r = RK.firstAirings([b, a, c]); assert.ok(r.includes(a) && r.includes(c) && !r.includes(b));
  assert.strictEqual(RK.stemKey({ title: 'Formule 1 - Velká cena Sao Paula 2026 (kvalifikace)' }), RK.stemKey({ title: 'Formule 1 - Velká cena Sao Paula 2026 (2. trénink)' }));
  assert.ok(RK.priority({ title: 'F1 (2. trénink)', score: 90, s: t0 }, t0) < RK.priority({ title: 'F1 (kvalifikace)', score: 90, s: t0 }, t0));
  assert.strictEqual(RK.clubBonus({ teams: ['LASK Linz', 'ŠK Slovan Bratislava'], comp: 'Liga mistrů UEFA' }), 24);
  const night = Date.parse('2026-11-05T01:35:00Z'); // 02:35 Bratislava
  assert.ok(RK.priority({ title: 'x', score: 80, s: night }, night - H) < RK.priority({ title: 'x', score: 80, s: night + 18 * H }, night - H));
  console.log('evrank ranking ok');
}

// card descriptions
{
  const assert = require('assert'); const RK = require('../evrank');
  const ctx = { rivals: new Set(['Pražské derby (S–S)']), tables: [{ league: 'Chance liga', rows: [{ name: 'Slavia Prague', rank: 1, pts: 31, form: 'WDDWW' }, { name: 'Sparta Prague', rank: 4, pts: 23, form: 'DWDWW' }] }] };
  const x = { teams: ['SK Slavia Praha', 'AC Sparta Praha'], comp: 'Chance liga', official: 'ok', round: '11', venue: 'Fortuna Arena', big: ['Pražské derby (S–S) +45'] };
  const f = RK.matchFacts(x, ctx); assert.strictEqual(f.ph.rank, 1); assert.strictEqual(f.pa.rank, 4); assert.strictEqual(f.rival, 'Pražské derby');
  const d = [0, 1, 2, 3].map((v) => RK.matchDesc(f, v)); assert.strictEqual(new Set(d).size, 4); assert.ok(d.every((z) => /Slavia/.test(z) && /11/.test(z)));
  assert.ok(!RK.okTeaser('Sledujte zápas európskej súťaže.', ['Zápas: A – B'], ['Sunderland', 'Dinamo']));
  assert.ok(!RK.okTeaser('Sunderland hostí Dinamo, ktoré prehralo 5 zápasov v rade.', ['Zápas: Sunderland – Dinamo'], ['Sunderland', 'Dinamo']));
  assert.ok(RK.okTeaser('Sunderland vyzve chorvátske Dinamo v 4. kole Európskej ligy.', ['Zápas: Sunderland – Dinamo. Kolo: 4'], ['Sunderland AFC', 'GNK Dinamo Záhreb']));
  assert.strictEqual(RK.cleanEpg('Záznam. Veľké finále speváckej šou prináša súboj dvoch finalistov. Moderuje: X Y', 'SuperStar'), 'Veľké finále speváckej šou prináša súboj dvoch finalistov.');
  console.log('evrank descriptions ok');
}

// round 2: Slovak names, strict teaser check, filler penalty, never-empty templates
{
  const assert = require('assert'); const RK = require('../evrank');
  assert.strictEqual(RK.sk('Liga mistrů UEFA'), 'Liga majstrov UEFA');
  assert.strictEqual(RK.sk('Evropská liga'), 'Európska liga');
  assert.strictEqual(RK.sk('MS v ledním hokeji žen 2026'), 'MS v ľadovom hokeji žien 2026');
  assert.ok(RK.isCzech('Atletika - rozjížďky žen') && RK.isCzech('Utkání Ligy mistrů') && !RK.isCzech('Zápas Ligy majstrov medzi Slovanom a LASK-om.'));
  assert.ok(!RK.okTeaser('Hannover hostí OKTAGON 97, kde sa v hlavnom zápase stretávaj Severino a Holzer.', ['OKTAGON 97 Severino Holzer Hannover'], null));
  assert.ok(!RK.okTeaser('Tímový šport, ktorého začiatky siahajú do storočia na škótskych jazerách.', ['Curling vznikol v 16. storočí v Škótsku.'], null));
  assert.ok(RK.okTeaser('Tímový šport, ktorého začiatky siahajú do 16. storočia na škótskych jazerách.', ['Curling vznikol v 16. storočí v Škótsku.'], null));
  assert.ok(!RK.okTeaser('V Lize mistrů se utkají LASK a Slovan.', ['Zápas'], ['LASK Linz']));
  const now = Date.parse('2026-11-05T10:00:00Z');
  assert.strictEqual(RK.filler({ title: 'Curling', sub: 'Skupina A' }), -30);
  assert.strictEqual(RK.filler({ title: 'Hokej', sub: 'MS 2026: finále' }), 0);
  assert.strictEqual(RK.filler({ title: 'Futbalový magazín' }), -30);
  assert.ok(RK.priority({ title: 'Curling', score: 70, s: now }, now) < RK.priority({ title: 'Hokej', sub: 'Slovensko - Fínsko', teams: ['Slovensko', 'Fínsko'], score: 70, s: now }, now));
  const X = [{ title: 'Formule 1 - Velká cena Sao Paula 2026 (kvalifikace)', cat: 'f1' }, { title: 'SuperStar', cat: 'show', kind: 'show' }, { title: 'Pelíšky', kind: 'film' },
    { title: 'Koncert: Elán', kind: 'music' }, { title: 'OKTAGON 97: Severino vs. Holzer', cat: 'mma' }, { title: 'Turnaj WTA Finals', cat: 'tennis' }, { title: 'Curling', kind: 'sport', cat: 'stadium' }, { title: 'Dokument' }];
  for (const x of X) for (const v of [0, 1, 2]) { const d = RK.catDesc(Object.assign({ chName: 'JOJ' }, x), v); assert.ok(d.length > 10 && /\.$/.test(d) && !RK.isCzech(d), d); }
  assert.ok(/Interlagos/.test(RK.catDesc(X[0])) && /kvalifikácia/.test(RK.catDesc(X[0])) && /Idol/.test(RK.catDesc(X[1])));
  console.log('evrank round2 ok');
}

// round 3: SK = CZ teams, SK/CZ players abroad, elite strength, ≥ 40 % non-sport, youth heats below prime-time films, reason chips
{
  const assert = require('assert'); const RK = require('../evrank');
  const now = Date.parse('2026-11-05T10:00:00Z'), ev = Date.parse('2026-11-05T19:00:00Z');
  const sk = RK.clubBonus({ teams: ['Slovan Bratislava', 'Žilina'], cat: 'football' }), cz = RK.clubBonus({ teams: ['Sparta Praha', 'Baník Ostrava'], cat: 'football' });
  assert.strictEqual(sk, cz); assert.ok(sk > 0);
  assert.strictEqual(RK.clubBonus({ teams: ['Česko', 'Lotyšsko'], cat: 'hockey' }), RK.clubBonus({ teams: ['Slovensko', 'Lotyšsko'], cat: 'hockey' }));
  // players abroad: below SK/CZ teams, above a plain match; the card names the player
  const nhl = { title: 'NHL', teams: ['Boston Bruins', 'Buffalo Sabres'], cat: 'hockey', comp: 'NHL', score: 70, s: ev, why: [] };
  const plain = { title: 'NHL', teams: ['Buffalo Sabres', 'Ottawa Senators'], cat: 'hockey', comp: 'NHL', score: 70, s: ev, why: [] };
  const czm = { title: 'Extraliga', teams: ['Sparta Praha', 'Kometa Brno'], cat: 'hockey', score: 70, s: ev, why: [] };
  assert.ok(RK.priority(czm, now) > RK.priority(nhl, now) && RK.priority(nhl, now) > RK.priority(plain, now));
  assert.deepStrictEqual(RK.legion(nhl).map((o) => o.who), ['David Pastrňák', 'Pavel Zacha']);
  assert.strictEqual(RK.legion({ teams: ['Boston Celtics', 'Miami Heat'], cat: 'basketball' }).length, 0, 'Celtics are not the Bruins');
  assert.ok(/Pastrňák/.test(RK.matchDesc(RK.matchFacts(nhl, {}), 0)));
  const ten = { title: 'Tenis: ATP Paríž', sub: 'Menšík – Zverev', cat: 'tennis', kind: 'sport', score: 60, s: ev, why: [] };
  assert.ok(RK.clubBonus(ten) > 0 && /Menšík/.test(RK.catDesc(ten, 0)));
  // strength: elite clash = šláger, high even without SK/CZ; plain cup tie without any link is pushed down
  const cl = { title: 'Liga majstrov', teams: ['Real Madrid', 'Bayern Mníchov'], cat: 'football', comp: 'Liga majstrov UEFA', score: 70, s: ev, why: [] };
  const sun = { title: 'Európska liga', teams: ['Sunderland AFC', 'GNK Dinamo Záhreb'], cat: 'football', comp: 'Európska liga UEFA', score: 70, s: ev, why: [] };
  assert.ok(RK.strength(cl).slager && !RK.strength(sun).slager && RK.nobody(sun) && !RK.nobody(cl));
  assert.ok(RK.priority(cl, now) >= RK.priority(czm, now) - 5 && RK.priority(sun, now) < RK.priority(nhl, now) && RK.priority(sun, now) < RK.priority(czm, now) - 20);
  assert.ok(RK.priority(Object.assign({}, cl, { sub: 'finále' }), now) > RK.priority(cl, now), 'final > league phase');
  assert.ok(!RK.strength({ teams: ['Inter Miami', 'LA Galaxy'], cat: 'football' }).tiers.some((t) => t));
  // non-sport quality + youth heats penalty
  assert.strictEqual(RK.chTier('Markíza FHD'), 2); assert.strictEqual(RK.chTier('JOJ Cinema FHD'), 1); assert.strictEqual(RK.chTier('Polsat PL'), 0);
  assert.ok(RK.tmdbPts({ pop: 80, vote: 7.8, n: 5000 }) > RK.tmdbPts({ pop: 3, vote: 5.1, n: 150 }));
  assert.strictEqual(RK.tmdbQuery('Rýchlo a zbesilo 9 (r. 2021)'), 'Rýchlo a zbesilo 9');
  assert.ok(RK.tmdbMatch('Rýchlo a zbesilo 9', { title: 'Rýchlo a zbesilo 9', original_title: 'F9' }) && !RK.tmdbMatch('Farma', { name: 'Farmář hledá ženu' }));
  const yoh = { title: 'Olympijské hry mládeže', sub: 'Atletika – rozjazdy', cat: 'athletics', kind: 'sport', score: 75, s: ev, why: [] };
  const film = { title: 'Rýchlo a zbesilo 9', kind: 'film', cat: 'film', chName: 'Markíza', score: 55, s: ev, why: [], tmdb: { pop: 60, vote: 7.2, n: 9000 } };
  const show = { title: 'StarDance XIV', kind: 'show', cat: 'show', chName: 'ČT1 FHD', score: 52, s: ev, why: [] };
  assert.ok(RK.priority(yoh, now) < RK.priority(film, now) && RK.priority(yoh, now) < RK.priority(show, now), 'youth heats below a prime-time film and show');
  assert.ok(RK.SEASON.test('ČESKO SLOVENSKO MÁ TALENT 7. série, 1. epizoda') && !RK.SEASON.test('Ulice 4512'));
  // reason chips
  assert.strictEqual(RK.reason(cl), '🔥 Šláger: Real vs. Bayern');
  assert.strictEqual(RK.reason({ teams: ['LASK Linz', 'ŠK Slovan Bratislava'], cat: 'football' }), '🇸🇰 Hrá ŠK Slovan Bratislava');
  assert.strictEqual(RK.reason({ teams: ['SSC Neapol', 'AS Rím'], cat: 'football' }), '🇸🇰 Hrá Lobotka');
  assert.strictEqual(RK.reason({ teams: ['Česko', 'Izrael'], cat: 'football' }), '🇨🇿 Hrá Česko');
  assert.strictEqual(RK.reason({ title: 'Formula 1 - Veľká cena São Paula (kvalifikácia)', cat: 'f1' }), '🏎️ Kvalifikácia F1');
  assert.strictEqual(RK.reason({ title: 'Kevin Hart: Tvrdý oriešok 2', kind: 'film', fl: 'p' }), '🎬 Filmová premiéra');
  assert.strictEqual(RK.reason({ title: 'Tenis', sub: 'finále', cat: 'tennis', kind: 'sport' }), '🏆 Finále');
  for (const x of [sun, yoh, film, show, plain]) assert.ok(RK.reason(x).length > 3);
  // select: 8 cards → ≤ 5 sport (60 %), ≥ 3 non-sport even when sport has far higher priority; spares keep the balance
  const mon = Date.parse('2026-11-02T08:00:00Z'), L = [], cats = ['football', 'hockey', 'tennis', 'f1', 'basketball', 'mma', 'athletics'];
  for (let i = 0; i < 14; i++) L.push({ k: 's' + i, title: 'S' + i, teams: ['A' + i, 'B' + i], s: mon + (i % 7) * 864e5, cat: cats[i % 7], kind: 'sport', prio: 120 - i });
  for (let i = 0; i < 5; i++) L.push({ k: 'n' + i, title: 'Film ' + i, s: mon + i * 864e5 + 3e6, cat: i % 2 ? 'film' : 'show', kind: i % 2 ? 'film' : 'show', prio: 50 - i });
  const sel = RK.select(L, 8, { spare: 2 }), main = sel.slice(0, 8);
  assert.strictEqual(sel.length, 10);
  assert.ok(main.filter((x) => !RK.isSport(x)).length >= 3, 'min 3 of 8 non-sport');
  assert.ok(main.filter(RK.isSport).length <= 5, 'sport ≤ 60 %');
  assert.ok(sel.slice(8).some((x) => !RK.isSport(x)) && sel.slice(8).some(RK.isSport), 'one spare of each');
  const L2 = L.filter(RK.isSport).concat(L.find((x) => !RK.isSport(x)));
  assert.strictEqual(RK.select(L2, 8).length, 8, 'sport fills the gaps when non-sport runs out');
  // 10 cards (new default/max): ≥ 4 non-sport, ≤ 6 sport
  const sel10 = RK.select(L, 10, { spare: 2 }), m10 = sel10.slice(0, 10);
  assert.strictEqual(sel10.length, 12);
  assert.ok(m10.filter((x) => !RK.isSport(x)).length >= 4 && m10.filter(RK.isSport).length <= 6, '10 → 4 non-sport / 6 sport');
  assert.strictEqual(RK.reason({ teams: ['SK Slavia Praha', 'AC Sparta Praha'], cat: 'football', big: ['pražské derby +20'] }), '🔥 Pražské derby');
  assert.notStrictEqual(RK.reason({ title: 'Noc v archíve', kind: 'film', cat: 'show', fl: 'p' }), '🎬 Filmová premiéra', 'a TV special is not a film');
  assert.strictEqual(RK.sk('7. série, 1. epizoda'), '7. séria, 1. epizóda');
  // women's derby (ČT „FORTUNA LYGA“): chip says „žien“, comp in Slovak, no men's elite tier, ranked lower
  const wd = { title: 'FORTUNA LYGA 2026/2027', sub: 'SK Slavia Praha - AC Sparta Praha', teams: ['SK Slavia Praha', 'AC Sparta Praha'], cat: 'football', big: ['pražské derby +20'] };
  assert.ok(RK.women(wd) && !RK.women({ title: 'Futbal', sub: 'SK Slavia Praha - AC Sparta Praha' }));
  assert.strictEqual(RK.reason(wd), '🔥 Pražské derby žien');
  assert.strictEqual(RK.sk('FORTUNA LYGA 2026/2027'), '1. česká futbalová liga žien 2026/2027');
  assert.ok(RK.minorSport(wd) <= -8);
  // the chip depends on the final category: computed before catOf (cat empty) a TV special reads as a film
  const sp = { title: 'Noc v archíve', kind: 'film', fl: 'p' };
  assert.strictEqual(RK.reason(sp), '🎬 Filmová premiéra');
  sp.cat = 'show';
  assert.notStrictEqual(RK.reason(sp), '🎬 Filmová premiéra');
  console.log('evrank round3 ok');
}
