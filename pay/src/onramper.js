'use strict';

/**
 * Onramper aggregator (buy.onramper.com) — EUR fiat → crypto to Ryan wallets.
 *
 * Verified 2026-10-07 (Europe/Zurich):
 * - Docs/demo key pk_prod_<REDACTED>: /supported + /quotes work for SK
 *   (Banxa/MoonPay/Stripe card; Banxa banktransfer; AlchemyPay SEPA on USDC ETH).
 * - Same demo key: POST /checkout/intent → 402 "Demo Key can not be used for checkout".
 * - Production checkout needs merchant ONRAMPER_API_KEY (KYB + subscription).
 * - Locking wallets in the URL requires signing (V1 HMAC or V2 Ed25519).
 *
 * Env:
 *   ONRAMPER_API_KEY=pk_prod_...          (required for live checkout)
 *   ONRAMPER_SIGNING_SECRET=...           (V1 HMAC for wallets param)
 *   ONRAMPER_SIGNING_PRIVATE_KEY=...      (PEM Ed25519 for V2 sig — preferred)
 *   ONRAMPER_WIDGET_BASE=https://buy.onramper.com
 *   ONRAMPER_API_BASE=https://api.onramper.com
 *   ONRAMPER_DEFAULT_CRYPTO=btc|usdc_ethereum|usdc_polygon|pol_polygon
 *   ONRAMPER_COUNTRY=SK
 *   ONRAMPER_ONLY_FIATS=eur
 *   ONRAMPER_ALLOW_DEMO=0                 (1 = treat docs key as configured for UI smoke only)
 *
 * Docs: https://docs.onramper.com/  · Signup: https://dashboard.onramper.com/
 */

const crypto = require('crypto');
const addressPool = require('./addressPool');

