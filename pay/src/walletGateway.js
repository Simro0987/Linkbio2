'use strict';
/**
 * 💳 Karta / Apple Pay / Google Pay via the public "temporary wallet" API used by Card2Crypto.org and PayGate.to
 * (Card2Crypto is a PayGate.to white-label: api.card2crypto.org/control/provider-status redirects to a paygate.to host).
 * Non-custodial for Ryan: the customer pays by card at a provider, USDC (Polygon) is forwarded to Ryan's own 0x address.
 *
 * Flow (docs: https://documenter.getpostman.com/view/40408788/2sAYHxo4T5 and https://documenter.getpostman.com/view/14826208/2sA3Bj9aBi):
 *   1. server: GET <api>/wallet.php?address=<payout>&callback=<urlencoded /wg-callback/<brand>?orderId=…&t=<random secret>>
 *      → address_in (encrypted), polygon_address_in, ipn_token – stored on the order (only a SHA-256 of the secret token is kept).
 *   2. customer: /wg-pay/<orderId> → 302 to <pay>/process-payment.php?address=<address_in>&amount=<total>&provider=<id>&email=<email>&currency=EUR (no iframe).
 *   3. provider bot: GET callback with value_coin (+ txid_in/txid_out) → constant-time token check, value_coin ≈ expected USDC,
 *      order → paid, Telegram to Ryan; txid_out checked on Polygon (public RPC: USDC Transfer to the payout address) – else flagged „overiť“.
 * Payout address is entered by Ryan in admin, validated as 0x EVM, stored AES-256-GCM (sealedStore). Hidden until address + enabled.
 * No fees are shown to customers.
 */
const crypto = require('crypto');
const sealed = require('./sealedStore');

const BRANDS = {
  card2crypto: { id: 'card2crypto', name: 'Card2Crypto', api: 'https://api.card2crypto.org/control', pay: 'https://pay.card2crypto.org', label: 'Karta / Apple Pay / Google Pay' },
  paygate: { id: 'paygate', name: 'PayGate.to', api: 'https://api.paygate.to/control', pay: 'https://checkout.paygate.to', label: 'Platobná karta / Apple Pay / Google Pay' },
};
const METHOD_ID = { card2crypto: 'card2crypto', paygate: 'paygate_direct' };
const BRAND_OF = Object.fromEntries(Object.entries(METHOD_ID).map(([b, m]) => [m, b]));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^ord_[a-f0-9]{16}$/;
const USDC_POLYGON = ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174']; // native USDC, USDC.e
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPCS = () => String(process.env.POLYGON_RPC_URLS || 'https://polygon-bor-rpc.publicnode.com,https://polygon-rpc.com,https://1rpc.io/matic').split(',').map((s) => s.trim()).filter(Boolean);
const LOGOS = ['/logos/visa.svg', '/logos/mastercard.svg', '/logos/applepay.svg', '/logos/googlepay.svg'];

let log = () => {};
const stores = Object.fromEntries(Object.keys(BRANDS).map((b) => [b, sealed.create('wallet-gw-' + b, { addrEnc: '', enabled: false, provider: '', label: '', tolerance: 10, providers: [], providersAt: null })]));
const LABEL = (b) => 'wallet-gw-payout-' + b;
const brandUrl = (b, k) => String(process.env['WG_' + b.toUpperCase() + '_' + k.toUpperCase()] || BRANDS[b][k]).replace(/\/$/, '');
const cfg = (b) => stores[b].get();
function payout(b) { const a = sealed.open(LABEL(b), cfg(b).addrEnc); return ADDR_RE.test(a) ? a : ''; }
function configured(b) { return Boolean(BRANDS[b] && cfg(b).enabled && payout(b) && cfg(b).provider); }
function isMethod(id) { return Object.prototype.hasOwnProperty.call(BRAND_OF, String(id || '').toLowerCase()); }
const mask = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
async function tg(text) { try { const t = global.__telegramBot; const chat = t && t.loadAdminChatId && t.loadAdminChatId(); if (chat) await t.sendMessage(chat, text); } catch { /* best effort */ } }

