// hero carousel: slide count setting and variety of the picks
const assert = require('assert');
const H = require('../epghero');
let n = 0, bad = 0; const t = (name, fn) => { n++; try { fn(); console.log('  ✓', name); } catch (e) { bad++; console.log('  ✗', name, e.message); } };
t('evh_max: default 10, clamp 1–10', () => { assert.strictEqual(H.maxOf({}), 10); assert.strictEqual(H.maxOf({ evh_max: '12' }), 10); assert.strictEqual(H.maxOf({ evh_max: '40' }), 10); assert.strictEqual(H.maxOf({ evh_max: '0' }), 10); assert.strictEqual(H.maxOf({ evh_max: '-3' }), 1); assert.strictEqual(H.maxOf({ evh_max: 'x' }), 10); assert.strictEqual(H.maxOf({ evh_max: '8' }), 8); });
const D = Date.UTC(2026, 10, 2, 18), day = 86400e3;
const mk = (id, cat, d) => ({ id, cat, s: D + d * day });
t('diversify: ≤3 of one sport for 8 slides, order kept', () => {
  const l = [mk(1, 'football', 0), mk(2, 'football', 1), mk(3, 'football', 2), mk(4, 'football', 3), mk(5, 'football', 4), mk(6, 'hockey', 1), mk(7, 'tennis', 2), mk(8, 'mma', 4), mk(9, 'film', 5), mk(10, 'f1', 6), mk(11, 'series', 3)];
  const out = H.diversify(l, 8); assert.strictEqual(out.length, 8); assert.ok(out.filter((x) => x.cat === 'football').length <= 3); assert.deepStrictEqual(out.map((x) => x.id), [1, 2, 3, 6, 7, 8, 9, 10]);
});
t('diversify: ≤4 on one day for 8 slides', () => { const l = Array.from({ length: 10 }, (_, i) => mk(i + 1, ['football', 'hockey', 'tennis', 'mma', 'film'][i % 5], i < 7 ? 0 : i - 6)); const out = H.diversify(l, 8); const d0 = out.filter((x) => x.s === D).length; assert.strictEqual(out.length, 8); assert.ok(d0 <= 5, 'day0=' + d0); });
t('diversify: fills from skipped when variety is impossible', () => { const l = Array.from({ length: 6 }, (_, i) => mk(i + 1, 'football', 0)); assert.strictEqual(H.diversify(l, 5).length, 5); });
console.log(`${n} evhero tests, ${bad} failed`); if (bad) process.exit(1);
