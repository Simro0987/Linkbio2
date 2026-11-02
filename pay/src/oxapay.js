'use strict';
/**
 * 🪙 OxaPay (optional crypto invoice gateway). Docs: https://docs.oxapay.com (API v1).
 * - Ryan pastes his „Merchant API key“ in admin → stored AES-256-GCM (sealedStore, same scheme as the Blink key); never logged / returned.
 * - Checkout: POST /v1/payment/invoice {amount EUR, lifetime 30, fee_paid_by_payer 0, callback_url, return_url, order_id}
 *   → order stored → /oxapay-pay/<orderId> 302 → OxaPay hosted payment page.
 * - Callback: raw body, header HMAC = HMAC-SHA512(raw body, merchant key), constant-time compare; status Paid + amount match → paid + Telegram.
 * - Hidden for customers unless a key is saved AND the switch is on.
 * - Local testing: OXAPAY_API_URL points to a mock; OXAPAY_SANDBOX=1 (or the admin toggle) sends sandbox:true.
 */
const crypto = require('crypto');
const sealed = require('./sealedStore');

const LABEL = 'oxapay-merchant-key';
const ID_RE = /^ord_[a-f0-9]{16}$/;
const COINS = [
  ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['USDT', 'Tether (USDT)'], ['USDC', 'USD Coin'], ['LTC', 'Litecoin'], ['TRX', 'Tron'], ['BNB', 'BNB'],
  ['SOL', 'Solana'], ['TON', 'Toncoin'], ['XRP', 'XRP'], ['DOGE', 'Dogecoin'], ['XMR', 'Monero'], ['BCH', 'Bitcoin Cash'], ['POL', 'Polygon (POL)'], ['DAI', 'DAI'], ['SHIB', 'Shiba Inu'],
];
const store = sealed.create('oxapay', { keyEnc: '', enabled: false, sandbox: false, coins: ['BTC', 'ETH', 'USDT', 'USDC', 'LTC'], lastTest: null });
let log = () => {};
const api = () => String(process.env.OXAPAY_API_URL || 'https://api.oxapay.com/v1').replace(/\/$/, '');
const cfg = () => store.get();
const key = () => sealed.open(LABEL, cfg().keyEnc);
const configured = () => Boolean(cfg().enabled && key());
const sandbox = () => Boolean(cfg().sandbox || process.env.OXAPAY_SANDBOX === '1');
async function tg(text) { try { const t = global.__telegramBot; const chat = t && t.loadAdminChatId && t.loadAdminChatId(); if (chat) await t.sendMessage(chat, text); } catch { /* best effort */ } }

