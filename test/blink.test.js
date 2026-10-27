'use strict';
// ⚡ Blink Lightning: EUR→sats conversion, price aggregation, invoice status handling, admin view never leaks the key.
const assert = require('assert');
process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY && /^[0-9a-f]{64}$/i.test(process.env.DATA_ENC_KEY) ? process.env.DATA_ENC_KEY : 'a'.repeat(64);
const blink = require('../pay/src/blink');
let n = 0; const t = (name, fn) => { fn(); n++; };

t('eurToSats exact', () => {
  assert.strictEqual(blink.eurToSats(10, 100000), 10000);          // 10 € @ 100k €/BTC = 0.0001 BTC
  assert.strictEqual(blink.eurToSats('25.00', 50000), 50000);
  assert.strictEqual(blink.eurToSats(0.01, 100000), 10);
});
t('eurToSats rounds up (merchant never short)', () => {
  const s = blink.eurToSats(9.99, 71669.8125);
  assert.ok(s * 71669.8125 / 1e8 >= 9.99 - 1e-9);
  assert.ok((s - 1) * 71669.8125 / 1e8 < 9.99);
  assert.strictEqual(blink.eurToSats(1, 30000), 3334);
});
t('eurToSats rejects bad input', () => {
  for (const [e, p] of [[0, 1e5], [-5, 1e5], ['abc', 1e5], [5, 0], [5, NaN], [5, -1]]) assert.throws(() => blink.eurToSats(e, p));
});
t('eurToSats uses cents (no float drift)', () => {
  assert.strictEqual(blink.eurToSats(0.1 + 0.2, 100000), 300);
});
t('aggregatePrice median + outlier drop', () => {
  const r = blink.aggregatePrice({ blink: 70000, coingecko: 70100, kraken: 69950, binance: 90000, coinbase: NaN });
  assert.deepStrictEqual(r.sources.sort(), ['blink', 'coingecko', 'kraken']);
  assert.strictEqual(r.price, 70000);
});
t('aggregatePrice needs ≥2 sources unless Blink', () => {
  assert.throws(() => blink.aggregatePrice({ kraken: 70000 }));
  assert.throws(() => blink.aggregatePrice({}));
  assert.throws(() => blink.aggregatePrice({ kraken: 5 })); // absurd value filtered
  assert.strictEqual(blink.aggregatePrice({ blink: 70000 }).price, 70000);
  assert.strictEqual(blink.aggregatePrice({ kraken: 70000, coinbase: 70200 }).price, 70100);
});
const mk = (exp) => ({ orderId: 'ord_0123456789abcdef', amountEur: 12.5, status: 'awaiting_payment', provider: 'blink_ln',
  blink: { invoices: [{ paymentRequest: 'lnbc1old', paymentHash: 'h1', sats: 100, status: 'PENDING', expiresAt: new Date(exp).toISOString() }] } });
