'use strict';

/**
 * Settlement destinations — prefer rotating UTXO pools over EVM.
 *
 * Ryan active pool coins: BTC → LTC → BCH (address rotation mandatory).
 * Network fee refs (SK/CZ, 2026-10-07 Blockchair 24h avg USD):
 *   ltc (~$0.003) → bch (~$0.007) → doge (~$0.028) → btc (~$0.25)
 * EVM (Polygon USDC) network ≈ $0 but platform path (C2P ~1% + Banxa SEPA ~1% / card 3–5%)
 * is used ONLY when cheaper than pool on-ramp OR pool path unavailable.
 *
 * On-ramp rank = fee + reliability for pool coins (see DESTINATIONS.md):
 *   1. Switchere (default) — direct BTC/LTC/BCH/DOGE; SEPA cheaper than card
 *   2. Banxa — native UTXO via partner/BTCPay on-ramp; C2P path = EVM
 *   3. Revolut Ramp — docs UTXO; C2P MetaMask = POL→USDC (EVM)
 *   4. C2P — USDC Polygon only → EVM fallback
 */

const addressPool = require('./addressPool');

/**
 * Pool coins ordered by typical withdraw/network fee (lowest first).
 * Override with DESTINATION_COIN=btc|ltc|bch|doge.
 */
const POOL_COINS = Object.freeze(['btc', 'ltc', 'bch']); // Ryan: BTC → LTC → BCH; no DOGE/EVM

/** Typical network fee USD (approx, for ranking docs / UI). */
const NETWORK_FEE_USD = Object.freeze({
  ltc: 0.003,
  bch: 0.007,
  doge: 0.03,
  btc: 0.25,
  evm: 0.01, // Polygon USDC — cheap chain, platform fees dominate
});

/**
 * Estimated all-in platform fee % for SK/CZ (excl. network).
 * Sources: Banxa support (card 1.99% + spread → ~3–5% card / ~1% SEPA),
 * Switchere FAQ (~3.4% service, loyalty −), C2P ~1% merchant.
 */
const PLATFORM_FEE_PCT = Object.freeze({
  switchere_sepa: { min: 2.5, typical: 3.4, note: 'Service fee; SEPA no card markup; loyalty up to −45%' },
  switchere_card: { min: 3.0, typical: 3.9, note: 'Service + card processing' },
  banxa_sepa_c2p: { min: 1.8, typical: 2.2, note: 'Banxa SEPA ~1% all-in + C2P ~1% → EVM USDC' },
  banxa_card_c2p: { min: 4.0, typical: 5.0, note: 'Banxa card 3–5% + C2P ~1% → EVM USDC' },
  revolut_c2p: { min: 1.5, typical: 2.5, note: 'Ramp quote varies; C2P POL→USDC + ~1%' },
  c2p_only: { min: 1.0, typical: 1.0, note: 'Merchant fee only; always EVM USDC' },
});

/** On-ramps ranked by fee + reliability for pool settlement. */
const ONRAMP_RANK = Object.freeze([
  {
    id: 'switchere',
    rank: 1,
    default: true,
    coins: ['ltc', 'bch', 'doge', 'btc'],
    toPool: true,
    feeHint: 'sepa≈3.4% svc (loyalty↓) · card≈3.9%; network LTC≪BTC',
    reliability: 'high',
    skCz: true,
    note:
      'Best default for pool settle: native LTC/BCH/DOGE/BTC → dstAddress; SEPA+card; CZ/SK OK; no C2P cut.',
  },
  {
    id: 'banxa',
    rank: 2,
    default: false,
    coins: ['ltc', 'bch', 'doge', 'btc'],
    toPool: 'partner_or_btcpay_onramp',
    feeHint: 'SEPA~1% / card~3–5% native; via C2P +~1% and EVM only',
    reliability: 'high',
    skCz: true,
    note:
      'Native Banxa supports UTXO. Partner/BTCPay on-ramp → pool. Via C2P TokenPocket = USDC Polygon (EVM) — use when EVM all-in cheaper.',
  },
  {
    id: 'revolut',
    rank: 3,
    default: false,
    coins: ['ltc', 'bch', 'doge', 'btc'],
    toPool: 'own_partner_only',
    feeHint: 'Quote API varies; C2P path POL→USDC +~1%',
    reliability: 'medium',
    skCz: true,
    note:
      'Ramp docs list BTC/LTC/BCH/DOGE. Via C2P MetaMask locked POL→USDC (EVM). Pool needs own Revolut partner.',
  },
  {
    id: 'c2p',
    rank: 4,
    default: false,
    coins: [],
    toPool: false,
    feeHint: '~1% merchant; always USDC Polygon',
    reliability: 'high',
    skCz: true,
    note:
      'Chain2Pay merchant payout always USDC on Polygon — EVM fallback only (use if cheaper/necessary).',
  },
]);

