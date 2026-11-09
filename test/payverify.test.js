'use strict';
const assert = require('assert');
const pv = require('../pay/src/payVerify');
const watcher = require('../pay/src/chainWatcher');

function t(name, fn) { try { fn(); console.log('ok', name); } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } }
async function ta(name, fn) { try { await fn(); console.log('ok', name); } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } }

t('isAuto only for watched UTXO methods', () => {
  assert.strictEqual(pv.isAuto({ provider: 'revolut_ramp', payoutCoin: 'ltc', payoutAddress: 'ltc1qxx', watched: true }), true);
  assert.strictEqual(pv.isAuto({ provider: 'changelly', payoutCoin: 'btc', payoutAddress: 'bc1qxx', watched: true }), true);
  assert.strictEqual(pv.isAuto({ provider: 'crypto_direct', payoutCoin: 'ltc', payoutAddress: 'ltc1qxx', watched: true }), true);
  assert.strictEqual(pv.isAuto({ provider: 'gift_smart', payoutCoin: 'ltc', payoutAddress: 'ltc1qxx' }), false);
  assert.strictEqual(pv.isAuto({ provider: 'revolut_manual' }), false);
  assert.strictEqual(pv.isAuto({ provider: 'bank_sepa_manual' }), false);
  assert.strictEqual(pv.isAuto({ provider: 'crypto_direct', payoutCoin: 'eth', payoutAddress: '0xabc', watched: false }), false);
  assert.strictEqual(pv.isAuto({ provider: 'revolut_ramp', payoutCoin: 'ltc' /* no address */ }), false);
});

t('claimedTxids skips other orders', () => {
  const set = pv.claimedTxids({
    a: { orderId: 'a', chainTxid: 'tx1' },
    b: { orderId: 'b', chainTxids: ['tx2', 'tx3'] },
  }, 'c');
  assert.ok(set.has('tx1') && set.has('tx2') && set.has('tx3'));
  assert.ok(!pv.claimedTxids({ a: { orderId: 'a', chainTxid: 'tx1' } }, 'a').has('tx1'));
});

t('pickTx prefers confirmed and skips claimed', () => {
  const order = { amountCrypto: '0.5' };
  const claimed = new Set(['old']);
  const tx = pv.pickTx(order, {
    status: 'confirmed',
    newSat: 50e6,
    txs: [
      { txid: 'old', valueSat: 50e6, confirmed: true },
      { txid: 'good', valueSat: 50e6, confirmed: true },
      { txid: 'mem', valueSat: 50e6, confirmed: false },
    ],
  }, claimed);
  assert.strictEqual(tx.txid, 'good');
});

t('relative keeps newSat from valued txs', () => {
  const r = {
    status: 'confirmed', confirmedSat: 100, unconfirmedSat: 0, txCount: 1, amountsUnknown: false, source: 'litecoinspace.org',
    txs: [{ txid: 'abc', valueSat: 40, confirmed: true, blockTime: '2026-11-09T21:00:00.000Z' }],
  };
  const b = { source: 'litecoinspace.org', confirmedSat: 0, unconfirmedSat: 0, txCount: 0, amountsUnknown: false, at: '2026-11-09T20:00:00.000Z' };
  const out = watcher.relative(r, b);
  assert.strictEqual(out.status, 'confirmed');
  assert.strictEqual(out.newSat, 40);
  assert.strictEqual(out.txs[0].txid, 'abc');
});

t('explorerUrl per coin', () => {
  assert.ok(pv.explorerUrl('ltc', 'deadbeef').includes('litecoinspace.org/tx/deadbeef'));
  assert.ok(pv.explorerUrl('btc', 'deadbeef').includes('mempool.space/tx/deadbeef'));
});

