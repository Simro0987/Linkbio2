'use strict';
const assert = require('assert');
const http = require('http');
const gp = require('../pay/src/giftPick');

function t(name, fn) { try { fn(); console.log('ok', name); } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } }
async function ta(name, fn) { try { await fn(); console.log('ok', name); } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } }

t('default threshold is 0.70', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  assert.strictEqual(gp.threshold(), 0.70);
});

t('unknown fees default to 0 (nothing invented)', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: {} });
  assert.deepStrictEqual(gp.feesOf('azteco'), { feePct: 0, feeFix: 0 });
  assert.deepStrictEqual(gp.feesOf('amazon'), { feePct: 0, feeFix: 0 });
  assert.strictEqual(gp.withFee(10, 'azteco'), 10);
});

t('equal face values prefer Azteco', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  const r = gp.pick(10);
  assert.ok(r.azteco && r.amazon, 'both options exist for 10€');
  assert.strictEqual(r.winner, 'azteco');
  assert.ok(['azteco-cheaper-or-equal', 'azteco-within-threshold'].includes(r.reason));
  assert.ok(!/poplat|fee/i.test(JSON.stringify(r.choice)));
});

t('50€ and 100€ also prefer Azteco at face value', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  assert.strictEqual(gp.pick(50).winner, 'azteco');
  assert.strictEqual(gp.pick(100).winner, 'azteco');
});

t('25€ uses Amazon 25 when Azteco would overshoot by more than threshold', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  const r = gp.pick(25);
  assert.ok(r.amazon, 'amazon 25 exists');
  // Azteco 10*3 = 30, overshoot 5€ and cost 30 vs 25 → Amazon
  assert.strictEqual(r.winner, 'amazon');
  assert.strictEqual(r.choice.family, 'amazon');
  assert.ok(r.choice.cards.some((c) => c.faceEur === 25));
});

t('45€ and 85€ pick Amazon exact face when Azteco is more than 0.70 dearer', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  assert.strictEqual(gp.pick(45).winner, 'amazon');
  assert.strictEqual(gp.pick(85).winner, 'amazon');
});

