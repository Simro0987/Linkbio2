'use strict';
/**
 * „Krypto – priamo na peňaženku“: customer pays straight to Ryan's own receive address.
 * Address = FIRST ENABLED address of the network in admin „Adresy peňaženiek“ (wallets.js, Neon). BTCPay is never used.
 * Coins without an enabled address are hidden; the whole method is hidden when no coin has one.
 * UTXO coins (BTC/LTC/BCH/DOGE) are watched by chainWatcher against a creation-time baseline (addresses are reused);
 * other networks are „nesledované“ — Ryan gets a Telegram message on order creation and when the customer clicks „Odoslal som“.
 */
const QRCode = require('qrcode');
const wallets = require('./wallets');
const watcher = require('./chainWatcher');
const { sameOrigin } = require('./payMethods');

const GATEWAY = 'crypto_direct';
// net = wallets network (forChain); cg = CoinGecko id (EUR price); dp = decimals shown; uri = QR scheme with amount
const ASSETS = [
  { id: 'btc', label: 'Bitcoin (BTC)', group: 'Bitcoin', net: 'btc', tk: 'BTC', cg: 'bitcoin', dp: 8, uri: 'bitcoin', watch: 'btc' },
  { id: 'btc_ln', label: 'Bitcoin – Lightning', group: 'Bitcoin', net: 'lightning', tk: 'BTC', cg: 'bitcoin', dp: 8, ln: true },
  { id: 'ltc', label: 'Litecoin (LTC)', group: 'Ďalšie mince', net: 'ltc', tk: 'LTC', cg: 'litecoin', dp: 8, uri: 'litecoin', watch: 'ltc' },
  { id: 'bch', label: 'Bitcoin Cash (BCH)', group: 'Ďalšie mince', net: 'bch', tk: 'BCH', cg: 'bitcoin-cash', dp: 8, uri: 'bitcoincash', watch: 'bch' },
  { id: 'doge', label: 'Dogecoin (DOGE)', group: 'Ďalšie mince', net: 'doge', tk: 'DOGE', cg: 'dogecoin', dp: 4, uri: 'dogecoin', watch: 'doge' },
  { id: 'xmr', label: 'Monero (XMR)', group: 'Ďalšie mince', net: 'xmr', tk: 'XMR', cg: 'monero', dp: 6, uri: 'monero' },
  { id: 'xrp', label: 'XRP', group: 'Ďalšie mince', net: 'xrp', tk: 'XRP', cg: 'ripple', dp: 3 },
  { id: 'ton', label: 'Toncoin (TON)', group: 'Ďalšie mince', net: 'ton', tk: 'TON', cg: 'the-open-network', dp: 3 },
  { id: 'eth', label: 'Ether (ETH) – Ethereum', group: 'Ethereum', net: 'eth', tk: 'ETH', cg: 'ethereum', dp: 6 },
  { id: 'usdt_eth', label: 'USDT – Ethereum (ERC-20)', group: 'Ethereum', net: 'eth', tk: 'USDT', cg: 'tether', dp: 2 },
  { id: 'usdc_eth', label: 'USDC – Ethereum (ERC-20)', group: 'Ethereum', net: 'eth', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'eth_base', label: 'ETH – Base', group: 'Base', net: 'base', tk: 'ETH', cg: 'ethereum', dp: 6 },
  { id: 'usdc_base', label: 'USDC – Base', group: 'Base', net: 'base', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'eth_arb', label: 'ETH – Arbitrum One', group: 'Arbitrum', net: 'arbitrum', tk: 'ETH', cg: 'ethereum', dp: 6 },
  { id: 'usdc_arb', label: 'USDC – Arbitrum One', group: 'Arbitrum', net: 'arbitrum', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'usdt_arb', label: 'USDT – Arbitrum One', group: 'Arbitrum', net: 'arbitrum', tk: 'USDT', cg: 'tether', dp: 2 },
  { id: 'eth_op', label: 'ETH – Optimism', group: 'Optimism', net: 'optimism', tk: 'ETH', cg: 'ethereum', dp: 6 },
  { id: 'usdc_op', label: 'USDC – Optimism', group: 'Optimism', net: 'optimism', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'pol', label: 'POL – Polygon', group: 'Polygon', net: 'polygon', tk: 'POL', cg: 'polygon-ecosystem-token', dp: 3 },
  { id: 'usdc_pol', label: 'USDC – Polygon', group: 'Polygon', net: 'polygon', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'usdt_pol', label: 'USDT – Polygon', group: 'Polygon', net: 'polygon', tk: 'USDT', cg: 'tether', dp: 2 },
  { id: 'bnb', label: 'BNB – BNB Smart Chain', group: 'BNB Smart Chain', net: 'bsc', tk: 'BNB', cg: 'binancecoin', dp: 6 },
  { id: 'usdt_bsc', label: 'USDT – BSC (BEP-20)', group: 'BNB Smart Chain', net: 'bsc', tk: 'USDT', cg: 'tether', dp: 2 },
  { id: 'usdc_bsc', label: 'USDC – BSC (BEP-20)', group: 'BNB Smart Chain', net: 'bsc', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'sol', label: 'Solana (SOL)', group: 'Solana', net: 'sol', tk: 'SOL', cg: 'solana', dp: 4 },
  { id: 'usdc_sol', label: 'USDC – Solana (SPL)', group: 'Solana', net: 'sol', tk: 'USDC', cg: 'usd-coin', dp: 2 },
  { id: 'usdt_sol', label: 'USDT – Solana (SPL)', group: 'Solana', net: 'sol', tk: 'USDT', cg: 'tether', dp: 2 },
  { id: 'trx', label: 'Tron (TRX)', group: 'Tron', net: 'trx', tk: 'TRX', cg: 'tron', dp: 2 },
  { id: 'usdt_trx', label: 'USDT – Tron (TRC-20)', group: 'Tron', net: 'trx', tk: 'USDT', cg: 'tether', dp: 2 },
];
const BY_ID = Object.fromEntries(ASSETS.map((a) => [a.id, a]));
const NET_NOTE = { eth: 'sieť Ethereum', base: 'sieť Base', arbitrum: 'sieť Arbitrum One', optimism: 'sieť Optimism', polygon: 'sieť Polygon PoS', bsc: 'sieť BNB Smart Chain (BEP-20)', sol: 'sieť Solana', trx: 'sieť Tron (TRC-20)' };

