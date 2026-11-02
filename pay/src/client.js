'use strict';

const config = require('./config');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Low-level HTTP helper. Follows redirects (api.chain2pay.net → api.paygate.to).
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function buildCallbackUrl(orderId, token) {
  const base = config.callbackBaseUrl;
  const sep = base.includes('?') ? '&' : '?';
  // t = per-order random secret (only its sha256 is stored on the order); verified in /callback.
  return `${base}${sep}orderId=${encodeURIComponent(orderId)}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
}

/** Chain2Pay payout (USDC on Polygon): admin „Adresy peňaženiek“ (Polygon, else shared EVM) → config fallback until loaded. */
function payoutWallet() {
  const ap = require('./addressPool');
  if (ap.walletsReady()) {
    const a = ap.merchantEvm();
    if (!a) throw new Error('Chýba zapnutá EVM/Polygon adresa v admine „Adresy peňaženiek“');
    return a;
  }
  return config.merchantWallet;
}

/**
 * Step 1: Generate a one-time encrypted receiving address.
 * Fresh wallet token per order — never reuse.
 */
async function createWallet(orderId, opts = {}) {
  if (!orderId) throw new Error('orderId is required');
  const callback = buildCallbackUrl(orderId, opts.token);
  const url =
    `${config.apiBase}/wallet.php` +
    `?address=${encodeURIComponent(payoutWallet())}` +
    `&callback=${encodeURIComponent(callback)}`;
  return apiFetch(url);
}

/**
 * Affiliate wallet — merchant + affiliate must differ.
 */
async function createAffiliateWallet(orderId, affiliateWallet) {
  if (!orderId) throw new Error('orderId is required');
  const affiliate = affiliateWallet || config.affiliateWallet;
  if (!affiliate) throw new Error('affiliateWallet is required');
  if (affiliate.toLowerCase() === payoutWallet().toLowerCase()) {
    throw new Error('Affiliate wallet must differ from merchant wallet');
  }
  const callback = buildCallbackUrl(orderId);
  const url =
    `${config.apiBase}/affiliate.php` +
    `?address=${encodeURIComponent(payoutWallet())}` +
    `&callback=${encodeURIComponent(callback)}` +
    `&affiliate=${encodeURIComponent(affiliate)}`;
  return apiFetch(url);
}

/**
 * Mass payout — fees object maps wallet → share; shares must sum to 1.0.
 */
async function massPayout(fees, orderId) {
  if (!fees || typeof fees !== 'object') {
    throw new Error('fees object is required');
  }
  const sum = Object.values(fees).reduce((a, b) => a + Number(b), 0);
  if (Math.abs(sum - 1.0) > 1e-9) {
    throw new Error(`fees must sum to 1.0 (got ${sum})`);
  }
  const oid = orderId || `mass_${Date.now()}`;
  const callback = buildCallbackUrl(oid);
  const url = `${config.apiBase}/mass-payout.php`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback, fees }),
  });
}

/**
 * Convert local currency amount to USD (Chain2Pay convert.php).
 */
async function convertToUsd(from, value) {
  if (!from || value === undefined || value === null) {
    throw new Error('from and value are required');
  }
  const url =
    `${config.apiBase}/convert.php` +
    `?from=${encodeURIComponent(from)}` +
    `&value=${encodeURIComponent(String(value))}`;
  return apiFetch(url);
}

/**
 * Convert EUR amount to a target currency.
 * USD → Chain2Pay convert.php; EUR → passthrough; other → ECB Frankfurter.
 */
async function convertFromEur(eurAmount, toCurrency) {
  const to = String(toCurrency || 'EUR').toUpperCase();
  const value = Number(eurAmount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('eurAmount must be a positive number');
  }
  if (to === 'EUR') {
    return {
      amount: roundMoney(value),
      currency: 'EUR',
      exchange_rate: 1,
      source: 'passthrough',
    };
  }
  if (to === 'USD') {
    const conv = await convertToUsd('EUR', value);
    const usd = Number(conv.value_coin);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new Error('convert.php returned invalid USD amount');
    }
    return {
      amount: roundMoney(usd),
      currency: 'USD',
      exchange_rate: Number(conv.exchange_rate) || null,
      source: 'chain2pay-convert',
      raw: conv,
    };
  }
  // CAD / INR / SEK / etc. — convert.php only yields USD; use ECB rates
  const fxUrl =
    `https://api.frankfurter.app/latest?from=EUR&to=${encodeURIComponent(to)}`;
  const fx = await apiFetch(fxUrl);
  const rate = fx && fx.rates && fx.rates[to];
  if (!rate) {
    throw new Error(`No FX rate EUR→${to}`);
  }
  return {
    amount: roundMoney(value * Number(rate)),
    currency: to,
    exchange_rate: Number(rate),
    source: 'frankfurter',
    raw: fx,
  };
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Pick checkout currency for a provider (constraints first, then minimum_currency).
 */
function resolveTargetCurrency(providerId, providerMeta) {
  const constrained = config.currencyConstraints[providerId];
  if (constrained) return String(constrained).toUpperCase();
  if (providerMeta && providerMeta.minimum_currency) {
    return String(providerMeta.minimum_currency).toUpperCase();
  }
  return 'EUR';
}

/**
 * EUR-first checkout: convert customer EUR amount into the currency the provider needs.
 */
async function resolveCheckoutAmount(eurAmount, providerId, providerMeta) {
  const currency = resolveTargetCurrency(providerId, providerMeta);
  const converted = await convertFromEur(eurAmount, currency);
  return {
    amountEur: roundMoney(Number(eurAmount)),
    amount: converted.amount,
    currency: converted.currency,
    exchange_rate: converted.exchange_rate,
    conversionSource: converted.source,
  };
}

/**
 * Look up payment by ipn_token — for support only, do not poll for order state.
 */
async function getPaymentStatus(ipnToken) {
  if (!ipnToken) throw new Error('ipnToken is required');
  const url =
    `${config.apiBase}/payment-status.php` +
    `?ipn_token=${encodeURIComponent(ipnToken)}`;
  return apiFetch(url);
}

/**
 * Live provider list with status and minimums.
 * Normalizes array or { providers: [...] } shapes.
 */
async function getProviders() {
  const data = await apiFetch(`${config.apiBase}/provider-status`);
  if (Array.isArray(data)) return { providers: data };
  if (data && Array.isArray(data.providers)) return data;
  if (data && typeof data === 'object') {
    const values = Object.values(data);
    if (values.length && values.every((v) => v && v.id)) {
      return { providers: values };
    }
  }
  return { providers: [] };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

/**
 * Single-provider checkout URL. Redirect customer — no iframes.
 */
function buildProcessPaymentUrl({
  addressIn,
  amount,
  provider,
  email,
  currency,
  ipCountry,
}) {
  if (!addressIn || !amount || !provider || !email || !currency) {
    throw new Error(
      'addressIn, amount, provider, email, and currency are required'
    );
  }
  const constraint = config.currencyConstraints[provider];
  if (constraint && currency.toUpperCase() !== constraint) {
    throw new Error(
      `Provider "${provider}" requires currency ${constraint}, got ${currency}`
    );
  }
  // address_in from API may already be URL-encoded; avoid double-encoding
  const addressParam = encodeURIComponent(safeDecode(addressIn));
  const qs =
    `address=${addressParam}` +
    `&amount=${encodeURIComponent(String(amount))}` +
    `&provider=${encodeURIComponent(String(provider))}` +
    `&email=${encodeURIComponent(String(email))}` +
    `&currency=${encodeURIComponent(String(currency).toUpperCase())}`;
  const url = `${config.checkoutBase}/process-payment.php?${qs}`;
  return { url, headers: ipCountry ? { 'PGTO-IPCountry': ipCountry } : {} };
}

/**
 * Multi-provider hosted selection page.
 */
function buildMultiProviderUrl({
  addressIn,
  amount,
  email,
  currency,
  branding = {},
}) {
  if (!addressIn || !amount || !email || !currency) {
    throw new Error('addressIn, amount, email, and currency are required');
  }
  const parts = [
    `address=${encodeURIComponent(safeDecode(addressIn))}`,
    `amount=${encodeURIComponent(String(amount))}`,
    `email=${encodeURIComponent(String(email))}`,
    `currency=${encodeURIComponent(String(currency).toUpperCase())}`,
  ];
  const { domain, logo, background, theme, button } = branding;
  if (domain) parts.push(`domain=${encodeURIComponent(domain)}`);
  if (logo) parts.push(`logo=${encodeURIComponent(logo)}`);
  if (background) parts.push(`background=${encodeURIComponent(background)}`);
  if (theme) parts.push(`theme=${encodeURIComponent(theme)}`);
  if (button) parts.push(`button=${encodeURIComponent(button)}`);
  return `${config.checkoutBase}/pay.php?${parts.join('&')}`;
}

function getHttp11Dispatcher() {
  try {
    const { Agent } = require('undici');
    return new Agent({
      allowH2: false,
      connect: { timeout: 30000 },
      bodyTimeout: 60000,
      headersTimeout: 60000,
    });
  } catch {
    return undefined;
  }
}

/**
 * Server-side second_step: GET process-payment URL with second_step=1,
 * parse JSON { url } → upstream provider checkout (Stripe/Link/etc).
 * Uses HTTP/1.1 when undici is available; never sends the customer browser
 * to checkout.chain2pay.net.
 */
async function resolveProviderUrl(processPaymentUrl, { timeoutMs = 60000 } = {}) {
  if (!processPaymentUrl) throw new Error('processPaymentUrl is required');

  const second = new URL(processPaymentUrl);
  second.searchParams.set('second_step', '1');
  const secondUrl = second.toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = getHttp11Dispatcher();

  try {
    let current = secondUrl;
    let res;
    for (let hop = 0; hop < 6; hop++) {
      const opts = {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': BROWSER_UA,
          Referer: processPaymentUrl,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      };
      if (dispatcher) opts.dispatcher = dispatcher;

      res = await fetch(current, opts);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).toString();
        continue;
      }
      break;
    }

    // Prefer final hop URL when Chain2Pay redirected to the provider page
    // (many providers return HTML SPA instead of JSON { url }).
    function isChain2PayHost(urlStr) {
      try {
        const h = new URL(urlStr).hostname.toLowerCase();
        return (
          h === 'checkout.chain2pay.net' ||
          h.endsWith('.chain2pay.net') ||
          h === 'checkout.paygate.to' ||
          h.endsWith('.paygate.to') ||
          h.includes('chain2pay') ||
          h.includes('paygate.to')
        );
      } catch {
        return true;
      }
    }

    if (!isChain2PayHost(current) && /^https?:\/\//i.test(current)) {
      return {
        providerUrl: current,
        secondStepUrl: secondUrl,
        raw: { via: 'redirect-final', status: res.status },
      };
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    // JSON { url } — accept even on non-2xx (e.g. PayPal 403 interstitial)
    const jsonUrl = data && data.url;
    if (jsonUrl && /^https?:\/\//i.test(String(jsonUrl))) {
      return {
        providerUrl: String(jsonUrl),
        secondStepUrl: secondUrl,
        raw: data,
      };
    }

    if (!data) {
      const err = new Error(
        `second_step returned non-JSON (HTTP ${res.status}) and stayed on Chain2Pay`
      );
      err.status = res.status;
      err.body = { raw: text.slice(0, 500), finalUrl: current };
      throw err;
    }

    if (!res.ok) {
      const err = new Error(`second_step HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }

    const err = new Error('second_step response missing provider url');
    err.body = data;
    throw err;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`second_step timed out after ${timeoutMs}ms`);
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (dispatcher && typeof dispatcher.close === 'function') {
      try {
        await dispatcher.close();
      } catch {
        /* ignore */
      }
    }
  }
}


/**
 * Chain2Pay/.net Revolut second_step often bakes MetaMask partner defaults
 * (countryCode=ES, paymentMethod=REVOLUT, partnerRedirectUrl=MetaMask fake-callback).
 * Rewrite country/region for SK/CZ and replace the MetaMask success redirect with
 * our /revolut-done page. Token/hash stay unchanged — Ramp still accepts login.
 *
 * @param {string} url
 * @param {string} countryCode
 * @param {{ returnUrl?: string, orderId?: string }} [opts]
 */
function normalizeRevolutRampUrl(url, countryCode, opts = {}) {
  if (!url || typeof url !== 'string') return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/ramp\.revolut\.com$/i.test(u.hostname) && u.hostname !== 'ramp.revolut.com') {
    return url;
  }
  const cc = String(countryCode || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const allowed = new Set([
    'SK', 'CZ', 'HU', 'PL', 'AT', 'DE', 'CH', 'RO', 'SI', 'HR',
    'ES', 'PT', 'IT', 'FR', 'NL', 'BE', 'IE', 'LT', 'LV', 'EE',
    'FI', 'SE', 'DK', 'NO', 'IS', 'GR', 'CY', 'MT', 'LU', 'LI', 'GB', 'UK',
  ]);
  if (cc && allowed.has(cc)) {
    const norm = cc === 'UK' ? 'GB' : cc;
    u.searchParams.set('countryCode', norm);
    u.searchParams.set('region', norm);
    // Lock country so customer only deals with payment (card / Revolut Pay).
    u.searchParams.set('disableCountryCode', 'true');
  }

  // Destination ranking: C2P MetaMask partner = POL intermediate → merchant USDC.
  // Never rewrite to USDC. Re-assert lock so customer cannot pick another coin.
  u.searchParams.set('cryptoCurrency', 'POL');
  u.searchParams.set('blockchain', 'POLYGON');
  u.searchParams.set('disableCryptoCurrency', 'true');
  u.searchParams.set('disableWalletAddress', 'true');
  u.searchParams.set('skipWalletAddress', 'true');

  // MetaMask partner onSuccess navigates to partnerRedirectUrl. Their
  // fake-callback returns a blank 200 — customers think payment failed.
  const pr = u.searchParams.get('partnerRedirectUrl') || '';
  const returnUrl = String((opts && opts.returnUrl) || '').trim();
  if (
    returnUrl &&
    /^https?:\/\//i.test(returnUrl) &&
    (/metamask\.io/i.test(pr) || !pr)
  ) {
    u.searchParams.set('partnerRedirectUrl', returnUrl);
  }
  // Revolut Ramp docs: no email / name / address URL params — customer fills in-app.
  return u.toString();
}

/**
 * Banxa referral-style URLs (partner.banxa.com/?coinType=…) may accept email /
 * returnUrl. Signed TokenPocket portal URLs (?expires=&id=&oid=&signature=)
 * must NOT be mutated — signature would break and KYC fields are not supported.
 *
 * @param {string} url
 * @param {{ email?: string, returnUrl?: string, countryCode?: string }} [opts]
 */
function normalizeBanxaUrl(url, opts = {}) {
  if (!url || typeof url !== 'string') return url;
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/\.banxa\.com$/i.test(u.hostname) && !/banxa\.com$/i.test(u.hostname)) {
    return url;
  }
  // Signed hosted-checkout portal (TokenPocket) — partner locks wallet + USDC; leave alone.
  if (
    u.searchParams.has('signature') ||
    u.searchParams.has('oid') ||
    u.searchParams.has('expires')
  ) {
    return url;
  }
  // Unsigned referral: lock destination ranking coin = USDC on Polygon (C2P settle).
  u.searchParams.set('coinType', opts.coinType || 'USDC');
  u.searchParams.set('blockchain', opts.blockchain || 'MATIC');
  if (opts.walletAddress) {
    u.searchParams.set('walletAddress', opts.walletAddress);
  }
  const email = String((opts && opts.email) || '').trim();
  if (email && email.includes('@')) {
    u.searchParams.set('email', email);
  }
  const returnUrl = String((opts && opts.returnUrl) || '').trim();
  if (returnUrl && /^https?:\/\//i.test(returnUrl)) {
    u.searchParams.set('returnUrl', returnUrl);
  }
  // Official referral params do not include firstName/lastName/address/country.
  return u.toString();
}

/**
 * Inspect checkout URL for locked crypto / wallet (customer must not pick coin).
 * Ranking: Switchere→LTC · Revolut→POL · Banxa/C2P→USDC.
 */
function inspectCryptoLock(url, provider) {
  const p = String(provider || '').toLowerCase();
  const out = {
    lockedCrypto: null,
    lockedWallet: false,
    disableCrypto: false,
    walletPreview: null,
    host: null,
  };
  if (!url || typeof url !== 'string') return out;
  let u;
  try {
    u = new URL(url.startsWith('http') ? url : `https://local.test${url}`);
  } catch {
    return out;
  }
  out.host = u.hostname || null;
  const g = (k) => u.searchParams.get(k);
  const crypto =
    g('cryptoCurrency') || g('coinType') || g('crypto') || g('to') || g('coin') || null;
  const wallet =
    g('walletAddress') || g('wallet') || g('dstAddress') || g('address') || null;
  if (wallet) {
    out.walletPreview = wallet.length > 16 ? `${wallet.slice(0, 10)}…${wallet.slice(-6)}` : wallet;
  }
  if (/ramp\.revolut\.com/i.test(u.hostname) || p === 'revolut' || p === 'apple_google_revolut') {
    out.lockedCrypto = 'POL';
    out.disableCrypto = g('disableCryptoCurrency') === 'true';
    out.lockedWallet =
      g('disableWalletAddress') === 'true' ||
      g('skipWalletAddress') === 'true' ||
      Boolean(wallet);
    return out;
  }
  if (/banxa\.com/i.test(u.hostname) || /banxa/.test(p)) {
    // TokenPocket signed portal = partner-locked USDC Polygon → C2P
    out.lockedCrypto = (crypto || 'USDC').toUpperCase().includes('USDC') ? 'USDC' : (crypto || 'USDC').toUpperCase();
    if (/tokenpocket/i.test(u.hostname) || u.searchParams.has('signature')) {
      out.lockedCrypto = 'USDC';
      out.lockedWallet = true;
      out.disableCrypto = true;
    } else {
      out.lockedWallet = Boolean(wallet);
      out.disableCrypto = Boolean(crypto);
    }
    return out;
  }
  if (/switchere\.com/i.test(u.hostname) || /switchere/.test(p)) {
    const pathCoin = (u.pathname.match(/buy\/(litecoin|bitcoin-cash|dogecoin|bitcoin)/i) || [])[1];
    const map = { litecoin: 'LTC', 'bitcoin-cash': 'BCH', dogecoin: 'DOGE', bitcoin: 'BTC' };
    out.lockedCrypto = (crypto || map[pathCoin] || 'LTC').toUpperCase();
    out.lockedWallet = Boolean(wallet);
    out.disableCrypto = Boolean(pathCoin); // path pins coin; SPA may still offer switch
    return out;
  }
  if (crypto) out.lockedCrypto = String(crypto).toUpperCase();
  out.lockedWallet = Boolean(wallet);
  return out;
}

/**
 * Apply provider-specific URL rewrites after C2P second_step (or direct on-ramp).
 */
function normalizeOnrampCheckoutUrl(url, provider, opts = {}) {
  if (!url || typeof url !== 'string') return url;
  const p = String(provider || '').toLowerCase();
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('ramp.revolut.com') || /revolut/.test(p)) {
      return normalizeRevolutRampUrl(url, opts.countryCode || opts.country, opts);
    }
    if (host.includes('banxa.com') || /banxa/.test(p)) {
      return normalizeBanxaUrl(url, opts);
    }
  } catch {
    /* ignore */
  }
  return url;
}

module.exports = {
  apiFetch,
  buildCallbackUrl,
  createWallet,
  createAffiliateWallet,
  massPayout,
  convertToUsd,
  convertFromEur,
  resolveTargetCurrency,
  resolveCheckoutAmount,
  getPaymentStatus,
  getProviders,
  buildProcessPaymentUrl,
  buildMultiProviderUrl,
  resolveProviderUrl,
  normalizeRevolutRampUrl,
  normalizeBanxaUrl,
  normalizeOnrampCheckoutUrl,
  inspectCryptoLock,
  config,
};