// SHA-256 of public Onramper docs/demo keys (keys themselves not stored in repo)
const DEMO_KEY_HASHES = new Set([
  '82ddc19c606f7310b067c45d88185ae13163a5133972f237d3f07340325a5988',
  'f6ce4b13879125717c5696bb494c6d5c5ec25f3fbec8b3d6f404c304beed4335',
  '2141e238e26a86822d36184bfc128fe60122038f2d8628a966b02527d84d0338',
]);

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name) {
  const v = env(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function apiKey() {
  return env('ONRAMPER_API_KEY');
}

function isDemoKey(key = apiKey()) {
  if (!key) return false;
  if (DEMO_KEY_HASHES.has(require('crypto').createHash('sha256').update(key).digest('hex'))) return true;
  return /demo|example|sample/i.test(key);
}

function widgetBase() {
  return (env('ONRAMPER_WIDGET_BASE') || 'https://buy.onramper.com').replace(/\/$/, '');
}

function apiBase() {
  return (env('ONRAMPER_API_BASE') || 'https://api.onramper.com').replace(/\/$/, '');
}

function defaultCrypto() {
  // Ryan: btc | ltc | bch only (no usdc/pol/evm)
  const want = (env('ONRAMPER_DEFAULT_CRYPTO') || 'btc').toLowerCase();
  if (want === 'ltc' || want === 'litecoin') return 'ltc';
  if (want === 'bch' || want === 'bitcoin_cash' || want === 'bitcoincash') return 'bch';
  return 'btc';
}

function country() {
  return (env('ONRAMPER_COUNTRY') || env('ONRAMP_COUNTRY') || 'SK').toLowerCase();
}

/** Real merchant key required for checkout (demo key quotes-only). */
function isConfigured() {
  // Widget URL is always buildable (docs key fallback). Live paid checkout may still need KYB key.
  return true;
}

function canQuote() {
  return Boolean(apiKey()) || true; // public docs key usable for quotes smoke
}

function quoteKey() {
  return apiKey(); // never fall back to public/docs keys
}

function evmWallet() {
  if (addressPool.walletsReady()) return addressPool.merchantEvm(); // admin „Adresy peňaženiek“ is the source of truth
  if (env('ONRAMPER_EVM_ADDRESS')) return env('ONRAMPER_EVM_ADDRESS');
  if (env('WALLET_EVM')) return env('WALLET_EVM');
  if (env('MERCHANT_WALLET')) return env('MERCHANT_WALLET');
  try {
    const peek = addressPool.peek('evm');
    if (peek.addresses && peek.addresses[0]) return peek.addresses[0];
  } catch {
    /* ignore */
  }
  return '0x0A6336C680AF9D3C6b54A77BCAC7C552cD62708d';
}

function nextBtcDestination(orderId) {
  return addressPool.nextAddress('btc', orderId ? { orderId } : {});
}

function nextLtcDestination(orderId) {
  return addressPool.nextAddress('ltc', orderId ? { orderId } : {});
}

function nextBchDestination(orderId) {
  return addressPool.nextAddress('bch', orderId ? { orderId } : {});
}

/** Fresh rotating pool address — BTC → LTC → BCH preference. */
function nextPoolDestination(orderId, coin) {
  const destination = require('./destination');
  return destination.pickDestination({
    orderId,
    provider: 'switchere',
    coin: coin || undefined,
    allowedCoins: ['btc', 'ltc', 'bch'],
    allowEvmFallback: false,
  });
}

function nextEvmDestination(orderId) {
  try {
    return addressPool.nextAddress('evm', orderId ? { orderId } : {});
  } catch {
    return { address: evmWallet(), index: 0 };
  }
}

/**
 * Build wallets= and networkWallets= for Ryan destinations.
 * Token IDs use Onramper IDs (lowercase recommended).
 */
function buildWalletParams(opts = {}) {
  // Ryan: lock Onramper wallets to BTC/LTC/BCH pool addresses. No EVM/USDC/SOL.
  const btc = opts.btcAddress || '';
  const ltc = opts.ltcAddress || '';
  const bch = opts.bchAddress || '';
  const parts = [];
  if (btc) parts.push(`btc:${btc}`);
  if (ltc) parts.push(`ltc:${ltc}`);
  if (bch) parts.push(`bch:${bch}`);
  const wallets = parts.join(',');
  return { wallets, networkWallets: '', btc, ltc, bch, evm: null };
}

/** V1 HMAC-SHA256 of wallets(+networkWallets(+walletAddressTags)) substring. */
function signV1(signContent) {
  const secret = env('ONRAMPER_SIGNING_SECRET');
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(signContent, 'utf8').digest('hex');
}

/**
 * V2 Ed25519 — sign canonical field string.
 * See https://docs.onramper.com/docs/widget-sign-a-url-v2
 */
function signV2(fields) {
  const pem = env('ONRAMPER_SIGNING_PRIVATE_KEY');
  if (!pem) return null;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomUUID();
  const fieldNames = Object.keys(fields);
  // Canonical: sorted key=value joined by &
  const sorted = [...fieldNames].sort();
  const payload = sorted.map((k) => `${k}=${fields[k]}`).join('&');
  const toSign = `${payload}&sigV2Timestamp=${timestamp}&sigV2Nonce=${nonce}`;
  let keyPem = pem;
  if (!pem.includes('BEGIN')) {
    // raw hex seed / PKCS8 hex — try as PKCS8 DER hex
    try {
      keyPem = crypto.createPrivateKey({
        key: Buffer.from(pem, 'hex'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      keyPem = pem;
    }
  }
  const keyObj =
    typeof keyPem === 'string'
      ? crypto.createPrivateKey(keyPem)
      : keyPem;
  const sig = crypto.sign(null, Buffer.from(toSign, 'utf8'), keyObj);
  return {
    sigV2: `v2:${sig.toString('base64')}`,
    sigV2Timestamp: timestamp,
    sigV2Nonce: nonce,
    sigV2Fields: fieldNames.join(','),
  };
}

/**
 * Build widget URL. Without merchant key returns null (caller should 503).
 * Without signing secret, wallets are omitted (customer pastes from pay page).
 */
function buildWidgetUrl(opts = {}) {
  // Prefer merchant key; fall back to docs/demo key so the widget URL still loads
  // (checkout intent API may 402 with demo — customer still sees the widget UI).
  const key = apiKey(); // Ryan: own key only — no docs/demo key
  if (!key) return null;
  const demo = isDemoKey(key);

  const u = new URL(widgetBase() + '/');
  if (key) u.searchParams.set('apiKey', key);
  u.searchParams.set('mode', 'buy');
  u.searchParams.set('defaultFiat', 'EUR');
  u.searchParams.set('onlyFiats', (env('ONRAMPER_ONLY_FIATS', 'eur') || 'eur').toUpperCase());
  if (opts.fiatAmount != null && Number(opts.fiatAmount) > 0) {
    u.searchParams.set('defaultAmount', String(opts.fiatAmount));
  }
  const cryptoId = (opts.cryptoId || defaultCrypto()).toLowerCase();
  u.searchParams.set('defaultCrypto', cryptoId);
  u.searchParams.set('onlyCryptos', 'btc,ltc,bch');
  u.searchParams.set('enableCountrySelector', 'true');
  if (opts.country) u.searchParams.set('country', String(opts.country).toLowerCase());
  else u.searchParams.set('country', country());
  if (opts.email) u.searchParams.set('email', opts.email);
  if (opts.orderId) u.searchParams.set('partnerContext', opts.orderId);
  if (opts.successUrl) u.searchParams.set('successRedirectUrl', opts.successUrl);
  if (opts.failedUrl) u.searchParams.set('failureRedirectUrl', opts.failedUrl);
  u.searchParams.set('redirectAtCheckout', 'true');
  // Documented `onlyOnramps`: limit to preferred (lighter-KYC for small amounts) ramps when available.
  const only = opts.onlyOnramps || env('ONRAMPER_ONLY_ONRAMPS', '');
  if (only) u.searchParams.set('onlyOnramps', String(only).toLowerCase());
  if (opts.defaultPaymentMethod) u.searchParams.set('defaultPaymentMethod', opts.defaultPaymentMethod);

  const { wallets, networkWallets } = buildWalletParams(opts);
  // Always pass wallets= when we have an address (docs-supported). Signing locks editability.
  if (wallets) {
    u.searchParams.set('wallets', wallets);
    if (networkWallets) u.searchParams.set('networkWallets', networkWallets);
  }

  const canSignV2 = Boolean(env('ONRAMPER_SIGNING_PRIVATE_KEY'));
  const canSignV1 = Boolean(env('ONRAMPER_SIGNING_SECRET'));
  const lockWallets = Boolean(opts.lockWallets !== false && (canSignV1 || canSignV2) && wallets);

  if (lockWallets) {
    u.searchParams.set('isAddressEditable', 'false');
    if (canSignV2) {
      const fields = {
        apiKey: key,
        wallets,
      };
      if (networkWallets) fields.networkWallets = networkWallets;
      if (opts.fiatAmount != null) fields.defaultAmount = String(opts.fiatAmount);
      fields.defaultFiat = 'EUR';
      fields.defaultCrypto = cryptoId;
      fields.mode = 'buy';
      if (opts.orderId) fields.partnerContext = opts.orderId;
      if (opts.successUrl) fields.successRedirectUrl = opts.successUrl;
      if (opts.failedUrl) fields.failureRedirectUrl = opts.failedUrl;
      const v2 = signV2(fields);
      if (v2) {
        u.searchParams.set('sigV2', v2.sigV2);
        u.searchParams.set('sigV2Timestamp', v2.sigV2Timestamp);
        u.searchParams.set('sigV2Nonce', v2.sigV2Nonce);
        u.searchParams.set('sigV2Fields', v2.sigV2Fields);
      }
    } else if (canSignV1) {
      let signContent = `wallets=${wallets}`;
      if (networkWallets) signContent += `&networkWallets=${networkWallets}`;
      const signature = signV1(signContent);
      if (signature) u.searchParams.set('signature', signature);
    }
  }

  return {
    url: u.toString(),
    lockedWallet: lockWallets,
    cryptoId,
    wallets: wallets || '',
    demo,
  };
}

async function fetchQuotes(opts = {}) {
  const source = (opts.fiat || 'EUR').toUpperCase();
  const dest = (opts.cryptoId || defaultCrypto()).toLowerCase();
  const amount = Number(opts.fiatAmount || 50);
  const paymentMethod = opts.paymentMethod || 'creditcard';
  const ctry = opts.country || country();
  const url =
    `${apiBase()}/quotes/${encodeURIComponent(source)}/${encodeURIComponent(dest)}` +
    `?amount=${encodeURIComponent(amount)}&paymentMethod=${encodeURIComponent(paymentMethod)}` +
    `&type=buy&country=${encodeURIComponent(ctry)}&platform=web`;
  const res = await fetch(url, {
    headers: {
      Authorization: quoteKey(),
      Accept: 'application/json',
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
    const err = new Error(`Onramper quotes ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  const list = Array.isArray(data) ? data : [];
  const ok = list.filter((q) => q && q.rate && !q.errors);
  return { ok, all: list, source, dest, amount, paymentMethod, country: ctry };
}

/**
 * Resolve checkout for an order.
 * Returns { mode, url, lockedWallet, cryptoId, dstBtc, dstEvm }
 */
async function preferredOnramps(opts = {}) {
  const pref = env('ONRAMPER_PREFERRED', 'mtpelerin,swipelux,wert')
    .toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (!pref.length) return { pick: [], available: [] };
  const avail = new Set();
  for (const pm of ['creditcard', 'applepay', 'sepabanktransfer']) {
    try {
      const q = await fetchQuotes({ ...opts, paymentMethod: pm });
      for (const r of q.all) if (r && r.ramp && (r.payout || r.rate) && !(r.errors && r.errors.length)) avail.add(String(r.ramp).toLowerCase());
    } catch { /* quotes unavailable — no restriction */ }
  }
  return { pick: pref.filter((x) => avail.has(x)), available: [...avail] };
}

async function resolveCheckout(opts = {}) {
  let preference = null;
  if (apiKey() && !opts.onlyOnramps && !env('ONRAMPER_ONLY_ONRAMPS', '')) {
    preference = await preferredOnramps({ fiatAmount: opts.fiatAmount, cryptoId: opts.cryptoId, country: opts.country });
    if (preference.pick.length) opts = { ...opts, onlyOnramps: preference.pick.join(',') };
  }
  const built = buildWidgetUrl(opts);
  if (!built || !built.url) {
    const err = new Error('Onramper: nepodarilo sa zložiť widget URL');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return {
    mode: built.lockedWallet ? 'widget_locked' : 'widget_open',
    url: built.url,
    lockedWallet: built.lockedWallet,
    cryptoId: built.cryptoId,
    demo: built.demo,
    wallets: built.wallets,
    dstBtc: opts.btcAddress || null,
    dstEvm: null,
    preference,
  };
}

function status() {
  const key = apiKey();
  const configured = isConfigured();
  return {
    id: 'onramper',
    provider_name: 'Onramper (agregátor kariet / SEPA)',
    configured,
    hasKey: Boolean(key),
    demoKey: key ? isDemoKey(key) : false,
    signingV1: Boolean(env('ONRAMPER_SIGNING_SECRET')),
    signingV2: Boolean(env('ONRAMPER_SIGNING_PRIVATE_KEY')),
    defaultCrypto: defaultCrypto(),
    btcOnly: false,
    supportedCrypto: ['btc', 'ltc', 'bch'],
    country: country().toUpperCase(),
    widgetBase: widgetBase(),
    signup: 'https://dashboard.onramper.com/',
    docs: 'https://docs.onramper.com/',
    hint: 'Onramper widget URL (buy.onramper.com) — EUR→BTC, wallets=btc:<adresa>. Produkčný ONRAMPER_API_KEY po KYB odporúčaný.',
  };
}

function keysNeeded() {
  return {
    required: [
      {
        name: 'ONRAMPER_API_KEY',
        why: 'Production widget + checkout. Docs/demo keys return 402 on /checkout/intent.',
        how: 'https://dashboard.onramper.com/ → Register → Stripe subscribe → KYB (3–7 days) → Request live keys',
      },
    ],
    recommended: [
      {
        name: 'ONRAMPER_SIGNING_PRIVATE_KEY',
        why: 'Ed25519 V2 URL signing — locks wallets= / networkWallets= so payout goes to Ryan addresses',
        how: 'Generate Ed25519 PKCS8, register public key with Onramper support, set PEM in env',
      },
      {
        name: 'ONRAMPER_SIGNING_SECRET',
        why: 'Legacy V1 HMAC if V2 not enabled yet',
        how: 'Provided by Onramper after onboarding',
      },
    ],
    optional: [
      { name: 'ONRAMPER_DEFAULT_CRYPTO', default: 'btc', note: 'btc | ltc | bch (EVM/USDC disabled)' },
      { name: 'ONRAMPER_COUNTRY', default: 'SK' },
      { name: 'ONRAMPER_ONLY_FIATS', default: 'eur' },
    ],
    smoke_without_key: {
      quotes: 'Authorization: pk_prod_<REDACTED> against api.onramper.com/quotes/EUR/btc works for SK',
      checkout: 'Blocked — Demo Key can not be used for checkout (402)',
    },
    alternatives_already_live: [
      'banxa / banxa_bank / sepa_instant (Chain2Pay.net — no merchant Onramper KYB)',
      'btcpay_onramp (Guardarian public widget)',
      'switchere (public buy + optional partner key)',
      'is_ramp / is_banxa / is_revolut (chain2pay.is)',
    ],
  };
}

module.exports = {
  DEMO_KEY_HASHES,
  apiKey,
  isDemoKey,
  isConfigured,
  canQuote,
  quoteKey,
  widgetBase,
  apiBase,
  defaultCrypto,
  country,
  evmWallet,
  nextBtcDestination,
  nextLtcDestination,
  nextBchDestination,
  nextPoolDestination,
  nextEvmDestination,
  buildWalletParams,
  buildWidgetUrl,
  fetchQuotes,
  resolveCheckout,
  status,
  keysNeeded,
};