const addrFor = (a) => wallets.forChain(a.net);
const xpub = require('./xpub');
function available() { if (!wallets.isReady()) return []; return ASSETS.filter((a) => addrFor(a)); }
const enabled = () => available().length > 0;

/* ---------- EUR prices (CoinGecko public API, 60 s cache; failures → EUR-only display) ---------- */
const PRICE = { at: 0, eur: {}, pending: null };
async function prices() {
  if (Date.now() - PRICE.at < 60e3 && Object.keys(PRICE.eur).length) return PRICE.eur;
  if (!PRICE.pending) {
    const ids = [...new Set(ASSETS.map((a) => a.cg))].join(',');
    PRICE.pending = fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=eur`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((j) => { const out = {}; for (const [k, v] of Object.entries(j || {})) if (v && Number(v.eur) > 0) out[k] = Number(v.eur); if (Object.keys(out).length) { PRICE.eur = out; PRICE.at = Date.now(); } return PRICE.eur; })
      .catch(() => PRICE.eur)
      .finally(() => { PRICE.pending = null; });
  }
  return PRICE.pending;
}
function cryptoAmount(asset, eur, px) {
  const p = px && px[asset.cg]; if (!(p > 0) || !(eur > 0)) return null;
  const f = 10 ** asset.dp; const v = Math.ceil((eur / p) * f) / f; // round UP so the payment is never short
  return { amount: v.toFixed(asset.dp), rate: p, at: new Date().toISOString() };
}

function qrText(o) {
  const a = BY_ID[o.asset]; if (!a) return o.address;
  if (a.ln) return o.address;
  if (a.uri && o.amountCrypto) {
    const base = a.uri === 'bitcoincash' ? o.address : `${a.uri}:${o.address}`;
    return `${base}?${a.uri === 'monero' ? 'tx_amount' : 'amount'}=${o.amountCrypto}`;
  }
  if (a.uri && a.uri !== 'monero') return a.uri === 'bitcoincash' ? o.address : `${a.uri}:${o.address}`;
  return o.address;
}

/** Fill asset/address/amount on an order (creation or asset switch). Returns error text or null. */
async function assign(order, assetId, appendLog) {
  const list = available();
  const a = BY_ID[assetId] && list.includes(BY_ID[assetId]) ? BY_ID[assetId] : list[0];
  if (!a) return 'Platba kryptom momentálne nie je dostupná.';
  let w = addrFor(a);
  // xpub configured for this coin (admin → xpub) → fresh derived receive address per order; otherwise the fixed wallet address (unchanged)
  const hd = a.watch && xpub.has(a.watch) ? await xpub.nextAddress(a.watch, order.orderId) : null;
  if (hd) w = { address: hd.address, memo: null, id: `xpub:${a.watch}:${hd.index}` };
  const q = cryptoAmount(a, Number(order.amountEur), await prices());
  Object.assign(order, {
    asset: a.id, assetLabel: a.label, ticker: a.tk, network: a.net, address: w.address, memo: w.memo || null, walletId: w.id,
    amountCrypto: q ? q.amount : null, rateEur: q ? q.rate : null, rateAt: q ? q.at : null,
    payoutCoin: a.watch || null, payoutAddress: a.watch ? w.address : null, xpubAddr: hd ? { coin: a.watch, index: hd.index } : null,
    chainBaseline: null, chainBaselinePending: !!a.watch, chainStatus: null, watched: !!a.watch,
  });
  if (a.watch) {
    const b = await watcher.baseline(a.watch, w.address).catch(() => null);
    if (b) { order.chainBaseline = b; order.chainBaselinePending = false; }
    else if (appendLog) appendLog(`CRYPTO_DIRECT_BASELINE_LATER ${order.orderId} ${a.watch}`);
  }
  return null;
}

async function tg(text) {
  try { const t = global.__telegramBot; const chat = t && t.loadAdminChatId && t.loadAdminChatId(); if (chat) await t.sendMessage(chat, text); } catch { /* best effort */ }
}
const orderLine = (o) => `Objednávka: ${o.orderId}\nSuma: ${o.amountEur} EUR${o.amountCrypto ? ` ≈ ${o.amountCrypto} ${o.ticker}` : ''}\nMena: ${o.assetLabel}\nAdresa: ${o.address}${o.memo ? `\nMemo/tag: ${o.memo}` : ''}\nSledovanie: ${o.watched ? 'automaticky (blockchain)' : 'nesledované – skontrolujte peňaženku'}`;

/** Called from handleCreateCheckout. */
async function createOrder({ orderId, amountEur, countryCode, providerAlias, email, asset, loadOrders, saveOrders, appendLog }) {
  const order = {
    orderId, amountEur, amount: amountEur, currency: 'EUR', country: countryCode, email: email || undefined,
    provider: GATEWAY, providerAlias, gateway: GATEWAY, paymentMethod: 'crypto', resolution: 'crypto_direct',
    status: 'awaiting_payment', createdAt: new Date().toISOString(),
  };
  const err = await assign(order, asset, appendLog);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  order.checkoutUrl = order.localPayUrl = `/crypto-pay?orderId=${encodeURIComponent(orderId)}`;
  const orders = loadOrders(); orders[orderId] = order; saveOrders(orders);
  appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=crypto_direct asset=${order.asset} addr=${wallets.short(order.address)}`);
  tg(`🪙 Nová objednávka – krypto priamo na peňaženku\n${orderLine(order)}`);
  return order;
}

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ID_RE = /^ord_[a-f0-9]{16}$/;

