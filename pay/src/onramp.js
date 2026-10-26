'use strict';

const destination = require('./destination');

/**
 * Fiat on-ramps that send BTC to a BTCPay invoice on-chain address.
 * Merchant does NOT need card acquiring — customer pays the on-ramp (KYC there).
 *
 * Env (optional):
 *   ONRAMP_PROVIDER=auto|banxa|guardarian|ramp|moonpay|transak|bridge
 *   BANXA_PARTNER_REF=yourpartner   → https://{ref}.banxa.com/?...
 *   RAMP_HOST_API_KEY=...
 *   RAMP_HOST_APP_NAME=Checkout
 *   RAMP_HOST_LOGO_URL=https://btcpaylite.com/favicon.ico
 *   MOONPAY_API_KEY=pk_live_...     (unsigned walletAddress may be ignored)
 *   TRANSAK_API_KEY=...             (needs session API — bridge fallback if unset)
 */

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function preferredProvider() {
  return (env('ONRAMP_PROVIDER', 'auto') || 'auto').toLowerCase();
}

function banxaConfigured() {
  return Boolean(env('BANXA_PARTNER_REF'));
}

function rampConfigured() {
  return Boolean(env('RAMP_HOST_API_KEY'));
}

function moonpayConfigured() {
  return Boolean(env('MOONPAY_API_KEY'));
}

function transakConfigured() {
  return Boolean(env('TRANSAK_API_KEY'));
}

/**
 * @param {{
 *   btcAddress: string,
 *   btcAmount?: string|number,
 *   fiatAmount: number,
 *   email?: string,
 *   returnUrl?: string,
 *   orderId?: string,
 * }} opts
 */
function buildBanxaUrl(opts) {
  const ref = env('BANXA_PARTNER_REF');
  if (!ref) return null;
  const base = env('BANXA_BASE_URL') || `https://${ref}.banxa.com/`;
  const u = new URL(base);
  // BTCPay on-ramp invoices are BTC; otherwise prefer lowest-fee pool coin
  const coin = String(opts.coin || opts.payoutCoin || 'btc').toLowerCase();
  const banxa = destination.BANXA_COIN[coin] || destination.BANXA_COIN.btc;
  u.searchParams.set('coinType', banxa.coinType);
  u.searchParams.set('blockchain', banxa.blockchain);
  const wallet = opts.walletAddress || opts.btcAddress;
  u.searchParams.set('walletAddress', wallet);
  u.searchParams.set('fiatType', 'EUR');
  if (opts.btcAmount != null && Number(opts.btcAmount) > 0) {
    u.searchParams.set('coinAmount', String(opts.btcAmount));
  }
  if (opts.fiatAmount != null && Number(opts.fiatAmount) > 0) {
    u.searchParams.set('fiatAmount', String(opts.fiatAmount));
  }
  if (opts.returnUrl) u.searchParams.set('returnUrl', opts.returnUrl);
  if (opts.email) u.searchParams.set('email', opts.email);
  return u.toString();
}

/** Guardarian consumer buy page — no merchant API key required. */
function buildGuardarianUrl(opts) {
  const u = new URL('https://guardarian.com/buy-btc');
  u.searchParams.set('to', 'BTC');
  u.searchParams.set('from', 'EUR');
  u.searchParams.set('amount', String(opts.fiatAmount));
  u.searchParams.set('address', opts.btcAddress);
  return u.toString();
}

function buildRampUrl(opts) {
  const key = env('RAMP_HOST_API_KEY');
  if (!key) return null;
  const u = new URL(env('RAMP_URL', 'https://app.ramp.network/'));
  u.searchParams.set('hostApiKey', key);
  u.searchParams.set('hostAppName', env('RAMP_HOST_APP_NAME', 'Checkout'));
  u.searchParams.set(
    'hostLogoUrl',
    env('RAMP_HOST_LOGO_URL', 'https://btcpaylite.com/favicon.ico')
  );
  u.searchParams.set('swapAsset', 'BTC_BTC');
  u.searchParams.set('enabledCryptoAssets', 'BTC_BTC');
  u.searchParams.set('userAddress', opts.btcAddress);
  u.searchParams.set('fiatCurrency', 'EUR');
  u.searchParams.set('fiatValue', String(opts.fiatAmount));
  // Exact sats if known (BTC has 8 decimals)
  if (opts.btcAmount != null && Number(opts.btcAmount) > 0) {
    const sats = Math.round(Number(opts.btcAmount) * 1e8);
    if (sats > 0) u.searchParams.set('swapAmount', String(sats));
  }
  if (opts.email) u.searchParams.set('userEmailAddress', opts.email);
  if (opts.returnUrl) u.searchParams.set('finalUrl', opts.returnUrl);
  u.searchParams.set('selectedCountryCode', env('ONRAMP_COUNTRY', 'SK'));
  return u.toString();
}

function buildMoonpayUrl(opts) {
  const key = env('MOONPAY_API_KEY');
  if (!key) return null;
  const u = new URL(env('MOONPAY_URL', 'https://buy.moonpay.com/'));
  u.searchParams.set('apiKey', key);
  u.searchParams.set('currencyCode', 'btc');
  u.searchParams.set('baseCurrencyCode', 'eur');
  u.searchParams.set('baseCurrencyAmount', String(opts.fiatAmount));
  u.searchParams.set('walletAddress', opts.btcAddress);
  u.searchParams.set('lockAmount', 'true');
  if (opts.email) u.searchParams.set('email', opts.email);
  if (opts.returnUrl) u.searchParams.set('redirectURL', opts.returnUrl);
  // Note: MoonPay may require URL signature when walletAddress is set.
  return u.toString();
}