async function getJson(url, ms = 20000) {
  const r = await fetch(url, { redirect: 'follow', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (lnkbio pay)' }, signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok || !j) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
/** Live provider list (only working ones, with minimums). */
async function fetchProviders(b) {
  // https + trailing slash matters (no slash → http redirect → 500). Card2Crypto's own endpoint redirects to its PayGate.to
  // white-label host (500 at the time of writing) – the provider set is the same, so fall back to PayGate.to's public list.
  let j = null;
  for (const u of [brandUrl(b, 'api') + '/provider-status/', brandUrl('paygate', 'api') + '/provider-status/']) { try { j = await getJson(u); break; } catch (x) { j = null; } }
  if (!j) throw new Error('provider-status nedostupný');
  const list = (Array.isArray(j.providers) ? j.providers : []).filter((p) => p && /^[a-z0-9_-]{2,40}$/i.test(String(p.id || '')) && String(p.status || '').toLowerCase() === 'active')
    .map((p) => ({ id: String(p.id), name: String(p.provider_name || p.id).slice(0, 60), min: Number(p.minimum_amount) || 0, minCur: String(p.minimum_currency || 'USD').toUpperCase().slice(0, 4) }))
    .filter((p) => p.minCur === 'USD' || p.minCur === 'EUR'); // EUR checkout: SEK/INR/CAD-only rails are not usable
  await stores[b].save({ providers: list, providersAt: new Date().toISOString() });
  return list;
}
function minEur(b) { const p = (cfg(b).providers || []).find((x) => x.id === cfg(b).provider); return p ? Math.max(1, Math.ceil(p.min)) : 1; } // USD/EUR minimum: 1 EUR > 1 USD → EUR ≥ min is enough
function status(b) { return { configured: configured(b), soon: false, label: configured(b) ? null : 'nenastavené' }; }

function items() {
  const out = [];
  for (const b of Object.keys(BRANDS)) {
    if (!configured(b)) continue;
    const id = METHOD_ID[b]; const label = cfg(b).label || BRANDS[b].label;
    out.push({ id, providerId: id, provider_name: label, method_label: label, status: 'active', group: 'cards', gateway: 'wallet_gw', configured: true, soon: false, unavailableLabel: null, preferred: false,
      hint: 'Platba kartou Visa / Mastercard, Apple Pay alebo Google Pay na zabezpečenej stránke platobného partnera.', minimum_amount: minEur(b), minimum_currency: 'EUR', logos: LOGOS });
  }
  return out;
}
function inject(res) {
  if (!res || !res.groups) return res;
  const its = items(); if (!its.length) return res;
  if (!res.groups.cards) res.groups.cards = { label: 'Karta', color: null, providers: [], soon: [] };
  const g = res.groups.cards; const have = new Set(g.providers.map((x) => x.id));
  for (const it of its) if (!have.has(it.id)) { g.providers.push(it); (res.providers || (res.providers = [])).push(it); }
  return res;
}

const hits = new Map();
function limited(key, max, win) { const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < win); a.push(now); hits.set(key, a); if (hits.size > 5000) hits.delete(hits.keys().next().value); return a.length > max; }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Called from handleCreateCheckout. */
async function createOrder({ methodId, orderId, amountEur, email, countryCode, ip, baseUrl, loadOrders, saveOrders, appendLog }) {
  const b = BRAND_OF[String(methodId).toLowerCase()];
  if (!b || !configured(b)) { const e = new Error('Tento spôsob platby momentálne nie je dostupný. Vyberte iný.'); e.status = 400; throw e; }
  const amt = Math.round(Number(amountEur) * 100) / 100;
  if (!(amt > 0) || amt > 10000) { const e = new Error('Neplatná suma.'); e.status = 400; throw e; }
  if (amt < minEur(b)) { const e = new Error(`Minimálna suma pre tento spôsob platby je ${minEur(b)} €.`); e.status = 400; throw e; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { const e = new Error('Platný email je povinný'); e.status = 400; throw e; }
  if (limited('wg:' + ip, 8, 10 * 60e3)) { const e = new Error('Príliš veľa pokusov. Skúste to o chvíľu.'); e.status = 429; throw e; }
  const token = crypto.randomBytes(24).toString('hex');
  const cb = `${String(baseUrl).replace(/\/$/, '')}/wg-callback/${b}?orderId=${orderId}&t=${token}`;
  const w = await getJson(`${brandUrl(b, 'api')}/wallet.php?address=${encodeURIComponent(payout(b))}&callback=${encodeURIComponent(cb)}`, 25000);
  if (!w.address_in || !ADDR_RE.test(String(w.polygon_address_in || ''))) throw new Error('wallet: bad response');
  let expectedUsdc = null;
  try { const c = await getJson(`${brandUrl(b, 'api')}/convert.php?value=${amt}&from=eur`, 15000); if (Number(c.value_coin) > 0) expectedUsdc = Number(c.value_coin); } catch { /* fallback below */ }
  const order = {
    orderId, amountEur: amt, amount: amt, currency: 'EUR', country: countryCode, email, provider: METHOD_ID[b], providerAlias: METHOD_ID[b], gateway: 'wallet_gw',
    paymentMethod: 'card', status: 'pending', createdAt: new Date().toISOString(),
    wg: { brand: b, provider: cfg(b).provider, addressIn: String(w.address_in), polygonAddressIn: String(w.polygon_address_in), ipnToken: String(w.ipn_token || '').slice(0, 400), tokenHash: sha(token).toString('hex'), expectedUsdc, payout: mask(payout(b)) },
    checkoutUrl: `/wg-pay/${orderId}`,
  };
  const orders = loadOrders(); orders[orderId] = order; saveOrders(orders);
  (appendLog || log)(`WG_ORDER ${b} ${orderId} eur=${amt} provider=${order.wg.provider} expUsdc=${expectedUsdc ?? '-'}`);
  return order;
}
function processUrl(o) {
  const b = o.wg.brand; let a = o.wg.addressIn; try { a = decodeURIComponent(a); } catch { /* raw */ }
  return `${brandUrl(b, 'pay')}/process-payment.php?address=${encodeURIComponent(a)}&amount=${encodeURIComponent(o.amountEur)}&provider=${encodeURIComponent(o.wg.provider)}&email=${encodeURIComponent(o.email)}&currency=EUR`;
}

async function rpc(method, params) {
  for (const url of RPCS()) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
      const j = await r.json(); if (j && j.result !== undefined) return j.result;
    } catch { /* next */ }
  }
  return undefined;
}
/** USDC (Polygon) actually sent to the payout address in txid_out → amount or null (unknown / not verifiable). */
async function onchainUsdc(txid, payoutAddr) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txid || '')) || !ADDR_RE.test(payoutAddr)) return null;
  const rc = await rpc('eth_getTransactionReceipt', [txid]);
  if (!rc || rc.status !== '0x1' || !Array.isArray(rc.logs)) return null;
  const to = '0x' + payoutAddr.toLowerCase().slice(2).padStart(64, '0');
  let sum = 0;
  for (const l of rc.logs) {
    if (!USDC_POLYGON.includes(String(l.address).toLowerCase()) || !l.topics || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC || String(l.topics[2]).toLowerCase() !== to) continue;
    sum += Number(BigInt(l.data)) / 1e6;
  }
  return sum > 0 ? Math.round(sum * 1e6) / 1e6 : null;
}

