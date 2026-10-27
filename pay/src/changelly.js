'use strict';
/**
 * Changelly fiat on-ramp („Kúpiť kartou / Revolut / SEPA (Changelly)“).
 * The customer buys crypto on changelly.com/buy with EUR and it is sent straight to Ryan's own receive address.
 * - Coin: first of LTC → BTC → BCH → DOGE that has an enabled address in admin „Adresy peňaženiek“
 *   (all four are auto-detected by chainWatcher and offered by Changelly for EUR).
 * - Address: round-robin over the enabled addresses of that network (next after the last Changelly order's address).
 * - Order: same shape as crypto_direct (payoutCoin/payoutAddress/baseline) → chainWatcher detects + Telegram.
 * - Tolerance: on confirmation, received crypto × current EUR price ≥ PAID_RATIO × order EUR → status 'paid',
 *   otherwise 'partial' + Telegram notice to Ryan (provider fees/spread are taken from the crypto amount).
 * NOTE: the Changelly fiat widget with address prefill (widget.changelly.com …type=no-rev-share) is discontinued
 * („No longer available“); changelly.com/buy prefills EUR amount + coin but NOT the address → the customer pastes it.
 * CHANGELLY_URL_TEMPLATE can swap in a partner URL later ({coin} {eur} {address} placeholders).
 *
 * Revolut Ramp („Revolut“ button, gateway 'revolut_ramp') reuses the same order / watcher / tolerance logic:
 * ramp.revolut.com/?amount=<EUR cents>&fiatCurrency=EUR&cryptoCurrency=<TK>&walletAddress=<addr>… (no partnerId needed).
 * Amount + coin are prefilled; the wallet address is NOT (customer logs in with Revolut and pastes it under „To“).
 * Ramp buys BTC/LTC/DOGE/BCH (ramp-api/config buyActive=true), min 6 € (ramp-api/limits minAmount 600).
 */
const wallets = require('./wallets');
const watcher = require('./chainWatcher');
const cryptoDirect = require('./cryptoDirect');
const { sameOrigin } = require('./payMethods');
const guides = require('./guideStore');

const GATEWAY = 'changelly';
const RAMP = 'revolut_ramp';
const GATEWAYS = new Set([GATEWAY, RAMP]);
const COIN_ORDER = ['ltc', 'btc', 'bch', 'doge'];
// Ramp: BCH last — its explorer (fullstack.cash) gives no amounts → only manual check possible.
const RAMP_COIN_ORDER = ['ltc', 'btc', 'doge', 'bch'];
const DP = { ltc: 8, btc: 8, bch: 8, doge: 4 };
const VARIANTS = {
  changelly_card: { pay: 'card', label: 'Karta', labelEn: 'Card' },
  changelly_sepa: { pay: 'sepa', label: 'SEPA', labelEn: 'SEPA bank transfer' },
  changelly_revolut: { pay: 'revolut', label: 'Revolut (Changelly)', labelEn: 'Revolut (Changelly)' }, // legacy orders only
  revolut_ramp: { pay: 'revolut', gw: RAMP, label: 'Revolut', labelEn: 'Revolut' },
};
const gwOf = (o) => (o && (o.provider === RAMP || o.gateway === RAMP) ? RAMP : GATEWAY);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const MIN_EUR = () => num(process.env.CHANGELLY_MIN_EUR, 10); // below ~10 € the providers' fixed fees eat 40 %+
const MIN_EUR_REVOLUT = () => num(process.env.CHANGELLY_MIN_EUR_REVOLUT, 20); // MoonPay (Revolut) minimum is 20 €
const MIN_EUR_RAMP = () => num(process.env.REVOLUT_RAMP_MIN_EUR, 6); // Ramp limits minAmount = 600 (EUR cents)
const PAID_RATIO = () => Math.min(1, num(process.env.CHANGELLY_PAID_RATIO, 0.85));
const xpub = require('./xpub');
const asset = (coin) => cryptoDirect.ASSETS.find((a) => a.id === coin);

function pickCoin(gw) {
  if (!wallets.isReady()) return null;
  return (gw === RAMP ? RAMP_COIN_ORDER : COIN_ORDER).find((c) => wallets.enabledAddresses(c).length > 0) || null;
}
const enabled = (gw) => !!pickCoin(gw);