t('applyStatus PAID marks order paid once', () => {
  const now = Date.now(); const o = mk(now + 60e3); const inv = o.blink.invoices[0];
  assert.strictEqual(blink.applyStatus(o, inv, 'PAID', now), 'paid');
  assert.strictEqual(o.status, 'paid'); assert.strictEqual(o.paidVia, 'blink_ln'); assert.strictEqual(o.paidSats, 100); assert.ok(o.paidAt);
  assert.strictEqual(blink.applyStatus(o, inv, 'PAID', now), null); // idempotent → no second Telegram message
});
t('applyStatus PENDING / EXPIRED', () => {
  const now = Date.now(); const o = mk(now + 60e3); const inv = o.blink.invoices[0];
  assert.strictEqual(blink.applyStatus(o, inv, 'PENDING', now), null); assert.strictEqual(inv.status, 'PENDING'); assert.strictEqual(o.status, 'awaiting_payment');
  assert.strictEqual(blink.applyStatus(o, inv, 'EXPIRED', now), null); assert.strictEqual(inv.status, 'EXPIRED'); assert.strictEqual(o.status, 'awaiting_payment');
  const o2 = mk(now - 10 * 60e3); blink.applyStatus(o2, o2.blink.invoices[0], 'PENDING', now); assert.strictEqual(o2.blink.invoices[0].status, 'EXPIRED');
  const o3 = mk(now - 10 * 60e3); o3.blink.invoices[0].status = 'EXPIRED';
  assert.strictEqual(blink.applyStatus(o3, o3.blink.invoices[0], 'PAID', now), 'paid'); // late payment of an expired-looking invoice still counts
  assert.strictEqual(blink.applyStatus(o, null, 'PAID', now), null);
  assert.strictEqual(blink.applyStatus(o, inv, 'UNKNOWN', now), null);
});
t('publicState', () => {
  const now = Date.now();
  let s = blink.publicState(mk(now + 60e3), now);
  assert.strictEqual(s.status, 'pending'); assert.strictEqual(s.amountEur, '12.50'); assert.strictEqual(s.sats, 100); assert.strictEqual(s.paymentRequest, 'lnbc1old');
  s = blink.publicState(mk(now - 1000), now); assert.strictEqual(s.status, 'expired');
  const p = mk(now + 60e3); p.status = 'paid'; s = blink.publicState(p, now); assert.strictEqual(s.status, 'paid'); assert.strictEqual(s.paymentRequest, null);
});
t('admin view never exposes the key', () => {
  blink._setConfig({ username: 'demo', lnAddress: '', walletId: 'w', keyEnc: 'c2VjcmV0' });
  const v = blink.adminView();
  assert.strictEqual(v.key, '(uložený)'); assert.strictEqual(v.lnAddressEffective, 'demo@blink.sv');
  assert.ok(!JSON.stringify(v).includes('c2VjcmV0'));
  blink._setConfig({ keyEnc: '' }); assert.strictEqual(blink.adminView().key, '(nenastavený)');
  blink._setConfig({ lnAddress: 'pay@example.com' }); assert.strictEqual(blink.adminView().lnAddressEffective, 'pay@example.com');
  blink._setConfig({ username: '', lnAddress: '', walletId: '' }); assert.strictEqual(blink.configured(), false);
});
// GraphQL wiring with a mocked fetch (no network): public on-behalf invoice + status mapping
(async () => {
  const calls = [];
  const fake = async (url, init) => { const b = JSON.parse(init.body); calls.push({ b, h: init.headers });
    if (/lnInvoiceCreateOnBehalfOfRecipient/.test(b.query)) return { status: 200, json: async () => ({ data: { lnInvoiceCreateOnBehalfOfRecipient: { errors: [], invoice: { paymentRequest: 'lnbc5u1test', paymentHash: 'abc', satoshis: b.variables.i.amount } } } }) };
    if (/lnInvoicePaymentStatusByPaymentRequest/.test(b.query)) return { status: 200, json: async () => ({ data: { lnInvoicePaymentStatusByPaymentRequest: { status: 'PAID' } } }) };
    return { status: 200, json: async () => ({ errors: [{ message: 'Account does not exist for username x' }] }) };
  };
  blink._setConfig({ walletId: 'wallet-1', keyEnc: '' });
  const inv = await blink.createInvoice({ sats: 1234, memo: 'Objednávka ord_0123456789abcdef' }, { fetchImpl: fake });
  assert.strictEqual(inv.paymentRequest, 'lnbc5u1test'); assert.strictEqual(inv.sats, 1234); assert.strictEqual(inv.via, 'public');
  assert.strictEqual(calls[0].b.variables.i.recipientWalletId, 'wallet-1'); assert.strictEqual(calls[0].b.variables.i.memo, 'Objednávka ord_0123456789abcdef');
  assert.ok(!('X-API-KEY' in calls[0].h));
  assert.strictEqual(await blink.invoiceStatus('lnbc5u1test', { fetchImpl: fake }), 'PAID');
  await assert.rejects(blink.walletForUsername('x', { fetchImpl: fake }), /does not exist/);
  await assert.rejects(blink.createInvoice({ sats: 0, memo: 'x' }, { fetchImpl: fake }));
  n += 1;
  console.log(`blink: ${n} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