function mount(app, deps) {
  const { loadOrders, saveOrders } = deps; log = deps.appendLog || log;
  const find = (id) => (ID_RE.test(String(id || '')) ? loadOrders()[id] : null);
  app.get('/wg-pay/:id', (req, res) => {
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
    const o = find(req.params.id);
    if (!o || o.gateway !== 'wallet_gw' || !o.wg) return res.status(404).type('html').send('<p>Objednávka sa nenašla. <a href="/platby">Späť</a></p>');
    if (o.status === 'paid') return res.redirect(302, '/?paid=' + encodeURIComponent(o.orderId));
    return res.redirect(302, processUrl(o));
  });
  app.get('/wg-callback/:brand', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = String(req.params.brand || ''); const q = req.query || {};
    const id = String(q.orderId || ''); const o = BRANDS[b] ? find(id) : null;
    const tok = String(q.t || '');
    const okTok = Boolean(o && o.wg && o.wg.brand === b && /^[a-f0-9]{48}$/.test(tok) && crypto.timingSafeEqual(sha(tok), Buffer.from(o.wg.tokenHash, 'hex')));
    if (!okTok) { log(`WG_CALLBACK_REJECT ${b} ${ID_RE.test(id) ? id : '-'}`); return res.status(403).send('forbidden'); }
    if (o.status === 'paid') return res.status(200).send('OK');
    const value = Number(q.value_coin);
    if (!(value > 0)) return res.status(400).send('missing value_coin');
    const exp = Number(o.wg.expectedUsdc) > 0 ? Number(o.wg.expectedUsdc) : Number(o.amountEur);
    const tol = Math.min(50, Math.max(0, Number(cfg(b).tolerance) || 10)) / 100;
    const amountOk = value >= exp * (1 - tol);
    const txOut = String(q.txid_out || '').slice(0, 80); const txIn = String(q.txid_in || '').slice(0, 80);
    const orders = loadOrders(); const cur = orders[id];
    cur.status = amountOk ? 'paid' : 'underpaid_review'; if (amountOk) cur.paidAt = new Date().toISOString();
    cur.wg = { ...cur.wg, valueCoin: value, coin: String(q.coin || '').slice(0, 30), txidIn: txIn, txidOut: txOut, callbackAt: new Date().toISOString() };
    saveOrders(orders);
    log(`WG_CALLBACK ${b} ${id} value=${value} exp=${exp} ok=${amountOk}`);
    res.status(200).send('OK');
    // on-chain double check (best effort, after replying)
    let chain = null; try { chain = await onchainUsdc(txOut, payout(b)); } catch { chain = null; }
    const verified = chain != null && chain >= value * 0.98;
    try { const all = loadOrders(); if (all[id]) { all[id].wg = { ...all[id].wg, onchainUsdc: chain, onchainVerified: verified }; saveOrders(all); } } catch { /* */ }
    await tg(`${amountOk ? '💳✅ Zaplatené kartou' : '💳⚠️ Platba kartou – nižšia suma'} (${BRANDS[b].name})\nObjednávka: ${id}\nSuma: ${o.amountEur} EUR (očakávané ≈ ${exp} USDC)\nPrijaté: ${value} USDC (Polygon)\n` +
      (verified ? `Blockchain: ✅ overené (${chain} USDC na výplatnú adresu)` : `Blockchain: ⚠️ overiť – ${txOut ? 'tx ' + txOut : 'bez txid'} (polygonscan.com)`) + (o.email ? `\nEmail: ${o.email}` : ''));
  });

  const ACTIONS = {};
  for (const b of Object.keys(BRANDS)) {
    const view = () => { const c = cfg(b); const a = payout(b); return { ok: true, brand: b, name: BRANDS[b].name, configured: configured(b), enabled: Boolean(c.enabled), addressSet: Boolean(a), addressMasked: mask(a), provider: c.provider || '', label: c.label || '', defaultLabel: BRANDS[b].label, tolerance: Number(c.tolerance) || 10, providers: c.providers || [], providersAt: c.providersAt, encAvailable: Boolean(process.env.DATA_ENC_KEY || process.env.BACKUP_ENC_KEY) }; };
    ACTIONS[b + '_get'] = async () => view();
    ACTIONS[b + '_providers'] = async () => { try { await fetchProviders(b); return view(); } catch (x) { return { ok: false, status: 502, error: 'Zoznam poskytovateľov sa nepodarilo načítať (' + x.message + ').' }; } };
    ACTIONS[b + '_save'] = async (f) => {
      const next = {};
      const addr = String(f.address || '').trim();
      if (addr) {
        if (!ADDR_RE.test(addr)) return { ok: false, status: 400, error: 'Neplatná adresa – zadajte USDC (Polygon) adresu v tvare 0x + 40 znakov.' };
        if (USDC_POLYGON.includes(addr.toLowerCase())) return { ok: false, status: 400, error: 'To je adresa USDC kontraktu, nie vaša peňaženka.' };
        try { next.addrEnc = sealed.seal(LABEL(b), addr); } catch (x) { return { ok: false, status: 400, error: x.message }; }
      } else if (String(f.clearAddress || '') === '1') next.addrEnc = '';
      const prov = String(f.provider || '').trim();
      if (prov && !(cfg(b).providers || []).some((p) => p.id === prov)) return { ok: false, status: 400, error: 'Vyberte poskytovateľa zo zoznamu (najprv „Načítať poskytovateľov“).' };
      next.provider = prov;
      next.label = String(f.label || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60);
      const tol = Number(f.tolerance); next.tolerance = Number.isFinite(tol) && tol >= 0 && tol <= 50 ? tol : 10;
      next.enabled = String(f.enabled || '') === '1';
      await stores[b].save(next);
      log(`WG_CONFIG_SAVED ${b} addr=${payout(b) ? 'set' : 'none'} enabled=${cfg(b).enabled} provider=${cfg(b).provider || '-'}`);
      return view();
    };
  }
  require('./payMethods').serveSigned(app, '/api/admin-bridge/wallet-gw', ACTIONS, 'WALLETGW');
}
async function init(appendLog) { if (appendLog) log = appendLog; for (const s of Object.values(stores)) await s.load(); }

module.exports = { BRANDS, METHOD_ID, isMethod, configured, status, items, inject, createOrder, processUrl, mount, init, onchainUsdc, fetchProviders,
  _store: (b) => stores[b], _seal: (b, a) => sealed.seal(LABEL(b), a) };
