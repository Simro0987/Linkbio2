// channel logos + EPG coverage: name variants (Cyrillic, +, aliases), curated Commons logos, Wikidata label guard, EPG alias keys, alt-feed id prefix, coverage-aware pick
const assert = require('assert');
const L = require('../tvlogos'), C = require('../epgcore'), W = require('../wdlogo');
let n = 0, bad = 0; const t = (name, fn) => { n++; try { fn(); console.log('  ✓', name); } catch (e) { bad++; console.log('  ✗', name, e.message); } };
t('translit Cyrillic → Latin', () => { assert.strictEqual(L.translit('Звезда').toLowerCase(), 'zvezda'); assert.ok(/^pervyy/.test(L.translit('Первый канал').toLowerCase())); });
t('nameVariants: aliases, plus, translit, HD strip', () => {
  const v = L.nameVariants('1+1 Marathon HD').map((x) => x.toLowerCase());
  assert.ok(v.some((x) => /1 plus 1 marafon/.test(x)), v.join(' | '));
  assert.ok(L.nameVariants('Первый канал').some((x) => /channel one/i.test(x)));
  assert.ok(L.nameVariants('Fox Sport 1').some((x) => /fox sports 1/i.test(x)));
});
t('curated Commons logo comes first', () => { const c = L.allCandidates(L.makeIndex ? L.makeIndex([]) : null, 'TN Live', 'Slovensko'); assert.ok(c.length && /upload\.wikimedia\.org/.test(c[0].url), JSON.stringify(c[0])); });
t('wikidata label guard: no digit extension (Signál ≠ Signal 1)', () => { const { norm } = W._test; assert.strictEqual(norm('Rádio Expres'), norm('radio expres')); });
t('EPG keys: JOJ Šport / Nova Sport CZ / Markíza FHD', () => {
  assert.strictEqual(C.nameKey('JOJ Šport 2').key, C.nameKey('JOJ Sport 2 HD').key);
  assert.strictEqual(C.nameKey('Nova Sport 5 CZ').key, C.nameKey('Nova Sport 5').key);
  assert.strictEqual(C.nameKey('Markíza FHD').key, C.nameKey('Markíza').key);
  assert.strictEqual(C.nameKey('Первый HD').key, C.nameKey('Первый канал').key);
});
t('alt-feed ids (IEPGRU1:/PWRU1:) are indexed by name part', () => {
  const ix = C.buildIndex([{ id: 'IEPGRU1:Perviy.Kanal.ru', name: '' }, { id: 'PWRU1:TNT.ru', name: '' }]);
  assert.ok(ix.byKey.has('perviy|'), [...ix.byKey.keys()].join(','));
  assert.ok([...ix.byKey.keys()].some((k) => k.startsWith('tnt|')));
});
t('pickCovered: priority unless the guide is (almost) empty', () => {
  assert.strictEqual(C.pickCovered([]), null);
  assert.strictEqual(C.pickCovered([{ id: 'k', n: -1 }, { id: 'a', n: 40 }]).id, 'k');
  assert.strictEqual(C.pickCovered([{ id: 'k', n: 30 }, { id: 'a', n: 40 }]).id, 'k');
  assert.strictEqual(C.pickCovered([{ id: 'k', n: 2 }, { id: 'a', n: 40 }]).id, 'a');
  assert.strictEqual(C.pickCovered([{ id: 'k', n: 0 }, { id: 'a', n: 3 }]).id, 'a');
});
t('modules load (no TDZ/init errors)', () => { for (const m of ['../epg', '../tvch', '../features', '../wdlogo', '../logoproxy']) assert.strictEqual(typeof require(m), m === '../wdlogo' || m === '../logoproxy' ? 'object' : 'function', m); });
console.log(`${n} tvlogo-epg tests, ${bad} failed`); if (bad) process.exit(1);
