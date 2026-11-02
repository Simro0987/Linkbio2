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
  assert.strictEqual(RK.clubBonus({ teams: ['LASK Linz', 'ŠK Slovan Bratislava'], comp: 'Liga mistrů UEFA' }), 20);
  const night = Date.parse('2026-11-05T01:35:00Z'); // 02:35 Bratislava
  assert.ok(RK.priority({ title: 'x', score: 80, s: night }, night - H) < RK.priority({ title: 'x', score: 80, s: night + 18 * H }, night - H));
  console.log('evrank ranking ok');
}
