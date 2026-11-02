'use strict';
// Affiliate tier bonuses: boundaries, inheritance, inactive referrals, only paid orders, device option, idempotency.
const assert = require('assert');
const A = require('../affiliate');
let n = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);
const T = A.DEF_TIERS;
const NOW = new Date('2026-06-15T12:00:00Z');
const future = new Date('2027-01-01T00:00:00Z'), past = new Date('2026-01-01T00:00:00Z');

t('tier boundaries 4/5/9/10/14/15/19/20 (12m package)', () => {
  const exp = { 4: 0, 5: 1, 9: 1, 10: 3, 14: 3, 15: 6, 19: 6, 20: 6 }; // 12m at 20 inherits +6 from ≥15 (12+12 removed)
  for (const [a, b] of Object.entries(exp)) assert.strictEqual(A.bonusFor(+a, 12, T), b, `active ${a}`);
  assert.strictEqual(A.tierFor(4, T), null);
  assert.strictEqual(A.tierFor(5, T).min, 5); assert.strictEqual(A.tierFor(9, T).min, 5);
  assert.strictEqual(A.tierFor(10, T).min, 10); assert.strictEqual(A.tierFor(14, T).min, 10);
  assert.strictEqual(A.tierFor(15, T).min, 15); assert.strictEqual(A.tierFor(19, T).min, 15);
  assert.strictEqual(A.tierFor(20, T).min, 20); assert.strictEqual(A.tierFor(500, T).min, 20);
  assert.strictEqual(A.nextTier(4, T).min, 5); assert.strictEqual(A.nextTier(19, T).min, 20); assert.strictEqual(A.nextTier(20, T), null);
});
t('defaults per package + inheritance upward', () => {
  // 3m: nothing below 20 (3+1 removed), 20→3 ; 6m: 5→1, 10→3, 15 inherits 3, 20→6 ; 12m: 1,3,6 and 20 inherits 6 (12+12 removed)
  assert.deepStrictEqual([4, 5, 10, 15, 19, 20].map((a) => A.bonusFor(a, 3, T)), [0, 0, 0, 0, 0, 3]);
  assert.deepStrictEqual([5, 10, 15, 20].map((a) => A.bonusFor(a, 6, T)), [1, 3, 3, 6]);
  assert.deepStrictEqual([5, 10, 15, 20, 50].map((a) => A.bonusFor(a, 12, T)), [1, 3, 6, 6, 6]);
  assert.strictEqual(A.deviceAllowed(20, T), true); assert.strictEqual(A.deviceAllowed(19, T), false);
  for (const m of [1, 7, 15]) for (const a of [0, 5, 10, 15, 20, 99]) assert.strictEqual(A.bonusFor(a, m, T), 0, `no bonus for ${m}m`);
  const mx = A.matrix(T);
  assert.deepStrictEqual(mx.rows.map((r) => r.bonus[3]), [0, 0, 0, 3]);
  assert.deepStrictEqual(mx.rows.map((r) => r.bonus[12]), [1, 3, 6, 6]);
});
t('stored settings migrate only when equal to the OLD defaults', () => {
  const mig = A.migrateTiers(JSON.stringify(A.OLD_DEF_TIERS));
  assert.ok(mig); assert.deepStrictEqual(A.settings({ aff_tiers: mig }).tiers, A.cleanTiers(A.DEF_TIERS));
  // key order / string numbers do not matter
  assert.ok(A.migrateTiers(JSON.stringify([{ min: '20', device: true, bonus: { 12: '12', 6: 6, 3: 3 } }, { min: 5, bonus: { 12: 1, 6: 1, 3: 1 } }, { min: 10, bonus: { 6: 3, 12: 3 } }, { min: 15, bonus: { 12: 6 } }])));
  // admin-edited table is left alone; already-new and empty too
  assert.strictEqual(A.migrateTiers(JSON.stringify([{ min: 5, bonus: { 3: 2, 6: 1, 12: 1 } }, { min: 10, bonus: { 6: 3, 12: 3 } }, { min: 15, bonus: { 12: 6 } }, { min: 20, bonus: { 3: 3, 6: 6, 12: 12 }, device: true }])), null);
  assert.strictEqual(A.migrateTiers(JSON.stringify(A.DEF_TIERS)), null);
  assert.strictEqual(A.migrateTiers(''), null); assert.strictEqual(A.migrateTiers('garbage'), null);
});
t('admin-edited tiers are validated and used', () => {
  const st = A.settings({ aff_tiers: JSON.stringify([{ min: 3, bonus: { 1: 1 } }, { min: 2, bonus: { 12: 2 } }]) });
  assert.deepStrictEqual(st.tiers.map((x) => x.min), [2, 3]);
  assert.strictEqual(A.bonusFor(3, 1, st.tiers), 1); assert.strictEqual(A.bonusFor(3, 12, st.tiers), 2);
  assert.strictEqual(A.cleanTiers([{ min: 5, bonus: {} }, { min: 5, bonus: {} }]), null);
  assert.strictEqual(A.cleanTiers([{ min: -1, bonus: {} }]), null);
  assert.strictEqual(A.cleanTiers([{ min: '1.5', bonus: {} }]), null);
  assert.strictEqual(A.cleanTiers([{ min: 0, bonus: {} }])[0].min, 0); // threshold 0 = every registered customer
  assert.strictEqual(A.settings({ aff_tiers: 'garbage' }).tiers.length, 4);
  assert.strictEqual(A.settings({ aff_on: '0' }).on, false);
});