function page(o, msg) {
  const list = available();
  const groups = [];
  for (const a of list) { let g = groups.find((x) => x.name === a.group); if (!g) groups.push(g = { name: a.group, items: [] }); g.items.push(a); }
  const locked = o.paidMarkedAt || o.chainStatus === 'unconfirmed' || o.chainStatus === 'confirmed';
  const a = BY_ID[o.asset] || {};
  const amountRow = o.amountCrypto
    ? `<div class="cprow"><code id="amt">${esc(o.amountCrypto)}</code><span class="unit">${esc(o.ticker)}</span><button type="button" data-cp="amt">Kopírovať</button></div><small>= ${esc(o.amountEur)} EUR · kurz ${esc(Number(o.rateEur).toLocaleString('sk-SK'))} EUR/${esc(o.ticker)}${a.ln ? ` · ${esc(Math.round(Number(o.amountCrypto) * 1e8).toLocaleString('sk-SK'))} sats` : ''}</small>`
    : `<p><b>${esc(o.amountEur)} EUR</b> v ${esc(o.ticker)} – kurz sa teraz nepodarilo načítať, pošlite ekvivalent podľa aktuálneho kurzu.</p>`;
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Platba kryptom</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#111}
.grid{display:grid;grid-template-columns:1fr 280px;gap:16px;align-items:start}@media(max-width:720px){.grid{grid-template-columns:1fr}}
.box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
code{display:block;word-break:break-all;background:#f5f5f5;padding:10px;border-radius:8px;font-size:17px;margin:8px 0}
.cprow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cprow code{flex:1 1 200px}.unit{font-weight:700}
button,.btn{background:#0666eb;color:#fff;border:0;border-radius:8px;padding:12px 14px;font-size:16px;cursor:pointer;text-decoration:none;display:inline-block}
select{width:100%;padding:12px;border-radius:8px;font-size:16px;border:1px solid #ccc}
.qr{text-align:center}.qr img{width:100%;max-width:260px;height:auto;background:#fff;border-radius:12px;padding:8px}
.warn{background:#fff7ed;border:2px solid #f59e0b;color:#7c2d12;border-radius:10px;padding:12px;margin:10px 0;font-weight:600}
.wide{width:100%;padding:16px;font-size:17px;text-align:center}.ok{background:#16a34a}small{color:#555}.msg{font-weight:700}
.logo{height:28px;vertical-align:middle;margin-right:8px;background:#fff;border-radius:6px;padding:2px}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body>
<h2><img class="logo" src="/logos/generic-wallet.svg?v=20261023" alt="">Platba kryptom – priamo na peňaženku</h2>
${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
<div class="grid"><div>
<form class="box" method="post" action="/crypto-pay/${esc(o.orderId)}/asset"><label for="asset"><b>Mena a sieť</b></label>
<select id="asset" name="asset"${locked ? ' disabled' : ''}>${groups.map((g) => `<optgroup label="${esc(g.name)}">${g.items.map((x) => `<option value="${esc(x.id)}"${x.id === o.asset ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</optgroup>`).join('')}</select>
${locked ? '' : '<button type="submit" style="margin-top:8px">Zmeniť menu</button>'}</form>
<div class="box"><div><b>Suma na odoslanie</b></div>${amountRow}</div>
<div class="box"><div><b>Adresa príjemcu</b> <small>(${esc(o.assetLabel)})</small></div><code id="addr">${esc(o.address)}</code>
<button type="button" class="wide" data-cp="addr">📋 Kopírovať adresu</button>
${o.memo ? `<div style="margin-top:10px"><b>${o.network === 'xrp' ? 'Destination tag' : 'Memo / komentár'} (povinné)</b><code id="memo">${esc(o.memo)}</code><button type="button" data-cp="memo">Kopírovať</button></div>` : ''}
<div class="warn">⚠️ Posielajte len ${esc(o.ticker)}${NET_NOTE[o.network] ? ` cez ${esc(NET_NOTE[o.network])}` : ''}. Iná mena alebo sieť = strata prostriedkov.${a.ln ? ' Lightning: zaplaťte na túto Lightning adresu z LN peňaženky.' : ''}</div></div>
</div><div>
<div class="box qr"><img src="/api/crypto-pay/${esc(o.orderId)}/qr.png?a=${esc(o.asset)}" alt="QR kód adresy" width="260" height="260"><br><small>Naskenujte v peňaženke${o.amountCrypto && a.uri ? ' (QR obsahuje aj sumu)' : ''}</small></div>
${o.watched ? `<div id="chainStatus" data-order-id="${esc(o.orderId)}"></div>` : '<div class="box"><small>Táto sieť sa nesleduje automaticky – po odoslaní kliknite nižšie, platbu overíme ručne.</small></div>'}
<form method="post" action="/crypto-pay/${esc(o.orderId)}/paid"><button class="btn wide ok" type="submit"${o.paidMarkedAt ? ' disabled' : ''}>${o.paidMarkedAt ? '✅ Ďakujeme, platbu overujeme' : 'Odoslal som platbu'}</button></form>
</div></div>
<p><small>Objednávka ${esc(o.orderId)}</small></p>
${require('./guideStore').html('crypto_direct', { amount: o.amountEur })}
${o.watched ? '<script src="/chain-status.js" defer></script>' : ''}<script src="/chat-widget.js" defer></script></body></html>`;
}

function mount(app, { loadOrders, saveOrders, appendLog }) {
  const find = (id) => (ID_RE.test(String(id || '')) ? loadOrders()[id] : null);
  const ok = (o) => o && o.provider === GATEWAY;
  app.get('/crypto-pay', (req, res) => {
    const o = find(req.query.orderId);
    if (!ok(o)) return res.status(404).type('html').send('<p>Objednávka sa nenašla. <a href="/platby">Späť</a></p>');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(page(o, { asset: 'Mena bola zmenená – skontrolujte novú adresu a sumu.', paid: 'Ďakujeme, platbu overujeme.', locked: 'Platba už prebieha – menu nie je možné zmeniť.', na: 'Táto mena nie je dostupná.' }[req.query.m] || ''));
  });
  app.get('/api/crypto-pay/:id/qr.png', async (req, res) => {
    const o = find(req.params.id); if (!ok(o)) return res.status(404).end();
    try {
      const png = await QRCode.toBuffer(qrText(o), { type: 'png', width: 520, margin: 2, errorCorrectionLevel: 'M' });
      res.set('Cache-Control', 'no-store'); res.type('png').send(png);
    } catch { res.status(500).end(); }
  });
  app.post('/crypto-pay/:id/asset', require('express').urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).send('Neplatný pôvod požiadavky');
    const orders = loadOrders(); const o = orders[req.params.id];
    if (!ID_RE.test(req.params.id) || !ok(o)) return res.status(404).send('Objednávka sa nenašla');
    const back = (m) => res.redirect(303, `/crypto-pay?orderId=${encodeURIComponent(o.orderId)}&m=${m}`);
    if (o.paidMarkedAt || o.chainStatus === 'unconfirmed' || o.chainStatus === 'confirmed') return back('locked');
    const want = String((req.body && req.body.asset) || '');
    if (!BY_ID[want] || !available().includes(BY_ID[want])) return back('na');
    if (want === o.asset) return back('asset');
    const err = await assign(o, want, appendLog); if (err) return back('na');
    const fresh = loadOrders(); fresh[o.orderId] = { ...fresh[o.orderId], ...o }; saveOrders(fresh);
    appendLog(`CRYPTO_DIRECT_ASSET ${o.orderId} ${o.asset}`);
    back('asset');
  });
  app.post('/crypto-pay/:id/paid', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).send('Neplatný pôvod požiadavky');
    const orders = loadOrders(); const o = orders[req.params.id];
    if (!ID_RE.test(req.params.id) || !ok(o)) return res.status(404).send('Objednávka sa nenašla');
    if (!o.paidMarkedAt) {
      o.paidMarkedAt = new Date().toISOString(); saveOrders(orders);
      appendLog(`CRYPTO_DIRECT_PAID_MARKED ${o.orderId}`);
      tg(`🙋 Zákazník hlási odoslanie – krypto priamo\n${orderLine(o)}`);
    }
    res.redirect(303, `/crypto-pay?orderId=${encodeURIComponent(o.orderId)}&m=paid`);
  });
}

module.exports = { GATEWAY, ASSETS, available, enabled, createOrder, mount, qrText, prices, _assign: assign };
