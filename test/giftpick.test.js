'use strict';
const assert = require('assert');
const gp = require('../pay/src/giftPick');

function t(name, fn) { try { fn(); console.log('ok', name); } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } }

t('default threshold is 0.70', () => {
  gp._set({ threshold: 0.70, prices: {} });
  assert.strictEqual(gp.threshold(), 0.70);
});

t('equal face values prefer Azteco', () => {
  gp._set({ threshold: 0.70, prices: {} });
  const r = gp.pick(10);
  assert.ok(r.azteco && r.amazon, 'both options exist for 10€');
  assert.strictEqual(r.winner, 'azteco');
  assert.ok(['azteco-cheaper-or-equal', 'azteco-within-threshold'].includes(r.reason));
  assert.ok(!/poplat|fee/i.test(JSON.stringify(r.choice)));
});

t('50€ and 100€ also prefer Azteco at face value', () => {
  gp._set({ threshold: 0.70, prices: {} });
  assert.strictEqual(gp.pick(50).winner, 'azteco');
  assert.strictEqual(gp.pick(100).winner, 'azteco');
});

t('25€ uses Amazon 25 when Azteco would overshoot by more than threshold', () => {
  gp._set({ threshold: 0.70, prices: {} });
  const r = gp.pick(25);
  assert.ok(r.amazon, 'amazon 25 exists');
  // Azteco 10*3 = 30, overshoot 5€ and cost 30 vs 25 → Amazon
  assert.strictEqual(r.winner, 'amazon');
  assert.strictEqual(r.choice.family, 'amazon');
  assert.ok(r.choice.cards.some((c) => c.faceEur === 25));
});

t('45€ and 85€ pick Amazon exact face when Azteco is more than 0.70 dearer', () => {
  gp._set({ threshold: 0.70, prices: {} });
  assert.strictEqual(gp.pick(45).winner, 'amazon');
  assert.strictEqual(gp.pick(85).winner, 'amazon');
});

t('prefer Azteco when it costs at most threshold more (real admin price)', () => {
  gp._set({ threshold: 0.70, prices: { azteco_ln_10: 10.60, amazon_de_10: 10.00 } });
  const r = gp.pick(10);
  assert.strictEqual(r.winner, 'azteco');
  assert.strictEqual(r.reason, 'azteco-within-threshold');
  gp._set({ threshold: 0.70, prices: { azteco_ln_10: 10.90, amazon_de_10: 10.00 } });
  const r2 = gp.pick(10);
  assert.strictEqual(r2.winner, 'amazon');
  assert.strictEqual(r2.reason, 'amazon-cheaper');
});

t('does not invent prices: unused products stay at face value', () => {
  gp._set({ threshold: 0.70, prices: {} });
  const r = gp.pick(10);
  assert.strictEqual(r.azteco.cost, 10);
  assert.strictEqual(r.amazon.cost, 10);
});

t('collapse hides individual Azteco/Amazon and adds gift_smart', () => {
  const res = gp.collapse({
    groups: {
      g2a_amazon: { providers: [{ id: 'g2a_amazon_de_10', group: 'g2a_amazon' }], soon: [] },
      g2a_azteco: { providers: [{ id: 'g2a_azteco_ln_10', group: 'g2a_azteco' }], soon: [] },
      vouchers: { providers: [{ id: 'gc_azteco', group: 'vouchers' }, { id: 'gc_steam', group: 'vouchers' }], soon: [] },
    },
    providers: [{ id: 'g2a_amazon_de_10' }, { id: 'gc_azteco' }, { id: 'gc_steam' }],
  });
  assert.ok(!res.groups.g2a_amazon);
  assert.ok(!res.groups.g2a_azteco);
  assert.strictEqual(res.groups.vouchers.providers[0].id, 'gift_smart');
  assert.ok(res.groups.vouchers.providers.some((p) => p.id === 'gc_steam'));
  assert.ok(!res.groups.vouchers.providers.some((p) => p.id === 'gc_azteco'));
  assert.ok(!/poplat|fee/i.test(JSON.stringify(res.groups.vouchers.providers[0])));
});

t('bestCombo combines cards', () => {
  const denoms = [
    { id: 'a10', amountEur: 10, cost: 10, type: 'azteco_ln' },
    { id: 'a50', amountEur: 50, cost: 50, type: 'azteco_ln' },
  ];
  const c = gp.bestCombo(denoms, 20);
  assert.ok(c);
  assert.strictEqual(c.coverEur, 20);
  assert.strictEqual(c.cards.length, 2);
});