/** Transak legacy query URL — prefer session API when TRANSAK_API_KEY set; may 403 without allowlist. */
function buildTransakUrl(opts) {
  const key = env('TRANSAK_API_KEY');
  if (!key) return null;
  const u = new URL(env('TRANSAK_URL', 'https://global.transak.com/'));
  u.searchParams.set('apiKey', key);
  u.searchParams.set('productsAvailed', 'BUY');
  u.searchParams.set('cryptoCurrencyCode', 'BTC');
  u.searchParams.set('network', 'mainnet');
  u.searchParams.set('fiatCurrency', 'EUR');
  u.searchParams.set('fiatAmount', String(opts.fiatAmount));
  u.searchParams.set('walletAddress', opts.btcAddress);
  u.searchParams.set('disableWalletAddressForm', 'true');
  if (opts.email) u.searchParams.set('email', opts.email);
  if (opts.returnUrl) u.searchParams.set('redirectURL', opts.returnUrl);
  return u.toString();
}

/**
 * Pick best redirect URL. Returns { provider, url, mode: 'redirect'|'bridge' }.
 * 'bridge' = show local page with address + links (no partner key yet).
 */
function resolveCheckout(opts) {
  const force = String(opts.forceProvider || opts.provider || '').toLowerCase();
  const want = force || preferredProvider();
  const builders = {
    banxa: buildBanxaUrl,
    guardarian: buildGuardarianUrl,
    ramp: buildRampUrl,
    moonpay: buildMoonpayUrl,
    transak: buildTransakUrl,
  };

  if (want === 'bridge') {
    return { provider: 'bridge', url: null, mode: 'bridge' };
  }

  if (want !== 'auto' && builders[want]) {
    const url = builders[want](opts);
    if (url) {
      // Guardarian public widget still uses bridge so BTC address is shown first.
      if (want === 'guardarian' && force === 'guardarian') {
        return { provider: 'guardarian', url, mode: 'bridge' };
      }
      return { provider: want, url, mode: want === 'guardarian' ? 'bridge' : 'redirect' };
    }
    return { provider: 'bridge', url: null, mode: 'bridge', fallbackReason: `${want}_not_configured` };
  }

  // Partner widgets (locked wallet) → direct redirect.
  // Guardarian alone → bridge page first (show locked BTCPay address + link).
  const partners = [
    ['banxa', buildBanxaUrl],
    ['ramp', buildRampUrl],
    ['moonpay', buildMoonpayUrl],
    ['transak', buildTransakUrl],
  ];
  for (const [name, fn] of partners) {
    const url = fn(opts);
    if (url) return { provider: name, url, mode: 'redirect' };
  }
  // No partner keys: bridge with Guardarian (and any future) links
  return {
    provider: 'guardarian',
    url: buildGuardarianUrl(opts),
    mode: 'bridge',
  };
}

function listAvailableLinks(opts) {
  const links = [];
  const banxa = buildBanxaUrl(opts);
  if (banxa) links.push({ id: 'banxa', label: 'Banxa (karta / bank)', url: banxa });
  const ramp = buildRampUrl(opts);
  if (ramp) links.push({ id: 'ramp', label: 'Ramp Network', url: ramp });
  const moon = buildMoonpayUrl(opts);
  if (moon) links.push({ id: 'moonpay', label: 'MoonPay', url: moon });
  const transak = buildTransakUrl(opts);
  if (transak) links.push({ id: 'transak', label: 'Transak', url: transak });
  links.push({
    id: 'guardarian',
    label: 'Guardarian (karta / bank · bez merchant API)',
    url: buildGuardarianUrl(opts),
  });
  return links;
}

function status() {
  const pref = preferredProvider();
  const configured = banxaConfigured() || rampConfigured() || moonpayConfigured() || transakConfigured() || true;
  return {
    id: 'btcpay_onramp',
    provider_name: 'Bank/card → BTC (on-ramp + BTCPay)',
    configured: Boolean(configured),
    preferred: pref,
    banxaPartner: banxaConfigured() ? env('BANXA_PARTNER_REF') : null,
    ramp: rampConfigured(),
    moonpay: moonpayConfigured(),
    transak: transakConfigured(),
    guardarian: true,
    destinationNote:
      'BTCPay invoice = BTC on-chain. For LTC/BCH/DOGE pool (lower fee) use Switchere. EVM only via C2P Banxa/Revolut.',
    ranking: destination.rankingDoc(),
    hint:
      'Zákazník platí fiat (karta/bank) na on-rampe → BTC na BTCPay invoice adresu. Bez merchant karty. Lacnejšie altcoiny: Switchere pool.',
  };
}

module.exports = {
  preferredProvider,
  banxaConfigured,
  resolveCheckout,
  listAvailableLinks,
  buildBanxaUrl,
  buildGuardarianUrl,
  buildRampUrl,
  buildMoonpayUrl,
  buildTransakUrl,
  status,
};