function world(active, inactive = 0, opts = {}) {
  const s = A.memoryStore();
  s.addUser({ id: 1, username: 'ref', aff_choice: opts.choice || 'months' });
  let id = 2;
  for (let i = 0; i < active; i++) s.addUser({ id: id++, username: 'a' + i, referrer_id: 1, licence_until: future });
  for (let i = 0; i < inactive; i++) s.addUser({ id: id++, username: 'x' + i, referrer_id: 1, licence_until: past });
  return s;
}
const order = (o = {}) => ({ orderId: 'o' + Math.random().toString(36).slice(2), status: 'paid', acct: { id: 1 }, planMonths: 12, amountEur: 50, ...o });
const st = A.settings({});

t('inactive referrals are not counted', async () => {
  const s = world(4, 10);
  const r = await A.processPaidOrder(s, order(), st, NOW);
  assert.strictEqual(r.active, 4); assert.strictEqual(r.bonus, 0); assert.strictEqual(s.ledger.length, 0);
  // disabled / blocked / override-expired referrals do not count either
  const s2 = world(5); [...s2.users.values()][1].disabled = true;
  assert.strictEqual((await A.processPaidOrder(s2, order(), st, NOW)).bonus, 0);
});
t('bonus granted on paid order, added on top of package', async () => {
  const s = world(10);
  const r = await A.processPaidOrder(s, order({ planMonths: 6 }), st, NOW);
  assert.strictEqual(r.bonus, 3);
  assert.strictEqual(s.users.get(1).licence_until.toISOString().slice(0, 10), '2027-03-15'); // 6 + 3 months
  assert.strictEqual(s.ledger.length, 1); assert.strictEqual(s.ledger[0].bonus_months, 3); assert.strictEqual(s.ledger[0].tier_min, 10);
});
t('only paid orders count', async () => {
  const s = world(20);
  for (const status of ['pending', 'created', 'expired', 'failed', 'awaiting_payment']) {
    const r = await A.processPaidOrder(s, order({ status }), st, NOW); assert.strictEqual(r.skipped, 'not-paid');
  }
  assert.strictEqual(s.users.get(1).licence_until, null);
  assert.ok(A.isPaidOrder({ status: 'confirmed' }));
  assert.ok(A.isPaidOrder({ status: 'x', provider: 'crypto_direct', chainStatus: 'confirmed' }));
  assert.ok(!A.isPaidOrder({ status: 'paid_partial' }));
  assert.strictEqual((await A.processPaidOrder(s, order({ acct: null }), st, NOW)).skipped, 'not-paid');
});
t('idempotent per order', async () => {
  const s = world(5); const o = order({ planMonths: 6 });
  await A.processPaidOrder(s, o, st, NOW); const u1 = s.users.get(1).licence_until.getTime();
  assert.strictEqual((await A.processPaidOrder(s, o, st, NOW)).skipped, 'done');
  assert.strictEqual(s.users.get(1).licence_until.getTime(), u1); assert.strictEqual(s.ledger.length, 1);
});
t('device option at >=20 only', async () => {
  const s = world(20, 0, { choice: 'device' });
  const r = await A.processPaidOrder(s, order({ planMonths: 12 }), st, NOW);
  assert.strictEqual(r.device, true); assert.strictEqual(r.bonus, 0);
  assert.strictEqual(s.devices.length, 1); assert.strictEqual(s.ledger[0].kind, 'device');
  assert.strictEqual(s.users.get(1).licence_until.toISOString().slice(0, 10), '2027-06-15');
  const s2 = world(19, 0, { choice: 'device' });
  const r2 = await A.processPaidOrder(s2, order({ planMonths: 12 }), st, NOW);
  assert.strictEqual(r2.device, false); assert.strictEqual(r2.bonus, 6);
  assert.ok(A.deviceAllowed(20, T)); assert.ok(!A.deviceAllowed(19, T));
});
t('licence extends from current end when still active', async () => {
  const s = world(0); s.users.get(1).licence_until = new Date('2026-07-01T00:00:00Z');
  await A.processPaidOrder(s, order({ planMonths: 1 }), st, NOW);
  assert.strictEqual(s.users.get(1).licence_until.toISOString().slice(0, 10), '2026-08-01');
});
t('affiliate disabled → no bonus', async () => {
  const s = world(20); const r = await A.processPaidOrder(s, order(), A.settings({ aff_on: '0' }), NOW);
  assert.strictEqual(r.bonus, 0);
});