t('prefer Azteco when it costs at most threshold more (real admin price)', () => {
  gp._set({ threshold: 0.70, prices: { azteco_ln_10: 10.60, amazon_de_10: 10.00 }, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  const r = gp.pick(10);
  assert.strictEqual(r.winner, 'azteco');
  assert.strictEqual(r.reason, 'azteco-within-threshold');
  gp._set({ threshold: 0.70, prices: { azteco_ln_10: 10.90, amazon_de_10: 10.00 }, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  const r2 = gp.pick(10);
  assert.strictEqual(r2.winner, 'amazon');
  assert.strictEqual(r2.reason, 'amazon-cheaper');
});

t('comparison uses total with fees, not bare purchase price', () => {
  // Bare prices: Azteco 10.00 vs Amazon 10.50 → Azteco cheaper without fees.
  // With Azteco +1.00 fix fee → total 11.00 vs Amazon 10.50 → gap 0.50 ≤ 0.70 → still Azteco.
  gp._set({
    threshold: 0.70,
    prices: { azteco_ln_10: 10.00, amazon_de_10: 10.50 },
    fees: { azteco: { feePct: 0, feeFix: 1.00 }, amazon: { feePct: 0, feeFix: 0 } },
  });
  const r = gp.pick(10);
  assert.strictEqual(r.azteco.base, 10);
  assert.strictEqual(r.azteco.cost, 11);
  assert.strictEqual(r.amazon.cost, 10.5);
  assert.strictEqual(r.winner, 'azteco');
  assert.strictEqual(r.reason, 'azteco-within-threshold');

  // Raise Azteco fee so total 11.30 vs 10.50 → gap 0.80 > 0.70 → Amazon
  gp._set({
    threshold: 0.70,
    prices: { azteco_ln_10: 10.00, amazon_de_10: 10.50 },
    fees: { azteco: { feePct: 0, feeFix: 1.30 }, amazon: { feePct: 0, feeFix: 0 } },
  });
  const r2 = gp.pick(10);
  assert.strictEqual(r2.winner, 'amazon');
  assert.strictEqual(r2.reason, 'amazon-cheaper');
});

t('percent fee is applied to base before comparison', () => {
  gp._set({
    threshold: 0.70,
    prices: { azteco_ln_10: 10.00, amazon_de_10: 10.00 },
    fees: { azteco: { feePct: 5, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } },
  });
  const r = gp.pick(10);
  assert.strictEqual(r.azteco.cost, 10.5);
  assert.strictEqual(r.amazon.cost, 10);
  assert.strictEqual(r.winner, 'azteco'); // 0.50 ≤ 0.70
});

t('does not invent prices: unused products stay at face value', () => {
  gp._set({ threshold: 0.70, prices: {}, fees: { azteco: { feePct: 0, feeFix: 0 }, amazon: { feePct: 0, feeFix: 0 } } });
  const r = gp.pick(10);
  assert.strictEqual(r.azteco.cost, 10);
  assert.strictEqual(r.amazon.cost, 10);
});

t('adminView exposes base and total; choice has no fee field names', () => {
  gp._set({
    threshold: 0.70,
    prices: { azteco_ln_10: 10.20 },
    fees: { azteco: { feePct: 10, feeFix: 0.5 }, amazon: { feePct: 0, feeFix: 0 } },
  });
  const v = gp.adminView();
  assert.strictEqual(v.fees.azteco.feePct, 10);
  assert.strictEqual(v.fees.azteco.feeFix, 0.5);
  const row = v.rows.find((r) => r.id === 'azteco_ln_10' || r.id.includes('azteco') && r.faceEur === 10);
  assert.ok(row);
  assert.strictEqual(row.baseEur, 10.2);
  assert.strictEqual(row.totalEur, 11.72); // 10.20 * 1.10 + 0.50
  const choice = gp.pick(10).choice;
  assert.ok(!/poplat|fee/i.test(JSON.stringify(choice)));
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
    { id: 'a10', amountEur: 10, cost: 10, base: 10, type: 'azteco_ln' },
    { id: 'a50', amountEur: 50, cost: 50, base: 50, type: 'azteco_ln' },
  ];
  const c = gp.bestCombo(denoms, 20);
  assert.ok(c);
  assert.strictEqual(c.coverEur, 20);
  assert.strictEqual(c.cards.length, 2);
});

(async () => {
  await ta('public /api/gift-pick never leaks costs or fees', async () => {
    gp._set({
      threshold: 0.70,
      prices: { azteco_ln_10: 10.60, amazon_de_10: 10.00 },
      fees: { azteco: { feePct: 8, feeFix: 0.25 }, amazon: { feePct: 3, feeFix: 0 } },
    });
    const app = { get(path, handler) { this._get = { path, handler }; }, post() {} };
    // payMethods.serveSigned is required by mount — stub a minimal Express-like app that only needs GET
    const realServe = require('../pay/src/payMethods').serveSigned;
    require('../pay/src/payMethods').serveSigned = (a) => a; // no-op bridge
    try {
      gp.mount(app);
    } finally {
      require('../pay/src/payMethods').serveSigned = realServe;
    }
    assert.strictEqual(app._get.path, '/api/gift-pick');
    let body = null, status = 200;
    const req = { query: { amount: '10' } };
    const res = {
      set() { return this; },
      status(c) { status = c; return this; },
      json(o) { body = o; return this; },
    };
    app._get.handler(req, res);
    assert.strictEqual(status, 200);
    assert.ok(body && body.ok);
    assert.strictEqual(body.coverEur, 10);
    assert.ok(body.cards && body.cards[0].faceEur === 10);
    const s = JSON.stringify(body);
    assert.ok(!/poplat|fee|cost|base|threshold|totalEur|priceEur/i.test(s), 'leaked: ' + s);
  });

  // flush async failures into exit code
  if (process.exitCode) process.exit(process.exitCode);
})().catch((e) => { console.error(e); process.exit(1); });
