'use strict';
// 🪙 per-method coins, 🎁 gift cards, OxaPay HMAC callback, 💳 Card2Crypto/PayGate.to wallet flow – all with mocked fetch (no live calls).
const assert = require('assert');
const os = require('os'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
process.env.DATA_ENC_KEY = 'b'.repeat(64);
delete process.env.DATABASE_URL;
for (const k of Object.keys(process.env)) if (/^(OXAPAY_|WG_)/.test(k)) delete process.env[k];
process.env.POLYGON_RPC_URLS = 'https://rpc.test.invalid';
const express = require('express');
const http = require('http');
const methodCoins = require('../pay/src/methodCoins');
const giftCards = require('../pay/src/giftCards');
const oxapay = require('../pay/src/oxapay');
const wg = require('../pay/src/walletGateway');
const DATA = path.join(__dirname, '..', 'pay', 'data');
const cleanup = () => { for (const f of ['oxapay.json', 'wallet-gw-card2crypto.json', 'wallet-gw-paygate.json']) { try { fs.unlinkSync(path.join(DATA, f)); } catch { /* */ } } };
cleanup();

const TEST_ADDR = '0x000000000000000000000000000000000000dEaD'; // obviously-test payout address
const realFetch = global.fetch; let calls = [];
const tgMsgs = []; global.__telegramBot = { loadAdminChatId: () => 1, sendMessage: async (c, t) => { tgMsgs.push(t); } };
const J = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
global.fetch = async (url, opt = {}) => {
  url = String(url); calls.push({ url, opt });
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opt);
  if (url.includes('/payment/invoice')) return J({ status: 200, data: { track_id: 'TRK123', payment_url: 'https://pay.oxapay.test/TRK123', expired_at: 1 } });
  if (url.includes('/payment/accepted-currencies')) return opt.headers.merchant_api_key === 'GOOD-KEY-1234' ? J({ status: 200, data: { list: ['BTC', 'USDT'] } }) : J({ status: 401, message: 'The provided merchant API key is invalid' }, 401);
  if (url.includes('/provider-status')) return J({ providers: [{ id: 'stripe', provider_name: 'Stripe (US/EU)', status: 'active', minimum_currency: 'USD', minimum_amount: 2 }, { id: 'dead', provider_name: 'X', status: 'inactive', minimum_amount: 1 }, { id: 'upi', provider_name: 'UPI', status: 'active', minimum_currency: 'INR', minimum_amount: 1600 }] });
  if (url.includes('/wallet.php')) return J({ address_in: 'abc%2Bdef%3D%3D', polygon_address_in: '0x' + '1'.repeat(40), callback_url: 'x', ipn_token: 'IPN' });
  if (url.includes('/convert.php')) return J({ status: 'success', value_coin: '27.50' });
  if (url.includes('rpc.test.invalid')) {
    const to = '0x' + TEST_ADDR.toLowerCase().slice(2).padStart(64, '0');
    return J({ jsonrpc: '2.0', id: 1, result: { status: '0x1', logs: [{ address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64), to], data: '0x' + (26500000).toString(16) }] } });
  }
  throw new Error('unexpected fetch ' + url);
};

let n = 0;
async function t(name, fn) { await fn(); n++; }
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

