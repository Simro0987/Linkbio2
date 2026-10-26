'use strict';

/**
 * Kryptonim public buy (no partner API key required).
 * Widget: https://buy.kryptonim.com/
 * Redirect form (Cake Wallet pattern):
 *   https://buy.kryptonim.com/redirect-form?amount=&currency=EUR&convertedCurrency=USDC&blockchain=Polygon&address=&paymentMethod=card
 * Docs: https://docs-ramp.kryptonim.com/ · https://www.kryptonim.com/help
 */
const destination = require('./destination');

const PUBLIC_BUY = 'https://buy.kryptonim.com/';
const PUBLIC_REDIRECT = 'https://buy.kryptonim.com/redirect-form';
const DOCS = 'https://www.kryptonim.com/';
const HELP = 'https://www.kryptonim.com/help';

function env(name) {
  const v = process.env[name];
  return v == null || String(v).trim() === '' ? '' : String(v).trim();
}

/** Public buy always available — no API key. */
function isConfigured() {
  return false; // BTC-only: no USDC settlement
}
function isConfigured_DISABLED() {
  return true;
}

function status() {
  return {
    id: 'kryptonim',
    provider_name: 'Platba kartou Kryptonim',
    configured: false,
    soon: true,
    btcOnlyUnavailable: true,
    hint: 'dočasne nedostupné — settlement len BTC (BTCPay), nie USDC Polygon',
  };
}

function payoutCurrency() {
  return (env('KRYPTONIM_CRYPTO') || 'USDC').toUpperCase();
}

function blockchain() {
  return env('KRYPTONIM_BLOCKCHAIN') || 'Polygon';
}

function paymentMethod(opts = {}) {
  const m = String(opts.paymentMethod || env('KRYPTONIM_PAYMENT') || 'card').toLowerCase();
  if (m === 'bank' || m === 'sepa' || m === 'bank_transfer') return 'bank_transfer';
  if (m === 'apple' || m === 'apple_pay') return 'apple_pay';
  if (m === 'google' || m === 'google_pay') return 'google_pay';
  return 'card';
}

function nextPoolDestination(orderId) {
  const err = new Error('Kryptonim settles USDC Polygon — BTC-only policy blocks this method');
  err.code = 'BTC_ONLY_UNAVAILABLE';
  throw err;
}

/**
 * Public redirect-form URL with EUR + destination address prefilled.
 * Prefer EUR / SK when country is passed (best-effort query params).
 */
function buildPublicBuyUrl(opts = {}) {
  const u = new URL(PUBLIC_REDIRECT);
  const amount = Number(opts.fiatAmount != null ? opts.fiatAmount : opts.amount);
  if (Number.isFinite(amount) && amount > 0) {
    u.searchParams.set('amount', String(Math.round(amount * 100) / 100));
  }
  u.searchParams.set('currency', String(opts.fiatCurrency || 'EUR').toUpperCase());
  const crypto = String(opts.payoutCurrency || payoutCurrency()).toUpperCase();
  u.searchParams.set('convertedCurrency', crypto);
  u.searchParams.set('blockchain', opts.blockchain || blockchain());
  const addr = opts.dstAddress || opts.address || '';
  if (addr) u.searchParams.set('address', addr);
  u.searchParams.set('paymentMethod', paymentMethod(opts));
  if (opts.email) u.searchParams.set('email', String(opts.email));
  const cc = String(opts.remoteCountry || opts.country || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);
  if (cc) {
    u.searchParams.set('country', cc);
    u.searchParams.set('countryCode', cc);
  }
  if (opts.orderId) u.searchParams.set('externalId', String(opts.orderId));
  return u.toString();
}

function resolveCheckout(opts = {}) {
  const payout = opts.dstAddress
    ? {
        address: opts.dstAddress,
        ticker: opts.payoutCurrency || payoutCurrency(),
        coin: 'evm',
      }
    : nextPoolDestination(opts.orderId);
  const url = buildPublicBuyUrl({
    ...opts,
    dstAddress: payout.address,
    payoutCurrency: payout.ticker || payoutCurrency(),
  });
  return {
    mode: 'public',
    url,
    publicBuy: url,
    lockedWallet: false,
    lockedCrypto: String(payout.ticker || payoutCurrency()).toUpperCase(),
    dstAddress: payout.address,
    payoutCurrency: String(payout.ticker || payoutCurrency()).toUpperCase(),
    payoutCoin: payout.coin || 'evm',
  };
}

module.exports = {
  PUBLIC_BUY,
  PUBLIC_REDIRECT,
  isConfigured,
  status,
  payoutCurrency,
  blockchain,
  nextPoolDestination,
  buildPublicBuyUrl,
  resolveCheckout,
};