async function call(method, path, body, k = key(), ms = 20000) {
  const r = await fetch(api() + path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', merchant_api_key: k }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  let j = null; try { j = await r.json(); } catch { j = null; }
  if (!r.ok || !j || (j.status && Number(j.status) !== 200)) {
    const e = new Error((j && (j.message || (j.error && j.error.message))) || `HTTP ${r.status}`); e.status = r.status; throw e;
  }
  return j;
}

function items() {
  if (!configured()) return [];
  return [{ id: 'oxapay', providerId: 'oxapay', provider_name: 'Kryptomeny (OxaPay)', method_label: 'Kryptomeny (OxaPay)', status: 'active', group: 'crypto', gateway: 'oxapay',
    configured: true, soon: false, unavailableLabel: null, preferred: false, minimum_amount: 1, minimum_currency: 'EUR', logos: ['/logos/bitcoin.svg'],
    hint: 'Zaplaťte kryptomenou (' + (cfg().coins || []).slice(0, 6).join(', ') + ' …) na zabezpečenej platobnej stránke. Faktúra platí 30 minút.' }];
}
function inject(res) {
  if (!res || !res.groups) return res;
  const its = items(); if (!its.length) return res;
  const gk = res.groups.crypto ? 'crypto' : Object.keys(res.groups).find((k) => /crypto|krypto|btc/i.test(k)) || 'crypto';
  if (!res.groups[gk]) res.groups[gk] = { label: 'Kryptomeny', color: null, providers: [], soon: [] };
  const g = res.groups[gk];
  if (!g.providers.some((x) => x.id === 'oxapay')) { g.providers.push(its[0]); (res.providers || (res.providers = [])).push(its[0]); }
  return res;
}

async function createOrder({ orderId, amountEur, email, countryCode, baseUrl, loadOrders, saveOrders, appendLog }) {
  if (!configured()) { const e = new Error('Tento spôsob platby momentálne nie je dostupný. Vyberte iný.'); e.status = 400; throw e; }
  const amt = Math.round(Number(amountEur) * 100) / 100;
  if (!(amt > 0) || amt > 20000) { const e = new Error('Neplatná suma.'); e.status = 400; throw e; }
  const base = String(baseUrl).replace(/\/$/, '');
  const body = { amount: amt, currency: 'EUR', lifetime: 30, fee_paid_by_payer: 0, under_paid_coverage: 0, mixed_payment: false,
    callback_url: `${base}/oxapay/callback`, return_url: `${base}/?paid=${orderId}`, order_id: orderId, description: `Objednávka ${orderId}`, sandbox: sandbox() };
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) body.email = email;
  const j = await call('POST', '/payment/invoice', body);
  const d = j.data || {};
  if (!d.track_id || !/^https:\/\//.test(String(d.payment_url || ''))) throw new Error('OxaPay: bad response');
  const order = { orderId, amountEur: amt, amount: amt, currency: 'EUR', country: countryCode, email: email || '', provider: 'oxapay', providerAlias: 'oxapay', gateway: 'oxapay', paymentMethod: 'crypto',
    status: 'pending', createdAt: new Date().toISOString(), oxapay: { trackId: String(d.track_id), paymentUrl: String(d.payment_url), expiresAt: d.expired_at || null, sandbox: body.sandbox }, checkoutUrl: `/oxapay-pay/${orderId}` };
  const orders = loadOrders(); orders[orderId] = order; saveOrders(orders);
  (appendLog || log)(`OXAPAY_ORDER ${orderId} eur=${amt} track=${order.oxapay.trackId} sandbox=${body.sandbox}`);
  return order;
}

function verifyHmac(raw, header, k) {
  if (!k || !header || !Buffer.isBuffer(raw)) return false;
  const want = crypto.createHmac('sha512', k).update(raw).digest();
  let got; try { got = Buffer.from(String(header).trim(), 'hex'); } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function mount(app, deps) {
  const { loadOrders, saveOrders } = deps; log = deps.appendLog || log;
  const express = require('express');
  app.get('/oxapay-pay/:id', (req, res) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
    const o = ID_RE.test(req.params.id) ? loadOrders()[req.params.id] : null;
    if (!o || o.gateway !== 'oxapay' || !o.oxapay) return res.status(404).type('html').send('<p>Objednávka sa nenašla. <a href="/platby">Späť</a></p>');
    if (o.status === 'paid') return res.redirect(302, '/?paid=' + encodeURIComponent(o.orderId));
    return res.redirect(302, o.oxapay.paymentUrl);
  });
  app.post('/oxapay/callback', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyHmac(raw, req.get('HMAC') || req.get('hmac'), key())) { log('OXAPAY_CALLBACK_BAD_HMAC'); return res.status(400).send('invalid hmac'); }
    let p; try { p = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('bad json'); }
    const id = String(p.order_id || ''); const orders = loadOrders(); const o = ID_RE.test(id) ? orders[id] : null;
    if (!o || o.gateway !== 'oxapay' || !o.oxapay || String(p.track_id) !== o.oxapay.trackId) { log(`OXAPAY_CALLBACK_UNKNOWN ${ID_RE.test(id) ? id : '-'}`); return res.status(200).send('ok'); }
    const st = String(p.status || '').toLowerCase();
    o.oxapay = { ...o.oxapay, lastStatus: st, callbackAt: new Date().toISOString() };
    let notify = null;
    if (st === 'paid' && o.status !== 'paid') {
      const amt = Number(p.amount); const cur = String(p.currency || '').toUpperCase();
      const ok = !(amt > 0) || cur !== 'EUR' || amt + 0.01 >= Number(o.amountEur); // invoice was created in EUR; OxaPay reports the invoice amount
      o.status = ok ? 'paid' : 'underpaid_review'; if (ok) o.paidAt = new Date().toISOString();
      const tx = Array.isArray(p.txs) && p.txs[0] ? p.txs[0] : {};
      o.oxapay.paidCoin = String(tx.currency || p.pay_currency || '').slice(0, 20); o.oxapay.paidAmount = Number(tx.amount || p.pay_amount) || null;
      notify = `${ok ? '🪙✅ Zaplatené cez OxaPay' : '🪙⚠️ OxaPay – overiť sumu'}${o.oxapay.sandbox ? ' (SANDBOX)' : ''}\nObjednávka: ${id}\nSuma: ${o.amountEur} EUR\nKrypto: ${o.oxapay.paidAmount ?? '?'} ${o.oxapay.paidCoin || ''}\nTrack ID: ${o.oxapay.trackId}` + (o.email ? `\nEmail: ${o.email}` : '');
    } else if (['expired', 'failed'].includes(st) && o.status === 'pending') o.status = st;
    saveOrders(orders);
    log(`OXAPAY_CALLBACK ${id} status=${st} order=${o.status}`);
    res.status(200).send('ok');
    if (notify) await tg(notify);
  });

  const view = () => { const c = cfg(); const k = key(); return { ok: true, configured: configured(), enabled: Boolean(c.enabled), keySet: Boolean(k), keyHint: k ? '••••' + k.slice(-4) : '', sandbox: Boolean(c.sandbox), coins: c.coins || [], allCoins: COINS, lastTest: c.lastTest, encAvailable: Boolean(process.env.DATA_ENC_KEY || process.env.BACKUP_ENC_KEY) }; };
  const ACTIONS = {
    ox_get: async () => view(),
    ox_save: async (f) => {
      const next = {};
      const k = String(f.apiKey || '').trim();
      if (k) {
        if (!/^[A-Za-z0-9-]{8,80}$/.test(k)) return { ok: false, status: 400, error: 'Kľúč má neplatný formát (vložte Merchant API key z OxaPay).' };
        try { next.keyEnc = sealed.seal(LABEL, k); } catch (x) { return { ok: false, status: 400, error: x.message }; }
      } else if (String(f.clearKey || '') === '1') next.keyEnc = '';
      const allowed = new Set(COINS.map((c) => c[0]));
      next.coins = String(f.coins || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => allowed.has(s));
      next.enabled = String(f.enabled || '') === '1';
      next.sandbox = String(f.sandbox || '') === '1';
      await store.save(next);
      log(`OXAPAY_CONFIG_SAVED key=${key() ? 'set' : 'none'} enabled=${cfg().enabled} sandbox=${cfg().sandbox}`);
      return view();
    },
    ox_test: async () => {
      const k = key(); if (!k) return { ok: false, status: 400, error: 'Najprv uložte Merchant API kľúč.' };
      let res;
      try { const j = await call('GET', '/payment/accepted-currencies', null, k, 15000); const list = (j.data && (j.data.list || j.data)) || []; res = { ok: true, at: new Date().toISOString(), msg: 'Kľúč funguje. Povolené meny v OxaPay: ' + (Array.isArray(list) ? list.join(', ') : Object.keys(list).join(', ')).slice(0, 300) }; }
      catch (x) { res = { ok: false, at: new Date().toISOString(), msg: 'Test zlyhal: ' + String(x.message).slice(0, 160) }; }
      await store.save({ lastTest: res });
      return view();
    },
  };
  require('./payMethods').serveSigned(app, '/api/admin-bridge/oxapay', ACTIONS, 'OXAPAY');
}
async function init(appendLog) { if (appendLog) log = appendLog; await store.load(); }
module.exports = { COINS, coinsShown: () => (cfg().coins || []).slice(), configured, items, inject, createOrder, verifyHmac, mount, init, _store: store };