(async () => {
  await t('methodCoins.parse keeps legacy unless custom selection is on', () => {
    const prev = ['btc']; assert.strictEqual(methodCoins.parse({}, prev), prev);
    assert.strictEqual(methodCoins.parse({ coinsSent: '1' }, ['btc']), undefined);
    const ids = methodCoins.choices().map((c) => c.id);
    assert.ok(ids.length >= 3);
    const out = methodCoins.parse({ coinsSent: '1', coinsCustom: '1', coins: ids.slice(0, 2).join(',') + ',bogus' }, undefined);
    assert.ok(Array.isArray(out) && !out.includes('bogus'));
  });
  await t('giftCards validation + seed', () => {
    assert.ok(giftCards.SEED.length >= 13);
    for (const c of giftCards.SEED) { assert.ok(giftCards._validUrl(c.url), c.url); assert.ok(giftCards._validLogo(c.logo), c.logo); assert.ok(fs.existsSync(path.join(__dirname, '..', 'pay', 'public', c.logo))); }
    assert.ok(!giftCards._validUrl('http://x.sk')); assert.ok(!giftCards._validUrl('javascript:alert(1)')); assert.ok(!giftCards._validLogo('https://evil/x.svg'));
  });
  await t('oxapay HMAC verify', () => {
    const raw = Buffer.from('{"a":1}'); const h = crypto.createHmac('sha512', 'K').update(raw).digest('hex');
    assert.ok(oxapay.verifyHmac(raw, h, 'K')); assert.ok(!oxapay.verifyHmac(raw, h, 'K2')); assert.ok(!oxapay.verifyHmac(raw, 'zz', 'K')); assert.ok(!oxapay.verifyHmac(raw, h, ''));
  });

  const orders = {};
  const app = express();
  const deps = { loadOrders: () => orders, saveOrders: () => {}, appendLog: () => {} };
  oxapay.mount(app, deps); wg.mount(app, deps);
  const srv = app.listen(0); const port = srv.address().port;
  const B = global.__payBridge;

  await t('oxapay hidden until key + switch; key never returned; test button', async () => {
    assert.strictEqual(oxapay.items().length, 0);
    let v = await B['/api/admin-bridge/oxapay'].ox_save({ apiKey: 'BAD-KEY-0000', enabled: '1', coins: 'BTC,usdt,XYZ' });
    assert.ok(v.configured && v.keySet && !JSON.stringify(v).includes('BAD-KEY-0000')); assert.deepStrictEqual(v.coins, ['BTC', 'USDT']);
    assert.ok(!fs.readFileSync(path.join(DATA, 'oxapay.json'), 'utf8').includes('BAD-KEY'));
    v = await B['/api/admin-bridge/oxapay'].ox_test({}); assert.strictEqual(v.lastTest.ok, false); assert.ok(!v.lastTest.msg.includes('BAD-KEY'));
    v = await B['/api/admin-bridge/oxapay'].ox_save({ apiKey: 'GOOD-KEY-1234', enabled: '1', coins: 'BTC' });
    v = await B['/api/admin-bridge/oxapay'].ox_test({}); assert.strictEqual(v.lastTest.ok, true);
    assert.strictEqual(oxapay.items().length, 1);
    assert.ok(!/TokiGo/i.test(JSON.stringify(oxapay.items())));
  });
  await t('oxapay order + signed callback → paid + telegram; bad signature rejected', async () => {
    calls = [];
    const o = await oxapay.createOrder({ orderId: 'ord_' + 'a'.repeat(16), amountEur: 25, email: 'c@example.com', countryCode: 'SK', baseUrl: 'https://shop.test', ...deps });
    const inv = calls.find((c) => c.url.includes('/payment/invoice')); const body = JSON.parse(inv.opt.body);
    assert.strictEqual(body.amount, 25); assert.strictEqual(body.currency, 'EUR'); assert.strictEqual(body.lifetime, 30); assert.strictEqual(body.fee_paid_by_payer, 0); assert.strictEqual(body.callback_url, 'https://shop.test/oxapay/callback');
    let r = await req(port, 'GET', '/oxapay-pay/' + o.orderId); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, 'https://pay.oxapay.test/TRK123');
    const payload = Buffer.from(JSON.stringify({ track_id: 'TRK123', status: 'Paid', amount: 25, currency: 'EUR', order_id: o.orderId, type: 'invoice', txs: [{ currency: 'BTC', amount: 0.0003 }] }));
    r = await req(port, 'POST', '/oxapay/callback', payload, { 'Content-Type': 'application/json', HMAC: 'ab'.repeat(64) }); assert.strictEqual(r.status, 400); assert.strictEqual(orders[o.orderId].status, 'pending');
    r = await req(port, 'POST', '/oxapay/callback', payload, { 'Content-Type': 'application/json', HMAC: crypto.createHmac('sha512', 'GOOD-KEY-1234').update(payload).digest('hex') });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body, 'ok'); assert.strictEqual(orders[o.orderId].status, 'paid');
    await new Promise((x) => setTimeout(x, 30)); assert.ok(tgMsgs.some((m) => m.includes(o.orderId) && m.includes('OxaPay')));
  });

  await t('wallet gateway: address validation, encrypted, hidden until configured', async () => {
    const A = B['/api/admin-bridge/wallet-gw'];
    assert.strictEqual(wg.items().length, 0);
    await assert.rejects(Promise.resolve(A.card2crypto_save({ address: '0x123', enabled: '1' })).then((v) => { if (!v.ok) throw new Error(v.error); }));
    let v = await A.card2crypto_save({ address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', enabled: '1' }); assert.strictEqual(v.ok, false);
    v = await A.card2crypto_providers({}); assert.deepStrictEqual(v.providers.map((p) => p.id), ['stripe']);
    v = await A.card2crypto_save({ address: TEST_ADDR, provider: 'stripe', enabled: '1', tolerance: '10' });
    assert.ok(v.configured && v.addressMasked === '0x0000…dEaD');
    assert.ok(!fs.readFileSync(path.join(DATA, 'wallet-gw-card2crypto.json'), 'utf8').toLowerCase().includes('dead'));
    const its = wg.items(); assert.strictEqual(its.length, 1); assert.strictEqual(its[0].provider_name, 'Karta / Apple Pay / Google Pay');
    assert.ok(!/fee|poplat|card2crypto|tokigo/i.test(its[0].provider_name + its[0].hint + its[0].method_label));
  });
  let order; let TOKEN;
  await t('wallet gateway order: wallet.php with token callback, redirect to process-payment', async () => {
    calls = [];
    order = await wg.createOrder({ methodId: 'card2crypto', orderId: 'ord_' + 'b'.repeat(16), amountEur: 25, email: 'c@example.com', countryCode: 'SK', ip: '1.2.3.4', baseUrl: 'https://shop.test', ...deps });
    const w = calls.find((c) => c.url.includes('/wallet.php'));
    const u = new URL(w.url); assert.strictEqual(u.origin, 'https://api.card2crypto.org'); assert.strictEqual(u.searchParams.get('address'), TEST_ADDR);
    const cb = new URL(u.searchParams.get('callback')); assert.strictEqual(cb.pathname, '/wg-callback/card2crypto'); assert.strictEqual(cb.searchParams.get('orderId'), order.orderId);
    TOKEN = cb.searchParams.get('t'); assert.ok(/^[a-f0-9]{48}$/.test(TOKEN)); assert.ok(!JSON.stringify(orders[order.orderId]).includes(TOKEN));
    assert.strictEqual(orders[order.orderId].wg.expectedUsdc, 27.5); assert.strictEqual(orders[order.orderId].wg.polygonAddressIn, '0x' + '1'.repeat(40));
    const r = await req(port, 'GET', '/wg-pay/' + order.orderId); assert.strictEqual(r.status, 302);
    const loc = new URL(r.headers.location); assert.strictEqual(loc.origin + loc.pathname, 'https://pay.card2crypto.org/process-payment.php');
    assert.strictEqual(loc.searchParams.get('address'), 'abc+def=='); assert.strictEqual(loc.searchParams.get('amount'), '25'); assert.strictEqual(loc.searchParams.get('provider'), 'stripe'); assert.strictEqual(loc.searchParams.get('currency'), 'EUR'); assert.strictEqual(loc.searchParams.get('email'), 'c@example.com');
  });
  await t('wallet gateway callback: bad token 403, low value → review, ok → paid + on-chain verified telegram', async () => {
    const id = order.orderId;
    let r = await req(port, 'GET', `/wg-callback/card2crypto?orderId=${id}&t=${'0'.repeat(48)}&value_coin=27`); assert.strictEqual(r.status, 403);
    r = await req(port, 'GET', `/wg-callback/paygate?orderId=${id}&t=${TOKEN}&value_coin=27`); assert.strictEqual(r.status, 403);
    r = await req(port, 'GET', `/wg-callback/card2crypto?orderId=${id}&t=${TOKEN}&value_coin=20`); assert.strictEqual(r.status, 200); assert.strictEqual(orders[id].status, 'underpaid_review');
    orders[id].status = 'pending';
    r = await req(port, 'GET', `/wg-callback/card2crypto?orderId=${id}&t=${TOKEN}&value_coin=26.5&coin=polygon_usdc&txid_out=0x${'c'.repeat(64)}`); assert.strictEqual(r.status, 200); assert.strictEqual(orders[id].status, 'paid');
    await new Promise((x) => setTimeout(x, 50));
    assert.strictEqual(orders[id].wg.onchainVerified, true);
    assert.ok(tgMsgs.some((m) => m.includes(id) && m.includes('✅ overené')));
    assert.ok(tgMsgs.some((m) => m.includes('overiť')));
  });
  await t('wallet gateway minimum + rate limit', async () => {
    await assert.rejects(wg.createOrder({ methodId: 'card2crypto', orderId: 'ord_' + 'c'.repeat(16), amountEur: 1, email: 'c@example.com', ip: '9.9.9.9', baseUrl: 'https://s', ...deps }), /Minimálna/);
    await assert.rejects(wg.createOrder({ methodId: 'paygate_direct', orderId: 'ord_' + 'd'.repeat(16), amountEur: 10, email: 'c@example.com', ip: '9.9.9.9', baseUrl: 'https://s', ...deps }), /nie je dostupný/);
  });
  srv.close(); cleanup(); global.fetch = realFetch;
  console.log(`paymore: ${n} tests passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