const COIN_LABELS = Object.freeze({
  btc: 'Bitcoin',
  ltc: 'Litecoin',
  bch: 'Bitcoin Cash',
  doge: 'Dogecoin',
  evm: 'EVM (USDC Polygon)',
  lightning: 'Lightning',
  sol: 'Solana',
});

const PAYOUT_TICKER = Object.freeze({
  btc: 'BTC',
  ltc: 'LTC',
  bch: 'BCH',
  doge: 'DOGE',
  evm: 'USDC',
});

const BANXA_COIN = Object.freeze({
  btc: { coinType: 'BTC', blockchain: 'BTC' },
  ltc: { coinType: 'LTC', blockchain: 'LTC' },
  bch: { coinType: 'BCH', blockchain: 'BCH' },
  doge: { coinType: 'DOGE', blockchain: 'DOGE' },
});

/** Public Switchere buy paths per coin. */
const SWITCHERE_BUY = Object.freeze({
  btc: 'https://switchere.com/buy/bitcoin',
  ltc: 'https://switchere.com/buy/litecoin',
  bch: 'https://switchere.com/buy/bitcoin-cash',
  doge: 'https://switchere.com/buy/dogecoin',
});

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name) {
  const v = env(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function defaultOnramp() {
  const want = (env('DESTINATION_ONRAMP') || 'switchere').toLowerCase();
  if (want === 'auto') return 'switchere';
  const hit = ONRAMP_RANK.find((r) => r.id === want);
  return hit ? hit.id : 'switchere';
}

/**
 * Prefer lowest-fee pool coin with non-empty pool.
 * DESTINATION_COIN overrides. DESTINATION_PREFER_RELIABILITY=1 boosts BTC.
 */
function preferredPoolCoin(allowed) {
  const override = (env('DESTINATION_COIN') || '').toLowerCase();
  const allow = Array.isArray(allowed) && allowed.length
    ? allowed.map((c) => String(c).toLowerCase())
    : [...POOL_COINS];

  const order = boolEnv('DESTINATION_PREFER_RELIABILITY')
    ? ['btc', 'ltc', 'bch', 'doge']
    : [...POOL_COINS];

  // SWITCHERE_PAYOUT_CURRENCY only applies when DESTINATION_COIN unset
  const sw = (env('SWITCHERE_PAYOUT_CURRENCY') || '').toLowerCase();
  const forced = override || (sw && POOL_COINS.includes(sw) ? sw : '');

  if (forced && POOL_COINS.includes(forced) && allow.includes(forced)) {
    try {
      if (addressPool.peek(forced).poolSize > 0) return forced;
    } catch {
      /* fall through */
    }
  }

  const pools = addressPool.loadPools();
  for (const coin of order) {
    if (!allow.includes(coin)) continue;
    const list = pools[coin];
    if (Array.isArray(list) && list.filter(Boolean).length > 0) return coin;
  }
  return null;
}

function nextPoolAddress(coin, meta = {}) {
  const key = String(coin || '').toLowerCase();
  if (!POOL_COINS.includes(key) && !['btc', 'ltc', 'bch', 'doge'].includes(key)) {
    const err = new Error(`Not a pool settlement coin: ${key}`);
    err.code = 'NOT_POOL_COIN';
    throw err;
  }
  const picked = addressPool.nextAddress(key, meta);
  return {
    source: 'pool',
    ...picked,
    ticker: PAYOUT_TICKER[key] || key.toUpperCase(),
    label: COIN_LABELS[key] || key,
    networkFeeUsd: NETWORK_FEE_USD[key] ?? null,
  };
}

function nextEvmFallback(meta = {}) {
  // Ryan BTC-only: EVM fallback disabled unless allowEvmFallback explicitly true.
  if (meta.allowEvmFallback !== true && !boolEnv('DESTINATION_ALLOW_CHEAPER_EVM')) {
    const err = new Error('EVM fallback disabled — settlement is BTC/LTC/BCH pool only');
    err.code = 'BTC_ONLY_UNAVAILABLE';
    throw err;
  }
  try {
    const picked = addressPool.nextAddress('evm', meta);
    return {
      ...picked,
      ticker: 'USDC',
      label: COIN_LABELS.evm,
      networkFeeUsd: NETWORK_FEE_USD.evm,
      source: 'evm_fallback',
    };
  } catch (err) {
    if (err && err.code === 'BTC_ONLY_UNAVAILABLE') throw err;
    const address = addressPool.walletsReady()
      ? addressPool.merchantEvm()
      : (env('MERCHANT_WALLET') || env('WALLET_EVM') || addressPool.merchantEvm() || '');
    return {
      coin: 'evm',
      address,
      index: 0,
      poolSize: address ? 1 : 0,
      reused: true,
      ticker: 'USDC',
      label: COIN_LABELS.evm,
      networkFeeUsd: NETWORK_FEE_USD.evm,
      source: 'evm_fallback',
    };
  }
}

/**
 * Whether EVM (Banxa SEPA via C2P) is likely cheaper than Switchere pool path.
 * Env DESTINATION_ALLOW_CHEAPER_EVM=1 enables auto-EVM when SEPA rail requested.
 */
function evmLikelyCheaper(opts = {}) {
  if (!boolEnv('DESTINATION_ALLOW_CHEAPER_EVM')) return false;
  const rail = String(opts.rail || opts.payinGroup || '').toLowerCase();
  // Banxa SEPA+C2P ~2.2% typical vs Switchere SEPA ~3.4% → EVM can win on fee
  return rail === 'sepa' || rail === 'bank' || rail === 'banxa_bank';
}

/**
 * Pick destination: lowest-fee pool coin (fresh rotation), EVM only if
 * cheaper (opt-in) or necessary (empty pools / provider EVM-only).
 */
function pickDestination(opts = {}) {
  const provider = String(opts.provider || defaultOnramp() || 'switchere').toLowerCase();
  const allowEvm = opts.allowEvmFallback === true; // Ryan BTC-only: EVM off unless explicit
  const rank = ONRAMP_RANK.find(
    (r) =>
      r.id === provider ||
      (['chain2pay', 'c2p', 'chain2pay_net', 'chain2pay_is'].includes(provider) &&
        r.id === 'c2p')
  );
  const providerCoins =
    opts.allowedCoins ||
    (rank && Array.isArray(rank.coins) && rank.coins.length
      ? rank.coins
      : [...POOL_COINS]);

  if (rank && rank.toPool === false) {
    // Cannot settle to BTC — caller should mark method unavailable
    const err = new Error('Provider cannot settle to BTC/LTC/BCH pool');
    err.code = 'BTC_ONLY_UNAVAILABLE';
    err.provider = provider;
    throw err;
  }

  if (allowEvm && evmLikelyCheaper(opts) && (provider === 'banxa' || provider === 'c2p' || opts.forceEvm)) {
    const evm = nextEvmFallback({
      ...(opts.orderId ? { orderId: opts.orderId } : {}),
      allowEvmFallback: true,
    });
    return { ...evm, provider, reason: 'evm_cheaper_sepa' };
  }

  // Ryan: prefer BTC → LTC → BCH from pools (unused-first / round-robin).
  // opts.coin may force a pool coin; otherwise preferredPoolCoin(POOL_COINS).
  const requested = opts.coin ? String(opts.coin).toLowerCase() : '';
  let wantCoin =
    requested && POOL_COINS.includes(requested)
      ? preferredPoolCoin([requested]) || requested
      : preferredPoolCoin(providerCoins.filter((c) => POOL_COINS.includes(c))) ||
        preferredPoolCoin([...POOL_COINS]) ||
        'btc';

  if (wantCoin && POOL_COINS.includes(wantCoin)) {
    try {
      const dest = nextPoolAddress(wantCoin, opts.orderId ? { orderId: opts.orderId } : {});
      return { ...dest, provider, reason: 'pool_preferred' };
    } catch (err) {
      if (err.code !== 'EMPTY_POOL') throw err;
    }
  }

  for (const coin of POOL_COINS) {
    if (wantCoin && coin === wantCoin) continue;
    if (!providerCoins.includes(coin)) continue;
    try {
      const dest = nextPoolAddress(coin, opts.orderId ? { orderId: opts.orderId } : {});
      return { ...dest, provider, reason: 'pool_alternate' };
    } catch {
      /* try next */
    }
  }

  if (!allowEvm) {
    const err = new Error('No pool addresses available and EVM fallback disabled');
    err.code = 'NO_DESTINATION';
    throw err;
  }

  const evm = nextEvmFallback({
    ...(opts.orderId ? { orderId: opts.orderId } : {}),
    allowEvmFallback: true,
  });
  return { ...evm, provider, reason: 'evm_fallback' };
}


const FALLBACK_ORDER = Object.freeze(['btc', 'ltc', 'bch']);

/**
 * BTC → LTC → BCH fallback. Each attempt takes a FRESH rotated pool address.
 * attempt(dest) may throw (provider rejects / checkout creation error) → next coin.
 * Test hook: DESTINATION_FORCE_FAIL=btc,ltc makes those coins fail (smoke only).
 */
async function withCoinFallback(attempt, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const tag = `${opts.provider || 'pool'} ${opts.orderId || ''}`.trim();
  const forced = String(process.env.DESTINATION_FORCE_FAIL || '')
    .toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const coins = (opts.coins || FALLBACK_ORDER).filter((c) => FALLBACK_ORDER.includes(c));
  const errors = [];
  for (const coin of coins) {
    let dest;
    try {
      if (forced.includes(coin)) {
        const e = new Error(`forced failure (DESTINATION_FORCE_FAIL) for ${coin}`);
        e.code = 'FORCED_FAIL';
        throw e;
      }
      // Ryan's own admin-managed addresses only (BTCPay is reserved for the BTCPay checkout option).
      if (!dest) dest = nextPoolAddress(coin, opts.orderId ? { orderId: opts.orderId } : {});
      dest = { ...dest, provider: opts.provider, reason: errors.length ? `fallback_from_${errors.map((x) => x.coin).join('_')}` : 'btc_first' };
      log(`COIN_ATTEMPT ${tag} coin=${coin} addr=${dest.address} idx=${dest.index}`);
      const result = await attempt(dest);
      if (errors.length) log(`COIN_FALLBACK_OK ${tag} coin=${coin} after=${errors.map((x) => x.coin + ':' + x.error).join(' | ')}`);
      return { dest, result, fallbackErrors: errors };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      errors.push({ coin, code: (err && err.code) || null, error: msg });
      log(`COIN_FAIL ${tag} coin=${coin} code=${(err && err.code) || ''} err=${msg}`);
    }
  }
  const e = new Error(`All coins failed: ${errors.map((x) => x.coin + ' → ' + x.error).join('; ')}`);
  e.code = 'ALL_COINS_FAILED';
  e.fallbackErrors = errors;
  throw e;
}

function rankingDoc() {
  return {
    updated: '2026-10-07',
    poolPreferenceLowestFee: [...POOL_COINS],
    // Public JSON (/health, /api/providers): no fee numbers or percentages (customers must never see fees).
    defaultOnramp: defaultOnramp(),
    defaultCoin: preferredPoolCoin() || 'btc',
    onramps: ONRAMP_RANK.map(({ feeHint, note, ...r }) => ({ ...r })),
    rule:
      'Pool settle BTC → LTC → BCH (fresh rotation). BTCPay paths stay BTC/LN. EVM/USDC/SOL disabled unless DESTINATION_ALLOW_CHEAPER_EVM + allowEvmFallback.',
  };
}

function poolSummary() {
  const pools = addressPool.loadPools();
  const stats = addressPool.poolStats();
  const out = {};
  for (const coin of ['ltc', 'bch', 'doge', 'btc', 'evm', 'lightning', 'sol']) {
    out[coin] = {
      poolSize: (pools[coin] || []).length,
      usedCount: (stats[coin] && stats[coin].usedCount) || 0,
      nextIndex: (stats[coin] && stats[coin].nextIndex) || 0,
      networkFeeUsd: NETWORK_FEE_USD[coin] ?? null,
    };
  }
  return out;
}

module.exports = {
  POOL_COINS,
  withCoinFallback,
  FALLBACK_ORDER,
  ONRAMP_RANK,
  NETWORK_FEE_USD,
  PLATFORM_FEE_PCT,
  COIN_LABELS,
  PAYOUT_TICKER,
  BANXA_COIN,
  SWITCHERE_BUY,
  defaultOnramp,
  preferredPoolCoin,
  nextPoolAddress,
  nextEvmFallback,
  pickDestination,
  evmLikelyCheaper,
  rankingDoc,
  poolSummary,
};