// ---- 2026-11 editor: explicit per-package values + per-package 2nd device ----
const PK = [1, 3, 6, 7, 12, 15];
t('materialize(defaults) = exactly the current effective table (prefill of the editor)', () => {
  const m = A.materialize(T, PK);
  assert.deepStrictEqual(m.map((r) => r.min), [5, 10, 15, 20]);
  assert.deepStrictEqual(m.map((r) => [r.bonus[3], r.bonus[6], r.bonus[12]]), [[0, 1, 1], [0, 3, 3], [0, 3, 6], [3, 6, 6]]);
  assert.deepStrictEqual(m.map((r) => Object.keys(r.devPk).map(Number)), [[], [], [], [3, 6, 12]]);
  // saving the prefilled editor unchanged gives identical rewards for every active count / package / choice
  const saved = A.cleanTiers(m);
  for (let a = 0; a <= 30; a++) for (const mo of PK) for (const ch of ['months', 'device']) assert.deepStrictEqual(A.rewardFor(a, mo, saved, ch), A.rewardFor(a, mo, T, ch), `a=${a} m=${mo} ${ch}`);
});
t('per-package device: with bonus → choice, without bonus → automatic, no inheritance', () => {
  const tiers = A.cleanTiers([{ min: 0, bonus: { 1: 0, 12: 1 } }, { min: 5, bonus: { 1: 0, 12: 2 }, devPk: { 1: true, 12: true } }, { min: 10, bonus: { 1: 0, 12: 4 }, devPk: {} }]);
  assert.deepStrictEqual(A.rewardFor(0, 12, tiers, 'device'), { bonus: 1, device: false, alt: false });
  assert.deepStrictEqual(A.rewardFor(6, 12, tiers, 'months'), { bonus: 2, device: false, alt: true });
  assert.deepStrictEqual(A.rewardFor(6, 12, tiers, 'device'), { bonus: 0, device: true, alt: 2 });
  assert.deepStrictEqual(A.rewardFor(6, 1, tiers, 'months'), { bonus: 0, device: true, alt: 0 }); // 0 months + device → automatic
  assert.strictEqual(A.deviceFor(12, 12, tiers), false); // higher tier without device flag does not inherit it
  assert.strictEqual(A.deviceAllowed(6, tiers), true); assert.strictEqual(A.deviceAllowed(12, tiers), false);
  const mx = A.matrix(tiers, [1, 12]);
  assert.deepStrictEqual(mx.rows.map((r) => [r.dev[1], r.dev[12], r.device]), [[false, false, false], [true, true, true], [false, false, false]]);
});
t('cleanTiers validates devPk and new packages are listed automatically', () => {
  assert.strictEqual(A.cleanTiers([{ min: 1, bonus: {}, devPk: { 0: true } }]), null);
  assert.strictEqual(A.cleanTiers([{ min: 1, bonus: { 2: 121 } }]), null);
  const c = A.cleanTiers([{ min: 1, bonus: { 24: 3 }, devPk: { 24: true, 6: false } }]);
  assert.deepStrictEqual(c[0].devPk, { 24: true }); assert.strictEqual(c[0].device, true);
  assert.ok(A.matrix(c, PK).packages.includes(24));
  assert.ok(A.materialize(T, [...PK, 24])[0].bonus[24] === 0);
});
t('ledger: automatic device at 0 bonus months', async () => {
  const tiers = A.cleanTiers([{ min: 0, bonus: { 1: 0 }, devPk: { 1: true } }]);
  const s = world(0); const r = await A.processPaidOrder(s, order({ planMonths: 1 }), { on: true, tiers }, NOW);
  assert.strictEqual(r.device, true); assert.strictEqual(r.bonus, 0);
  assert.strictEqual(s.ledger[0].kind, 'device'); assert.strictEqual(s.ledger[0].note, '2. zariadenie zadarmo');
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } }
  console.log(`affiliate: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