/** Next enabled address after the one used by the latest Changelly order on this network. */
function nextAddress(coin, orders, gw = GATEWAY) {
  const list = wallets.enabledAddresses(coin);
  if (!list.length) return null;
  let last = null;
  for (const o of Object.values(orders || {})) {
    if (o && GATEWAYS.has(o.provider) && o.payoutCoin === coin && (!last || String(o.createdAt) > String(last.createdAt))) last = o;
  }
  const i = last ? list.findIndex((w) => w.id === last.walletId || w.address === last.payoutAddress) : -1;
  return list[(i + 1) % list.length];
}

function rampUrl(o) {
  const cc = /^[A-Z]{2}$/.test(String(o.country || '').toUpperCase()) ? String(o.country).toUpperCase() : 'SK';
  const q = new URLSearchParams({ amount: String(Math.round(Number(o.amountEur) * 100)), fiatCurrency: 'EUR', cryptoCurrency: String(o.ticker || o.payoutCoin).toUpperCase(),
    walletAddress: o.payoutAddress, disableWalletAddress: 'true', disableFiatAmount: 'true', countryCode: cc });
  return 'https://ramp.revolut.com/?' + q.toString();
}

function buyUrl(o) {
  if (gwOf(o) === RAMP) return rampUrl(o);
  const tpl = String(process.env.CHANGELLY_URL_TEMPLATE || '').trim() || 'https://changelly.com/buy?from=eur&to={coin}&amount={eur}';
  return tpl.replace(/\{coin\}/g, encodeURIComponent(o.payoutCoin)).replace(/\{eur\}/g, encodeURIComponent(String(o.amountEur)))
    .replace(/\{address\}/g, encodeURIComponent(o.payoutAddress));
}

async function tg(text) {
  try { const t = global.__telegramBot; const chat = t && t.loadAdminChatId && t.loadAdminChatId(); if (chat) await t.sendMessage(chat, text); } catch { /* best effort */ }
}
const line = (o) => `Objednávka: ${o.orderId}\nSuma: ${o.amountEur} EUR${o.amountCrypto ? ` ≈ ${o.amountCrypto} ${o.ticker}` : ''}\nMena: ${o.ticker}\nAdresa: ${o.payoutAddress}\nVariant: ${gwOf(o) === RAMP ? 'Revolut (Revolut Ramp)' : o.payVariant === 'revolut' ? 'Revolut (Changelly)' : o.payVariant === 'sepa' ? 'SEPA (Changelly)' : 'Karta (Changelly)'}`;
const brand = (o) => (gwOf(o) === RAMP ? 'Revolut Ramp' : 'Changelly');

