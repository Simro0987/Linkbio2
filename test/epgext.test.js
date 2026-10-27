// external schedules for channels without a TV guide: name matching, simulcast/duplicate rules, parsers on small fixtures
const assert = require('assert');
const X = require('../epgext');
let n = 0, bad = 0; const t = (name, fn) => { n++; try { fn(); console.log('  ✓', name); } catch (e) { bad++; console.log('  ✗', name, e.message); } };
const chans = [[1, 'Oneplay Sport 1 (9:00 - 23:59)'], [2, 'Oneplay Sport 2 FHD ( od:9:00-23-59)'], [3, 'Oneplay Sport 1 MD 2'], [4, 'Oneplay Sport 2 MD 2'], [5, 'Prima sport'], [6, 'Nike Liga 1'], [7, 'Nike Liga 2'], [8, 'Nova Sport 5 CZ'], [9, 'Nova Sport 5 SK']].map(([id, name]) => ({ id, name }));
const ix = X.chanIndex(chans, '');
t('nkey strips HD, notes, diacritics', () => { assert.strictEqual(X.nkey('Oneplay Sport 2 FHD ( od:9:00-23-59)'), 'oneplay sport 2'); assert.strictEqual(X.nkey('Niké Liga 1'), 'nike liga 1'); assert.strictEqual(X.nkey('Prima Sport HD'), 'prima sport'); });
t('exact numbered channel', () => { assert.strictEqual(X.resolve(ix, 'Oneplay Sport 2', 'cz').ch.id, 2); assert.strictEqual(X.resolve(ix, 'Prima Sport', 'cz').ch.id, 5); });
t('country variant preferred', () => { assert.strictEqual(X.resolve(ix, 'Nova Sport 5', 'sk').ch.id, 9); assert.strictEqual(X.resolve(ix, 'Nova Sport 5 HD', 'cz').ch.id, 8); });
t('MD without base number → candidates (predicted)', () => { const r = X.resolve(ix, 'Oneplay Sport MD2', 'cz'); assert.ok(!r.ch); assert.deepStrictEqual(r.cands.map((c) => c.id), [3, 4]); });
t('unknown name → null (logged as unmapped)', () => assert.strictEqual(X.resolve(ix, 'Golf Channel', 'cz'), null));
t('admin alias makes it exact', () => { const ia = X.chanIndex(chans, 'Oneplay Sport MD2 = Oneplay Sport 2 MD 2'); assert.strictEqual(X.resolve(ia, 'Oneplay Sport MD2', 'cz').ch.id, 4); });
t('sameMatch: same teams, pre-show start', () => { const s = Date.UTC(2026, 9, 27, 16); assert.ok(X.sameMatch({ s, title: 'ELH: Rytíři Kladno-HC Sparta Praha' }, { s: s + 70 * 60e3, title: 'Rytíři Kladno – HC Sparta Praha' })); assert.ok(!X.sameMatch({ s, title: 'Rytíři Kladno – HC Sparta Praha' }, { s, title: 'HC Škoda Plzeň – HC Olomouc' })); });
t('default durations', () => { assert.strictEqual(X.DUR.fotbal, 120); assert.strictEqual(X.DUR.hokej, 150); assert.strictEqual(X.DUR.mma, 300); });
t('durations per sport (basketbal 2h15, tenis 3h, F1 2h, NHL 2h45, volejbal 2h)', () => {
  assert.strictEqual(X.DUR.basketbal, 135); assert.strictEqual(X.DUR.tenis, 180); assert.strictEqual(X.DUR.motorsport, 120); assert.strictEqual(X.DUR.volejbal, 120);
  assert.strictEqual(X.durOf({ kind: 'hokej', comp: 'Hokej – NHL', title: 'Boston – Montreal' }), 165); assert.strictEqual(X.durOf({ kind: 'hokej', comp: 'Tipsport liga', title: 'a' }), 150);
});
t('kindOf: page wins; „CHL:“ on the mixed page = Chance Liga football; keywords per sport', () => {
  assert.strictEqual(X.kindOf('hokej', 'Champions Hockey League'), 'hokej');
  assert.strictEqual(X.kindOf('sport', 'CHL: Sparta Praha - Slavia Praha'), 'fotbal');
  assert.strictEqual(X.kindOf('sport', 'Volejbal: Extraliga mužov'), 'volejbal');
  assert.strictEqual(X.kindOf('sport', 'Florbal – Superliga'), 'florbal');
  assert.strictEqual(X.kindOf('sport', 'Házená: Chance extraliga'), 'hadzana');
  assert.strictEqual(X.kindOf('sport', 'Formule 1: VC Mexika'), 'motorsport');
  assert.strictEqual(X.kindOf('sport', 'Biatlon: Svetový pohár'), 'zimne');
  assert.strictEqual(X.kindOf('sport', 'Studio'), 'sport');
});
const L1 = X.TSDB.find((l) => l.id === 4932), NHL = X.TSDB.find((l) => l.id === 4380);
t('TheSportsDB event → item (UTC timestamp, platform JOJ Play, skip postponed/finished)', () => {
  const x = X.tsdbItem({ strHomeTeam: 'Slovan Bratislava', strAwayTeam: 'Dukla Trencin', strTimestamp: '2026-10-28T17:30:00' }, L1);
  assert.strictEqual(x.s, Date.UTC(2026, 9, 28, 17, 30)); assert.strictEqual(x.plat, 'joj'); assert.strictEqual(x.title, 'Slovan Bratislava – Dukla Trencin'); assert.strictEqual(x.cc, 'sk');
  assert.strictEqual(X.tsdbItem({ strHomeTeam: 'a', strAwayTeam: 'b', strTimestamp: '2026-10-28T17:30:00', strPostponed: 'yes' }, L1), null);
  assert.strictEqual(X.tsdbItem({ strHomeTeam: 'a', strAwayTeam: 'b', strTimestamp: '2026-10-28T17:30:00', strStatus: 'FT' }, L1), null);
});
t('NHL pick: only listed teams, ≤2 per day, best team first', () => {
  const mk = (h, a, hh) => X.tsdbItem({ strHomeTeam: h, strAwayTeam: a, strTimestamp: `2026-10-29T0${hh}:00:00` }, NHL);
  const out = X.tsdbPick([mk('Dallas Stars', 'Utah Mammoth', 0), mk('Calgary Flames', 'Seattle Kraken', 1), mk('St. Louis Blues', 'Montreal Canadiens', 0), mk('Carolina Hurricanes', 'Boston Bruins', 1)], NHL);
  assert.deepStrictEqual(out.map((x) => x.title), ['St. Louis Blues – Montreal Canadiens', 'Carolina Hurricanes – Boston Bruins']);
});
(async () => {
  // round walker: cached round 5 is finished → 6 has a future game → 7 starts after the window → stop; cache moves to 6
  const now = Date.UTC(2026, 9, 27, 12), day = 86400e3, iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  const R = { 5: [now - 3 * day], 6: [now + day, now + 2 * day], 7: [now + 9 * day] }, asked = [];
  const getJson = async (u) => { const r = +/[?&]r=(\d+)/.exec(u)[1]; asked.push(r); return { events: (R[r] || []).map((s, i) => ({ strHomeTeam: 'Home' + i, strAwayTeam: 'Away' + r, strTimestamp: iso(s) })) }; };
  const rounds = { 4932: 5 };
  const out = await X.tsdbLeague(L1, { now, getJson, rounds, pause: 0 });
  n++; try { assert.deepStrictEqual(asked, [5, 6, 7]); assert.strictEqual(out.length, 2); assert.strictEqual(rounds[4932], 6); console.log('  ✓ TheSportsDB round walker (skip finished, stop after window, cache current round)'); } catch (e) { bad++; console.log('  ✗ round walker', e.message); }
  console.log(`${n} epgext tests, ${bad} failed`); if (bad) process.exit(1);
})();