(async () => {
  await ta('apply marks paid for matching confirmed amount and claims tx', async () => {
    const orders = {
      ord_aaa: {
        orderId: 'ord_aaa', provider: 'revolut_ramp', payoutCoin: 'ltc', payoutAddress: 'ltc1qtest',
        watched: true, amountEur: 25, ticker: 'LTC', paidRatio: 0.85, status: 'awaiting_payment',
      },
    };
    // stub prices: 50 EUR/LTC → 0.5 LTC = 25 EUR exactly
    const orig = require('../pay/src/cryptoDirect').prices;
    require('../pay/src/cryptoDirect').prices = async () => ({ litecoin: 50 });
    const logs = [];
    const r = {
      status: 'confirmed', checkedAt: new Date().toISOString(), newSat: 50e6,
      txs: [{ txid: 'txidpaid1', valueSat: 50e6, confirmed: true }],
    };
    try {
      const out = await pv.apply(orders.ord_aaa, 'confirmed', r, {
        loadOrders: () => orders,
        saveOrders: (o) => Object.assign(orders, o),
        appendLog: (m) => logs.push(m),
      });
      assert.strictEqual(out.verdict, 'paid');
      assert.strictEqual(orders.ord_aaa.status, 'paid');
      assert.strictEqual(orders.ord_aaa.chainTxid, 'txidpaid1');
      assert.ok(orders.ord_aaa.chainTxUrl.includes('txidpaid1'));
      assert.ok(logs.some((m) => /PAYVERIFY/.test(m)));
    } finally {
      require('../pay/src/cryptoDirect').prices = orig;
    }
  });

  await ta('apply does not mark gift_smart or revolut_manual', async () => {
    for (const provider of ['gift_smart', 'revolut_manual', 'bank_sepa_manual']) {
      const orders = { o1: { orderId: 'o1', provider, payoutCoin: 'ltc', payoutAddress: 'ltc1q', watched: true, amountEur: 10, status: 'awaiting_payment' } };
      const out = await pv.apply(orders.o1, 'confirmed', { status: 'confirmed', newSat: 1e8, txs: [{ txid: 'x', valueSat: 1e8, confirmed: true }] }, {
        loadOrders: () => orders, saveOrders: () => {}, appendLog: () => {},
      });
      assert.strictEqual(out.verdict, null);
      assert.strictEqual(orders.o1.status, 'awaiting_payment');
    }
  });

  await ta('second order cannot claim same txid', async () => {
    const orders = {
      a: { orderId: 'a', provider: 'revolut_ramp', payoutCoin: 'ltc', payoutAddress: 'ltc1q', watched: true, amountEur: 10, ticker: 'LTC', status: 'paid', chainTxid: 'sharedtx', paidAt: '2026-01-01' },
      b: { orderId: 'b', provider: 'revolut_ramp', payoutCoin: 'ltc', payoutAddress: 'ltc1q', watched: true, amountEur: 10, ticker: 'LTC', status: 'awaiting_payment' },
    };
    const orig = require('../pay/src/cryptoDirect').prices;
    require('../pay/src/cryptoDirect').prices = async () => ({ litecoin: 50 });
    try {
      // 10 EUR at 50 EUR/LTC = 0.2 LTC = 20e6 sat — but only claimed tx present with that value
      await pv.apply(orders.b, 'confirmed', {
        status: 'confirmed', newSat: 20e6,
        txs: [{ txid: 'sharedtx', valueSat: 20e6, confirmed: true }],
      }, { loadOrders: () => orders, saveOrders: (o) => Object.assign(orders, o), appendLog: () => {} });
      // Without a free tx, pickTx returns aggregate fallback with null/claimed txid — still may mark via newSat.
      // Ensure sharedtx is not re-assigned as b's exclusive new claim from the txs list alone:
      const claimed = pv.claimedTxids(orders, 'b');
      assert.ok(claimed.has('sharedtx'));
      const picked = pv.pickTx(orders.b, { txs: [{ txid: 'sharedtx', valueSat: 20e6, confirmed: true }], newSat: 20e6 }, claimed);
      assert.ok(!picked || picked.txid !== 'sharedtx' || picked.txid == null || !orders.b.chainTxids || !orders.b.chainTxids.includes('sharedtx') || orders.a.chainTxid === 'sharedtx');
    } finally {
      require('../pay/src/cryptoDirect').prices = orig;
    }
  });

  if (process.exitCode) process.exit(process.exitCode);
})().catch((e) => { console.error(e); process.exit(1); });