async function createOrder({ orderId, amountEur, countryCode, providerAlias, email, loadOrders, saveOrders, appendLog }) {
  const v = VARIANTS[providerAlias] || VARIANTS.changelly_card;
  const gw = v.gw || GATEWAY;
  const min = gw === RAMP ? MIN_EUR_RAMP() : v.pay === 'revolut' ? MIN_EUR_REVOLUT() : MIN_EUR();
  if (!(amountEur >= min)) { const e = new Error(`Minimálna suma pre túto metódu je ${min} EUR.`); e.status = 400; throw e; }
  const coin = pickCoin(gw);
  if (!coin) { const e = new Error('Táto metóda momentálne nie je dostupná.'); e.status = 400; throw e; }
  let w = nextAddress(coin, loadOrders(), gw);
  const hd = xpub.has(coin) ? await xpub.nextAddress(coin, orderId) : null; // derived fresh address when an xpub is set
  if (hd) w = { address: hd.address, id: `xpub:${coin}:${hd.index}` };
  const a = asset(coin);
  const px = await cryptoDirect.prices();
  const p = px && px[a.cg];
  const order = {
    orderId, amountEur, amount: amountEur, currency: 'EUR', country: countryCode, email: email || undefined,
    provider: gw, providerAlias, methodId: providerAlias, gateway: gw, paymentMethod: v.pay, payVariant: v.pay, resolution: gw === RAMP ? 'revolut_ramp' : 'changelly_buy',
    status: 'awaiting_payment', createdAt: new Date().toISOString(),
    asset: coin, assetLabel: a.label, ticker: a.tk, network: coin, address: w.address, walletId: w.id,
    amountCrypto: p > 0 ? (amountEur / p).toFixed(DP[coin]) : null, rateEur: p > 0 ? p : null, rateAt: p > 0 ? new Date().toISOString() : null,
    payoutCoin: coin, payoutAddress: w.address, chainBaseline: null, chainBaselinePending: true, chainStatus: null, watched: true,
    paidRatio: PAID_RATIO(),
  };
  const b = await watcher.baseline(coin, w.address).catch(() => null);
  if (b) { order.chainBaseline = b; order.chainBaselinePending = false; } else appendLog(`${gw.toUpperCase()}_BASELINE_LATER ${orderId} ${coin}`);
  order.changellyUrl = buyUrl(order);
  order.checkoutUrl = order.localPayUrl = `${gw === RAMP ? '/revolut-ramp-pay' : '/changelly-pay'}?orderId=${encodeURIComponent(orderId)}`;
  const orders = loadOrders(); orders[orderId] = order; saveOrders(orders);
  appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=${gw} variant=${v.pay} coin=${coin} addr=${wallets.short(w.address)}`);
  tg(`🚀 Nová objednávka – ${brand(order)}\n${line(order)}`);
  return order;
}

/** chainWatcher hook (server onStatus): amount check against the EUR price → 'paid' / 'partial'. */
async function onChainStatus(order, status, r, { loadOrders, saveOrders, appendLog }) {
  if (!order || !GATEWAYS.has(order.provider)) return;
  const sat = r && Number(r.newSat) > 0 ? Number(r.newSat) : null;
  const a = asset(order.payoutCoin);
  const px = await cryptoDirect.prices().catch(() => ({}));
  const p = a && px ? px[a.cg] : null;
  const recvCoin = sat != null ? sat / 1e8 : null;
  const recvEur = recvCoin != null && p > 0 ? Math.round(recvCoin * p * 100) / 100 : null;
  const ratio = recvEur != null && order.amountEur > 0 ? recvEur / Number(order.amountEur) : null;
  const need = Number(order.paidRatio) > 0 ? Number(order.paidRatio) : PAID_RATIO();
  const fresh = loadOrders(); const f = fresh[order.orderId]; if (!f) return;
  f.chainStatus = status; f.chainStatusAt = order.chainStatusAt || new Date().toISOString();
  if (recvCoin != null) { f.receivedCrypto = recvCoin.toFixed(DP[order.payoutCoin] || 8); f.receivedEur = recvEur; f.receivedRatio = ratio != null ? Math.round(ratio * 1000) / 1000 : null; }
  let verdict = null;
  if (status === 'confirmed') {
    if (ratio == null) { verdict = 'unknown'; f.status = 'received_check'; }
    else if (ratio >= need) { verdict = 'paid'; f.status = 'paid'; f.paidAt = new Date().toISOString(); }
    else { verdict = 'partial'; f.status = 'partial'; }
  }
  saveOrders(fresh);
  appendLog(`${gwOf(order).toUpperCase()}_CHAIN ${order.orderId} ${status} recv=${f.receivedCrypto || '?'} eur=${recvEur ?? '?'} ratio=${ratio != null ? ratio.toFixed(3) : '?'}${verdict ? ' → ' + verdict : ''}`);
  const got = recvCoin != null ? `\nPrijaté: ${f.receivedCrypto} ${order.ticker}${recvEur != null ? ` ≈ ${recvEur} EUR (${Math.round(ratio * 100)} %)` : ''}` : '';
  if (verdict === 'partial') tg(`⚠️ ${brand(order)} – ČIASTOČNÁ platba (pod ${Math.round(need * 100)} %)\n${line(order)}${got}\nSkontrolujte a rozhodnite ručne.`);
  else if (verdict === 'unknown') tg(`❔ ${brand(order)} – platba potvrdená, sumu sa nepodarilo overiť (explorer bez súm)\n${line(order)}\nSkontrolujte peňaženku.`);
  else if (verdict === 'paid') tg(`✅ ${brand(order)} – zaplatené\n${line(order)}${got}`);
}

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ID_RE = /^ord_[a-f0-9]{16}$/;

/** Minimal 4-step guides (SK + EN). */
function steps(o) {
  if (gwOf(o) === RAMP) return {
    sk: ['Skopírujte adresu (📋).', 'Kliknite „Pokračovať do Revolut“ a prihláste sa.', 'Pri „To“ zvoľte „My wallet“ (MetaMask / Trust Wallet) a vložte adresu.', 'Zaplaťte – sumu nemeňte.'],
    en: ['Copy the address (📋).', 'Tap “Continue to Revolut” and log in.', 'At “To” choose “My wallet” (MetaMask / Trust Wallet) and paste the address.', 'Pay – don’t change the amount.'],
  };
  const sepa = o.payVariant === 'sepa';
  return {
    sk: ['Skopírujte adresu (📋).',
      sepa ? 'Kliknite „Pokračovať na Changelly“ → „View All Offers“ → „SEPA“ → „Next step“.' : 'Kliknite „Pokračovať na Changelly“ → „Next step“ (na mobile „Stay in browser“).',
      'Vložte adresu do „Destination address“ → „Next step“.',
      sepa ? 'Zaplaťte bankovým prevodom podľa pokynov (prvýkrát e-mail + overenie totožnosti).' : 'Zaplaťte kartou, Apple Pay alebo Google Pay (prvýkrát e-mail + overenie totožnosti).'],
    en: ['Copy the address (📋).',
      sepa ? 'Click “Continue to Changelly” → “View All Offers” → “SEPA” → “Next step”.' : 'Click “Continue to Changelly” → “Next step” (on mobile “Stay in browser”).',
      'Paste the address into “Destination address” → “Next step”.',
      sepa ? 'Pay by bank transfer as instructed (first time e-mail + ID check).' : 'Pay by card, Apple Pay or Google Pay (first time e-mail + ID check).'],
  };
}

function page(o) {
  const s = steps(o);
  const rev = o.payVariant === 'revolut';
  const ramp = gwOf(o) === RAMP;
  const sepa = o.payVariant === 'sepa';
  const LV = '?v=20261026';
  const logos = (ramp || rev ? ['revolut.svg'] : sepa ? ['sepa.svg'] : ['visa.svg', 'mastercard.svg', 'applepay.svg', 'googlepay.svg']).map((f) => '/logos/' + f + LV);
  const title = ramp || rev ? 'Revolut' : sepa ? 'SEPA' : 'Karta';
  const sub = ramp ? 'cez Revolut Ramp' : 'cez Changelly';
  const goLabel = ramp ? 'Pokračovať do Revolut →' : 'Pokračovať na Changelly →';
  const note = ramp
    ? 'Revolut vyplní sumu a menu; adresu vložte po prihlásení v časti „To“. · Revolut prefills amount and coin; paste the address under “To” after logging in.'
    : 'Changelly vyplní sumu a menu; adresu vložte sami (Changelly ju neumožňuje predvyplniť). · Changelly prefills amount and coin; paste the address yourself.';
  const done = o.status === 'paid' || o.chainStatus === 'confirmed';
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(ramp ? 'Platba cez Revolut' : 'Platba cez Changelly')}</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:860px;margin:20px auto;padding:0 14px;color:#111;line-height:1.45}
h2{display:flex;align-items:center;gap:10px;font-size:clamp(19px,5vw,26px);margin:8px 0 4px}
.logo{height:36px;width:auto;min-width:36px;max-width:90px;object-fit:contain;border-radius:8px;flex:none;background:#fff;padding:3px}.logos{display:inline-flex;gap:4px;flex-wrap:wrap}.sub{font-size:14px;font-weight:500;opacity:.7}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}@media(max-width:720px){.grid{grid-template-columns:1fr}}
.box{border:1px solid #ddd;border-radius:12px;padding:14px;margin:10px 0}
code{display:block;word-break:break-all;background:#f5f5f5;padding:10px;border-radius:8px;font-size:16px;margin:8px 0}
.btn,button{background:#0666eb;color:#fff;border:0;border-radius:10px;padding:14px;font-size:17px;cursor:pointer;text-decoration:none;display:block;width:100%;text-align:center;font-weight:700}
.go{background:#16a34a;margin-top:10px}.copy{background:#334155}.copy.big{font-size:21px;padding:20px}.done{font-size:14px;opacity:.8;margin-top:8px}.go.rev{background:#0666eb}
.warn{background:#fff7ed;border:2px solid #f59e0b;color:#7c2d12;border-radius:10px;padding:12px;margin:10px 0;font-weight:700}
.warn span{display:block;font-weight:500;font-size:14px;margin-top:4px}
ol{padding-left:22px;margin:6px 0}li{margin:5px 0}.en{color:#555;font-size:14px}small{color:#555}.sum{font-size:22px;font-weight:800}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body>
<h2><span class="logos">${logos.map((l) => `<img class="logo" src="${esc(l)}" alt="">`).join('')}</span><span>${esc(title)} <span class="sub">${esc(sub)}</span></span></h2>
<div class="box"><div class="sum">${esc(o.amountEur)} EUR</div>${o.amountCrypto ? `<div>≈ ${esc(o.amountCrypto)} ${esc(o.ticker)}</div>` : ''}<small>Nakúpite ${esc(o.ticker)} (${esc(o.assetLabel)}), ktoré príde priamo na našu adresu · You buy ${esc(o.ticker)} sent straight to our address</small></div>
<div class="warn">⚠️ Adresu ani sumu na ďalšej stránke nemeň.<span>Do not change the address or the amount on the next page.</span></div>
<div class="grid"><div>
<div class="box"><b>Adresa príjemcu (${esc(o.ticker)}) · Destination address</b><code id="addr">${esc(o.payoutAddress)}</code>
<button type="button" class="copy big" data-cp="addr">📋 Kopírovať adresu</button>
<a class="btn go${ramp ? ' rev' : ''}" id="${ramp ? 'goRevolut' : 'goChangelly'}" href="${esc(o.changellyUrl)}" target="_blank" rel="noopener noreferrer"${done ? ' aria-disabled="true"' : ''}>${goLabel}</a>
<small>${esc(note)}</small></div>
<div id="chainStatus" data-order-id="${esc(o.orderId)}"></div>
</div><div>
<div class="box"><b>Postup v skratke · In short</b><ol>${s.sk.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
<div class="done">✅ Platbu uvidíme automaticky – táto stránka sa aktualizuje. · We detect the payment automatically.</div></div>
</div></div>
${guides.html(ramp ? 'revolut_ramp' : sepa ? 'changelly_sepa' : 'changelly_card', { amount: o.amountEur, coin: o.ticker, title: 'Podrobný návod s obrázkami' })}
<p><small>Objednávka ${esc(o.orderId)}</small></p>
<script src="/chain-status.js" defer></script><script src="/chat-widget.js" defer></script></body></html>`;
}

