'use strict';

/**
 * Switchere fiat→crypto (EUR card/SEPA → LTC/BCH/DOGE/BTC pool).
 * Docs: https://developer.switchere.com/
 *
 * Prefer rotating pool addresses (lowest network fee first: LTC→BCH→DOGE→BTC)
 * over EVM. See destination.js / DESTINATIONS.md.
 *
 * Prefer NON-merchant widget/partner URL with dstAddress = pool address
 * (isMerchant:true disables dstAddress — do not use for direct-to-wallet).
 *
 * Free public URLs (no API key; customer may need to paste wallet):
 *   https://switchere.com/buy/bitcoin
 *   https://switchere.com/ramp?mode=buy
 *   https://switchere.com/js/sdk-builder.js
 *
 * Locked wallet needs SWITCHERE_PARTNER_KEY (widget SDK) and/or
 * SWITCHERE_API_KEY + SWITCHERE_API_SECRET (Partner API v2).
 *
 * Affiliate / partner signup: https://switchere.com/sign-up
 * Business on-ramp: https://switchere.com/fiat-on-ramp
 * Limits: https://switchere.com/limits
 */

const crypto = require('crypto');
const addressPool = require('./addressPool');
const destination = require('./destination');

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name) {
  const v = env(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const PUBLIC_BUY_BTC = 'https://switchere.com/buy/bitcoin';
/** Skrill e-wallet → BTC (public pages; no Skrill merchant account needed). */
const PUBLIC_BUY_BTC_SKRILL = 'https://switchere.com/buy/bitcoin/skrill';
const PUBLIC_SKRILL = 'https://switchere.com/skrill';
/** @deprecated kept for reference; primary path is BTC */
const PUBLIC_BUY_USDC_POLYGON = 'https://switchere.com/buy/usdc-polygon';
const PUBLIC_BUY_USDC_POLYGON_SKRILL = 'https://switchere.com/buy/usdc-polygon/skrill';
const PUBLIC_RAMP_BUY = 'https://switchere.com/ramp?mode=buy';
const SDK_PROD = 'https://switchere.com/js/sdk-builder.js';
const SDK_SANDBOX = 'https://sandbox.switchere.com/js/sdk-builder.js';
const API_PROD = 'https://switchere.com/api/v2';
const API_SANDBOX = 'https://sandbox.switchere.com/api/v2';

function sandbox() {
  return boolEnv('SWITCHERE_SANDBOX');
}

function partnerKey() {
  return env('SWITCHERE_PARTNER_KEY');
}

function apiKey() {
  return env('SWITCHERE_API_KEY');
}

function apiSecret() {
  return env('SWITCHERE_API_SECRET');
}

function payoutCurrency() {
  const forced = env('SWITCHERE_PAYOUT_CURRENCY');
  if (forced) return forced.toUpperCase();
  // Ryan: BTC → LTC → BCH from pools
  const coin = destination.preferredPoolCoin(['btc', 'ltc', 'bch']) || 'btc';
  return destination.PAYOUT_TICKER[coin] || 'BTC';
}

function payinGroupDefault() {
  return env('SWITCHERE_PAYIN_GROUP', 'card') || 'card';
}

/**
 * Static/fallback pool destination (lowest-fee coin peek).
 * Order checkout should call nextPoolDestination / pickDestination.
 */
function merchantWallet() {
  if (!addressPool.walletsReady() && env('SWITCHERE_DST_ADDRESS')) return env('SWITCHERE_DST_ADDRESS');
  try {
    const coin = destination.preferredPoolCoin(['btc', 'ltc', 'bch']) || 'btc';
    const peek = addressPool.peek(coin);
    if (peek.addresses && peek.addresses[0]) return peek.addresses[0];
    if (env('WALLET_BTC')) return env('WALLET_BTC');
    const btc = addressPool.peek('btc');
    if (btc.addresses && btc.addresses[0]) return btc.addresses[0];
    const ltc = addressPool.peek('ltc');
    if (ltc.addresses && ltc.addresses[0]) return ltc.addresses[0];
    const bch = addressPool.peek('bch');
    if (bch.addresses && bch.addresses[0]) return bch.addresses[0];
  } catch {
    /* ignore */
  }
  return env('WALLET_BTC') || '';
}

/** Fresh rotating pool address — BTC → LTC → BCH. */
function nextPoolDestination(orderId, coin) {
  return destination.pickDestination({
    orderId,
    provider: 'switchere',
    coin: coin || undefined,
    allowEvmFallback: false,
  });
}

/** @deprecated use nextPoolDestination — kept for BTC-only callers */
function nextBtcDestination(orderId) {
  try {
    return destination.nextPoolAddress('btc', orderId ? { orderId } : {});
  } catch {
    return addressPool.nextAddress('btc', orderId ? { orderId } : {});
  }
}

function sdkUrl() {
  return sandbox() ? SDK_SANDBOX : SDK_PROD;
}

function apiBase() {
  return (env('SWITCHERE_API_BASE') || (sandbox() ? API_SANDBOX : API_PROD)).replace(
    /\/$/,
    ''
  );
}

function hasPartnerWidget() {
  return Boolean(partnerKey());
}

function hasPartnerApi() {
  return Boolean(apiKey() && apiSecret());
}

/** Always usable via public buy/ramp URLs; partner keys unlock locked wallet. */
function isConfigured() {
  return true;
}

function publicUrls() {
  return {
    buyBtc: PUBLIC_BUY_BTC,
    buyBitcoin: PUBLIC_BUY_BTC,
    buyBtcSkrill: PUBLIC_BUY_BTC_SKRILL,
    skrill: PUBLIC_SKRILL,
    buyUsdcPolygon: PUBLIC_BUY_USDC_POLYGON,
    buyUsdcPolygonSkrill: PUBLIC_BUY_USDC_POLYGON_SKRILL,
    rampBuy: PUBLIC_RAMP_BUY,
    sdk: sdkUrl(),
    docs: 'https://developer.switchere.com/',
    widgetDocs: 'https://developer.switchere.com/widget/',
    partnerApi: 'https://developer.switchere.com/api-v2/endpoints/partner/',
    affiliateTerms: 'https://switchere.com/referral-terms',
    partnerSignup: 'https://switchere.com/sign-up',
    businessOnramp: 'https://switchere.com/fiat-on-ramp',
    limits: 'https://switchere.com/limits',
  };
}

/**
 * Public consumer buy page (Bitcoin — Switchere default). No partner key.
 * Address query is not reliably locked by Switchere — customer may paste wallet.
 */
function buildPublicBuyUrl(opts = {}) {
  // Path pins coin (bitcoin|litecoin|bitcoin-cash) from pool preference / payoutCurrency.
  const ticker = String(opts.payoutCurrency || payoutCurrency() || 'BTC').toUpperCase();
  const coin = ticker.toLowerCase();
  const base =
    destination.SWITCHERE_BUY[coin] ||
    destination.SWITCHERE_BUY.btc ||
    PUBLIC_BUY_BTC;
  const u = new URL(base);
  const wallet = opts.dstAddress || merchantWallet();
  if (wallet) u.searchParams.set('address', wallet);
  if (opts.fiatAmount != null && Number(opts.fiatAmount) > 0) {
    u.searchParams.set('amount', String(opts.fiatAmount));
    u.searchParams.set('fiatAmount', String(opts.fiatAmount));
  }
  u.searchParams.set('from', 'EUR');
  u.searchParams.set('fiat', 'EUR');
  u.searchParams.set('to', ticker);
  u.searchParams.set('crypto', ticker);
  u.searchParams.set('fixedCrypto', ticker);
  u.searchParams.set('lockCrypto', '1');
  if (opts.email) u.searchParams.set('email', opts.email);
  const cc = String(opts.remoteCountry || opts.country || '').trim().toUpperCase().slice(0, 2);
  if (cc) {
    u.searchParams.set('country', cc);
    u.searchParams.set('remote_country', cc);
  }
  if (opts.orderId) u.searchParams.set('partnerOrderId', opts.orderId);
  return u.toString();
}

/**
 * Public Skrill → BTC buy page. No Switchere partner key and no Skrill merchant KYC.
 * Customer pays from Skrill wallet; coins go to dstAddress (bc1…) when they paste it.
 */
function buildPublicSkrillUrl(opts = {}) {
  // Pin coin path from pool (BTC/LTC/BCH) — customer must not pick coin.
  const ticker = String(opts.payoutCurrency || payoutCurrency() || 'BTC').toUpperCase();
  const coin = ticker.toLowerCase();
  const buyBase =
    destination.SWITCHERE_BUY[coin] ||
    destination.SWITCHERE_BUY.btc ||
    PUBLIC_BUY_BTC;
  const u = new URL(`${buyBase.replace(/\/$/, '')}/skrill`);
  const wallet = opts.dstAddress || merchantWallet();
  if (wallet) u.searchParams.set('address', wallet);
  if (opts.fiatAmount != null && Number(opts.fiatAmount) > 0) {
    u.searchParams.set('amount', String(opts.fiatAmount));
    u.searchParams.set('fiatAmount', String(opts.fiatAmount));
  }
  u.searchParams.set('from', 'EUR');
  u.searchParams.set('fiat', 'EUR');
  u.searchParams.set('to', ticker);
  u.searchParams.set('crypto', ticker);
  // Encourage SPA to keep pinned coin / wallet (best-effort; path is primary lock).
  u.searchParams.set('fixedCrypto', ticker);
  u.searchParams.set('lockCrypto', '1');
  u.searchParams.set('payin', 'skrill');
  u.searchParams.set('payment', 'skrill');
  if (opts.email) u.searchParams.set('email', opts.email);
  const ccS = String(opts.remoteCountry || opts.country || '').trim().toUpperCase().slice(0, 2);
  if (ccS) {
    u.searchParams.set('country', ccS);
    u.searchParams.set('remote_country', ccS);
  }
  if (opts.orderId) u.searchParams.set('partnerOrderId', opts.orderId);
  return u.toString();
}

function buildPublicRampUrl(opts = {}) {
  const u = new URL('https://switchere.com/ramp');
  u.searchParams.set('mode', 'buy');
  // request_id only works after Partner create_request
  if (opts.requestId) u.searchParams.set('request_id', opts.requestId);
  return u.toString();
}

/**
 * Widget SDK init options — NON-merchant so dstAddress locks payout wallet.
 * Requires SWITCHERE_PARTNER_KEY. Default payoutCurrency = BTC → LTC → BCH.
 */
function buildWidgetInit(opts = {}) {
  const key = partnerKey();
  if (!key) return null;
  const wallet = opts.dstAddress || merchantWallet();
  const payinGroup = opts.payinGroup || payinGroupDefault();
  const init = {
    el: opts.el || '#switchere',
    partnerKey: key,
    // Do NOT set isMerchant — merchant mode makes dstAddress unavailable
    partnerOrderId: opts.orderId || undefined,
    httpReturnSuccess: opts.successUrl || undefined,
    httpReturnFailed: opts.failedUrl || undefined,
    payinCurrency: opts.payinCurrency || 'EUR',
    payinGroup,
    payinAmount:
      opts.fiatAmount != null && Number(opts.fiatAmount) > 0
        ? String(opts.fiatAmount)
        : undefined,
    payoutCurrency: opts.payoutCurrency || payoutCurrency(),
    payoutGroup: 'crypto',
    dstAddress: wallet || undefined,
    // Lock email when known so customer only fills card/payment (Switchere docs: clientEmail).
    clientEmail: opts.lockEmail !== false && opts.email ? opts.email : undefined,
    clientEmailDefault: opts.email || undefined,
  };
  // Drop undefined keys for cleaner embed
  Object.keys(init).forEach((k) => {
    if (init[k] === undefined || init[k] === null || init[k] === '') delete init[k];
  });
  return init;
}

/** HMAC for Partner API: signature = hmac_sha512_base64(sha256(path + content), secret) */
function signRequest(path, content, secret) {
  const body = content == null ? '' : String(content);
  const digest = crypto.createHash('sha256').update(path + body, 'utf8').digest();
  return crypto.createHmac('sha512', secret).update(digest).digest('base64');
}

async function partnerApi(method, path, bodyObj) {
  if (!hasPartnerApi()) {
    const err = new Error(
      'Switchere Partner API: nastavte SWITCHERE_API_KEY + SWITCHERE_API_SECRET'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  // path relative to /api/v2, e.g. /partner/order/create
  const rel = path.startsWith('/') ? path : `/${path}`;
  const fullPath = rel.startsWith('/api/v2') ? rel : `/api/v2${rel}`;
  const endpoint = `${apiBase()}${fullPath.replace(/^\/api\/v2/, '')}`;
  const content = bodyObj != null ? JSON.stringify(bodyObj) : '';
  const signature = signRequest(fullPath, content, apiSecret());
  const res = await fetch(endpoint, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'API-Key': apiKey(),
      'API-Signature': signature,
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : content || undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `Switchere API ${res.status}: ${data?.error || data?.message || text.slice(0, 200)}`
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * Partner order create → redirect URL with locked dst_address.
 * https://developer.switchere.com/api-v2/endpoints/partner/
 */
async function createPartnerOrder(opts = {}) {
  const wallet = opts.dstAddress || merchantWallet();
  const partnerOrderId =
    opts.orderId || `sw_${crypto.randomBytes(8).toString('hex')}`;
  const body = {
    partner_order_id: partnerOrderId,
    payin_currency: opts.payinCurrency || 'EUR',
    payin_amount: Number(opts.fiatAmount),
    payin_group: opts.payinGroup || payinGroupDefault(),
    payout_currency: opts.payoutCurrency || payoutCurrency(),
    payout_group: 'crypto',
    dst_address: wallet,
    client_email: opts.email || undefined,
    client_ip: opts.clientIp || '127.0.0.1',
    remote_country: opts.remoteCountry || env('ONRAMP_COUNTRY', 'SK') || 'SK',
    free_first: 1,
  };
  Object.keys(body).forEach((k) => {
    if (body[k] === undefined) delete body[k];
  });
  const data = await partnerApi('POST', '/partner/order/create', body);
  const redirect = data.redirect || data.redirect_url || null;
  return {
    partnerOrderId,
    clientOrderId: data.client_order_id || null,
    redirect,
    raw: data,
  };
}

/**
 * create_request → request_id for https://switchere.com/ramp?request_id=...
 */
async function createPartnerRequest(opts = {}) {
  const wallet = opts.dstAddress || merchantWallet();
  const partnerOrderId =
    opts.orderId || `sw_${crypto.randomBytes(8).toString('hex')}`;
  const body = {
    partner_order_id: partnerOrderId,
    payin_amount: opts.fiatAmount != null ? String(opts.fiatAmount) : undefined,
    payin_currency: 'EUR',
    payin_group: opts.payinGroup || payinGroupDefault(),
    payout_currency: opts.payoutCurrency || payoutCurrency(),
    payout_group: 'crypto',
    dst_address: wallet,
    http_return_success: opts.successUrl,
    http_return_failed: opts.failedUrl,
  };
  Object.keys(body).forEach((k) => {
    if (body[k] === undefined) delete body[k];
  });
  const data = await partnerApi('POST', '/partner/create_request', body);
  const requestId = data.request_id || data.requestId || null;
  return {
    partnerOrderId,
    requestId,
    rampUrl: requestId ? buildPublicRampUrl({ requestId }) : null,
    raw: data,
  };
}

/**
 * Resolve best checkout for an order.
 * Returns { mode, url, widgetInit, publicUrls, lockedWallet }
 */
async function resolveCheckout(opts = {}) {
  const wallet = opts.dstAddress || merchantWallet();
  const payinGroup = String(opts.payinGroup || payinGroupDefault() || 'card').toLowerCase();
  const wantSkrill = payinGroup === 'skrill' || payinGroup === 'ewallet';
  const publicBuy = wantSkrill
    ? buildPublicSkrillUrl({ ...opts, dstAddress: wallet })
    : buildPublicBuyUrl({ ...opts, dstAddress: wallet });
  const publicRamp = buildPublicRampUrl(opts);
  const publicSkrill = buildPublicSkrillUrl({ ...opts, dstAddress: wallet });

  // Skrill is a Switchere marketing/public rail — API paymentGroup enum has no `skrill`
  // (only card/sepa/neteller/…). Skip partner API for Skrill; use public buy page.
  if (wantSkrill) {
    return {
      mode: 'public_skrill',
      url: publicSkrill,
      lockedWallet: false,
      dstAddress: wallet,
      publicBuy: publicSkrill,
      publicRamp,
      publicSkrill,
      sdkUrl: sdkUrl(),
    };
  }

  if (hasPartnerApi()) {
    try {
      const order = await createPartnerOrder(opts);
      if (order.redirect) {
        return {
          mode: 'api_redirect',
          url: order.redirect,
          partnerOrderId: order.partnerOrderId,
          clientOrderId: order.clientOrderId,
          lockedWallet: true,
          dstAddress: wallet,
          publicBuy,
          publicRamp,
        };
      }
    } catch (err) {
      // Fall through to widget / public
      if (opts.strictApi) throw err;
    }
    try {
      const req = await createPartnerRequest(opts);
      if (req.rampUrl) {
        return {
          mode: 'api_request',
          url: req.rampUrl,
          partnerOrderId: req.partnerOrderId,
          requestId: req.requestId,
          lockedWallet: true,
          dstAddress: wallet,
          publicBuy,
          publicRamp,
        };
      }
    } catch {
      /* fall through */
    }
  }

  if (hasPartnerWidget()) {
    const widgetInit = buildWidgetInit({ ...opts, dstAddress: wallet });
    return {
      mode: 'widget',
      url: null, // served by local /switchere-pay embed
      widgetInit,
      lockedWallet: Boolean(widgetInit && widgetInit.dstAddress),
      dstAddress: wallet,
      sdkUrl: sdkUrl(),
      publicBuy,
      publicRamp,
    };
  }

  // Free public path — no locked wallet guarantee
  return {
    mode: 'public',
    url: publicBuy,
    lockedWallet: false,
    dstAddress: wallet,
    publicBuy,
    publicRamp,
    sdkUrl: sdkUrl(),
  };
}

function status() {
  const urls = publicUrls();
  const dst = merchantWallet();
  return {
    id: 'switchere',
    provider_name: 'Switchere (karta / SEPA)',
    configured: isConfigured(),
    partnerWidget: hasPartnerWidget(),
    partnerApi: hasPartnerApi(),
    sandbox: sandbox(),
    payoutCurrency: payoutCurrency(),
    dstAddress: dst ? `${dst.slice(0, 12)}…${dst.slice(-6)}` : null,
    dstAddressFull: dst || null,
    lockedWalletReady: hasPartnerWidget() || hasPartnerApi(),
    publicBuyBtc: urls.buyBtc,
    publicBuyUsdcPolygon: urls.buyUsdcPolygon,
    publicRampBuy: urls.rampBuy,
    methods: ['card', 'sepa', 'bank', 'skrill'],
    publicBuyBtcSkrill: urls.buyBtcSkrill,
    publicSkrill: urls.skrill,
    hint: hasPartnerWidget() || hasPartnerApi()
      ? `Switchere widget/API — ${payoutCurrency()} peňaženka zamknutá (pool rotácia, bez merchant módu)`
      : `Verejný buy URL (${payoutCurrency()}) — čerstvá adresa z poolu (BTC→LTC→BCH); pre zamknutú peňaženku doplňte SWITCHERE_PARTNER_KEY`,
    destinationRank: destination.rankingDoc(),
  };
}

module.exports = {
  PUBLIC_BUY_BTC,
  PUBLIC_BUY_BTC_SKRILL,
  PUBLIC_SKRILL,
  PUBLIC_BUY_USDC_POLYGON,
  PUBLIC_BUY_USDC_POLYGON_SKRILL,
  PUBLIC_RAMP_BUY,
  isConfigured,
  hasPartnerWidget,
  hasPartnerApi,
  partnerKey,
  merchantWallet,
  nextBtcDestination,
  nextPoolDestination,
  payoutCurrency,
  sdkUrl,
  publicUrls,
  buildPublicBuyUrl,
  buildPublicSkrillUrl,
  buildPublicRampUrl,
  buildWidgetInit,
  createPartnerOrder,
  createPartnerRequest,
  resolveCheckout,
  status,
};
