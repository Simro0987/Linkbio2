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
console.log(`${n} epgext tests, ${bad} failed`); if (bad) process.exit(1);