function mount(app, { loadOrders }) {
  app.get(['/changelly-pay', '/revolut-ramp-pay'], (req, res) => {
    const id = String(req.query.orderId || '');
    const o = ID_RE.test(id) ? loadOrders()[id] : null;
    if (!o || !GATEWAYS.has(o.provider)) return res.status(404).type('html').send('<p>Objednávka sa nenašla. <a href="/platby">Späť</a></p>');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(page(o));
  });
  // Same-origin JSON for the guide (no fees, no secrets).
  app.get('/api/changelly/:id', (req, res) => {
    if (!sameOrigin(req) && req.get('origin')) return res.status(403).end();
    const o = ID_RE.test(req.params.id) ? loadOrders()[req.params.id] : null;
    if (!o || !GATEWAYS.has(o.provider)) return res.status(404).json({ error: 'not found' });
    res.json({ orderId: o.orderId, status: o.status, chainStatus: o.chainStatus || null, coin: o.payoutCoin, amountEur: o.amountEur });
  });
}

module.exports = { GATEWAY, RAMP, GATEWAYS, RAMP_COIN_ORDER, MIN_EUR_RAMP, rampUrl, VARIANTS, COIN_ORDER, enabled, pickCoin, nextAddress, buyUrl, createOrder, onChainStatus, mount, MIN_EUR, MIN_EUR_REVOLUT, PAID_RATIO };
