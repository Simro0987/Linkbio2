'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const client = require('./client');
const config = require('./config');
const btcpay = require('./btcpay');
const onramp = require('./onramp');
const getblitz = require('./getblitz');
const mollie = require('./mollie');
const chain2payIs = require('./chain2payIs');
const switchere = require('./switchere');
const kryptonim = require('./kryptonim');
const onramper = require('./onramper');
const electrocoin = require('./electrocoin');
const electrocoinGuided = require('./electrocoinGuided');
const sepaManual = require('./sepaManual');
const guardarian = require('./guardarian');
const telegramBot = require('./telegramBot');
const sepaQr = require('./sepaQr');
const adminSepa = require('./adminSepa');
const adminSepaChain = require('./adminSepaChain');
const sepaBotChain = require('./sepaBotChain');
const payMethods = require('./payMethods');
const methodRank = require('./methodRank');
const guideStore = require('./guideStore');
const adminCategories = require('./adminCategories');
const wallets = require('./wallets');
const cryptoDirect = require('./cryptoDirect');
const blink = require('./blink');
const methodCoins = require('./methodCoins');
const giftCards = require('./giftCards');
const giftPick = require('./giftPick');
const fulfill = require('./fulfill');
const oxapay = require('./oxapay');
const walletGw = require('./walletGateway');
const changelly = require('./changelly');
const amountLinks = require('./amountLinks');
const paysafecard = require('./paysafecard');
const g2a = require('./g2a');
const addressPool = require('./addressPool');
const destination = require('./destination');
const customerPrefill = require('./customerPrefill');

const app = express();
const sha256Hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Public JSON brand/secret scrub (safety net): no internal brand name, notify e-mails, store slugs or admin paths in API output.
app.use(require('./publicScrub').middleware);
// Compression (brotli/gzip); never buffer Server-Sent Events.
app.use(require('compression')({
  filter: (req, res) => !/event-stream/i.test(String(res.getHeader('Content-Type') || '')) && !/\/(events|stream|updates)\b/.test(req.path) && require('compression').filter(req, res),
}));
// Per-request CSP nonce: every <script> in HTML responses gets it; inline on* handlers were replaced by
// delegated listeners in /csp-handlers.js, so script-src no longer needs 'unsafe-inline'.
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string' && /<script\b|<\/body>/i.test(body) && /^\s*</.test(body)) {
      body = body.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
      if (!/csp-handlers\.js/.test(body)) body = body.replace(/<\/body>/i, `<script nonce="${nonce}" src="/csp-handlers.js" defer></script></body>`);
    }
    return send(body);
  };
  next();
});
// Security headers. script-src uses a per-request nonce (no 'unsafe-inline'); styles still inline;
// all browser fetch/SSE is same-origin. Payment providers are reached via links/redirects/forms (https).
app.use(require('helmet')({
  contentSecurityPolicy: { useDefaults: false, directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`], scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:', 'https:'], fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"], frameSrc: ['https:'], formAction: ["'self'", 'https:'], objectSrc: ["'none'"],
    baseUri: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: [] } },
  strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));
app.use((req, res, next) => { res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self), interest-cohort=()'); next(); });
// SK/EN switch (?lang=en / cookie) + private status-link box on confirmation pages
app.use(require('./i18n').middleware);
// Read-through for orders written by another instance (old checkout during the move): load the row before handlers run.
const ORD_RE = /ord_[a-f0-9]{8,32}/g;
function readThrough(req, res, next) {
  const db = require('./db');
  if (!db.enabled()) return next();
  const ids = new Set(String(req.originalUrl || '').match(ORD_RE) || []);
  if (req.body && typeof req.body === 'object') for (const v of [req.body.orderId, req.body.order_id, req.body.id]) if (typeof v === 'string' && /^ord_[a-f0-9]{8,32}$/.test(v)) ids.add(v);
  const tok = /^\/status\/([^/?#]+)/.exec(req.path || '');
  const jobs = [...ids].map((id) => db.fetchOne(id));
  if (tok) jobs.push(require('./statusLinks').getByToken(decodeURIComponent(tok[1])).then((r) => (r && r.ref ? db.fetchOne(r.ref) : null)).catch(() => null));
  if (!jobs.length) return next();
  Promise.all(jobs).then(() => next(), () => next());
}
app.use(readThrough);
app.use((req, res, next) => require('./statusLinks').injector({ loadOrders })(req, res, next));
function publicBaseFromReq(req) {
  const envBase = (config.callbackBaseUrl || '').replace(/\/callback\/?$/i, '');
  if (envBase) return envBase.replace(/\/$/, '');
  const fwd = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = fwd || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`.replace(/\/$/, '');
}
const ROOT = path.join(__dirname, '..');
const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);
// On Vercel the deploy FS is read-only — use /tmp (ephemeral per instance).
const LOG_DIR = IS_SERVERLESS
  ? path.join('/tmp', 'chain2pay-logs')
  : path.join(ROOT, 'logs');
const DATA_DIR = IS_SERVERLESS
  ? path.join('/tmp', 'chain2pay-data')
  : path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const PROVIDERS_CACHE = path.join(DATA_DIR, 'providers.json');
const PROVIDERS_CACHE_BUNDLED = path.join(ROOT, 'data', 'providers.json');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* ignore on restricted FS */
}

/** In-memory order fallback when disk writes fail (serverless). */
const memoryOrders = Object.create(null);

const orderDb = require('./db');
const proofStore = require('./proofStore');

function loadOrders() {
  if (orderDb.enabled()) return orderDb.load();
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return { ...memoryOrders };
  }
}

function saveOrders(orders) {
  try { if (global.__lnkAccounts) setImmediate(global.__lnkAccounts.kick); } catch { /* accounts optional */ }
  try { for (const o of Object.values(orders || {})) require('./statusLinks').ensureOrder(o); } catch (e) { appendLog('STATUS_TOKEN_FAIL ' + e.message); }
  try { for (const o of Object.values(orders || {})) if (fulfill.isPaid(o)) fulfill.ensure(o); } catch (e) { appendLog('FULFILL_TOKEN_FAIL ' + e.message); }
  if (orderDb.enabled()) { orderDb.save(orders, appendLog); return; } // Neon is the store – no extra in-memory/disk copies
  Object.keys(memoryOrders).forEach((k) => delete memoryOrders[k]);
  Object.assign(memoryOrders, orders);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  } catch {
    /* memory-only on read-only FS */
  }
}

global.__payOrders = { load: () => loadOrders(), save: (o) => saveOrders(o) };
function appendLog(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'callbacks.log'), `${msg}\n`);
    if (/^(TELEGRAM|ORDER_CREATED)/.test(line)) console.log(msg);
  } catch {
    console.log(msg);
  }
}

function readProvidersCacheFile() {
  for (const p of [PROVIDERS_CACHE, PROVIDERS_CACHE_BUNDLED]) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function normalizeProvidersPayload(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.providers)
      ? data.providers
      : [];
  return list;
}

async function fetchLiveProviders({ activeOnly = false } = {}) {
  const live = await client.getProviders();
  let providers = normalizeProvidersPayload(live);
  if (activeOnly) {
    providers = providers.filter(
      (p) => String(p.status || '').toLowerCase() === 'active'
    );
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: `${config.apiBase}/provider-status`,
    count: normalizeProvidersPayload(live).length,
    activeCount: normalizeProvidersPayload(live).filter(
      (p) => String(p.status || '').toLowerCase() === 'active'
    ).length,
    providers,
  };
  try {
    fs.writeFileSync(PROVIDERS_CACHE, JSON.stringify(payload, null, 2));
  } catch {
    /* ignore cache write errors */
  }
  return payload;
}

function findProvider(providers, providerId) {
  return (providers || []).find(
    (p) => String(p.id).toLowerCase() === String(providerId).toLowerCase()
  );
}


/**
 * Slovak UI groups — curated customer checkout (SK · HU · PL · CZ).
 * Customer-facing copy: normal payments only (no crypto / USDC / on-ramp wording).
 * Visible: card, SEPA/Instant, Revolut, Apple/Google Pay (+ Switchere / .is / Ramp).
 * Hidden: PayPal (CZ/SK unverified on C2P PYUSD path), Coinbase Apple Pay (USD session),
 * BTCPay raw, Binance, Blockchain.com, heavy-KYC .is (MoonPay/Paybis/Topper),
 * non-EU, iDEAL/Klarna, Mollie/GetBlitz/BLIK/P24 until keys.
 * CZ/SK verification: see CZ-SK-VERIFIED.md (2026-10-07).
 * Wise: NOT available as a Chain2Pay .net / .is provider id (only GetBlitz bank adapter).
 */
// Card on-ramp minimum (Guardarian card / widget). BTCPay store now gives an on-chain BTC address from 5 EUR
// (lowered 2026-10-20), so the binding limit is Guardarian's own buy minimum: 15 EUR.
const ONRAMP_MIN_EUR = Number(process.env.ONRAMP_MIN_EUR) || 15;

const METHOD_GROUPS = [
  {
    key: 'cards',
    label: 'Platba kartou',
    color: '#3b82f6',
    entries: [
      {
        providerId: 'banxa',
        label: 'Platba kartou Banxa',
        hint: 'dočasne nedostupné — C2P settlement USDC, nie BTC (BTCPay)',
        preferred: false,
        soon: true,
      },
      {
        providerId: 'stripe',
        label: 'Platba kartou Stripe',
        hint: 'dočasne nedostupné — C2P settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'switchere',
        gateway: 'switchere',
        label: 'Platba kartou Switchere',
        hint: 'Visa / Mastercard · settlement BTC/LTC/BCH (rotácia pool)',
        preferred: true,
      },
      {
        providerId: 'multihosted',
        aliasId: 'is_multihosted',
        gateway: 'chain2pay_is',
        label: 'Platba kartou (auto)',
        hint: 'dočasne nedostupné — C2P.is settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'btcpay_onramp',
        aliasId: 'guardarian_card',
        gateway: 'btcpay_onramp',
        label: 'Platba kartou Guardarian',
        hint: 'Karta cez Guardarian widget',
        onrampForce: 'guardarian',
        minimumEur: ONRAMP_MIN_EUR,
      },
      {
        providerId: 'transak',
        aliasId: 'is_transak',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Transak',
        hint: 'dočasne nedostupné — C2P.is settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'transak',
        aliasId: 'is_transak_alt',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Transak (alt.)',
        hint: 'Alternatívna Transak cesta',
        hidden: true,
      },
      {
        providerId: 'alchemy',
        aliasId: 'is_alchemy',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Alchemy Pay',
        hint: 'dočasne nedostupné — C2P.is settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'kryptonim',
        gateway: 'kryptonim',
        label: 'Platba kartou Kryptonim',
        hint: 'dočasne nedostupné — settlement len BTC (BTCPay), nie USDC',
        buyUrl: 'https://buy.kryptonim.com/',
        soonIfUnconfigured: true,
        hidden: true,
      },
      {
        providerId: 'onramper',
        gateway: 'onramper',
        label: 'Platba kartou (agregátor)',
        hint: 'Onramper — agregátor s open-source SDK (porovná viaceré brány; pri malých sumách uprednostní ľahšie KYC, ak sú dostupné) · KYC robí vybraná brána · vyžaduje kľúč',
        soonIfUnconfigured: true,
      },
      {
        providerId: 'btcpay_onramp',
        gateway: 'btcpay_onramp',
        label: 'Platba kartou (widget)',
        hint: 'Karta / banka cez on-ramp widget',
        minimumEur: ONRAMP_MIN_EUR,
      },
      {
        providerId: 'banxa',
        aliasId: 'is_banxa',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Banxa (alt.)',
        hint: 'Alternatívna Banxa cesta',
        hidden: true,
      },
      {
        providerId: 'banxa2',
        aliasId: 'is_banxa2',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Banxa 2',
        hint: 'Ďalšia Banxa cesta',
        hidden: true,
      },
      {
        providerId: 'stripe',
        aliasId: 'is_stripe',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Stripe (alt.)',
        hint: 'Alternatívna Stripe cesta',
        hidden: true,
      },
      {
        providerId: 'robinhood',
        label: 'Platba kartou (Robinhood)',
        hint: 'USA only',
        hidden: true,
      },
      {
        providerId: 'sardine',
        label: 'Platba kartou (Sardine)',
        hint: 'nedostupné',
        hidden: true,
      },
      {
        providerId: 'topper',
        aliasId: 'is_topper',
        gateway: 'chain2pay_is',
        label: 'Platba kartou (Topper)',
        hint: 'plné overenie',
        hidden: true,
      },
      {
        providerId: 'moonpay',
        aliasId: 'is_moonpay',
        gateway: 'chain2pay_is',
        label: 'Platba kartou (MoonPay)',
        hint: 'ťažšie overenie',
        hidden: true,
      },
      {
        providerId: 'paybis',
        aliasId: 'is_paybis',
        gateway: 'chain2pay_is',
        label: 'Platba kartou (Paybis)',
        hint: 'plné overenie',
        hidden: true,
      },
    ],
  },
  {
    key: 'sepa',
    label: 'Bankový prevod / SEPA',
    color: '#22c55e',
    entries: [
      {
        providerId: 'banxa',
        aliasId: 'banxa_bank',
        label: 'SEPA Banxa',
        hint: 'dočasne nedostupné — C2P settlement USDC, nie BTC (BTCPay)',
        preferred: false,
        soon: true,
      },
      {
        providerId: 'banxa',
        aliasId: 'sepa_instant',
        label: 'SEPA Instant Banxa',
        hint: 'dočasne nedostupné — C2P settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'switchere',
        aliasId: 'switchere_bank',
        gateway: 'switchere',
        label: 'SEPA Switchere',
        hint: 'SEPA / SEPA Instant EUR · settlement BTC/LTC/BCH (rotácia pool)',
        preferred: true,
      },
      {
        providerId: 'bank_sepa_manual',
        gateway: 'bank_sepa_manual',
        label: 'SEPA platba',
        hint: 'Len suma · platobné údaje (IBAN, poznámka) dostanete na stránke',
        preferred: true,
      },
      {
        providerId: 'transak',
        aliasId: 'is_transak_sepa',
        gateway: 'chain2pay_is',
        label: 'SEPA Transak',
        hint: 'dočasne nedostupné — C2P.is settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'ramp',
        aliasId: 'is_ramp',
        gateway: 'chain2pay_is',
        label: 'SEPA / karta Ramp',
        hint: 'dočasne nedostupné — C2P.is settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'onramper',
        aliasId: 'onramper_bank',
        gateway: 'onramper',
        label: 'SEPA (agregátor)',
        hint: 'SEPA cez Onramper (agregátor s open-source SDK) · KYC robí vybraná brána · vyžaduje kľúč',
        soonIfUnconfigured: true,
      },
      {
        providerId: 'getblitz',
        gateway: 'getblitz',
        label: 'SEPA Instant QR (GetBlitz)',
        hint: 'dočasne nedostupné — SEPA na EUR IBAN, nie BTC settlement',
        soonIfUnconfigured: true,
        hidden: true,
      },
      {
        providerId: 'mollie_banktransfer',
        gateway: 'mollie',
        label: 'Bankový prevod (Mollie)',
        hint: 'vyžaduje MOLLIE_API_KEY',
        soonIfUnconfigured: true,
        hidden: true,
      },
      {
        providerId: 'mollie_przelewy24',
        gateway: 'mollie',
        label: 'Przelewy24 (Mollie)',
        hint: 'vyžaduje MOLLIE_API_KEY',
        soonIfUnconfigured: true,
        hidden: true,
      },
      {
        providerId: 'mollie_blik',
        gateway: 'mollie',
        label: 'BLIK (Mollie)',
        hint: 'vyžaduje MOLLIE_API_KEY',
        soonIfUnconfigured: true,
        hidden: true,
      },
    ],
  },
  {
    key: 'crypto_direct',
    label: 'Krypto – priamo na peňaženku',
    color: '#f59e0b',
    entries: [
      {
        providerId: 'crypto_direct',
        aliasId: 'crypto_direct',
        gateway: 'crypto_direct',
        label: 'Krypto priamo na peňaženku',
        hint: 'BTC, LTC, USDT, USDC, ETH, SOL… · pošlete priamo na našu adresu · zadáte len sumu',
      },
      {
        // ⚡ Blink Lightning invoice for the exact amount (off by default – payMethods DEFAULT_OFF; hidden until configured)
        providerId: 'blink_ln',
        aliasId: 'blink_ln',
        gateway: 'blink_ln',
        label: 'Bitcoin Lightning (Blink)',
        hint: 'Lightning faktúra na presnú sumu · QR kód · potvrdenie automaticky · zadáte len sumu',
      },
    ],
  },
  {
    key: 'changelly',
    label: 'Revolut · Karta · SEPA',
    color: '#7ee050',
    entries: [
      {
        providerId: 'revolut_ramp',
        aliasId: 'revolut_ramp',
        gateway: 'revolut_ramp',
        label: 'Revolut',
        subtitle: 'cez Revolut Ramp',
        hint: 'Zaplatíte v aplikácii Revolut · cez Revolut Ramp',
        minimumEur: 6,
      },
      {
        providerId: 'changelly_card',
        aliasId: 'changelly_card',
        gateway: 'changelly',
        label: 'Karta',
        subtitle: 'cez Changelly',
        hint: 'Visa / Mastercard, Apple Pay / Google Pay · cez Changelly',
        minimumEur: 10,
      },
      {
        providerId: 'changelly_sepa',
        aliasId: 'changelly_sepa',
        gateway: 'changelly',
        label: 'SEPA',
        subtitle: 'cez Changelly',
        hint: 'Bankový prevod · cez Changelly',
        minimumEur: 10,
      },
    ],
  },
  {
    key: 'revolut',
    label: 'Revolut',
    color: '#8b5cf6',
    entries: [
      {
        providerId: 'revolut_manual',
        aliasId: 'revolut_manual',
        gateway: 'revolut_manual',
        label: 'Revolut',
        hint: 'Platba priamo na Revolut účet · zadáte len sumu · Revtag dostanete do pár minút',
        preferred: true,
      },
    ],
  },
  {
    key: 'mtpelerin',
    label: 'Mt Pelerin (Bridge)',
    color: '#0ea5e9',
    entries: [
      {
        providerId: 'mtpelerin',
        aliasId: 'mtpelerin',
        gateway: 'mtpelerin',
        label: 'Mt Pelerin · kartou / bankou',
        hint: 'Mt Pelerin Bridge (Švajčiarsko) · EUR kartou alebo SEPA → BTC · KYC robíte u Mt Pelerin',
      },
    ],
  },
  {
    key: 'keyless',
    label: 'Ďalšie brány (bez registrácie u nás)',
    color: '#64748b',
    entries: [
      { providerId: 'keyless', aliasId: 'changenow_buy', gateway: 'keyless', label: 'ChangeNOW · kúpa BTC kartou',
        hint: 'ChangeNOW verejná stránka · karta (cez ich partnerov) · adresu skopírujete · KYC robí brána' },
      { providerId: 'keyless', aliasId: 'paybis_buy', gateway: 'keyless', label: 'Paybis · kartou / SEPA',
        hint: 'Paybis verejná stránka · karta, Apple/Google Pay, SEPA · adresu skopírujete · KYC robí Paybis' },
      { providerId: 'keyless', aliasId: 'anycoin_buy', gateway: 'keyless', label: 'Anycoin (CZ/SK) · bankou / kartou',
        hint: 'Anycoin.cz · účet a KYC u Anycoin · BTC pošlete na skopírovanú adresu' },
      { providerId: 'keyless', aliasId: 'coinmate_buy', gateway: 'keyless', label: 'Coinmate (CZ) · SEPA / kartou',
        hint: 'Coinmate burza · účet a KYC u Coinmate · výber BTC na skopírovanú adresu' },
      { providerId: 'keyless', aliasId: 'bitpanda_buy', gateway: 'keyless', label: 'Bitpanda · SEPA / kartou',
        hint: 'Bitpanda · účet a KYC u Bitpanda · výber BTC na skopírovanú adresu' },
      { providerId: 'keyless', aliasId: 'kriptomat_buy', gateway: 'keyless', label: 'Kriptomat · SEPA / kartou',
        hint: 'Kriptomat · účet a KYC u Kriptomat · výber BTC na skopírovanú adresu' },
    ],
  },
  {
    key: 'meld',
    label: 'Meld (agregátor)',
    color: '#14b8a6',
    entries: [
      {
        providerId: 'meld',
        aliasId: 'meld',
        gateway: 'meld',
        label: 'Meld · agregátor (karta / banka)',
        hint: 'Meld porovná viaceré brány → BTC na novú adresu · KYC robí vybraná brána',
        soonIfUnconfigured: true,
        unconfiguredLabel: 'nedostupné – chýba kľúč',
      },
    ],
  },
  {
    key: 'skrill',
    label: 'Skrill',
    color: '#6366f1',
    entries: [
      {
        providerId: 'switchere',
        aliasId: 'switchere_skrill',
        gateway: 'switchere',
        label: 'Skrill',
        hint: 'Skrill · settlement BTC/LTC/BCH (rotácia pool)',
        preferred: true,
      },
    ],
  },
  {
    key: 'paysafecard',
    label: 'PaysafeCard',
    color: '#ef4444',
    entries: [
      {
        providerId: 'paysafecard',
        gateway: 'paysafecard',
        label: 'PaysafeCard',
        hint: 'Len návod — PIN nikomu neposielajte',
        preferred: true,
      },
    ],
  },
  {
    key: 'g2a_amazon',
    label: 'Darčekové karty Amazon',
    color: '#f59e0b',
    entries: [
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_10',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 10 €',
        productId: 'amazon_de_10',
        amountEur: 10,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-10-eur-amazon-key-germany-i10000001698004',
        hint: 'Presne 10 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_25',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 25 €',
        productId: 'amazon_de_25',
        amountEur: 25,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-germany-25-eur-amazon-i10000001698002',
        hint: 'Presne 25 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_45',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 45 €',
        productId: 'amazon_de_45',
        amountEur: 45,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-45-eur-amazon-germany-i10000001698088',
        hint: 'Presne 45 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_50',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 50 €',
        productId: 'amazon_de_50',
        amountEur: 50,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-50-eur-amazon-key-germany-i10000001698012',
        hint: 'Presne 50 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_85',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 85 €',
        productId: 'amazon_de_85',
        amountEur: 85,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-85-eur-amazon-key-germany-i10000178883055',
        hint: 'Presne 85 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_100',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 100 €',
        productId: 'amazon_de_100',
        amountEur: 100,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-100-eur-amazon-key-germany-i10000001698005',
        hint: 'Presne 100 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_amazon_de_200',
        gateway: 'g2a',
        label: 'Darčeková karta Amazon 200 €',
        productId: 'amazon_de_200',
        amountEur: 200,
        buyUrl: 'https://www.g2a.com/amazon-gift-card-200-eur-amazon-germany-i10000001698076',
        hint: 'Presne 200 € · len návod — kód nikomu neposielajte',
      },
    ],
  },
  {
    key: 'g2a_azteco',
    label: 'Darčekové karty Azteco',
    color: '#fb923c',
    entries: [
      {
        providerId: 'g2a',
        aliasId: 'g2a_azteco_ln_10',
        gateway: 'g2a',
        label: 'Darčeková karta Azteco 10 €',
        productId: 'azteco_ln_10',
        amountEur: 10,
        buyUrl: 'https://www.g2a.com/azteco-bitcoin-lightning-voucher-10-eur-azteco-key-global-i10000337158001',
        hint: 'Presne 10 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_azteco_ln_50',
        gateway: 'g2a',
        label: 'Darčeková karta Azteco 50 €',
        productId: 'azteco_ln_50',
        amountEur: 50,
        buyUrl: 'https://www.g2a.com/azteco-bitcoin-lightning-voucher-50-eur-azteco-key-global-i10000337158007',
        hint: 'Presne 50 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_azteco_ln_200',
        gateway: 'g2a',
        label: 'Darčeková karta Azteco 200 €',
        productId: 'azteco_ln_200',
        amountEur: 200,
        buyUrl: 'https://www.g2a.com/azteco-bitcoin-lightning-voucher-200-eur-azteco-key-global-i10000337158008',
        hint: 'Presne 200 € · len návod — kód nikomu neposielajte',
      },
      {
        providerId: 'g2a',
        aliasId: 'g2a_azteco_onchain_100',
        gateway: 'g2a',
        label: 'Darčeková karta Azteco 100 €',
        productId: 'azteco_onchain_100',
        amountEur: 100,
        buyUrl: 'https://www.g2a.com/azteco-bitcoin-on-chain-voucher-100-eur-azteco-key-global-i10000337159005',
        hint: 'Presne 100 € · len návod — kód nikomu neposielajte',
      },
    ],
  },
  {
    key: 'paypal',
    label: 'PayPal',
    color: '#0ea5e9',
    entries: [
      {
        providerId: 'paypal',
        label: 'PayPal',
        hint: 'CZ/SK neoverené',
        preferred: false,
        hidden: true,
      },
      {
        providerId: 'paypal',
        aliasId: 'is_paypal',
        gateway: 'chain2pay_is',
        label: 'PayPal (alt.)',
        hint: 'CZ/SK neoverené',
        hidden: true,
      },
    ],
  },
  {
    key: 'wallets',
    label: 'Apple Pay / Google Pay',
    color: '#ec4899',
    entries: [
      {
        providerId: 'banxa',
        aliasId: 'apple_google_banxa',
        label: 'Apple / Google Banxa',
        hint: 'dočasne nedostupné — C2P settlement USDC, nie BTC (BTCPay)',
        preferred: false,
        soon: true,
      },

      {
        providerId: 'stripe',
        aliasId: 'apple_google_stripe',
        label: 'Apple / Google Stripe',
        hint: 'dočasne nedostupné — C2P settlement USDC, nie BTC (BTCPay)',
        soon: true,
      },
      {
        providerId: 'switchere',
        aliasId: 'apple_google_switchere',
        gateway: 'switchere',
        label: 'Apple / Google Switchere',
        hint: 'Apple/Google · settlement BTC/LTC/BCH (rotácia pool)',
        preferred: true,
      },
      {
        providerId: 'onramper',
        aliasId: 'apple_google_onramper',
        gateway: 'onramper',
        label: 'Apple / Google (agregátor)',
        hint: 'Onramper — agregátor s open-source SDK · KYC robí vybraná brána · vyžaduje kľúč',
        soonIfUnconfigured: true,
      },
      {
        providerId: 'coinbase',
        aliasId: 'apple_pay_coinbase',
        label: 'Apple / Google Coinbase',
        hint: 'Neoverené pre SK/CZ',
        hidden: true,
      },
    ],
  },
  {
    key: 'onramps',
    label: 'Ďalšie platby',
    color: '#14b8a6',
    entries: [
      {
        providerId: 'guardarian',
        aliasId: 'is_guardarian',
        gateway: 'chain2pay_is',
        label: 'Platba kartou Guardarian (.is)',
        hint: 'C2P.is Guardarian',
        soon: true,
      },
    ],
  },
  {
    key: 'paypal_hidden',
    label: 'PayPal (legacy)',
    color: '#64748b',
    entries: [
      {
        providerId: 'paypal',
        aliasId: 'paypal_legacy',
        label: 'PayPal legacy',
        hint: 'duplicitný záznam',
        hidden: true,
      },
    ],
  },
  {
    key: 'onramp_btcpay',
    label: 'Bank/card → BTC',
    color: '#64748b',
    entries: [
      {
        providerId: 'btcpay_onramp',
        aliasId: 'onramp_btcpay',
        gateway: 'btcpay_onramp',
        label: 'Bank/card → BTC',
        hint: 'skryté z predvoleného checkoutu',
        hidden: true,
      },
    ],
  },
  {
    key: 'crypto_btcpay',
    label: 'Krypto',
    color: '#06b6d4',
    entries: [
      {
        providerId: 'btcpay',
        gateway: 'btcpay',
        label: 'BTC / Lightning',
        hint: 'Bitcoin alebo Lightning',
        soonIfUnconfigured: true,
        preferred: true,
      },
    ],
  },
  {
    key: 'crypto',
    label: 'Ďalšie',
    color: '#64748b',
    entries: [
      { providerId: 'binance', label: 'Binance', hint: 'skryté', hidden: true },
      { providerId: 'coinbase', label: 'Coinbase', hint: 'skryté', hidden: true },
      { providerId: 'blockchaincom', label: 'Blockchain.com', hint: 'skryté', hidden: true },
      { providerId: 'cashapp', label: 'Cash App', hint: 'USA only', hidden: true },
      { providerId: 'topper', label: 'Topper', hint: 'skryté', hidden: true },
      { providerId: 'meld', label: 'Meld', hint: 'skryté', hidden: true },
      { providerId: 'simplex', label: 'Simplex', soon: true, hidden: true },
      { providerId: 'particle', label: 'Particle', soon: true, hidden: true },
    ],
  },
  {
    key: 'regional',
    label: 'Ďalšie regióny',
    color: '#64748b',
    entries: [
      { providerId: 'upi', label: 'UPI', hidden: true },
      { providerId: 'interac', label: 'Interac', hidden: true },
    ],
  },
  {
    key: 'ideal',
    label: 'iDEAL',
    color: '#64748b',
    entries: [
      { providerId: 'ideal', label: 'iDEAL', soon: true, hidden: true },
      {
        providerId: 'mollie_ideal',
        gateway: 'mollie',
        label: 'iDEAL (Mollie)',
        soonIfUnconfigured: true,
        hidden: true,
      },
    ],
  },
  {
    key: 'klarna',
    label: 'Klarna',
    color: '#64748b',
    entries: [
      { providerId: 'klarna', label: 'Klarna', soon: true, hidden: true },
    ],
  },
];

const SMOKE_PASSED_IDS_BASE = [
  'stripe',
  'banxa',
  'revolut',
  // PayPal / Binance / Coinbase / Blockchain.com remain callable via API
  // but are hidden from default customer UI (METHOD_GROUPS.hidden).
  'paypal',
  'coinbase',
  'binance',
  'blockchaincom',
];

/** Visible checkout smoke (data/visible-methods-smoke.json) — selectId + providerId. */
function loadVisibleMethodsSmoke() {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'visible-methods-smoke.json'), 'utf8')
    );
    const passed = new Set(
      (j.passed || [])
        .concat((j.results || []).filter((r) => r && r.ok).map((r) => r.id))
        .map((x) => String(x).toLowerCase())
    );
    const failed = new Set(
      (j.failed || [])
        .concat((j.results || []).filter((r) => r && r.ok === false).map((r) => r.id))
        .map((x) => String(x).toLowerCase())
    );
    return { loaded: true, passed, failed, ranAt: j.ranAt || null };
  } catch {
    return { loaded: false, passed: new Set(), failed: new Set(), ranAt: null };
  }
}
const VISIBLE_METHODS_SMOKE = loadVisibleMethodsSmoke();

const SMOKE_PASSED_IDS = new Set([
  ...SMOKE_PASSED_IDS_BASE,
  ...VISIBLE_METHODS_SMOKE.passed,
]);

const VERIFIED_PROVIDER_IDS = new Set([
  ...SMOKE_PASSED_IDS,
  // aliases map back to real provider ids in checkout
]);

/** chain2pay.is providers that returned checkout_url in smoke (data/chain2pay-is-smoke.json). */
function loadIsSmokePassed() {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'chain2pay-is-smoke.json'), 'utf8')
    );
    return new Set((j.working || []).map((x) => String(x).toLowerCase()));
  } catch {
    return new Set(['ramp', 'banxa', 'revolut']);
  }
}
const IS_SMOKE_PASSED = loadIsSmokePassed();

/** Smoke gate for a checkout select id (alias) / provider id. */
function smokeStatusFor(selectId, providerId, gateway) {
  const sid = String(selectId || '').toLowerCase();
  const pid = String(providerId || '').toLowerCase();
  const gw = String(gateway || 'chain2pay').toLowerCase();
  if (VISIBLE_METHODS_SMOKE.loaded) {
    if (VISIBLE_METHODS_SMOKE.failed.has(sid) || VISIBLE_METHODS_SMOKE.failed.has(pid)) {
      return { ok: false, label: 'dočasne nedostupné' };
    }
    if (VISIBLE_METHODS_SMOKE.passed.has(sid) || VISIBLE_METHODS_SMOKE.passed.has(pid)) {
      return { ok: true, label: null };
    }
    // Not in latest smoke artifact → treat as temporarily unavailable (will re-smoke).
    return { ok: false, label: 'dočasne nedostupné' };
  }
  if (gw === 'chain2pay') {
    return SMOKE_PASSED_IDS.has(pid)
      ? { ok: true, label: null }
      : { ok: false, label: 'dočasne nedostupné' };
  }
  if (gw === 'chain2pay_is') {
    return IS_SMOKE_PASSED.has(pid)
      ? { ok: true, label: null }
      : { ok: false, label: 'dočasne nedostupné' };
  }
  return { ok: true, label: null };
}


function ossStatus(gateway) {
  if (gateway === 'btcpay') return btcpay.status();
  if (gateway === 'btcpay_onramp') return onramp.status();
  if (gateway === 'getblitz') return getblitz.status();
  if (gateway === 'mollie') return mollie.status();
  if (gateway === 'chain2pay_is') return chain2payIs.status();
  if (gateway === 'switchere') return switchere.status();
  if (gateway === 'revolut_manual') return { configured: true, hint: 'Revolut · Revtag cez Telegram' };
  if (gateway === 'keyless') return { configured: true, hint: 'verejná stránka, bez kľúča' };
  if (gateway === 'blink_ln') return blink.status();
  if (gateway === 'crypto_direct') return { configured: cryptoDirect.enabled(), hint: 'adresy z „Adresy peňaženiek“ (admin)' };
  if (gateway === 'revolut_ramp') return { configured: changelly.enabled('revolut_ramp'), hint: 'ramp.revolut.com · LTC/BTC/DOGE/BCH na adresy z „Adresy peňaženiek“' };
  if (gateway === 'changelly') return { configured: changelly.enabled(), hint: 'changelly.com/buy · LTC/BTC/BCH/DOGE na adresy z „Adresy peňaženiek“' };
  if (gateway === 'meld') return { configured: Boolean(String(process.env.MELD_PUBLIC_KEY || '').trim()), hint: 'Meld widget (MELD_PUBLIC_KEY)' };
  if (gateway === 'mtpelerin') return { configured: true, hint: 'Mt Pelerin priamy odkaz (bez merchant kľúča)' };
  if (gateway === 'guardarian') return { configured: true, locked: guardarian.isConfigured(), hint: guardarian.isConfigured() ? 'Guardarian API · adresa zamknutá' : 'Guardarian verejná stránka · adresa na skopírovanie' };
  if (gateway === 'kryptonim') return kryptonim.status();
  if (gateway === 'bank_sepa_manual') return { id: 'bank_sepa_manual', provider_name: 'SEPA platba', configured: true, hint: 'Len suma · IBAN + poznámka cez Telegram / bot' };
  if (gateway === 'paysafecard') return paysafecard.status();
  if (gateway === 'g2a') return g2a.status();
  if (gateway === 'onramper') return onramper.status();
  return { configured: false };
}

function buildExtraProviders() {
  // Kept for /api/config-public extras; UI uses METHOD_GROUPS (configured-only).
  const extras = [];
  for (const gw of [
    ['btcpay', btcpay],
    ['btcpay_onramp', onramp],
    ['getblitz', getblitz],
    ['mollie', mollie],
    ['chain2pay_is', chain2payIs],
    ['switchere', switchere],
    ['kryptonim', kryptonim],
    ['onramper', onramper],
    ['bank_sepa_manual', electrocoin],
    ['paysafecard', paysafecard],
    ['g2a', g2a],
  ]) {
    const [id, mod] = gw;
    const s = mod.status();
    extras.push({
      id,
      provider_name: s.provider_name,
      status: s.configured ? 'active' : 'setup_required',
      group: 'opensource',
      configured: s.configured,
      hint: s.hint,
      minimum_amount: 1,
      minimum_currency: 'EUR',
      gateway: id,
      methods: s.methods,
    });
  }
  return extras;
}

/** Built-in methods + admin overrides (logo / on-off / name / order) + admin-added custom payment links. */
function groupProviders(chainProviders) {
  const res = giftPick.collapse(payMethods.apply(walletGw.inject(oxapay.inject(giftCards.inject(groupProvidersBase(chainProviders)))), METHOD_GROUPS.map((g) => ({ key: g.key, label: g.label, color: g.color || null }))));
  // Per-amount payment links: expose only the matching amounts (never URLs) so the UI can go amount-only on an exact match.
  const al = amountLinks.amountsByMethod();
  const tag = (it) => { if (it && al[it.id]) it.amountLinks = al[it.id]; };
  if (res && res.groups) for (const g of Object.values(res.groups)) { (g.providers || []).forEach(tag); (g.soon || []).forEach(tag); }
  if (res) { (res.providers || []).forEach(tag); }
  return res;
}
// Public provider pages of the keyless built-ins (same as KEYLESS in handleCreateCheckout) — "Otvoriť odkaz" on the admin dashboard.
const BUILTIN_PUBLIC_URLS = {
  changenow_buy: 'https://changenow.io/buy/bitcoin', paybis_buy: 'https://paybis.com/', anycoin_buy: 'https://www.anycoin.cz/',
  coinmate_buy: 'https://coinmate.io/', bitpanda_buy: 'https://www.bitpanda.com/', kriptomat_buy: 'https://kriptomat.io/',
};
/** Current system availability of built-ins (čoskoro / dočasne nedostupné), from the cached provider list — no network call. */
function builtinLiveStatus() {
  const cached = readProvidersCacheFile();
  const base = groupProvidersBase((cached && cached.providers) || []);
  const out = {};
  for (const g of Object.values(base.groups)) {
    for (const it of g.providers) out[it.id] = { soon: false, label: null };
    for (const it of g.soon) out[it.id] = { soon: true, label: it.unavailableLabel || 'čoskoro' };
  }
  return out;
}
/** Methods offered in „Odkazy podľa sumy“: every visible built-in + admin custom links; link-based ones listed first. */
const LINK_BASED_GROUPS = new Set(['revolut', 'skrill']);
const LINK_BASED_GATEWAYS = new Set(['revolut_manual', 'keyless', 'guardarian', 'mtpelerin', 'switchere', 'custom']);
function amountLinkMethods() {
  const gw = {}; for (const g of METHOD_GROUPS) for (const en of g.entries) gw[String(en.aliasId || en.providerId).toLowerCase()] = en.gateway || 'chain2pay';
  const out = builtinMethods().filter((m) => m.id !== 'crypto_direct' && m.id !== 'blink_ln' && m.id !== 'btcpay' && !/^(g2a|paysafe)/.test(m.id)).map((m) => ({ id: m.id, label: m.label, linkBased: LINK_BASED_GROUPS.has(m.group) || LINK_BASED_GATEWAYS.has(gw[m.id]) }));
  try { for (const r of payMethods.customs ? payMethods.customs() : []) if (!r.deleted) out.push({ id: r.id, label: r.name + ' (vlastný odkaz)', linkBased: true }); } catch { /* none */ }
  return out;
}
function builtinMethods() {
  const out = []; const seen = new Set();
  for (const g of METHOD_GROUPS) for (const entry of g.entries) {
    if (entry.hidden) continue;
    const id = String(entry.aliasId || entry.providerId).toLowerCase();
    if (seen.has(id)) continue; seen.add(id);
    out.push({ id, label: entry.label, group: g.key, soon: Boolean(entry.soon), url: entry.buyUrl || BUILTIN_PUBLIC_URLS[id] || null });
  }
  return out;
}

function groupProvidersBase(chainProviders) {
  const byId = Object.create(null);
  for (const p of chainProviders || []) {
    byId[String(p.id).toLowerCase()] = p;
  }

  const groups = {};
  const flat = [];
  const soonFlat = [];

  for (const g of METHOD_GROUPS) {
    const list = [];
    const soonList = [];
    for (const entry of g.entries) {
      if (entry.hidden) continue;
      const pid = String(entry.providerId).toLowerCase();
      const gateway = entry.gateway || 'chain2pay';
      // Ryan: keyless only — hide key-gated aggregators until their own env key is set.
      if (gateway === 'meld' && !String(process.env.MELD_PUBLIC_KEY || '').trim()) continue;
      if ((gateway === 'onramper' || pid === 'onramper') && !String(process.env.ONRAMPER_API_KEY || '').trim()) continue;
      // Direct crypto: hidden entirely until at least one wallet address is enabled.
      if (gateway === 'crypto_direct' && !cryptoDirect.enabled()) continue;
      if (gateway === 'blink_ln' && !blink.configured()) continue;
      if (gateway === 'changelly' && !changelly.enabled()) continue;
      if (gateway === 'revolut_ramp' && !changelly.enabled('revolut_ramp')) continue;
      const selectId = String(entry.aliasId || entry.providerId).toLowerCase();

      if (gateway !== 'chain2pay') {
        const s = ossStatus(gateway);
        const configured = Boolean(s.configured);
        let soon =
          Boolean(entry.soon) ||
          (entry.soonIfUnconfigured && !configured);
        let unavailableLabel = (!configured && entry.unconfiguredLabel) || 'čoskoro';
        let minimum_amount = 1;
        let minimum_currency = 'EUR';
        if (gateway === 'chain2pay_is') {
          minimum_amount = chain2payIs.minEurForProvider(pid, []);
          minimum_currency = 'EUR';
        }
        const smoke = smokeStatusFor(selectId, pid, gateway);
        const forceRevolutOss = /^revolut/.test(pid) || /^revolut_/.test(selectId) || gateway === 'guardarian' || gateway === 'mtpelerin' || gateway === 'meld' || gateway === 'keyless' || gateway === 'revolut_manual' || gateway === 'crypto_direct' || gateway === 'blink_ln' || gateway === 'changelly' || gateway === 'revolut_ramp';
        if (!soon && configured && !smoke.ok && !forceRevolutOss) {
          soon = true;
          unavailableLabel = smoke.label || 'dočasne nedostupné';
        } else if (!soon && !configured && entry.soonIfUnconfigured) {
          unavailableLabel = entry.unconfiguredLabel || 'čoskoro';
        } else if (soon && entry.soon) {
          // Intentional čoskoro (e.g. is_guardarian duplicate of live guardarian_card)
          unavailableLabel = 'čoskoro';
        } else if (soon && !smoke.ok && configured) {
          unavailableLabel = smoke.label || 'dočasne nedostupné';
        }
        if (entry.minimumEur != null && Number.isFinite(Number(entry.minimumEur))) {
          minimum_amount = Math.max(minimum_amount, Number(entry.minimumEur));
        }
        if (entry.amountEur != null && Number.isFinite(Number(entry.amountEur))) {
          minimum_amount = Number(entry.amountEur);
          minimum_currency = 'EUR';
        }
        const item = {
          id: selectId,
          providerId: pid,
          provider_name: entry.label,
          subtitle: entry.subtitle || undefined,
          method_label: soon ? `${entry.label} — ${unavailableLabel}` : entry.label,
          status: soon ? 'soon' : configured ? 'active' : 'setup_required',
          group: g.key,
          gateway,
          configured,
          soon,
          unavailableLabel: soon ? unavailableLabel : null,
          preferred: Boolean(entry.preferred) && !soon && configured,
          hint: entry.hint || s.hint,
          minimum_amount,
          minimum_currency,
          faceValueEur: entry.amountEur != null ? Number(entry.amountEur) : undefined,
          productId: entry.productId || undefined,
          buyUrl: entry.buyUrl || undefined,
          methods: s.methods || s.providers,
          demo: Boolean(s.demo),
          keyPrefix: s.keyPrefix || undefined,
        };
        if (soon || !configured) {
          soonList.push(item);
          soonFlat.push(item);
        } else {
          list.push(item);
          flat.push(item);
        }
        continue;
      }

      const meta = byId[pid];
      const active =
        meta && String(meta.status || '').toLowerCase() === 'active';
      const smoke = smokeStatusFor(selectId, pid, 'chain2pay');
      const smokeOk = smoke.ok;
      // Revolut 1–4: keep selectable for My-wallet + BTCPay paste flow even if C2P marks inactive.
      const forceRevolut = /^revolut/.test(pid) || /^revolut_/.test(selectId) || selectId === 'apple_google_revolut';
      let soon = Boolean(entry.soon) || (!forceRevolut && !active) || (!forceRevolut && !smokeOk);
      if (forceRevolut && !entry.soon) soon = false;
      let unavailableLabel = !active
        ? 'čoskoro'
        : !smokeOk
          ? smoke.label || 'dočasne nedostupné'
          : 'čoskoro';

      if (!meta && !entry.soon) {
        // unknown / missing from live list → soon
        const item = {
          id: selectId,
          providerId: pid,
          provider_name: entry.label,
          subtitle: entry.subtitle || undefined,
          method_label: `${entry.label} — dočasne nedostupné`,
          status: 'soon',
          group: g.key,
          gateway: 'chain2pay',
          soon: true,
          unavailableLabel: 'dočasne nedostupné',
          hint: entry.hint || 'Provider nie je v live zozname',
          buyUrl: entry.buyUrl || undefined,
        };
        soonList.push(item);
        soonFlat.push(item);
        continue;
      }

      const item = {
        ...(meta || {}),
        id: selectId,
        providerId: pid,
        provider_name: entry.label,
        method_label: soon
          ? `${entry.label} — ${unavailableLabel}`
          : entry.label,
        raw_provider_name: meta && meta.provider_name,
        hint: entry.hint,
        preferred: Boolean(entry.preferred) && !soon,
        group: g.key,
        gateway: 'chain2pay',
        soon,
        unavailableLabel: soon ? unavailableLabel : null,
        status: soon ? 'soon' : 'active',
        buyUrl: entry.buyUrl || undefined,
      };

      if (soon) {
        soonList.push(item);
        soonFlat.push(item);
      } else if (active && smokeOk) {
        list.push(item);
        flat.push(item);
      } else if (!soon && (active || forceRevolut)) {
        // Selectable even when upstream C2P status is not literally "active"
        item.status = 'active';
        item.soon = false;
        item.unavailableLabel = null;
        item.method_label = entry.label;
        list.push(item);
        flat.push(item);
      }
    }
    if (list.length || soonList.length) {
      groups[g.key] = {
        label: g.label,
        color: g.color || null,
        providers: list,
        soon: soonList,
      };
    }
  }

  return {
    groups,
    providers: flat,
    soonProviders: soonFlat,
    methodGroups: METHOD_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      color: g.color || null,
    })),
  };
}

function isChain2PayHost(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return (
      h === 'checkout.chain2pay.net' ||
      h.endsWith('.chain2pay.net') ||
      h === 'checkout.chain2pay.is' ||
      h.endsWith('.chain2pay.is') ||
      h === 'checkout.paygate.to' ||
      h.endsWith('.paygate.to')
    );
  } catch {
    return false;
  }
}

const __jsonSmall = express.json({ limit: '1mb' });
// /oxapay/callback needs the raw body for its HMAC → parsed by express.raw on the route itself.
app.use((req, res, next) => (req.path === '/api/proof' || req.path === payMethods.BRIDGE_PATH || req.path.startsWith('/api/admin-bridge/') || req.path === '/oxapay/callback' ? next() : __jsonSmall(req, res, next)));
const __urlenc = express.urlencoded({ extended: true });
app.use((req, res, next) => (req.path === '/oxapay/callback' ? next() : __urlenc(req, res, next)));
app.use((req, res, next) => (req.body && typeof req.body === 'object' && Object.keys(req.body).length ? readThrough(req, res, next) : next()));
// index.html via res.send so the language middleware can translate it + add the toggle
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'));
});
require('./statusLinks').register(app, { loadOrders });
require('./backup').register(app, { appendLog });
app.get('/robots.txt', (req, res) => res.type('text').set('Cache-Control', 'public, max-age=86400').send('User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /status/\n'));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    // Always revalidate HTML/JS so visitors never get a stale checkout page.
    if (/\.(html|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    // Static media/styles: long-lived + immutable (ETag still sent for validation).
    else if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
// Guided Electrocoin SEPA (no automation) — registered early so /bank-sepa-pay can redirect
electrocoinGuided.register(app, { loadOrders, saveOrders, appendLog });
// Live on-chain payment watcher (read-only public explorers)
require('./orderStatus').register(app, { loadOrders });
if (require('./payMode').jobs()) require('./chainWatcher').start({
  loadOrders,
  saveOrders,
  appendLog,
  onStatus: (order, status, r) => {
    if (status === 'unconfirmed' || status === 'confirmed') require('./xpub').markUsed(order && order.orderId).catch(() => {});
    if (order && (order.provider === 'changelly' || order.provider === 'revolut_ramp')) {
      changelly.onChainStatus(order, status, r, { loadOrders, saveOrders, appendLog }).catch((e) => appendLog('CHANGELLY_CHAIN_FAIL ' + (e && e.message)));
    }
    try {
      if (global.__telegramBot && (status === 'unconfirmed' || status === 'confirmed')) {
        global.__telegramBot.notifyChain(order, status);
      }
    } catch (e) {
      appendLog('TELEGRAM_CHAIN_FAIL ' + (e && e.message));
    }
  },
});
const __tg = telegramBot.createBot({
  loadOrders,
  saveOrders,
  appendLog,
  publicBase: (config.callbackBaseUrl || '').replace(/\/callback\/?$/i, '') || process.env.RENDER_EXTERNAL_URL || '',
});
global.__telegramBot = __tg;
__tg.register(app);
const __sup = require('./supportBot').create({ appendLog, mainBot: () => __tg });
global.__supportBot = __sup;
global.__azteco = require('./aztecoAuto').create({ appendLog }); if (require('./payMode').jobs()) global.__azteco.start();
__sup.register(app);


// Private SEPA admin (Ryan only) — /admin/login, /admin/platby/sepa
adminSepa.mount(app, { loadOrders, saveOrders, appendLog });
adminSepaChain.mount(app, { appendLog });
adminSepaChain.mountPublic(app, { appendLog });
require('./adminAzteco').mount(app, { loadOrders, saveOrders, appendLog });
// Admin: editable payment guides (SK/EN text + screenshots per step) — /admin/platby/guides; public images /gimg/:id
guideStore.mount(app, { appendLog });
guideStore.mountPublic(app);
// Admin: payment methods (custom payment links + logos/on-off/order for built-ins) — /admin/platby/methods
payMethods.mount(app, { appendLog, methodGroups: () => METHOD_GROUPS.map((g) => ({ key: g.key, label: g.label, color: g.color || null })), builtins: builtinMethods, liveStatus: builtinLiveStatus,
  // current customer-facing order (same code path as /api/providers) for the admin "Poradie na pokladni" card
  preview: async () => {
    const act = (l) => (l || []).filter((p) => String(p.status || '').toLowerCase() === 'active');
    const c = readProvidersCacheFile(); // written by every /api/providers call — no slow upstream fetch on admin pages
    if (c && Array.isArray(c.providers)) return groupProviders(act(c.providers));
    try { return groupProviders((await fetchLiveProviders({ activeOnly: true })).providers); } catch { return groupProviders([]); }
  },
  feeOf: (id, group) => { try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'method-costs.json'), 'utf8')); return c[id] || c['group:' + group] || null; } catch { return null; } } });
// Popularity ranking: anonymous per-method click counter + hourly recompute from Neon orders
methodRank.mountPublic(app);
payMethods.register(app);
// Admin: wallet receive addresses (source of truth for direct crypto) — /admin/platby/wallets + signed bridge
wallets.mount(app, { appendLog });
// Admin: per-amount payment links (Revolut, Skrill, …) — /admin/platby/amount-links + signed bridge; public /link-pay
amountLinks.mountAdmin(app);
// Admin „Kategórie“ + „Podľa sumy“ (same data as methods / amount links / guides; own admin-only links)
adminCategories.mountAdmin(app, { appendLog, fetchPlan: (id) => fetchPlan(id) });
amountLinks.mount(app, { loadOrders, saveOrders, appendLog });
// Public: direct crypto pay page (/crypto-pay) — addresses from wallets
cryptoDirect.mount(app, { loadOrders, saveOrders, appendLog });
// Public: ⚡ Blink Lightning invoice page (/blink-pay) + admin bridge /api/admin-bridge/blink
blink.mount(app, { loadOrders, saveOrders, appendLog });
giftCards.mount(app, { appendLog });
giftPick.mount(app);
fulfill.mount(app, { loadOrders, saveOrders, appendLog });
// 🪙 OxaPay invoices (/oxapay-pay, /oxapay/callback) + 💳 Card2Crypto / PayGate.to card payments (/wg-pay, /wg-callback) – hidden until configured in admin
oxapay.mount(app, { loadOrders, saveOrders, appendLog });
walletGw.mount(app, { loadOrders, saveOrders, appendLog });
// Public: Changelly pre-redirect page (/changelly-pay) — coin/address from wallets, watched by chainWatcher
changelly.mount(app, { loadOrders, saveOrders, appendLog });

/** Public provider list never carries fee estimates (admin-only): drop fee docs / hints from the diagnostic extras. */
function stripFees(v) {
  if (Array.isArray(v)) return v.map(stripFees);
  if (!v || typeof v !== 'object') return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (/fee|^ranking$|^destinationRank$|^destinations$|^destinationNote$/i.test(k)) continue;
    o[k] = stripFees(x);
  }
  return o;
}
app.use('/api/providers', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (b) => { if (b && b.extras) b.extras = stripFees(b.extras); return json(b); };
  next();
});
/** Live ACTIVE providers + open-source / EU extras. */
app.get('/api/providers', async (req, res) => {
  try {
    const activeOnly = String(req.query.active || '1') !== '0';
    const payload = await fetchLiveProviders({ activeOnly });
    const grouped = groupProviders(payload.providers);
    res.json({
      ...payload,
      providers: grouped.providers,
      soonProviders: grouped.soonProviders,
      groups: grouped.groups,
      methodGroups: grouped.methodGroups,
      rank: grouped.rank,
      extras: {
        btcpay: btcpay.status(),
        btcpay_onramp: onramp.status(),
        getblitz: getblitz.status(),
        mollie: mollie.status(),
        chain2pay_is: chain2payIs.status(),
      switchere: switchere.status(),
      kryptonim: kryptonim.status(),
      onramper: onramper.status(),
      bank_sepa_manual: electrocoin.status(),
      sepa_admin: {
        configured: adminSepa.isConfigured(),
      },
      paysafecard: paysafecard.status(),
      g2a: g2a.status(),
      destinations: destination.rankingDoc(),
      destinationPools: destination.poolSummary(),
      },
    });
  } catch (err) {
    // Fallback to cache if live fetch fails
    const cachedEarly = readProvidersCacheFile();
    if (cachedEarly) {
      try {
        const cached = cachedEarly;
        let providers = cached.providers || [];
        if (String(req.query.active || '1') !== '0') {
          providers = providers.filter(
            (p) => String(p.status || '').toLowerCase() === 'active'
          );
        }
        const grouped = groupProviders(providers);
        return res.json({
          ...cached,
          providers: grouped.providers,
          soonProviders: grouped.soonProviders,
          groups: grouped.groups,
          methodGroups: grouped.methodGroups,
      rank: grouped.rank,
          extras: {
            btcpay: btcpay.status(),
            btcpay_onramp: onramp.status(),
            getblitz: getblitz.status(),
            mollie: mollie.status(),
            chain2pay_is: chain2payIs.status(),
            switchere: switchere.status(),
            kryptonim: kryptonim.status(),
          bank_sepa_manual: electrocoin.status(),
      paysafecard: paysafecard.status(),
      g2a: g2a.status(),
          },
          stale: true,
          fetchError: err.message,
        });
      } catch {
        /* fall through */
      }
    }
    // Even without Chain2Pay, still return OSS options
    const grouped = groupProviders([]);
    res.status(200).json({
      providers: grouped.providers,
      soonProviders: grouped.soonProviders,
      groups: grouped.groups,
      methodGroups: grouped.methodGroups,
      rank: grouped.rank,
      extras: {
        btcpay: btcpay.status(),
        btcpay_onramp: onramp.status(),
        getblitz: getblitz.status(),
        mollie: mollie.status(),
        chain2pay_is: chain2payIs.status(),
      switchere: switchere.status(),
      kryptonim: kryptonim.status(),
      onramper: onramper.status(),
      bank_sepa_manual: electrocoin.status(),
      paysafecard: paysafecard.status(),
      g2a: g2a.status(),
      },
      fetchError: err.message,
      stale: true,
    });
  }
});

app.get('/api/config-public', (_req, res) => {
  const pools = addressPool.loadPools();
  res.json({
    merchantWallet: addressPool.walletsReady() ? addressPool.merchantEvm() : config.merchantWallet,
    currencyConstraints: config.currencyConstraints,
    callbackBaseUrl: config.callbackBaseUrl,
    addressPools: {
      btc: (pools.btc || []).length,
      ltc: (pools.ltc || []).length,
      bch: (pools.bch || []).length,
      evm: (pools.evm || []).length,
      lightning: (pools.lightning || []).length,
    },
    poolStats: addressPool.poolStats(),
    extras: {
      btcpay: btcpay.status(),
      getblitz: getblitz.status(),
      mollie: mollie.status(),
      chain2pay_is: chain2payIs.status(),
      switchere: switchere.status(),
      kryptonim: kryptonim.status(),
    onramper: onramper.status(),
    bank_sepa_manual: electrocoin.status(),
      paysafecard: paysafecard.status(),
      g2a: g2a.status(),
    },
  });
});

app.get('/api/address-pools', (_req, res) => {
  res.json({
    stats: addressPool.poolStats(),
    note: 'Addresses rotate per payment (unused-first, then round-robin). State: data/address-state.json',
  });
});

/** Rotate next pool address (btc|ltc). Smoke / admin. */
app.get('/api/destination/next', (req, res) => {
  try {
    const coin = String(req.query.coin || '').toLowerCase();
    const orderId = String(req.query.orderId || '').trim() || undefined;
    if (coin && !['btc', 'ltc', 'bch'].includes(coin)) {
      return res.status(400).json({
        error: 'coin must be btc, ltc, or bch (active pool coins)',
        poolCoins: destination.POOL_COINS,
      });
    }
    const dest = coin
      ? destination.nextPoolAddress(coin, orderId ? { orderId } : {})
      : destination.pickDestination({
          orderId,
          provider: 'switchere',
          allowEvmFallback: false,
        });
    res.json({
      ...dest,
      poolCoins: [...destination.POOL_COINS],
      ranking: destination.rankingDoc().rule,
    });
  } catch (err) {
    res.status(err.code === 'EMPTY_POOL' ? 503 : 400).json({
      error: err.message,
      code: err.code || null,
    });
  }
});


/**
 * Customer checkout: amount EUR + provider + email → wallet + convert →
 * server-side second_step → upstream provider URL (never send browser to
 * checkout.chain2pay.net).
 */
async function handleCreateCheckout(req, res) {
  try {
    const body = { ...(req.query || {}), ...(req.body || {}) };
    let email = String(body.email || '').trim();
    const ALIAS_MAP = {
      ...g2a.aliasMap(),
      apple_google_stripe: 'stripe',
      apple_google_revolut: 'guardarian_revolut',
      revolut_manual: 'revolut_manual',
      crypto_direct: 'crypto_direct',
      blink_ln: 'blink_ln',
      changelly_card: 'changelly', changelly_sepa: 'changelly', changelly_revolut: 'changelly', revolut_ramp: 'revolut_ramp',
      revolut_1: 'guardarian_revolut',
      changenow_buy: 'keyless', paybis_buy: 'keyless', anycoin_buy: 'keyless', coinmate_buy: 'keyless', bitpanda_buy: 'keyless', kriptomat_buy: 'keyless',
      revolut_2: 'guardarian_revolut',
      revolut_3: 'guardarian_revolut',
      revolut_4: 'guardarian_revolut',
      apple_google_banxa: 'banxa',
      apple_google_switchere: 'switchere',
      apple_pay_coinbase: 'coinbase',
      banxa_bank: 'banxa',
      sepa_instant: 'banxa',
      revolut_cee: 'guardarian_revolut',
      transak_sepa: 'transak',
      is_transak_sepa: 'is_transak',
      onramp_btcpay: 'btcpay_onramp',
      banxa_btcpay: 'btcpay_onramp',
      switchere_bank: 'switchere',
      switchere_card: 'switchere',
      switchere_skrill: 'switchere',
      skrill: 'switchere',
      onramper_bank: 'onramper',
      onramper_card: 'onramper',
      apple_google_onramper: 'onramper',
      guardarian_card: 'btcpay_onramp',
    };
    let provider = String(body.provider || '').trim();
    const providerAlias = provider.toLowerCase();
    // Admin-managed: disabled built-ins are refused; custom payment links (cm_*) use the keyless external-link flow.
    const customMethod = payMethods.customFor(providerAlias);
    if ((providerAlias.startsWith('cm_') && !customMethod) || payMethods.isBuiltinDisabled(providerAlias)) {
      return res.status(400).json({ error: 'Tento spôsob platby momentálne nie je dostupný. Vyberte iný.' });
    }
    if (customMethod) ALIAS_MAP[providerAlias] = 'keyless';
    if (ALIAS_MAP[providerAlias]) {
      provider = ALIAS_MAP[providerAlias];
    }
    let amountEur = Number(body.amount ?? body.amountEur ?? body.suma);
    let plan = null;
    if (body.plan_id != null && String(body.plan_id) !== '') {
      try { plan = await fetchPlan(body.plan_id); } catch { plan = null; }
      if (!plan) return res.status(400).json({ error: 'Plán sa nepodarilo overiť. Obnovte stránku cenníka a skúste znova.' });
      amountEur = plan.amount; // server-authoritative price
      body.amount = plan.amount;
      appendLog(`PLAN_CHECKOUT plan=${plan.id} eur=${plan.amount} name=${JSON.stringify(plan.name)}`);
    }
    const redirect =
      body.redirect === undefined
        ? req.method === 'POST' &&
          String(req.headers['content-type'] || '').includes(
            'application/x-www-form-urlencoded'
          )
        : String(body.redirect) === '1' || body.redirect === true;

    // PaysafeCard + G2A gift cards: amount/email collected on pay page — allow empty
    // on main checkout and fill placeholders for these gateways only.
    const providerLowerEarly = String(provider || '').toLowerCase();
    const isElectrocoinSepa =
      providerLowerEarly === 'bank_sepa_manual' ||
      providerLowerEarly === 'bank_sepa' ||
      providerLowerEarly === 'electrocoin' ||
      providerLowerEarly === 'electrocoin_manual' ||
      providerLowerEarly === 'sepa_manual';
    const deferredAmountEmail =
      providerLowerEarly === 'paysafecard' ||
      providerLowerEarly === 'paysafe' ||
      providerLowerEarly === 'psc' ||
      providerLowerEarly === 'paysafe_pin' ||
      providerLowerEarly === 'g2a' ||
      providerLowerEarly === 'g2a_voucher' ||
      providerAlias.startsWith('g2a_') ||
      providerAlias.startsWith('paysafe');

    if (deferredAmountEmail) {
      // PaysafeCard / G2A (Amazon, Azteco): informational guides only. No orders, no PIN/code collection.
      return res.status(409).json({
        error: 'Len informačný návod — PIN ani kód kupónu sa nikam neposiela.',
        code: 'GUIDE_ONLY',
        guideOnly: true,
      });
    }
    // Per-amount payment link (admin „Odkazy podľa sumy“): exact enabled match → only a „Zaplatiť“ button, URL stays server-side.
    {
      const link = Number.isFinite(amountEur) && amountEur > 0 ? amountLinks.match(providerAlias, amountEur) : null;
      if (link) {
        const linkOrderId = `ord_${crypto.randomBytes(8).toString('hex')}`;
        const order = await amountLinks.createOrder({
          link, orderId: linkOrderId, amountEur, provider,
          countryCode: customerPrefill.normalizeCountry(body.country || body.countryCode || process.env.ONRAMP_COUNTRY || 'SK'),
          providerAlias, loadOrders, saveOrders, appendLog,
        });
        if (redirect) return res.redirect(302, order.checkoutUrl);
        return res.json({ orderId: linkOrderId, checkoutUrl: order.checkoutUrl, localPayUrl: order.checkoutUrl, provider: 'amount_link', amountEur, currency: 'EUR', status: order.status });
      }
    }
    if (false) {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        email = 'pending@pay.local';
      }
      if (!Number.isFinite(amountEur) || amountEur <= 0) {
        if (
          providerLowerEarly === 'g2a' ||
          providerAlias.startsWith('g2a_')
        ) {
          const prod =
            g2a.getProduct(providerAlias) ||
            g2a.resolveProduct({ alias: providerAlias, productId: body.productId });
          amountEur = prod && Number(prod.amountEur) > 0 ? Number(prod.amountEur) : 50;
        } else {
          // PaysafeCard: denomination chosen on pay / shop page
          amountEur = 50;
        }
      }
    } else if (isElectrocoinSepa) {
      // Server creates readable temp inbox - customer does not supply email
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        email = '';
      }
    } else if (['guardarian_revolut', 'keyless', 'revolut_manual', 'crypto_direct', 'blink_ln', 'changelly', 'revolut_ramp', 'btcpay', 'mtpelerin', 'oxapay'].includes(String(ALIAS_MAP[providerAlias] || provider).toLowerCase())) {
      // Revolut / keyless public gateways: amount only — no email, name or country from the customer.
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';
    } else if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Platný email je povinný' });
    }
    const countryCode = customerPrefill.normalizeCountry(
      body.country || body.countryCode || process.env.ONRAMP_COUNTRY || 'SK'
    );
    // Customer profile: only the customer's own email + country. No generated identities.
    // Used for Switchere email lock + guide UX; Banxa/Revolut lack name/address URL params.
    const customer = customerPrefill.resolveCustomerProfile(
      { ...(body.customer || {}), ...(body.address || {}), email },
      countryCode
    );
    if (!provider) {
      return res.status(400).json({ error: 'Provider je povinný' });
    }
    if (!deferredAmountEmail && (!Number.isFinite(amountEur) || amountEur <= 0)) {
      return res.status(400).json({ error: 'Suma v EUR musí byť kladné číslo' });
    }

    // Never let the client pick/overwrite an order id (IDOR / order overwrite).
    const orderId = `ord_${crypto.randomBytes(8).toString('hex')}`;

    const providerLower = provider.toLowerCase();

    if (providerLower === 'crypto_direct') {
      try {
        const order = await cryptoDirect.createOrder({ orderId, amountEur, countryCode, providerAlias, email, asset: body.asset, loadOrders, saveOrders, appendLog });
        if (redirect) return res.redirect(302, order.checkoutUrl);
        return res.json({ orderId, checkoutUrl: order.checkoutUrl, localPayUrl: order.checkoutUrl, provider: 'crypto_direct', amountEur, currency: 'EUR', status: order.status });
      } catch (e) {
        appendLog(`CRYPTO_DIRECT_FAIL ${orderId} ${e.message}`);
        return res.status(e.status || 500).json({ error: e.status === 400 ? e.message : 'Krypto platbu sa nepodarilo vytvoriť. Skúste to znova.' });
      }
    }

    if (providerLower === 'oxapay' || walletGw.isMethod(providerLower)) {
      const isOx = providerLower === 'oxapay';
      try {
        const args = { methodId: providerLower, orderId, amountEur, email, countryCode, ip: req.ip, baseUrl: publicBaseFromReq(req), loadOrders, saveOrders, appendLog };
        const order = isOx ? await oxapay.createOrder(args) : await walletGw.createOrder(args);
        if (redirect) return res.redirect(302, order.checkoutUrl);
        return res.json({ orderId, checkoutUrl: order.checkoutUrl, localPayUrl: order.checkoutUrl, provider: order.provider, amountEur: order.amountEur, amount: order.amountEur, currency: 'EUR', status: order.status });
      } catch (e) {
        appendLog(`${isOx ? 'OXAPAY' : 'WG'}_FAIL ${orderId} ${String(e.message || '').slice(0, 200)}`);
        return res.status(e.status === 400 || e.status === 429 ? e.status : 502).json({ error: e.status === 400 || e.status === 429 ? e.message : 'Platbu sa nepodarilo vytvoriť. Skúste to znova alebo zvoľte iný spôsob.' });
      }
    }

    if (providerLower === 'blink_ln') {
      try {
        // amount = server-validated order amount (plan price or checked amount); the invoice is built from the stored order only
        const order = await blink.createOrder({ orderId, amountEur, countryCode, providerAlias, email, ip: req.ip, loadOrders, saveOrders, appendLog });
        if (redirect) return res.redirect(302, order.checkoutUrl);
        return res.json({ orderId, checkoutUrl: order.checkoutUrl, localPayUrl: order.checkoutUrl, provider: 'blink_ln', amountEur: order.amountEur, amount: order.amountEur, currency: 'EUR', status: order.status });
      } catch (e) {
        appendLog(`BLINK_FAIL ${orderId} ${String(e.message || '').slice(0, 200)}`);
        return res.status(e.status || 502).json({ error: e.status === 400 || e.status === 429 ? e.message : 'Lightning faktúru sa nepodarilo vytvoriť. Skúste to znova alebo zvoľte iný spôsob.' });
      }
    }

    if (providerLower === 'changelly' || providerLower === 'revolut_ramp') {
      try {
        const order = await changelly.createOrder({ orderId, amountEur, countryCode, providerAlias, email, loadOrders, saveOrders, appendLog });
        if (redirect) return res.redirect(302, order.checkoutUrl);
        return res.json({ orderId, checkoutUrl: order.checkoutUrl, localPayUrl: order.checkoutUrl, provider: order.provider, amountEur, amount: amountEur, currency: 'EUR', status: order.status });
      } catch (e) {
        appendLog(`${providerLower.toUpperCase()}_FAIL ${orderId} ${e.message}`);
        return res.status(e.status || 500).json({ error: e.status === 400 ? e.message : 'Platbu sa nepodarilo vytvoriť. Skúste to znova.' });
      }
    }

    if (providerLower === 'revolut_manual') {
      const localPayUrl = `/revolut-pay?orderId=${encodeURIComponent(orderId)}`;
      const paymentNote = 'R' + orderId.replace(/^ord_/, '').slice(0, 8).toUpperCase();
      const orders = loadOrders();
      const order = {
        orderId, amountEur, amount: amountEur, currency: 'EUR', country: countryCode,
        provider: 'revolut_manual', providerAlias, gateway: 'revolut_manual', paymentMethod: 'revolut',
        checkoutUrl: localPayUrl, localPayUrl, paymentNote, revtag: null,
        resolution: 'revolut_manual_telegram', status: 'awaiting_revtag', createdAt: new Date().toISOString(),
      };
      orders[orderId] = order;
      saveOrders(orders);
      appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=revolut_manual note=${paymentNote}`);
      try { if (global.__telegramBot) await global.__telegramBot.notifyRevolutOrder(order); }
      catch (e) { appendLog(`TELEGRAM_REVOLUT_FAIL ${orderId} ${e.message}`); }
      if (redirect) return res.redirect(302, localPayUrl);
      return res.json({ orderId, checkoutUrl: localPayUrl, localPayUrl, provider: 'revolut_manual', amountEur, currency: 'EUR', paymentNote, status: order.status });
    }


    if (providerLower === 'onramper' && !String(process.env.ONRAMPER_API_KEY || '').trim()) {
      return res.status(503).json({ error: 'Onramper nedostupné – chýba vlastný kľúč (ONRAMPER_API_KEY)', provider: 'onramper', code: 'NOT_CONFIGURED' });
    }
    if (providerLower === 'keyless') {
      const KEYLESS = {
        changenow_buy: { name: 'ChangeNOW', url: () => 'https://changenow.io/buy/bitcoin', prefill: 'nič (verejná stránka) — sumu/BTC/adresu zadáte' },
        paybis_buy: { name: 'Paybis', url: () => 'https://paybis.com/', prefill: 'nič — sumu, BTC a adresu zadáte u Paybis' },
        anycoin_buy: { name: 'Anycoin', url: () => 'https://www.anycoin.cz/', prefill: 'nič — nákup na účte, potom výber BTC na adresu' },
        coinmate_buy: { name: 'Coinmate', url: () => 'https://coinmate.io/', prefill: 'nič — nákup na účte, potom výber BTC na adresu' },
        bitpanda_buy: { name: 'Bitpanda', url: () => 'https://www.bitpanda.com/', prefill: 'nič — nákup na účte, potom výber BTC na adresu' },
        kriptomat_buy: { name: 'Kriptomat', url: () => 'https://kriptomat.io/', prefill: 'nič — nákup na účte, potom výber BTC na adresu' },
      };
      const k = KEYLESS[providerAlias] || (customMethod && {
        name: customMethod.name, url: () => payMethods.buildUrl(customMethod, { amountEur, orderId }),
        prefill: customMethod.description || 'nič — sumu a údaje zadáte u poskytovateľa',
      });
      if (!k) return res.status(400).json({ error: 'Neznáma brána' });
      if (customMethod && Number(customMethod.minEur) > 0 && amountEur < Number(customMethod.minEur)) {
        return res.status(400).json({ error: `Minimálna suma pre ${customMethod.name} je ${customMethod.minEur} EUR.`, minimum_amount: Number(customMethod.minEur), minimum_currency: 'EUR' });
      }
      if (customMethod && customMethod.mode === 'link') {
        // Plain payment link (no BTC address): local page with amount, instructions, link and the proof form.
        const url = k.url();
        const localPayUrl = `/guardarian-pay?orderId=${encodeURIComponent(orderId)}`;
        const orders = loadOrders();
        orders[orderId] = {
          orderId, amountEur, amount: amountEur, email, country: countryCode, customer, currency: 'EUR',
          provider: 'keyless', providerAlias, providerName: k.name, gateway: 'keyless', paymentMethod: 'link',
          customMethod: true, customMode: 'link', customInstructions: customMethod.description || '', proofForm: customMethod.proofForm !== false,
          ...(Array.isArray(payMethods.coinsFor(providerAlias)) ? { coins: payMethods.coinsFor(providerAlias) } : {}),
          checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: url, providerHost: new URL(url).hostname,
          resolution: 'custom_link', status: 'pending', createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=custom:${providerAlias} mode=link`);
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({ orderId, checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: url, provider: providerAlias, amountEur, currency: 'EUR' });
      }
      try {
        // BTC only (all of these deliver BTC on-chain); address from admin 👛 Adresy peňaženiek (never BTCPay).
        const fb = await destination.withCoinFallback(async () => ({ url: k.url() }), { orderId, provider: providerAlias, coins: ['btc'], log: appendLog });
        const dest = fb.dest;
        const localPayUrl = `/guardarian-pay?orderId=${encodeURIComponent(orderId)}`;
        const orders = loadOrders();
        orders[orderId] = {
          orderId, amountEur, amount: amountEur, email, country: countryCode, customer, currency: 'EUR',
          provider: 'keyless', providerAlias, providerName: k.name, gateway: 'keyless', paymentMethod: 'card',
          checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: fb.result.url, lockedWallet: false, lockedCrypto: 'BTC',
          dstAddress: dest.address, payoutAddress: dest.address, payoutCoin: 'btc', payoutIndex: dest.index,
          payoutSource: dest.source || 'pool', payoutCurrency: 'BTC', prefill: k.prefill,
          providerHost: new URL(fb.result.url).hostname, resolution: 'keyless_public', status: 'pending', createdAt: new Date().toISOString(),
          ...(customMethod ? { customMethod: true, customMode: 'btc', customInstructions: customMethod.description || '', proofForm: customMethod.proofForm !== false } : {}),
          ...(Array.isArray(payMethods.coinsFor(providerAlias)) ? { coins: payMethods.coinsFor(providerAlias) } : {}),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=keyless:${providerAlias} dst=btc:${dest.address} src=${dest.source}`);
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({ orderId, checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: fb.result.url, provider: providerAlias,
          amountEur, currency: 'EUR', payoutAddress: dest.address, payoutCoin: 'btc', payoutCurrency: 'BTC', payoutSource: dest.source || 'pool', prefill: k.prefill });
      } catch (err) {
        return res.status(502).json({ error: err.message, provider: providerAlias });
      }
    }

    if (providerLower === 'meld') {
      const meldKey = String(process.env.MELD_PUBLIC_KEY || '').trim();
      if (!meldKey) return res.status(503).json({ error: 'Meld nedostupné – chýba kľúč (MELD_PUBLIC_KEY)', provider: 'meld', code: 'NOT_CONFIGURED' });
      try {
        const fb = await destination.withCoinFallback(async (dest) => {
          const ticker = dest.ticker || String(dest.coin).toUpperCase();
          const u = new URL(process.env.MELD_WIDGET_BASE || 'https://meldcrypto.com/');
          u.searchParams.set('publicKey', meldKey);
          u.searchParams.set('sourceAmount', String(amountEur));
          u.searchParams.set('sourceCurrencyCode', 'EUR');
          u.searchParams.set('destinationCurrencyCodeLocked', ticker);
          u.searchParams.set('walletAddressLocked', dest.address);
          if (countryCode) u.searchParams.set('countryCode', countryCode);
          u.searchParams.set('externalSessionId', orderId);
          return { url: u.toString() };
        }, { orderId, provider: 'meld', log: appendLog });
        const dest = fb.dest; const ticker = dest.ticker || 'BTC';
        const localPayUrl = `/guardarian-pay?orderId=${encodeURIComponent(orderId)}`;
        const orders = loadOrders();
        orders[orderId] = {
          orderId, amountEur, amount: amountEur, email, country: countryCode, customer, currency: 'EUR',
          provider: 'meld', providerAlias, gateway: 'meld', paymentMethod: 'card',
          checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: fb.result.url, lockedWallet: true, lockedCrypto: ticker,
          dstAddress: dest.address, payoutAddress: dest.address, payoutCoin: dest.coin, payoutIndex: dest.index,
          payoutSource: dest.source || 'pool', payoutCurrency: ticker, providerHost: 'meldcrypto.com',
          resolution: 'meld_widget', status: 'pending', createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=meld dst=${dest.coin}:${dest.address} src=${dest.source}`);
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({ orderId, checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: fb.result.url, provider: 'meld',
          amountEur, currency: 'EUR', payoutAddress: dest.address, payoutCoin: dest.coin, payoutCurrency: ticker, payoutSource: dest.source || 'pool' });
      } catch (err) {
        return res.status(502).json({ error: err.message, provider: 'meld', code: err.code || null });
      }
    }

    if (providerLower === 'mtpelerin') {
      try {
        const fb = await destination.withCoinFallback(async (dest) => {
          const ticker = dest.ticker || String(dest.coin).toUpperCase();
          const net = { BTC: 'bitcoin_mainnet' }[ticker];
          if (!net) { const e = new Error(`Mt Pelerin: ${ticker} not supported`); e.code = 'UNSUPPORTED_COIN'; throw e; }
          const u = new URL('https://widget.mtpelerin.com/');
          const ctkn = String(process.env.MTPELERIN_CTKN || '').trim();
          if (ctkn) u.searchParams.set('_ctkn', ctkn);
          u.searchParams.set('type', 'direct-link');
          u.searchParams.set('tabs', 'buy');
          u.searchParams.set('tab', 'buy');
          u.searchParams.set('bsc', 'EUR');
          u.searchParams.set('bdc', ticker);
          u.searchParams.set('crys', ticker);
          u.searchParams.set('bsa', String(amountEur));
          u.searchParams.set('net', net);
          u.searchParams.set('dnet', net);
          u.searchParams.set('addr', dest.address);
          u.searchParams.set('lang', 'en'); // docs: en/fr/de/it/es/pt — no sk
          if (countryCode) u.searchParams.set('ctry', countryCode);
          return { url: u.toString(), mode: 'direct_link', lockedWallet: false };
        }, { orderId, provider: 'mtpelerin', log: appendLog });
        const dest = fb.dest; const r = fb.result;
        const ticker = dest.ticker || 'BTC';
        const localPayUrl = `/guardarian-pay?orderId=${encodeURIComponent(orderId)}`;
        const orders = loadOrders();
        orders[orderId] = {
          orderId, amountEur, amount: amountEur, email, country: countryCode, customer, currency: 'EUR',
          provider: 'mtpelerin', providerAlias, gateway: 'mtpelerin', paymentMethod: 'card',
          checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: r.url, lockedWallet: false, lockedCrypto: ticker,
          dstAddress: dest.address, payoutAddress: dest.address, payoutCoin: dest.coin, payoutIndex: dest.index,
          payoutSource: dest.source || 'pool', payoutCurrency: ticker, payoutReason: dest.reason,
          providerHost: 'widget.mtpelerin.com', resolution: 'mtpelerin_direct', status: 'pending', createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=mtpelerin dst=${dest.coin}:${dest.address} src=${dest.source}`);
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({ orderId, checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: r.url, provider: 'mtpelerin',
          amountEur, currency: 'EUR', payoutAddress: dest.address, payoutCoin: dest.coin, payoutCurrency: ticker, payoutSource: dest.source || 'pool',
          providerHost: 'widget.mtpelerin.com' });
      } catch (err) {
        return res.status(502).json({ error: err.message, provider: 'mtpelerin', code: err.code || null });
      }
    }

    if (providerLower === 'guardarian_revolut') {
      const METHOD_BY_ALIAS = {
        revolut_1: 'card', revolut_cee: 'card',
        revolut_2: 'revolut_pay',
        revolut_3: 'apple_pay', apple_google_revolut: 'apple_pay',
        revolut_4: 'google_pay',
      };
      const method = String(body.method || METHOD_BY_ALIAS[providerAlias] || 'card').toLowerCase();
      try {
        const fwd = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
        const publicBase = `${fwd || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
        const pay = `${publicBase}/guardarian-pay?orderId=${encodeURIComponent(orderId)}`;
        const fb = await destination.withCoinFallback(
          (dest) => guardarian.resolveCheckout({
            ticker: dest.ticker || String(dest.coin).toUpperCase(),
            fiatAmount: amountEur,
            address: dest.address,
            method,
            email,
            successUrl: `${pay}&done=1`,
            cancelUrl: `${pay}&cancelled=1`,
            failUrl: `${pay}&failed=1`,
          }),
          { orderId, provider: 'guardarian', log: appendLog }
        );
        const dest = fb.dest;
        const r = fb.result;
        const ticker = dest.ticker || String(dest.coin).toUpperCase();
        const localPayUrl = `/guardarian-pay?orderId=${encodeURIComponent(orderId)}`;
        const orders = loadOrders();
        orders[orderId] = {
          orderId, amountEur, amount: amountEur, email, country: countryCode, customer,
          currency: 'EUR', provider: 'guardarian_revolut', providerAlias, gateway: 'guardarian',
          paymentMethod: method, checkoutUrl: localPayUrl, localPayUrl,
          providerCheckoutUrl: r.url, guardarianMode: r.mode, guardarianId: r.guardarianId || null,
          lockedWallet: r.lockedWallet, lockedCrypto: ticker,
          dstAddress: dest.address, payoutAddress: dest.address, payoutCoin: dest.coin, payoutIndex: dest.index,
          payoutCurrency: ticker, payoutReason: dest.reason, payoutSource: dest.source || 'pool', fallbackErrors: fb.fallbackErrors,
          providerHost: (() => { try { return new URL(r.url).hostname; } catch { return 'guardarian.com'; } })(),
          resolution: r.mode === 'api' ? 'guardarian_api' : 'guardarian_public',
          status: 'pending', createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=guardarian_revolut alias=${providerAlias} method=${method} mode=${r.mode} dst=${dest.coin}:${dest.address}`);
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({
          orderId, checkoutUrl: localPayUrl, localPayUrl, providerCheckoutUrl: r.url,
          provider: 'guardarian_revolut', providerAlias, gateway: 'guardarian', paymentMethod: method,
          guardarianMode: r.mode, lockedWallet: r.lockedWallet, lockedCrypto: ticker,
          amountEur, amount: amountEur, currency: 'EUR',
          payoutAddress: dest.address, payoutCoin: dest.coin, payoutCurrency: ticker, payoutSource: dest.source || 'pool',
          resolution: orders[orderId].resolution, providerHost: orders[orderId].providerHost,
        });
      } catch (err) {
        appendLog(`GUARDARIAN_FAIL ${orderId} ${err.message}`);
        return res.status(502).json({ error: err.message, provider: 'guardarian_revolut', code: err.code || null });
      }
    }

    // Ryan BTC-only: C2P .net / .is settle to USDC/POL (EVM) — refuse at checkout.
    const BTC_ONLY_EVM_BLOCKED = new Set([
      'banxa', 'banxa2', 'stripe', 'revolut', 'paypal', 'coinbase', 'binance',
      'blockchaincom', 'robinhood', 'sardine', 'topper', 'moonpay', 'paybis',
      'meld', 'simplex', 'particle', 'ideal', 'klarna', 'upi', 'interac', 'cashapp',
      'transak', 'alchemy', 'multihosted', 'ramp', 'guardarian',
    ]);
    const BTC_ONLY_IS_BLOCKED = new Set([
      'transak', 'alchemy', 'multihosted', 'ramp', 'banxa', 'banxa2', 'stripe',
      'revolut', 'paypal', 'guardarian', 'moonpay', 'paybis', 'topper',
    ]);
    const evmAllowed = new Set(String(process.env.ALLOW_EVM_PROVIDERS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));
    if (evmAllowed.has(providerLower) || evmAllowed.has(providerLower.replace(/^is_/, ''))) {
      appendLog(`EVM_ALLOWED ${providerLower} alias=${providerAlias}`);
    } else if (BTC_ONLY_EVM_BLOCKED.has(providerLower) && !['switchere', 'btcpay', 'btcpay_onramp', 'bank_sepa_manual', 'paysafecard', 'g2a', 'onramper', 'kryptonim'].includes(providerLower)) {
      // Default C2P .net path (no gateway override) — EVM USDC/POL
      const alias = String(providerAlias || '').toLowerCase();
      const isOssAlias =
        alias.startsWith('switchere') ||
        alias.startsWith('g2a_') ||
        alias === 'guardarian_card' ||
        alias === 'onramp_btcpay' ||
        alias === 'banxa_btcpay';
      if (!isOssAlias && !providerLower.startsWith('is_') && !providerLower.startsWith('mollie')) {
        return res.status(503).json({
          error: 'dočasne nedostupné — settlement len BTC/LTC/BCH pool, nie EVM/USDC/SOL',
          code: 'BTC_ONLY_UNAVAILABLE',
          provider: providerLower,
          hint: 'Použite Switchere (BTC/LTC/BCH), Guardarian (BTCPay BTC), SEPA Elektrocoin alebo BTC / Lightning.',
        });
      }
    }
    if (providerLower.startsWith('is_')) {
      const isPid = providerLower.slice(3);
      if (BTC_ONLY_IS_BLOCKED.has(isPid) && !evmAllowed.has(isPid) && !evmAllowed.has(providerLower)) {
        return res.status(503).json({
          error: 'dočasne nedostupné — C2P.is settlement USDC/POL, nie BTC (BTCPay)',
          code: 'BTC_ONLY_UNAVAILABLE',
          provider: providerLower,
        });
      }
    }
    if (providerLower === 'kryptonim') {
      return res.status(503).json({
        error: 'dočasne nedostupné — settlement len BTC (BTCPay), nie USDC Polygon',
        code: 'BTC_ONLY_UNAVAILABLE',
        provider: 'kryptonim',
        status: kryptonim.status(),
      });
    }

    // --- Open-source / EU gateways (optional env) ---
    if (providerLower === 'btcpay') {
      try {
        const payoutBtc = addressPool.nextAddress('btc', { orderId, btcpay: true });
        const payoutLn = addressPool.nextAddress('lightning', { orderId, btcpay: true });
        const inv = await btcpay.createInvoice(amountEur, email, orderId, {
          payoutBtc: payoutBtc.address,
          payoutLightning: payoutLn.address,
        });
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          currency: 'EUR',
          provider: 'btcpay',
          gateway: 'btcpay',
          checkoutUrl: inv.checkoutLink,
          invoiceId: inv.invoiceId,
          resolution: 'direct',
          providerHost: (() => { try { return new URL(inv.checkoutLink).hostname; } catch { return null; } })(),
          payoutAddress: payoutBtc.address,
          payoutCoin: 'btc',
          payoutLightning: payoutLn.address,
          payoutIndex: payoutBtc.index,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=btcpay payout=btc:${payoutBtc.address} ln:${payoutLn.address} idx=${payoutBtc.index}`
        );
        if (redirect) return res.redirect(302, inv.checkoutLink);
        return res.json({
          orderId,
          checkoutUrl: `/pay/btcpay?orderId=${encodeURIComponent(orderId)}`, // invoice link stays server-side
          resolution: 'direct',
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'btcpay',
          email,
          payoutAddress: payoutBtc.address,
          payoutLightning: payoutLn.address,
        });
      } catch (err) {
        const status = err.code === 'NOT_CONFIGURED' ? 503 : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'btcpay',
          configured: false,
          code: err.code || null,
        });
      }
    }

    if (
      providerLower === 'btcpay_onramp' ||
      providerLower === 'onramp_btcpay' ||
      providerLower === 'banxa_btcpay'
    ) {
      if (!(Number(amountEur) >= ONRAMP_MIN_EUR)) {
        return res.status(400).json({
          error: `Minimálna suma pre platbu kartou cez widget je ${ONRAMP_MIN_EUR} EUR.`,
          code: 'BELOW_MINIMUM',
          minimum_amount: ONRAMP_MIN_EUR,
          minimum_currency: 'EUR',
          provider: providerAlias || provider,
        });
      }
      try {
        if (!btcpay.isConfigured()) {
          const err = new Error(
            'BTCPay nie je nastavený. Doplňte BTCPAY_URL, BTCPAY_STORE_ID a BTCPAY_API_KEY.'
          );
          err.code = 'NOT_CONFIGURED';
          throw err;
        }
        const publicBase =
          `${req.protocol}://${req.get('host')}` ||
          (config.callbackBaseUrl || '').replace(/\/callback\/?$/, '');
        const returnUrl = `${publicBase}/onramp-bridge?orderId=${encodeURIComponent(orderId)}&done=1`;
        const inv = await btcpay.createInvoiceWithOnChain(amountEur, email, orderId, {
          redirectURL: returnUrl,
        });
        const onrampOpts = {
          btcAddress: inv.btcAddress,
          btcAmount: inv.btcAmount,
          fiatAmount: amountEur,
          email,
          returnUrl,
          orderId,
        };
        if (providerAlias === 'guardarian_card' || body.onrampForce === 'guardarian') {
          onrampOpts.forceProvider = 'guardarian';
        }
        const resolved = onramp.resolveCheckout(onrampOpts);
        const links = onramp.listAvailableLinks(onrampOpts);
        const bridgeUrl = `/onramp-bridge?orderId=${encodeURIComponent(orderId)}`;
        // Always bridge first: BTC receive address must be copyable before opening on-ramp
        const checkoutUrl = bridgeUrl;
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          currency: 'EUR',
          provider: 'btcpay_onramp',
          gateway: 'btcpay_onramp',
          onrampProvider: resolved.provider,
          checkoutUrl,
          bridgeUrl,
          onrampUrl: resolved.url || null,
          onrampLinks: links,
          invoiceId: inv.invoiceId,
          btcpayCheckout: inv.checkoutLink,
          btcAddress: inv.btcAddress,
          btcAmount: inv.btcAmount,
          paymentLink: inv.paymentLink,
          resolution: resolved.mode === 'redirect' ? 'onramp_redirect' : 'onramp_bridge',
          providerHost:
            resolved.mode === 'redirect' && resolved.url
              ? (() => {
                  try {
                    return new URL(resolved.url).hostname;
                  } catch {
                    return 'onramp';
                  }
                })()
              : 'onramp-bridge',
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=btcpay_onramp onramp=${resolved.provider} btc=${inv.btcAddress} amt=${inv.btcAmount} invoice=${inv.invoiceId}`
        );
        if (redirect) return res.redirect(302, checkoutUrl);
        return res.json({
          orderId,
          checkoutUrl,
          bridgeUrl,
          onrampUrl: resolved.url || null,
          onrampProvider: resolved.provider,
          onrampLinks: links,
          resolution: orders[orderId].resolution,
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'btcpay_onramp',
          email,
          invoiceId: inv.invoiceId,
          btcAddress: inv.btcAddress,
          btcAmount: inv.btcAmount,
          btcpayCheckout: inv.checkoutLink,
        });
      } catch (err) {
        const status =
          err.code === 'NOT_CONFIGURED'
            ? 503
            : err.code === 'NO_ONCHAIN_ADDRESS'
              ? 502
              : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'btcpay_onramp',
          code: err.code || null,
          methods: err.methods || undefined,
        });
      }
    }



    if (
      providerLower === 'bank_sepa_manual' ||
      providerLower === 'bank_sepa' ||
      providerLower === 'electrocoin' ||
      providerLower === 'electrocoin_manual' ||
      providerLower === 'sepa_manual'
    ) {
      try {
        // Customer name is optional — checkout needs amount only.
        const firstName = String(
          body.firstName ||
            body.meno ||
            (body.customer && body.customer.firstName) ||
            ''
        ).trim();
        const lastName = String(
          body.lastName ||
            body.priezvisko ||
            (body.customer && body.customer.lastName) ||
            ''
        ).trim();
        const order = await sepaManual.buildOrder({
          orderId,
          amountEur,
          firstName,
          lastName,
        });
        const localPayUrl = `/bank-sepa-pay?orderId=${encodeURIComponent(orderId)}`;
        order.checkoutUrl = localPayUrl;
        order.localPayUrl = localPayUrl;
        const orders = loadOrders();
        orders[orderId] = order;
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=bank_sepa_manual sepa_manual name=${firstName} ${lastName} btc=${order.btcAddress} src=${order.btcSource}`
        );
        // SEPA bot chain (optional) or classic @Plat4Bot notify.
        // Chain runs in background so checkout responds immediately; on failure it falls back.
        try {
          const fallbackNotify = async (o) => {
            if (global.__telegramBot) await global.__telegramBot.notifySepaOrder(o);
          };
          // Bot chain ONLY for this SEPA method (guard inside shouldRunForOrder / runChain too).
          if (sepaBotChain.shouldRunForOrder(order)) {
            appendLog('SEPA_CHAIN_START ' + orderId);
            setImmediate(() => {
              sepaBotChain
                .runChain(order, {
                  loadOrders,
                  saveOrders,
                  appendLog,
                  fallbackFn: fallbackNotify,
                })
                .catch((e) => appendLog('SEPA_CHAIN_UNHANDLED ' + (e && e.message)));
            });
          } else {
            await fallbackNotify(order);
          }
        } catch (te) {
          appendLog('TELEGRAM_NOTIFY_FAIL ' + (te && te.message));
        }
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({
          orderId,
          checkoutUrl: localPayUrl,
          localPayUrl,
          resolution: 'sepa_manual_telegram',
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'bank_sepa_manual',
          firstName,
          lastName,
          status: order.status,
          bankDetailsPublic: false,
          payoutAddress: order.payoutAddress,
          payoutCoin: order.payoutCoin,
          sepaChain: sepaBotChain.shouldRunForOrder(order) ? 'started' : 'off',
        });
      } catch (err) {
        const status =
          err.code === 'NOT_CONFIGURED' || err.code === 'BAD_NAME' || err.code === 'BAD_AMOUNT'
            ? err.code === 'BAD_NAME' || err.code === 'BAD_AMOUNT'
              ? 400
              : 503
            : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'bank_sepa_manual',
          code: err.code || null,
        });
      }
    }




    if (
      providerLower === 'paysafecard' ||
      providerLower === 'paysafe' ||
      providerLower === 'psc' ||
      providerLower === 'paysafe_pin'
    ) {
      try {
        const hostBase = `${req.protocol}://${req.get('host')}`;
        const envBase = (config.callbackBaseUrl || '').replace(/\/callback\/?$/, '');
        const publicBase =
          hostBase.includes('127.0.0.1') || hostBase.includes('localhost')
            ? envBase || hostBase
            : hostBase || envBase;
        const order = paysafecard.buildOrder({ orderId, amountEur, email });
        const localPayUrl = `/paysafe-pay?orderId=${encodeURIComponent(orderId)}`;
        order.checkoutUrl = localPayUrl;
        order.localPayUrl = localPayUrl;
        const delivery = await paysafecard.deliverEmails(order, publicBase);
        order.emailDelivery = delivery;
        const orders = loadOrders();
        orders[orderId] = order;
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=paysafecard ref=${order.reference} deadline=${order.deadlineAt} emailMode=${delivery.mode} smtpSent=${(delivery.sent || []).length}`
        );
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({
          orderId,
          checkoutUrl: localPayUrl,
          localPayUrl,
          resolution: 'manual_paysafe',
          providerHost: 'local-paysafecard',
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'paysafecard',
          email,
          reference: order.reference,
          deadlineAt: order.deadlineAt,
          deadlineMinutes: order.deadlineMinutes,
          customerPrompt: order.customerPrompt,
          pinShopUrl: order.pinShopUrl,
          suggestedPins: order.suggestedPins,
          emailDelivery: {
            mode: delivery.mode,
            smtpConfigured: delivery.smtpConfigured,
            sent: delivery.sent,
            temp: Boolean(delivery.temp),
            errors: delivery.errors,
          },
        });
      } catch (err) {
        const status = err.code === 'BAD_EMAIL' || err.code === 'BAD_AMOUNT' ? 400 : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'paysafecard',
          configured: paysafecard.isConfigured(),
          code: err.code || null,
          status: paysafecard.status(),
        });
      }
    }


    if (
      providerLower === 'g2a' ||
      providerLower === 'g2a_voucher' ||
      providerAlias.startsWith('g2a_')
    ) {
      try {
        const hostBase = `${req.protocol}://${req.get('host')}`;
        const envBase = (config.callbackBaseUrl || '').replace(/\/callback\/?$/, '');
        const publicBase =
          hostBase.includes('127.0.0.1') || hostBase.includes('localhost')
            ? envBase || hostBase
            : hostBase || envBase;
        const order = g2a.buildOrder({
          orderId,
          amountEur,
          email,
          productId: body.productId || body.product || null,
          alias: providerAlias,
        });
        const localPayUrl = `/g2a-pay?orderId=${encodeURIComponent(orderId)}`;
        order.checkoutUrl = localPayUrl;
        order.localPayUrl = localPayUrl;
        const delivery = await g2a.deliverEmails(order, publicBase);
        order.emailDelivery = delivery;
        const orders = loadOrders();
        orders[orderId] = order;
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${order.amountEur} provider=g2a product=${order.productId} ref=${order.reference} deadline=${order.deadlineAt} emailMode=${delivery.mode} smtpSent=${(delivery.sent || []).length}`
        );
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({
          orderId,
          checkoutUrl: localPayUrl,
          localPayUrl,
          resolution: 'manual_g2a',
          providerHost: 'local-g2a',
          amountEur: order.amountEur,
          amount: order.amountEur,
          currency: 'EUR',
          provider: 'g2a',
          providerAlias: order.providerAlias,
          productId: order.productId,
          productLabel: order.productLabel,
          buyUrl: order.buyUrl,
          email,
          reference: order.reference,
          deadlineAt: order.deadlineAt,
          deadlineMinutes: order.deadlineMinutes,
          customerPrompt: order.customerPrompt,
          suggestedProducts: order.suggestedProducts,
          emailDelivery: {
            mode: delivery.mode,
            smtpConfigured: delivery.smtpConfigured,
            sent: delivery.sent,
            temp: Boolean(delivery.temp),
            errors: delivery.errors,
          },
        });
      } catch (err) {
        const status =
          err.code === 'BAD_EMAIL' || err.code === 'BAD_AMOUNT' || err.code === 'BAD_PRODUCT'
            ? 400
            : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'g2a',
          configured: g2a.isConfigured(),
          code: err.code || null,
          status: g2a.status(),
          suggested: g2a.suggestProducts(amountEur, { limit: 6 }),
        });
      }
    }

    if (providerLower === 'switchere') {
      try {
        const publicBase =
          `${req.protocol}://${req.get('host')}` ||
          (config.callbackBaseUrl || '').replace(/\/callback\/?$/, '');
        const successUrl = `${publicBase}/switchere-pay?orderId=${encodeURIComponent(orderId)}&done=1`;
        const failedUrl = `${publicBase}/switchere-pay?orderId=${encodeURIComponent(orderId)}&failed=1`;
        const payinGroup = (() => {
          const alias = providerAlias;
          const requested = String(body.payinGroup || '').toLowerCase();
          if (
            alias === 'switchere_skrill' ||
            alias === 'skrill' ||
            requested === 'skrill' ||
            requested === 'ewallet'
          ) {
            return 'skrill';
          }
          if (
            alias === 'switchere_bank' ||
            requested === 'sepa' ||
            requested === 'bank'
          ) {
            return requested === 'bank' ? 'bank' : 'sepa';
          }
          return 'card';
        })();
                // BTC → LTC → BCH fallback, fresh rotated pool address each attempt.
        const fb = await destination.withCoinFallback(async (dest) => {
          const r = await switchere.resolveCheckout({
          fiatAmount: amountEur,
          email,
          orderId,
          dstAddress: dest.address,
          payoutCurrency: dest.ticker || 'BTC',
          payinGroup,
          successUrl,
          failedUrl,
          clientIp:
            (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
            req.socket?.remoteAddress ||
            '127.0.0.1',
          remoteCountry: countryCode,
          country: countryCode,
          lockEmail: true,
        });
          if (!r || (!r.url && !r.widgetInit && !r.publicBuy)) {
            const e = new Error('Switchere checkout creation returned no URL');
            e.code = 'NO_CHECKOUT';
            throw e;
          }
          return r;
        }, { orderId, provider: 'switchere', log: appendLog });
        const payout = fb.dest;
        const resolved = fb.result;
        const dstAddress = payout.address;
        const payoutCurrency = payout.ticker || 'BTC';
        const localPayUrl = `/switchere-pay?orderId=${encodeURIComponent(orderId)}`;
        // Always land on local pay page first so destination address + Kopírovať is visible
        // when Switchere does not hard-lock the wallet field.
        let checkoutUrl = localPayUrl;
        let resolution = 'switchere_embed';
        if (resolved.mode === 'api_redirect' && resolved.url) {
          resolution = 'switchere_api';
        } else if (resolved.mode === 'api_request' && resolved.url) {
          resolution = 'switchere_request';
        } else if (resolved.mode === 'public_skrill' && resolved.url) {
          resolution = 'switchere_skrill';
        } else if (resolved.mode === 'public' && resolved.url && String(body.embed || '1') === '0') {
          resolution = 'switchere_public';
        }
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          country: countryCode,
          customer,
          currency: 'EUR',
          provider: 'switchere',
          gateway: 'switchere',
          payinGroup,
          checkoutUrl,
          localPayUrl,
          switchereMode: resolved.mode,
          switchereUrl: resolved.url || null,
          publicBuy:
            resolved.publicBuy ||
            (payinGroup === 'skrill'
              ? switchere.buildPublicSkrillUrl({
                  fiatAmount: amountEur,
                  email,
                  orderId,
                  dstAddress,
                  payoutCurrency,
                })
              : switchere.buildPublicBuyUrl({
                  fiatAmount: amountEur,
                  email,
                  orderId,
                  dstAddress,
                  payoutCurrency,
                })),
          publicRamp: resolved.publicRamp || switchere.PUBLIC_RAMP_BUY,
          widgetInit: resolved.widgetInit || null,
          sdkUrl: resolved.sdkUrl || switchere.sdkUrl(),
          lockedWallet: Boolean(resolved.lockedWallet),
          lockedCrypto: payoutCurrency,
          disableCrypto: true,
          dstAddress,
          payoutAddress: dstAddress,
          payoutCoin: payout.coin || 'btc',
          payoutIndex: payout.index,
          payoutCurrency,
          payoutNetworkFeeUsd: payout.networkFeeUsd ?? null,
          payoutReason: payout.reason || 'pool_lowest_fee',
          partnerOrderId: resolved.partnerOrderId || orderId,
          requestId: resolved.requestId || null,
          resolution,
          providerHost: (() => {
            try {
              if (resolved.url) return new URL(resolved.url).hostname;
            } catch {}
            return 'switchere.com';
          })(),
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=switchere mode=${resolved.mode} locked=${resolved.lockedWallet} dst=${payout.coin}:${dstAddress} idx=${payout.index} feeUsd~${payout.networkFeeUsd}`
        );
        if (redirect) return res.redirect(302, checkoutUrl);
        return res.json({
          orderId,
          checkoutUrl,
          localPayUrl,
          switchereMode: resolved.mode,
          switchereUrl: resolved.url || null,
          publicBuy: orders[orderId].publicBuy,
          lockedWallet: orders[orderId].lockedWallet,
          lockedCrypto: payoutCurrency,
          disableCrypto: true,
          resolution,
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'switchere',
          email,
          country: countryCode,
          customer,
          prefill: {
            emailLocked: true,
            country: countryCode,
            addressViaUrl: false,
            note: 'Switchere: BTC first, fallback LTC → BCH; wallet prefilled on buy URL.',
          },
          dstAddress,
          payoutAddress: dstAddress,
          payoutCoin: payout.coin || 'btc',
          payoutCurrency,
          payoutIndex: payout.index,
          payoutNetworkFeeUsd: payout.networkFeeUsd ?? null,
          payoutReason: payout.reason || 'pool_lowest_fee',
        });
      } catch (err) {
        const status = err.code === 'NOT_CONFIGURED' ? 503 : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'switchere',
          code: err.code || null,
          status: switchere.status(),
        });
      }
    }



    if (providerLower === 'kryptonim') {
      try {
        const payout = kryptonim.nextPoolDestination(orderId);
        const dstAddress = payout.address;
        const payoutCurrency = payout.ticker || kryptonim.payoutCurrency() || 'USDC';
        const resolved = kryptonim.resolveCheckout({
          fiatAmount: amountEur,
          email,
          orderId,
          dstAddress,
          payoutCurrency,
          remoteCountry: countryCode,
          country: countryCode,
          paymentMethod: 'card',
        });
        const providerCheckoutUrl = resolved.url || resolved.publicBuy;
        const localPayUrl = `/provider-pay?orderId=${encodeURIComponent(orderId)}`;
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          country: countryCode,
          customer,
          currency: 'EUR',
          provider: 'kryptonim',
          gateway: 'kryptonim',
          checkoutUrl: localPayUrl,
          localPayUrl,
          providerCheckoutUrl,
          publicBuy: resolved.publicBuy || providerCheckoutUrl,
          lockedWallet: false,
          lockedCrypto: payoutCurrency,
          disableCrypto: true,
          dstAddress,
          payoutAddress: dstAddress,
          payoutCoin: payout.coin || 'evm',
          payoutCurrency,
          payoutIndex: payout.index,
          merchantWallet: dstAddress,
          resolution: 'kryptonim_public',
          providerHost: 'buy.kryptonim.com',
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=kryptonim resolution=kryptonim_public payout=evm:${String(dstAddress).slice(0, 10)}… crypto=${payoutCurrency}`
        );
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({
          orderId,
          checkoutUrl: localPayUrl,
          localPayUrl,
          providerCheckoutUrl,
          publicBuy: orders[orderId].publicBuy,
          lockedWallet: false,
          lockedCrypto: payoutCurrency,
          disableCrypto: true,
          resolution: 'kryptonim_public',
          providerHost: 'buy.kryptonim.com',
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'kryptonim',
          email,
          country: countryCode,
          dstAddress,
          payoutAddress: dstAddress,
          payoutCoin: payout.coin || 'evm',
          payoutCurrency,
        });
      } catch (err) {
        return res.status(502).json({
          error: err.message,
          provider: 'kryptonim',
          status: kryptonim.status(),
        });
      }
    }

    if (providerLower === 'onramper') {
      try {
        const publicBase = publicBaseFromReq(req);
        const successUrl = `${publicBase}/onramper-pay?orderId=${encodeURIComponent(orderId)}&done=1`;
        const failedUrl = `${publicBase}/onramper-pay?orderId=${encodeURIComponent(orderId)}&failed=1`;
        const preferBank =
          providerAlias === 'onramper_bank' ||
          String(body.payinGroup || '').toLowerCase() === 'sepa' ||
          String(body.payinGroup || '').toLowerCase() === 'bank';
        const fb = await destination.withCoinFallback(async (payout) => {
          const cryptoId = payout.coin === 'ltc' ? 'ltc' : payout.coin === 'bch' ? 'bch' : 'btc';
          return onramper.resolveCheckout({
            fiatAmount: amountEur,
            email,
            orderId,
            country: countryCode,
            btcAddress: payout.coin === 'btc' ? payout.address : undefined,
            ltcAddress: payout.coin === 'ltc' ? payout.address : undefined,
            bchAddress: payout.coin === 'bch' ? payout.address : undefined,
            cryptoId,
            successUrl,
            failedUrl,
            defaultPaymentMethod: preferBank ? 'banktransfer' : undefined,
            lockWallets: true,
          });
        }, { orderId, provider: 'onramper', log: appendLog });
        const payout = fb.dest;
        const resolved = fb.result;
        const cryptoId = payout.coin === 'ltc' ? 'ltc' : payout.coin === 'bch' ? 'bch' : 'btc';
        const localPayUrl = `/onramper-pay?orderId=${encodeURIComponent(orderId)}`;
        // Always land on Slovak pay page first (shows wallet + iframe/redirect)
        const checkoutUrl = localPayUrl;
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          currency: 'EUR',
          provider: 'onramper',
          gateway: 'onramper',
          preferBank,
          checkoutUrl,
          localPayUrl,
          onramperMode: resolved.mode,
          onramperUrl: resolved.url || null,
          lockedWallet: Boolean(resolved.lockedWallet),
          cryptoId: resolved.cryptoId || cryptoId,
          dstAddress: payout.address,
          payoutAddress: payout.address,
          btcAddress: payout.coin === 'btc' ? payout.address : (payout.address || null),
          payoutBtc: payout.coin === 'btc' ? payout.address : null,
          payoutLtc: payout.coin === 'ltc' ? payout.address : null,
          payoutBch: payout.coin === 'bch' ? payout.address : null,
          payoutCoin: payout.coin || 'btc',
          payoutIndex: payout.index,
          payoutCurrency:
            payout.ticker ||
            (cryptoId === 'ltc' ? 'LTC' : cryptoId === 'bch' ? 'BCH' : 'BTC'),
          resolution: resolved.lockedWallet ? 'onramper_locked' : 'onramper_widget',
          providerHost: (() => {
            try {
              if (resolved.url) return new URL(resolved.url).hostname;
            } catch {}
            return 'buy.onramper.com';
          })(),
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=onramper mode=${resolved.mode} locked=${resolved.lockedWallet} crypto=${cryptoId} dst=${payout.coin}:${payout.address}`
        );
        if (redirect) return res.redirect(302, checkoutUrl);
        return res.json({
          orderId,
          checkoutUrl,
          localPayUrl,
          onramperMode: resolved.mode,
          onramperUrl: resolved.url || null,
          lockedWallet: orders[orderId].lockedWallet,
          resolution: orders[orderId].resolution,
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'onramper',
          email,
          dstAddress: payout.address,
          payoutCoin: payout.coin,
          cryptoId,
          keysNeeded: onramper.isConfigured() ? undefined : onramper.keysNeeded(),
        });
      } catch (err) {
        const status =
          err.code === 'NOT_CONFIGURED' || err.code === 'DEMO_KEY' ? 503 : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'onramper',
          code: err.code || null,
          status: onramper.status(),
          keysNeeded: onramper.keysNeeded(),
        });
      }
    }

    if (providerLower === 'getblitz') {

      try {
        const publicBase =
          `${req.protocol}://${req.get('host')}` ||
          (config.callbackBaseUrl || '').replace(/\/callback\/?$/, '');
        const ch = await getblitz.createChallenge(amountEur, email, orderId, {
          publicBase,
        });
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          currency: 'EUR',
          provider: 'getblitz',
          gateway: 'getblitz',
          checkoutUrl: ch.paymentUrl,
          sessionId: ch.sessionId,
          referenceId: ch.referenceId,
          resolution: 'direct',
          providerHost: (() => { try { return new URL(ch.paymentUrl).hostname; } catch { return null; } })(),
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=getblitz`);
        if (redirect) return res.redirect(302, ch.paymentUrl);
        return res.json({
          orderId,
          checkoutUrl: ch.paymentUrl,
          resolution: 'direct',
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'getblitz',
          email,
          sessionId: ch.sessionId,
          referenceId: ch.referenceId,
        });
      } catch (err) {
        const status = err.code === 'NOT_CONFIGURED' ? 503 : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'getblitz',
          configured: false,
          code: err.code || null,
        });
      }
    }

    if (providerLower === 'mollie' || providerLower.startsWith('mollie_')) {
      const method =
        body.method ||
        (providerLower.startsWith('mollie_')
          ? providerLower.replace(/^mollie_/, '')
          : 'ideal');
      try {
        const pay = await mollie.createPayment(
          amountEur,
          email,
          orderId,
          method,
          body.redirectUrl,
          body.webhookUrl || config.callbackBaseUrl
        );
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          currency: 'EUR',
          provider: 'mollie',
          gateway: 'mollie',
          method: pay.method,
          checkoutUrl: pay.checkoutUrl,
          paymentId: pay.paymentId,
          resolution: 'direct',
          providerHost: (() => { try { return new URL(pay.checkoutUrl).hostname; } catch { return null; } })(),
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=mollie method=${pay.method}`);
        if (redirect) return res.redirect(302, pay.checkoutUrl);
        return res.json({
          orderId,
          checkoutUrl: pay.checkoutUrl,
          resolution: 'direct',
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: 'mollie',
          method: pay.method,
          email,
          paymentId: pay.paymentId,
        });
      } catch (err) {
        const status = err.code === 'NOT_CONFIGURED' ? 503 : 502;
        return res.status(status).json({
          error: err.message,
          provider: 'mollie',
          configured: false,
          code: err.code || null,
        });
      }
    }


    // --- chain2pay.is Dashboard API (wallet bound to API key) ---
    if (providerLower.startsWith('is_')) {
      const isProvider = providerLower.slice(3).toLowerCase();
      try {
        if (!chain2payIs.isConfigured()) {
          const err = new Error(
            'chain2pay.is nie je nastavený. Doplňte CHAIN2PAY_IS_API_KEY v .env.'
          );
          err.code = 'NOT_CONFIGURED';
          throw err;
        }
        if (!isProvider) {
          return res.status(400).json({ error: 'Chýba .is provider (is_ramp, is_banxa, …)' });
        }
        const cbTokenIs = crypto.randomBytes(24).toString('hex');
        const callbackUrl = `${chain2payIs.buildCallbackUrl(orderId, config.callbackBaseUrl)}&t=${cbTokenIs}`;
        const pay = await chain2payIs.createPayment({
          amount: amountEur,
          currency: 'EUR',
          callbackUrl,
          customerEmail: email,
          provider: isProvider,
          metadata: { orderId, source: 'checkout', rail: 'chain2pay_is' },
        });
        const checkoutUrl = pay.checkout_url || pay.checkoutUrl;
        if (!checkoutUrl) {
          const err = new Error('chain2pay.is nevrátil checkout_url');
          err.body = pay;
          throw err;
        }
        const merchantWallet =
          pay.merchant_wallet || pay.merchantWallet || null;
        const providerCheckoutUrl = checkoutUrl;
        const localPayUrl = `/provider-pay?orderId=${encodeURIComponent(orderId)}`;
        const payoutEvmIs = addressPool.nextAddress('evm', { orderId });
        const walletAddr = merchantWallet || payoutEvmIs.address || config.merchantWallet || '';
        const orders = loadOrders();
        orders[orderId] = {
          orderId,
          amountEur,
          amount: amountEur,
          email,
          currency: 'EUR',
          provider: `is_${isProvider}`,
          providerId: isProvider,
          gateway: 'chain2pay_is',
          cbTokenHash: sha256Hex(cbTokenIs),
          checkoutUrl: localPayUrl,
          providerCheckoutUrl,
          localPayUrl,
          paymentId: pay.id,
          chain2payOrderId: pay.id,
          merchantWallet: walletAddr,
          payoutAddress: walletAddr,
          payoutCoin: 'evm',
          lockedWallet: Boolean(merchantWallet),
          lockedCrypto: /revolut/i.test(isProvider) ? 'POL' : 'USDC',
          resolution: 'direct',
          providerHost: (() => {
            try {
              return new URL(providerCheckoutUrl).hostname;
            } catch {
              return 'checkout.chain2pay.is';
            }
          })(),
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        saveOrders(orders);
        appendLog(
          `ORDER_CREATED ${orderId} eur=${amountEur} provider=is_${isProvider} paymentId=${pay.id} wallet=${walletAddr ? String(walletAddr).slice(0, 10) + '…' : '?'}`
        );
        if (redirect) return res.redirect(302, localPayUrl);
        return res.json({
          orderId,
          checkoutUrl: localPayUrl,
          localPayUrl,
          providerCheckoutUrl,
          resolution: 'direct',
          providerHost: orders[orderId].providerHost,
          amountEur,
          amount: amountEur,
          currency: 'EUR',
          provider: `is_${isProvider}`,
          gateway: 'chain2pay_is',
          email,
          paymentId: pay.id,
          merchantWallet: walletAddr,
          payoutAddress: walletAddr,
          lockedWallet: Boolean(merchantWallet),
        });
      } catch (err) {
        const status =
          err.code === 'NOT_CONFIGURED'
            ? 503
            : err.status === 401
              ? 502
              : 502;
        return res.status(status).json({
          error: err.message,
          provider: providerLower,
          gateway: 'chain2pay_is',
          configured: chain2payIs.isConfigured(),
          code: err.code || null,
        });
      }
    }

    if (
      !SMOKE_PASSED_IDS.has(providerLower) &&
      !VERIFIED_PROVIDER_IDS.has(providerLower)
    ) {
      return res.status(400).json({
        error: `Provider ${provider} je dočasne nedostupný (smoke).`,
        allowed: [...SMOKE_PASSED_IDS],
      });
    }

    let providersPayload;
    try {
      providersPayload = await fetchLiveProviders({ activeOnly: false });
    } catch {
      providersPayload = readProvidersCacheFile() || { providers: [] };
    }
    const providerMeta = findProvider(providersPayload.providers, provider);
    if (!providerMeta) {
      return res.status(400).json({ error: `Neznámy provider: ${provider}` });
    }
    if (String(providerMeta.status).toLowerCase() !== 'active') {
      return res.status(400).json({
        error: `Provider ${provider} nie je aktívny (status: ${providerMeta.status})`,
      });
    }

    const resolved = await client.resolveCheckoutAmount(
      amountEur,
      provider,
      providerMeta
    );

    const minAmt = Number(providerMeta.minimum_amount);
    if (Number.isFinite(minAmt) && resolved.amount < minAmt) {
      return res.status(400).json({
        error: `Minimálna suma pre ${providerMeta.provider_name} je ${minAmt} ${providerMeta.minimum_currency}. Zadaná suma po konverzii: ${resolved.amount} ${resolved.currency}.`,
        minimum_amount: minAmt,
        minimum_currency: providerMeta.minimum_currency,
        converted: resolved,
      });
    }

    // Fresh wallet every time — old tokens may return Bad Request on second_step
    const cbToken = crypto.randomBytes(24).toString('hex');
    const wallet = await client.createWallet(orderId, { token: cbToken });
    const built = client.buildProcessPaymentUrl({
      addressIn: wallet.address_in,
      amount: resolved.amount,
      provider,
      email,
      currency: resolved.currency,
    });
    const processPaymentUrl = built.url;

    let checkoutUrl;
    let resolution = 'bridge';
    let secondStepError = null;
    let providerHost = null;

    try {
      const step = await client.resolveProviderUrl(processPaymentUrl, {
        timeoutMs: 60000,
      });
      checkoutUrl = step.providerUrl;
      resolution = 'direct';
      // C2P .net Revolut now wraps Ramp in a Coindisco redirect (country from server IP).
      // Unwrap server-side so normalizeRevolutRampUrl can set SK/CZ + our return URL.
      if (/api\.coindisco\.com/i.test(String(checkoutUrl || ''))) {
        try {
          const r = await fetch(checkoutUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
          const loc = r.headers.get('location');
          if (loc && /^https:\/\/ramp\.revolut\.com\//i.test(loc)) {
            appendLog(`COINDISCO_UNWRAP ${orderId} -> ramp.revolut.com`);
            checkoutUrl = loc;
          }
        } catch (e) {
          appendLog(`COINDISCO_UNWRAP_FAIL ${orderId} ${e.message}`);
        }
      }
      // Prefill / lock what each on-ramp URL supports:
      // Revolut → countryCode SK/CZ + disableCountryCode + checkout success redirect
      // Banxa unsigned referral → email/returnUrl (signed TokenPocket portal left alone)
      // Email already sent to C2P via process_payment; name/address have no Banxa/Revolut URL params.
      if (checkoutUrl) {
        const envBase = (config.callbackBaseUrl || '').replace(/\/callback\/?$/i, '');
        const fwdProto = String(req.get('x-forwarded-proto') || '')
          .split(',')[0]
          .trim();
        const proto =
          fwdProto ||
          (envBase.startsWith('https:') ? 'https' : req.protocol || 'https');
        const host = req.get('x-forwarded-host') || req.get('host');
        const publicBase = (envBase || `${proto}://${host}`).replace(/\/$/, '');
        const isRevolut =
          providerLower === 'revolut' || /ramp\.revolut\.com/i.test(checkoutUrl);
        const returnUrl = isRevolut
          ? `${publicBase}/revolut-done?orderId=${encodeURIComponent(orderId)}`
          : `${publicBase}/callback?orderId=${encodeURIComponent(orderId)}`;
        const before = checkoutUrl;
        const normalized = client.normalizeOnrampCheckoutUrl(checkoutUrl, providerLower, {
          countryCode,
          country: countryCode,
          email,
          returnUrl,
          orderId,
          customer,
        });
        if (normalized && normalized !== before) {
          let note = `ONRAMP_NORMALIZE ${orderId} provider=${providerLower} country=${countryCode}`;
          try {
            const bu = new URL(before);
            const au = new URL(normalized);
            if (bu.searchParams.get('countryCode') !== au.searchParams.get('countryCode')) {
              note += ` cc:${bu.searchParams.get('countryCode')}→${au.searchParams.get('countryCode')}`;
            }
            if (bu.searchParams.get('partnerRedirectUrl') !== au.searchParams.get('partnerRedirectUrl')) {
              note += ' redirect=checkout';
            }
            if (!bu.searchParams.get('email') && au.searchParams.get('email')) {
              note += ' email=prefill';
            }
          } catch {
            /* ignore */
          }
          appendLog(note);
          checkoutUrl = normalized;
        }
      }
      try {
        providerHost = new URL(checkoutUrl).hostname;
      } catch {
        providerHost = null;
      }
      appendLog(
        `SECOND_STEP_OK ${orderId} host=${providerHost} url=${checkoutUrl.slice(0, 120)}`
      );
    } catch (err) {
      secondStepError = err.message;
      appendLog(
        `SECOND_STEP_FAIL ${orderId} ${err.message} body=${JSON.stringify(err.body || null).slice(0, 300)}`
      );
      // Same-origin bridge — browser never hits checkout.chain2pay.net
      checkoutUrl = `/checkout-bridge?orderId=${encodeURIComponent(orderId)}`;
      resolution = 'bridge';
    }

    const payoutEvm = addressPool.nextAddress('evm', { orderId });
    // Ranking lock: Banxa/C2P → USDC · Revolut → customer picks My wallet + pastes BTC (BTCPay).
    const cryptoLock = client.inspectCryptoLock(checkoutUrl, providerLower);
    if (/banxa/.test(providerLower) && !cryptoLock.lockedCrypto) {
      cryptoLock.lockedCrypto = 'USDC';
      cryptoLock.lockedWallet = true;
      cryptoLock.disableCrypto = true;
    }
    let revolutBtc = null;
    let walletNickname = null;
    if (/revolut/.test(providerLower) || /revolut/.test(String(provider))) {
      try {
        revolutBtc = addressPool.nextAddress('btc', { orderId: orderId + ':revolut-btc' });
      } catch (e) {
        try { revolutBtc = null; } catch (_) {}
      }
      if (!revolutBtc || !revolutBtc.address) {
        try {
          const dest = require('./destination').pickDestination({
            orderId, provider: 'revolut', coin: 'btc', allowedCoins: ['btc'], allowEvmFallback: false,
          });
          revolutBtc = { address: dest.address, index: dest.index };
        } catch (_) {}
      }
      const nickN = ((revolutBtc && revolutBtc.index) != null ? Number(revolutBtc.index) : Math.floor(Math.random() * 90) + 1) % 99 + 1;
      walletNickname = `Moja BTC peňaženka ${nickN}`;
      // Prefer guiding customer to paste BTC into My wallet (MetaMask/Trust nickname).
      if (!cryptoLock.lockedCrypto) cryptoLock.lockedCrypto = 'BTC';
    }
    const providerCheckoutUrl =
      checkoutUrl && /^https?:\/\//i.test(checkoutUrl) ? checkoutUrl : null;
    const localPayUrl = `/provider-pay?orderId=${encodeURIComponent(orderId)}`;
    // Land on local page first so destination address is always copyable
    const customerCheckoutUrl = localPayUrl;
    const orders = loadOrders();
    orders[orderId] = {
      orderId,
      amountEur: resolved.amountEur,
      amount: resolved.amount,
      email,
      country: countryCode,
      customer,
      currency: resolved.currency,
      provider,
      mode: 'single',
      exchange_rate: resolved.exchange_rate,
      conversionSource: resolved.conversionSource,
      address_in: wallet.address_in,
      polygon_address_in: wallet.polygon_address_in,
      ipn_token: wallet.ipn_token,
      callback_url: wallet.callback_url,
      cbTokenHash: sha256Hex(cbToken),
      processPaymentUrl,
      checkoutUrl: customerCheckoutUrl,
      providerCheckoutUrl: providerCheckoutUrl || checkoutUrl,
      localPayUrl,
      resolution,
      secondStepError,
      providerHost,
      payoutAddress: (revolutBtc && revolutBtc.address) || payoutEvm.address,
      payoutCoin: revolutBtc && revolutBtc.address ? 'btc' : 'evm',
      payoutIndex: (revolutBtc && revolutBtc.index) != null ? revolutBtc.index : payoutEvm.index,
      btcAddress: revolutBtc && revolutBtc.address ? revolutBtc.address : null,
      walletNickname: walletNickname,
      merchantWallet: config.merchantWallet,
      lockedWallet: Boolean(cryptoLock.lockedWallet),
      lockedCrypto: cryptoLock.lockedCrypto,
      disableCrypto: Boolean(cryptoLock.disableCrypto),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    saveOrders(orders);
    appendLog(
      `ORDER_CREATED ${orderId} eur=${resolved.amountEur} → ${resolved.amount} ${resolved.currency} provider=${provider} resolution=${resolution} payout=${orders[orderId].payoutCoin}:${orders[orderId].payoutAddress} crypto=${cryptoLock.lockedCrypto || '?'} nick=${walletNickname || '-'} lockedWallet=${Boolean(cryptoLock.lockedWallet)}`
    );

    if (redirect) {
      return res.redirect(302, customerCheckoutUrl);
    }

    res.json({
      orderId,
      checkoutUrl: customerCheckoutUrl,
      localPayUrl,
      providerCheckoutUrl: providerCheckoutUrl || checkoutUrl,
      resolution,
      providerHost,
      processPaymentUrl,
      secondStepError,
      amountEur: resolved.amountEur,
      amount: resolved.amount,
      currency: resolved.currency,
      exchange_rate: resolved.exchange_rate,
      conversionSource: resolved.conversionSource,
      provider,
      email,
      country: countryCode,
      customer,
      prefill: {
        email: true,
        country: /revolut/i.test(providerLower),
        addressViaUrl: false,
        note: 'Destination shown on /provider-pay with Kopírovať adresu when provider wallet field may be empty.',
      },
      address_in: wallet.address_in,
      polygon_address_in: wallet.polygon_address_in,
      payoutAddress: payoutEvm.address,
      payoutCoin: 'evm',
      lockedWallet: Boolean(cryptoLock.lockedWallet),
      lockedCrypto: cryptoLock.lockedCrypto,
      disableCrypto: Boolean(cryptoLock.disableCrypto),
      merchantWallet: config.merchantWallet,
      bridgeUrl: `/checkout-bridge?orderId=${encodeURIComponent(orderId)}`,
    });
  } catch (err) {
    appendLog(`CREATE_ERROR ${err.message}`);
    res.status(500).json({
      error: err.message,
      body: err.body || null,
    });
  }
}


// ---- lnkbio pricing plans: authoritative amount fetched server-side by plan id (customers cannot tamper the price) ----
const LNKBIO_URL = String(process.env.LNKBIO_URL || 'https://lnkbio.onrender.com').replace(/\/$/, '');
const planCache = new Map();
async function fetchPlan(id) {
  const k = String(id || '');
  if (!/^\d{1,9}$/.test(k)) return null;
  const c = planCache.get(k);
  if (c && Date.now() - c.at < 60000) return c.plan;
  // merged into lnkbio: read the plan in-process (same DB/cache as /api/plans/:id), no HTTP round trip
  if (typeof global.__lnkbioPlan === 'function') {
    const j = await global.__lnkbioPlan(Number(k));
    const amount = Number(j && j.amount);
    const plan = j && j.active && Number.isFinite(amount) && amount > 0 ? { id: Number(k), name: String(j.name || '').slice(0, 80), name_en: String(j.name_en || '').slice(0, 80), amount: Math.round(amount * 100) / 100, currency: 'EUR', period: Number(j.period) || 1 } : null;
    planCache.set(k, { at: Date.now(), plan });
    return plan;
  }
  // lnkbio may be asleep (Render free tier, cold start up to ~60 s): wait for it, retry once, and on a
  // network failure fall back to the last known plan (max 6 h old) instead of failing the checkout.
  let r = null;
  for (let i = 0; i < 2 && !r; i++) {
    try { r = await fetch(`${LNKBIO_URL}/api/plans/${k}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(i ? 30000 : 60000) }); }
    catch (e) { if (i) { if (c && c.plan && Date.now() - c.at < 6 * 3600e3) return c.plan; throw e; } }
    if (r && r.status >= 500) { if (i === 0) { r = null; continue; } if (c && c.plan && Date.now() - c.at < 6 * 3600e3) return c.plan; }
  }
  if (!r.ok) { planCache.set(k, { at: Date.now(), plan: null }); return null; }
  const j = await r.json();
  const amount = Number(j.amount);
  const plan = j && j.active && j.currency === 'EUR' && Number.isFinite(amount) && amount > 0 ? { id: Number(k), name: String(j.name || '').slice(0, 80), name_en: String(j.name_en || '').slice(0, 80), amount: Math.round(amount * 100) / 100, currency: 'EUR', period: Number(j.period) || 1 } : null;
  planCache.set(k, { at: Date.now(), plan });
  return plan;
}
app.get('/api/plan', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { const p = await fetchPlan(req.query.id); if (!p) return res.status(404).json({ error: 'Plán neexistuje alebo nie je aktívny.' }); res.json(p); }
  catch { res.status(502).json({ error: 'Cenník je dočasne nedostupný.' }); }
});
/** Public: only the per-method amount limits (fees are admin-only, never shown to customers). */
app.get('/api/method-costs', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  try {
    const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'method-costs.json'), 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(all)) if (!k.startsWith('_') && v && typeof v === 'object') out[k] = { max: v.max == null ? null : Number(v.max) };
    res.json(out);
  } catch { res.json({}); }
});
/** Remember which checkout method created the order (for popularity ranking) — wraps res.json, never touches the flow. */
function tagMethod(handler) {
  return (req, res) => {
    const id = String(((req.body || {}).provider) || '').trim().toLowerCase();
    if (/^[a-z0-9_]{2,60}$/.test(id)) {
      const json = res.json.bind(res);
      res.json = (b) => {
        try {
          if (b && b.orderId && res.statusCode < 400) {
            const all = loadOrders(); const o = all[b.orderId];
            if (o && !o.methodId) { o.methodId = id; saveOrders(all); }
          }
        } catch (x) { appendLog('METHOD_TAG_FAIL ' + x.message); }
        return json(b);
      };
    }
    return handler(req, res);
  };
}
/** Logged-in lnkbio customer → link the new order to the account (+ plan months for the licence/affiliate ledger). Never changes the flow or price. */
function tagAccount(handler) {
  return async (req, res) => {
    let acct = null; let months = 0; let planId = null;
    try {
      const A = global.__lnkAccounts; const u = A ? await A.fromReq(req) : null;
      if (u) {
        acct = { id: u.id, u: u.username };
        const b = req.body || {};
        if (b.plan_id != null && String(b.plan_id) !== '') { const pl = await fetchPlan(b.plan_id).catch(() => null); if (pl) { months = Number(pl.period) || 1; planId = pl.id; } }
        if (!months) { const pl = await A.planByAmount(b.amount ?? b.amountEur ?? b.suma).catch(() => null); if (pl) { months = pl.period; planId = pl.id; } }
      }
    } catch (x) { appendLog('ACCT_TAG_FAIL ' + x.message); acct = null; }
    if (acct) {
      const json = res.json.bind(res);
      res.json = (b) => {
        try {
          if (b && b.orderId && res.statusCode < 400) {
            const all = loadOrders(); const o = all[b.orderId];
            if (o && !o.acct) { o.acct = acct; o.planMonths = months || null; o.planId = planId; saveOrders(all); }
          }
        } catch (x) { appendLog('ACCT_TAG_FAIL ' + x.message); }
        return json(b);
      };
      // form posts answer with a redirect (no orderId in the body) – tag the order this request just created
      const t0 = Date.now() - 1000; const redir = res.redirect.bind(res);
      res.redirect = (...args) => {
        try {
          const all = loadOrders(); let best = null;
          for (const [id, o] of Object.entries(all)) { const t = Date.parse(o && o.createdAt); if (o && !o.acct && t >= t0 && (!best || t > best.t)) best = { id, t }; }
          if (best) { const o = all[best.id]; o.acct = acct; o.planMonths = months || null; o.planId = planId; saveOrders(all); }
        } catch (x) { appendLog('ACCT_TAG_FAIL ' + x.message); }
        return redir(...args);
      };
    }
    return handler(req, res);
  };
}
app.post('/api/checkout', tagMethod(tagAccount(handleCreateCheckout)));
app.post('/create-checkout', tagMethod(tagAccount(handleCreateCheckout)));
app.post('/api/create-checkout', tagMethod(tagAccount(handleCreateCheckout)));
/** BTCPay checkout via server-side redirect – the BTCPay link / store name never appears in client JSON or HTML. */
app.get('/pay/btcpay', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String(req.query.orderId || '');
  const o = /^ord_[a-f0-9]{8,40}$/.test(id) ? loadOrders()[id] : null;
  const u = o && (o.gateway === 'btcpay' || o.provider === 'btcpay') ? String(o.checkoutUrl || '') : '';
  if (!/^https?:\/\//i.test(u)) return res.status(404).type('text/plain').send('Objednávka nenájdená.');
  return res.redirect(302, u);
});

/**
 * Proxy second_step for an existing order (used by /checkout-bridge).
 */
app.get('/api/provider-step', async (req, res) => {
  try {
    const orderId = String(req.query.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'orderId je povinný' });
    }
    const orders = loadOrders();
    const order = orders[orderId];
    if (!order || !order.processPaymentUrl) {
      return res.status(404).json({ error: 'Objednávka sa nenašla' });
    }

    const step = await client.resolveProviderUrl(order.processPaymentUrl, {
      timeoutMs: 60000,
    });

    order.checkoutUrl = step.providerUrl;
    order.resolution = 'direct';
    try {
      order.providerHost = new URL(step.providerUrl).hostname;
    } catch {
      /* ignore */
    }
    order.secondStepError = null;
    orders[orderId] = order;
    saveOrders(orders);
    appendLog(
      `PROVIDER_STEP_OK ${orderId} host=${order.providerHost}`
    );

    res.json({ url: step.providerUrl, orderId });
  } catch (err) {
    appendLog(`PROVIDER_STEP_FAIL ${err.message}`);
    res.status(502).json({
      error:
        'Nepodarilo sa pripraviť platobnú stránku providera. Skúste to znova.',
      detail: err.message,
      body: err.body || null,
    });
  }
});

/**
 * Same-origin Processing page — fetch goes to our /api/provider-step,
 * so the customer browser never talks to checkout.chain2pay.net.
 */
app.get('/checkout-bridge', (req, res) => {
  const orderId = String(req.query.orderId || '').trim();
  if (!orderId) {
    return res.status(400).type('html').send(`<!DOCTYPE html>
<html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Chyba</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body style="font-family:system-ui;background:#0f1115;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center">
<p>Chýba orderId.</p></body></html>`);
  }

  const orders = loadOrders();
  const order = orders[orderId];
  if (!order) {
    return res.status(404).type('html').send(`<!DOCTYPE html>
<html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Nenájdené</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body style="font-family:system-ui;background:#0f1115;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center">
<p>Objednávka sa nenašla.</p></body></html>`);
  }

  // If we already have a direct provider URL, bounce immediately
  if (
    order.resolution === 'direct' &&
    order.checkoutUrl &&
    /^https?:\/\//i.test(order.checkoutUrl) &&
    !isChain2PayHost(order.checkoutUrl)
  ) {
    return res.redirect(302, order.checkoutUrl);
  }

  const safeOrderId = JSON.stringify(orderId);
  res.type('html').send(`<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pripravujem platbu…</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: linear-gradient(135deg, #0f1115 0%, #1a1d29 100%);
    color: #e5e7eb;
    padding: 1.5rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
    max-width: 400px;
    width: 100%;
    padding: 3rem 2.75rem;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 20px;
    text-align: center;
  }
  .spinner {
    width: 48px; height: 48px;
    border: 3px solid rgba(255,255,255,0.12);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.15rem; font-weight: 600; }
  p { color: #9ca3af; font-size: 0.9rem; line-height: 1.5; }
  .err { color: #f87171; }
  button {
    margin-top: 0.5rem;
    padding: 0.7rem 1.2rem;
    border: 0; border-radius: 10px;
    background: #3b82f6; color: #fff; font: inherit; font-weight: 600;
    cursor: pointer;
  }
</style>
<link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body>
  <div class="card" id="loading">
    <div class="spinner" aria-hidden="true"></div>
    <h1>Pripravujem platbu…</h1>
    <p>Presmerovávame vás na zabezpečenú stránku providera.</p>
  </div>
  <div class="card" id="failed" hidden>
    <h1 class="err">Platbu sa nepodarilo pripraviť</h1>
    <p id="failMsg">Skúste to znova o chvíľu.</p>
    <button type="button" data-href="/platby">Späť</button>
  </div>
<script>
  const orderId = ${safeOrderId};
  function showFailed(msg) {
    document.getElementById('loading').hidden = true;
    document.getElementById('failed').hidden = false;
    if (msg) document.getElementById('failMsg').textContent = msg;
  }
  fetch('/api/provider-step?orderId=' + encodeURIComponent(orderId), {
    headers: { Accept: 'application/json' },
  })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (r) {
      if (r.ok && r.data && r.data.url) {
        window.location.replace(r.data.url);
      } else {
        showFailed((r.data && r.data.error) || 'Provider nevrátil platobnú URL.');
      }
    })
    .catch(function () {
      showFailed('Sieťová chyba pri príprave platby.');
    });
</script>
</body>
</html>`);
});

function handleCallback(req, res) {
  const q = req.query;
  let orderId = q.orderId || q.id || q.invoice || null;
  const chain2payOrderId = q.chain2pay_order_id || null;
  const isIsCallback =
    String(q.source || '') === 'chain2pay_is' || Boolean(chain2payOrderId);

  const fields = {
    orderId,
    chain2pay_order_id: chain2payOrderId,
    value_coin: q.value_coin,
    coin: q.coin,
    txid_in: q.txid_in,
    txid_out: q.txid_out,
    address_in: q.address_in,
    value_forwarded_coin: q.value_forwarded_coin,
    provider: q.provider || null,
    source: q.source || null,
    rawQuery: (() => { const { t, ...rest } = q; return rest; })(),
  };

  appendLog(`CALLBACK ${JSON.stringify(fields)}`);

  // .net IPN needs address_in; .is webhooks send chain2pay_order_id + value_coin + txid_out (no address_in)
  const ok = Boolean(
    fields.value_coin &&
      fields.txid_out &&
      (fields.address_in || isIsCallback)
  );

  const orders = loadOrders();
  if (!orderId && chain2payOrderId) {
    for (const [oid, o] of Object.entries(orders)) {
      if (
        o &&
        (o.paymentId === chain2payOrderId ||
          o.chain2payOrderId === chain2payOrderId)
      ) {
        orderId = oid;
        fields.orderId = oid;
        break;
      }
    }
  }
  // Orders created since the callback token was introduced carry cbTokenHash: the callback must present
  // the matching secret t (constant-time). Older pending orders (no hash) keep the legacy behaviour.
  const target = orderId ? orders[orderId] : null;
  if (target && target.cbTokenHash) {
    const tok = String(q.t || '');
    const good = /^[a-f0-9]{48}$/.test(tok) && /^[a-f0-9]{64}$/.test(String(target.cbTokenHash)) &&
      crypto.timingSafeEqual(Buffer.from(sha256Hex(tok), 'hex'), Buffer.from(String(target.cbTokenHash), 'hex'));
    if (!good) {
      appendLog(`CALLBACK_TOKEN_REJECT orderId=${orderId}`);
      return res.status(tok ? 403 : 400).send(tok ? 'forbidden' : 'missing payment fields');
    }
    if (target.status === 'paid') return res.status(200).send('OK');
  }
  if (orderId && orders[orderId]) {
    orders[orderId].status = ok ? 'paid' : 'callback_incomplete';
    orders[orderId].callback = fields;
    orders[orderId].paidAt = new Date().toISOString();
    if (chain2payOrderId) orders[orderId].chain2payOrderId = chain2payOrderId;
    saveOrders(orders);
  }

  if (!ok) {
    appendLog(`CALLBACK_VERIFY_FAIL orderId=${orderId}`);
    return res.status(400).send('missing payment fields');
  }

  res.status(200).send('OK');
}

app.get('/callback', handleCallback);
app.get('/callback/', handleCallback);

app.get('/api/orders/:orderId', (req, res) => {
  const orders = loadOrders();
  const o = orders[req.params.orderId];
  if (!o) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store');
  // Do not expose PII / customer-submitted codes / internal fields by order id.
  const { contact, customer, email, phone, ip, proofSubmissions, adminDecision, adminDecisionAt, statusToken, amountLinkUrl, cbTokenHash, callback_url, ipn_token, callback, wg, ...pub } = o;
  res.json(pub);
});


/** Shared post-payment note (no external messaging). */
function postPayNoteCss() {
  return '.shotbox{margin:1rem 0;padding:.85rem 1rem;border:1px solid #fbbf2488;background:#78350f33;border-radius:12px;font-size:.88rem;line-height:1.45;color:#fde68a}.shotbox strong{color:#fff}';
}
function postPayNoteHtml() {
  return '<div class="shotbox"><strong>Po platbe:</strong> stav objednávky sa aktualizuje automaticky. Potvrdenie od providera si uschovajte.</div><div id="chainStatus"></div><script src="/chain-status.js" defer></script>';
}

function htmlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Switchere local pay page (locked crypto + pool address + Kopírovať). Restored 2026-10-12 — route was missing (404). */
function switcherePayPage(req, res) {
  const orderId = String(req.query.orderId || '').trim();
  const order = loadOrders()[orderId];
  if (!order || order.provider !== 'switchere') {
    return res.status(404).type('html').send('<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Objednávka nenájdená</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body style="font-family:system-ui;background:#0b1220;color:#e8eef9;padding:2rem"><h1>Objednávka nenájdená</h1><p><a style="color:#3b82f6" href="/platby">← Späť</a></p></body></html>');
  }
  const done = String(req.query.done || '') === '1';
  const failed = String(req.query.failed || '') === '1';
  const buyUrl = order.switchereUrl || order.publicBuy || order.publicRamp || 'https://switchere.com/';
  const coin = String(order.lockedCrypto || order.payoutCurrency || 'BTC').toUpperCase();
  const addr = order.dstAddress || order.payoutAddress || '';
  const method = order.payinGroup === 'skrill' ? 'Skrill' : order.payinGroup === 'sepa' || order.payinGroup === 'bank' ? 'SEPA prevod' : 'Karta / Apple Pay / Google Pay';
  res.type('html').send(`<!DOCTYPE html>
<html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>TV Software · platba (${htmlEsc(method)})</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e8eef9;padding:1.5rem}
.card{max-width:560px;width:100%;background:#121a2b;border:1px solid #243044;border-radius:18px;padding:1.5rem}
h1{margin:0 0 .5rem;font-size:1.25rem}.sub{color:#93a0b8;font-size:.9rem;line-height:1.45}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid #243044;font-size:.92rem}.row span:first-child{color:#93a0b8}.row strong{text-align:right;word-break:break-all}
.addr{font-family:ui-monospace,monospace;font-size:.82rem;background:#0f172a;border:1px solid #243044;border-radius:10px;padding:.85rem;word-break:break-all;margin:.5rem 0}
button.copy{width:100%;border:0;border-radius:10px;padding:.95rem;min-height:50px;font-size:1rem;background:#1e293b;color:#e8eef9;font-weight:600;cursor:pointer}
.btn{display:block;text-align:center;text-decoration:none;color:#fff;background:linear-gradient(135deg,#3b82f6,#2563eb);border-radius:12px;padding:.85rem 1rem;font-weight:700;margin:1rem 0 .5rem}
.ghost{display:block;text-align:center;color:#93a0b8;margin-top:.5rem}.ok{color:#22c55e}.bad{color:#f87171}
${postPayNoteCss()}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body><div class="card">
<h1>${done ? '<span class="ok">Ďakujeme — platba odoslaná</span>' : failed ? '<span class="bad">Platba zlyhala</span>' : 'Platba: ' + htmlEsc(method)}</h1>
<p class="sub">Nič nevyberáte — mena aj adresa sú nastavené automaticky. Na stránke providera len zadajte platobné údaje.</p>
<div class="row"><span>Objednávka</span><strong>${htmlEsc(order.orderId)}</strong></div>
<div class="row"><span>Suma</span><strong>${htmlEsc(order.amountEur)} EUR</strong></div>
<div class="row"><span>Mena (pevná)</span><strong>${htmlEsc(coin)}</strong></div>
<p class="sub" style="margin:.8rem 0 0">Adresa (ak ju provider vypýta, vložte presne túto):</p>
<div class="addr" id="addr">${htmlEsc(addr)}</div>
<button type="button" class="copy" id="copyBtn">Kopírovať adresu</button>
${postPayNoteHtml()}
<a class="btn" href="${htmlEsc(buyUrl)}" target="_blank" rel="noopener">Pokračovať na platbu →</a>
<a class="ghost" href="/platby">← Späť na platby</a>
${order.payinGroup === 'skrill' ? guideStore.html('switchere_skrill', { amount: order.amountEur, coin }) : ''}
</div>
<script>
document.getElementById('copyBtn').onclick=async()=>{const t=document.getElementById('addr').textContent.trim();try{await navigator.clipboard.writeText(t);document.getElementById('copyBtn').textContent='Skopírované';}catch{document.getElementById('copyBtn').textContent='Skopírujte ručne';}};
</script><script src="/chat-widget.js" defer></script><script src="/proof-form.js" defer></script></body></html>`);
}


/** Shared local pay page: copyable destination + optional wallet nickname (Revolut My wallet). */
function providerPayPage(req, res) {
  const orderId = String(req.query.orderId || '').trim();
  const order = loadOrders()[orderId];
  if (!order) {
    return res.status(404).type('html').send('<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Objednávka nenájdená</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body style="font-family:system-ui;background:#0b1220;color:#e8eef9;padding:2rem"><h1>Objednávka nenájdená</h1><p><a style="color:#3b82f6" href="/platby">← Späť</a></p></body></html>');
  }
  const buyUrl = order.providerCheckoutUrl || order.checkoutUrl || '/platby';
  const external = /^https?:\/\//i.test(String(buyUrl));
  const coin = String(order.lockedCrypto || order.payoutCoin || 'BTC').toUpperCase();
  const addr = order.btcAddress || order.dstAddress || order.payoutAddress || '';
  const nick = order.walletNickname || '';
  const isRev = /revolut/i.test(String(order.provider || '')) || /revolut/i.test(String(order.providerAlias || ''));
  const title = isRev ? 'Revolut · My wallet' : ('Platba: ' + htmlEsc(order.provider || 'provider'));
  res.type('html').send(`<!DOCTYPE html>
<html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0b1220;color:#e8eef9;padding:1rem}
.card{max-width:560px;width:100%;background:#121a2b;border:1px solid #243044;border-radius:18px;padding:1.25rem}
h1{margin:0 0 .4rem;font-size:1.25rem}.sub{color:#93a0b8;font-size:.9rem;line-height:1.45}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-bottom:1px solid #243044;font-size:.92rem}
.row span:first-child{color:#93a0b8}.addr{font-family:ui-monospace,monospace;font-size:.85rem;background:#0f172a;border:1px solid #243044;border-radius:12px;padding:.85rem;word-break:break-all;margin:.45rem 0}
button.copy{width:100%;border:0;border-radius:12px;padding:1rem;min-height:52px;font-size:1.05rem;background:#1e293b;color:#e8eef9;font-weight:700;cursor:pointer;margin:.25rem 0}
.btn{display:block;text-align:center;text-decoration:none;color:#fff;background:linear-gradient(135deg,#8b5cf6,#6d28d9);border-radius:12px;padding:1rem;font-weight:800;margin:1rem 0 .5rem;font-size:1.05rem}
.ghost{display:block;text-align:center;color:#93a0b8;margin-top:.5rem}.tip{background:#1e3a8a33;border:1px solid #3b82f688;border-radius:12px;padding:.75rem .9rem;font-size:.88rem;line-height:1.45;margin:.75rem 0}
ol{padding-left:1.2rem;line-height:1.5;margin:.4rem 0}
${postPayNoteCss()}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body><div class="card">
<h1>${title}</h1>
<p class="sub">Objednávka <b>${htmlEsc(order.orderId)}</b> · ${htmlEsc(order.amountEur)} EUR · ${htmlEsc(coin)}</p>
${isRev ? `<details class="tip"><summary style="cursor:pointer"><strong>📖 Návod: krok „My wallet“ na Revolut Ramp</strong></summary>
<ol>
<li>Zvoľte <b>MetaMask</b> alebo <b>Trust Wallet</b> (nie Exchange).</li>
<li>Do poľa adresy vložte BTC adresu nižšie (tlačidlo Kopírovať).</li>
<li>Nickname peňaženky (len popis, nie totožnosť): <b id="nick">${htmlEsc(nick || 'Moja BTC peňaženka')}</b>
<button type="button" class="copy" data-copy="nick" style="margin-top:.45rem">Kopírovať nickname</button></li>
</ol></details>` : `<p class="sub">Ak provider vypýta adresu peňaženky, vložte presne túto:</p>`}
<div class="addr" id="addr">${htmlEsc(addr)}</div>
<button type="button" class="copy" data-copy="addr">Kopírovať BTC adresu</button>
${postPayNoteHtml()}
<a class="btn" href="${htmlEsc(external ? buyUrl : (order.providerCheckoutUrl || buyUrl || '/platby'))}" target="_blank" rel="noopener">${isRev ? 'Otvoriť Revolut Ramp →' : 'Pokračovať na platbu →'}</a>
<a class="ghost" href="/platby">← Späť na platby</a>
</div>
<script>
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=async()=>{const t=document.getElementById(b.dataset.copy).textContent.trim();try{await navigator.clipboard.writeText(t);b.textContent='Skopírované ✓';}catch{b.textContent='Skopírujte ručne';}setTimeout(()=>{b.textContent=b.dataset.copy==='nick'?'Kopírovať nickname':'Kopírovať BTC adresu';},1500);});
</script>
<script src="/chain-status.js" defer></script>
</body></html>`);
}

/** Onramper local pay: widget URL button + BTC copy fallback. */
function onramperPayPage(req, res) {
  const orderId = String(req.query.orderId || '').trim();
  const order = loadOrders()[orderId];
  if (!order || order.provider !== 'onramper') {
    return res.status(404).type('html').send('<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Objednávka nenájdená</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body style="font-family:system-ui;background:#0b1220;color:#e8eef9;padding:2rem"><h1>Objednávka nenájdená</h1><p><a style="color:#3b82f6" href="/platby">← Späť</a></p></body></html>');
  }
  const done = String(req.query.done || '') === '1';
  const failed = String(req.query.failed || '') === '1';
  const buyUrl = order.onramperUrl || order.providerCheckoutUrl || '';
  const addr = order.btcAddress || order.payoutAddress || order.dstAddress || '';
  const locked = Boolean(order.lockedWallet);
  res.type('html').send(`<!DOCTYPE html>
<html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Onramper · platba</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0b1220;color:#e8eef9;padding:1rem}
.card{max-width:560px;width:100%;background:#121a2b;border:1px solid #243044;border-radius:18px;padding:1.25rem}
h1{margin:0 0 .4rem;font-size:1.25rem}.sub{color:#93a0b8;font-size:.9rem;line-height:1.45}
.addr{font-family:ui-monospace,monospace;font-size:.85rem;background:#0f172a;border:1px solid #243044;border-radius:12px;padding:.85rem;word-break:break-all;margin:.45rem 0}
button.copy{width:100%;border:0;border-radius:12px;padding:1rem;min-height:52px;font-size:1.05rem;background:#1e293b;color:#e8eef9;font-weight:700;cursor:pointer}
.btn{display:block;text-align:center;text-decoration:none;color:#052e16;background:linear-gradient(135deg,#22c55e,#16a34a);border-radius:12px;padding:1.05rem;font-weight:800;margin:1rem 0 .5rem;font-size:1.08rem}
.ghost{display:block;text-align:center;color:#93a0b8}.ok{color:#22c55e}.bad{color:#f87171}
.tip{color:#93a0b8;font-size:.85rem;margin:.5rem 0}
${postPayNoteCss()}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body><div class="card">
<h1>${done ? '<span class="ok">Ďakujeme — platba odoslaná</span>' : failed ? '<span class="bad">Platba zlyhala</span>' : 'Onramper (karta / SEPA)'}</h1>
<p class="sub">Objednávka <b>${htmlEsc(order.orderId)}</b> · ${htmlEsc(order.amountEur)} EUR → BTC</p>
<p class="tip">${locked ? 'Adresa je predvyplnená vo widgete (wallets=).' : 'Ak widget nevyplní peňaženku, vložte BTC adresu nižšie.'}</p>
<div class="addr" id="addr">${htmlEsc(addr)}</div>
<button type="button" class="copy" id="copyBtn">Kopírovať BTC adresu</button>
${postPayNoteHtml()}
${buyUrl ? `<a class="btn" id="goOnr" href="${htmlEsc(buyUrl)}" target="_blank" rel="noopener">Otvoriť Onramper widget →</a>` : '<p class="bad">Widget URL nie je k dispozícii — skontrolujte ONRAMPER_API_KEY.</p>'}
<a class="ghost" href="/platby">← Späť na platby</a>
</div>
<script>
document.getElementById('copyBtn').onclick=async()=>{const t=document.getElementById('addr').textContent.trim();try{await navigator.clipboard.writeText(t);document.getElementById('copyBtn').textContent='Skopírované ✓';}catch{document.getElementById('copyBtn').textContent='Skopírujte ručne';}};
</script>
<script src="/chain-status.js" defer></script>
</body></html>`);
}

function onrampBridgePage(req, res) {
  const orderId = String(req.query.orderId || '').trim();
  const orders = loadOrders();
  const order = orders[orderId];
  if (!order || order.provider !== 'btcpay_onramp') {
    return res.status(404).type('html').send(`<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Objednávka nenájdená</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e8eef9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
.card{max-width:480px;background:#121a2b;border:1px solid #243044;border-radius:16px;padding:1.5rem}a{color:#3b82f6}</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body><div class="card"><h1>Objednávka nenájdená</h1><p>Chýba platná on-ramp + BTCPay objednávka.</p><p><a href="/platby">← Späť</a></p></div></body></html>`);
  }
  const links = (order.onrampLinks || [])
    .map(
      (l) =>
        `<a class="btn" href="${String(l.url).replace(/"/g, '&quot;')}" target="_blank" rel="noopener">${l.label}</a>`
    )
    .join('\n');
  const done = String(req.query.done || '') === '1';
  res.type('html').send(`<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Bank/card → BTC · BTCPay</title>
<style>
:root{--bg:#0b1220;--card:#121a2b;--border:#243044;--text:#e8eef9;--muted:#93a0b8;--accent:#3b82f6;--ok:#22c55e;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:radial-gradient(900px 500px at 10% -10%,#1e3a8a55,transparent),var(--bg);color:var(--text);padding:1.5rem}
.card{max-width:560px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:1.5rem;box-shadow:0 20px 50px #0006}
h1{margin:0 0 .4rem;font-size:1.25rem}.sub{color:var(--muted);font-size:.9rem;margin:0 0 1rem;line-height:1.45}
.badge{display:inline-block;background:#14532d55;color:var(--ok);border:1px solid #16653488;border-radius:999px;padding:.2rem .65rem;font-size:.75rem;font-weight:700;margin-bottom:.85rem}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.7rem 0;border-bottom:1px solid var(--border);font-size:.92rem}
.row span:first-child{color:var(--muted)}.row strong{text-align:right;word-break:break-all}
.addr{font-family:ui-monospace,monospace;font-size:.82rem;background:#0f172a;border:1px solid var(--border);border-radius:10px;padding:.85rem;word-break:break-all;margin:.5rem 0 1rem}
.btns{display:flex;flex-direction:column;gap:.55rem;margin:1rem 0}
.btn{display:block;text-align:center;text-decoration:none;color:#fff;background:linear-gradient(135deg,var(--accent),#2563eb);
border-radius:12px;padding:.85rem 1rem;font-weight:700}
.btn.secondary{background:#0f172a;border:1px solid var(--border);color:var(--text);font-weight:600}
.btn.ghost{background:transparent;border:1px dashed var(--border);color:var(--muted);font-weight:500;font-size:.85rem}
.warn{color:var(--warn);font-size:.85rem;line-height:1.45}.ok{color:var(--ok)}.status{margin-top:.75rem;font-size:.85rem;color:var(--muted);min-height:1.2em}
button.copy{width:100%;margin-top:.35rem;border:0;border-radius:10px;padding:.95rem;min-height:50px;font-size:1rem;background:#1e293b;color:var(--text);font-weight:600;cursor:pointer}
${postPayNoteCss()}
</style>
<link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body>
<div class="card">
  <div class="badge">${done ? 'Návrat z on-rampu' : 'Fiat → BTC → BTCPay'}</div>
  <h1>Bank/card → BTC (cez on-ramp + BTCPay)</h1>
  <p class="sub">Zaplatíte fiatom u on-ramp providera. BTC musí prísť na <strong>presnú BTCPay invoice adresu</strong> nižšie — potom sa invoice označí ako zaplatená.</p>
  <div class="row"><span>Objednávka</span><strong>${order.orderId}</strong></div>
  <div class="row"><span>Suma (fiat)</span><strong>${order.amountEur} EUR</strong></div>
  <div class="row"><span>BTC due</span><strong>${order.btcAmount || '—'} BTC</strong></div>
  <div class="row"><span>Invoice</span><strong>${order.invoiceId || '—'}</strong></div>
  <div class="row"><span>Stav invoice</span><strong id="invStatus">…</strong></div>
  <p style="margin:.8rem 0 .35rem;font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:700">BTCPay receive address</p>
  <div class="addr" id="btcAddr">${order.btcAddress || ''}</div>
  <button type="button" class="copy" id="copyBtn">Kopírovať adresu</button>
  <p class="warn">Pošlite <em>aspoň</em> uvedenú sumu. Overte, že adresa peňaženky v on-rampe = adresa vyššie.</p>
  ${postPayNoteHtml()}
  <div class="btns">
    ${links || '<span class="warn">Žiadne on-ramp linky</span>'}
    <a class="btn secondary" href="${order.btcpayCheckout || '#'}" target="_blank" rel="noopener">Otvoriť BTCPay invoice (status)</a>
    <a class="btn ghost" href="/platby">← Späť na platby</a>
  </div>
  <div class="status" id="pollStatus">Sledujem BTCPay invoice…</div>
</div>
<script>
  const orderId = ${JSON.stringify(order.orderId)};
  const addr = document.getElementById('btcAddr').textContent.trim();
  document.getElementById('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(addr); document.getElementById('copyBtn').textContent = 'Skopírované'; }
    catch { document.getElementById('copyBtn').textContent = 'Skopírujte ručne'; }
  };
  async function poll() {
    try {
      const r = await fetch('/api/btcpay-invoice/' + encodeURIComponent(orderId));
      const d = await r.json();
      const el = document.getElementById('invStatus');
      const st = document.getElementById('pollStatus');
      if (!r.ok) { el.textContent = 'chyba'; st.textContent = d.error || 'Nepodarilo sa načítať stav'; return; }
      el.textContent = (d.status || '?') + (d.additionalStatus ? ' / ' + d.additionalStatus : '');
      const paid = /settled|processing|complete|paid|confirmed/i.test(String(d.status||''));
      if (paid) { el.className = 'ok'; st.className = 'status ok'; st.textContent = 'Platba zaznamenaná na BTCPay.'; return; }
      st.textContent = 'Čakám na BTC on-chain… obnovím o 8 s';
      setTimeout(poll, 8000);
    } catch (e) {
      document.getElementById('pollStatus').textContent = 'Poll chyba — skúste obnoviť stránku';
    }
  }
  poll();
</script>
</body>
</html>`);
}


/** Public view of a bank_sepa_manual order + admin-set recipient name (Reťaz SEPA botov). */
function sepaPublicView(order) {
  const view = (order.resolution === 'sepa_manual_telegram' || order.status === 'awaiting_iban')
    ? sepaManual.publicOrderView(order)
    : electrocoin.publicOrderView(order);
  try {
    return sepaBotChain.applyRecipientNameToView(view, order);
  } catch (e) {
    appendLog('sepa recipientName skipped ' + (order && order.orderId) + ' ' + (e && e.message));
    return view;
  }
}

async function bankSepaPayPage(req, res) {
  const orderId = String(req.query.orderId || '').trim();
  const orders = loadOrders();
  const order = orders[orderId];
  if (!order || order.provider !== 'bank_sepa_manual') {
    return res.status(404).type('html').send(`<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Objednávka nenájdená</title>
<style>body{font-family:system-ui;background:#0b1220;color:#e8eef9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
.card{max-width:480px;background:#121a2b;border:1px solid #243044;border-radius:16px;padding:1.5rem}a{color:#3b82f6}</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body><div class="card"><h1>Objednávka nenájdená</h1><p>Chýba platná SEPA objednávka.</p><p><a href="/platby">← Späť</a></p></div></body></html>`);
  }
  const safe = (v) =>
    String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const view = sepaPublicView(order);
  const ssrReady = Boolean(view.bankDetailsPublic && view.bank && view.bank.iban);
  const ssrBenef = safe(ssrReady ? view.bank.beneficiary : '');
  const ssrIban = safe(ssrReady ? view.bank.iban : '');
  const ssrAmountNum = safe(ssrReady ? (view.bank.amountExact || view.amountExact || '') : '');
  const ssrAmount = ssrAmountNum ? `${ssrAmountNum} EUR` : '';
  const ssrNote = safe(ssrReady ? (view.bank.paymentNote || view.paymentNote || view.bank.purpose || view.purpose || '') : '');
  const ssrVs = safe(ssrReady ? (view.bank.vs || view.vs || '') : '');
  const ssrRef = ssrNote; // legacy id kept for note
  const ssrDeadline = ssrReady && view.deadlineAt ? JSON.stringify(view.deadlineAt) : 'null';
  let ssrQrSpd = '';
  let ssrQrEpc = '';
  let ssrBankOpen = null;
  // QR + bank-open CTA are optional. On any failure: silently skip them and keep
  // copyable IBAN/amount/PURPOSE/beneficiary. Never fail the pay page / order.
  if (ssrReady) {
    let fields = null;
    try {
      fields = sepaQr.fieldsFromBank(view.bank, {
        amountExact: view.amountExact,
        purpose: view.purpose,
        paymentNote: view.paymentNote || view.purpose,
        vs: view.vs,
        reference: view.reference,
      });
    } catch (e) {
      appendLog('sepaQr fields SSR failed ' + orderId + ' ' + (e && e.message));
      fields = null;
    }
    if (fields) {
      try {
        const qrs = await sepaQr.generatePaymentQrs(fields);
        ssrQrSpd = qrs && qrs.spd && qrs.spd.dataUrl ? qrs.spd.dataUrl : '';
        ssrQrEpc = qrs && qrs.epc && qrs.epc.dataUrl ? qrs.epc.dataUrl : '';
      } catch (e) {
        appendLog('sepaQr QR SSR skipped ' + orderId + ' ' + (e && e.message));
        ssrQrSpd = '';
        ssrQrEpc = '';
      }
      try {
        ssrBankOpen = sepaQr.buildBankOpenPayload(fields);
      } catch (e) {
        appendLog('sepaQr bankOpen SSR skipped ' + orderId + ' ' + (e && e.message));
        ssrBankOpen = null;
      }
    }
  }
  // Only embed successful data URLs — no PNG API fallback (avoids broken-image retry loops).
  const qrSpdSrc = ssrQrSpd || '';
  const qrEpcSrc = ssrQrEpc || '';
  const ssrBankOpenJson = JSON.stringify(ssrBankOpen).replace(/</g, '\\u003c');
  res.type('html').send(`<!DOCTYPE html>
<html lang="sk">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Bankový prevod (SEPA)</title>
<style>
:root{--bg:#0b1220;--card:#121a2b;--border:#243044;--text:#e8eef9;--muted:#93a0b8;--accent:#3b82f6;--ok:#22c55e;--warn:#fbbf24;--danger:#f87171}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:radial-gradient(900px 500px at 10% -10%,#14532d55,transparent),var(--bg);color:var(--text);padding:1.25rem}
.wrap{max-width:560px;width:100%}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:1.25rem 1.25rem 1.4rem;box-shadow:0 20px 50px #0006}
h1{margin:0 0 .35rem;font-size:1.25rem}.sub{color:var(--muted);font-size:.9rem;margin:0 0 1rem;line-height:1.45}
.badge{display:inline-block;background:#14532d55;color:var(--ok);border:1px solid #16653488;border-radius:999px;padding:.2rem .65rem;font-size:.75rem;font-weight:700;margin-bottom:.85rem}
.badge.warn{background:#78350f55;color:var(--warn);border-color:#b4530988}
.badge.danger{background:#7f1d1d55;color:var(--danger);border-color:#b91c1c88}
.row{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-bottom:1px solid var(--border);font-size:.9rem}
.row span:first-child{color:var(--muted)}.row strong{text-align:right;word-break:break-all}
.timer{font-size:1.6rem;font-weight:800;letter-spacing:.04em;text-align:center;padding:.75rem;margin:.5rem 0 1rem;background:#0f172a;border-radius:12px;border:1px solid var(--border)}
.timer.expired{color:var(--danger)}
.bankbox{display:none;margin:0 0 1rem;padding:.85rem;border-radius:14px;background:#0f172a;border:1px solid #16653488}
.bankbox h2{margin:0 0 .65rem;font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.field{margin:0 0 .65rem}.field label{display:block;font-size:.72rem;color:var(--muted);margin-bottom:.2rem;text-transform:uppercase;letter-spacing:.03em}
.field .val{font-family:ui-monospace,monospace;font-size:.95rem;padding:.55rem .65rem;background:#121a2b;border:1px solid var(--border);border-radius:8px;word-break:break-all;user-select:all}
.field.recipient .val{font-family:system-ui,-apple-system,sans-serif;font-size:1.05rem;font-weight:700;color:#fff;word-break:break-word}
.field.note{padding:.75rem;border-radius:14px;background:#78350f33;border:1px solid #f59e0b88;margin:.85rem 0}
.field.note label{color:#fde68a;font-size:.8rem;font-weight:800}
.field.note .val{background:#0f172a;border-color:#f59e0b66;font-size:1.05rem;font-weight:700;color:#fff}
.field.note .notewarn{margin:.45rem 0 .2rem;color:#fde68a;font-size:.88rem;line-height:1.4;font-weight:600}
.field.note button.copy{background:#b45309;color:#fff}
button.copy,button.primary,label.filebtn{width:100%;margin-top:.35rem;border:0;border-radius:10px;padding:.75rem;font:inherit;font-weight:700;cursor:pointer}
button.copy{background:#1e293b;color:var(--text)}
button.primary{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;margin-top:.65rem}
button.primary:disabled{opacity:.5;cursor:not-allowed}
label.filebtn{display:block;text-align:center;background:#0f172a;border:1px dashed var(--border);color:var(--text);margin-top:.5rem}
input[type=file]{display:none}
.warnbox{display:none;margin:.75rem 0 0;padding:.75rem .9rem;border-radius:10px;background:#78350f55;border:1px solid #b4530988;color:#fde68a;font-size:.85rem;line-height:1.45}
.errbox{display:none;margin:.75rem 0;padding:.75rem .9rem;border-radius:10px;background:#7f1d1d55;border:1px solid #b91c1c88;color:#fecaca;font-size:.85rem;line-height:1.45}
.waitbox{padding:1rem;border-radius:14px;background:#1e3a8a33;border:1px solid #3b82f688;text-align:center;margin-bottom:1rem}
.waitbox strong{display:block;margin-bottom:.35rem}
.muted{color:var(--muted);font-size:.85rem;line-height:1.45}
.status{margin-top:.75rem;font-size:.85rem;color:var(--muted);min-height:1.2em;text-align:center}
a.ghost{display:block;text-align:center;margin-top:1rem;color:var(--muted);font-size:.85rem}
.check{display:flex;gap:.55rem;align-items:flex-start;margin:.75rem 0;font-size:.85rem;color:var(--muted);line-height:1.4}
.check input{margin-top:.2rem}
.shot-prompt{margin:1rem 0;padding:1rem 1.1rem;border-radius:14px;background:linear-gradient(135deg,#14532d55,#0f172a);border:1px solid #22c55e88;text-align:center}
.shot-prompt strong{display:block;font-size:1.05rem;line-height:1.35;margin-bottom:.35rem;color:#86efac}
.shot-prompt p{margin:0;color:var(--muted,#93a0b8);font-size:.85rem;line-height:1.45}
.qrbox{display:none;gap:.75rem;margin:.85rem 0 1rem;flex-wrap:wrap;justify-content:center}
.qrbox.show{display:flex}
.qritem{flex:1 1 140px;max-width:200px;text-align:center;background:#121a2b;border:1px solid var(--border);border-radius:12px;padding:.65rem .5rem .75rem}
.qritem img{width:100%;max-width:168px;height:auto;aspect-ratio:1;background:#fff;border-radius:8px;display:block;margin:0 auto .45rem}
.qritem .qrlbl{font-size:.72rem;color:var(--muted);line-height:1.35;font-weight:600}
.qrhint{font-size:.8rem;color:var(--muted);margin:.15rem 0 .5rem;line-height:1.4;text-align:center}
.openbank{display:none;margin:.85rem 0 1rem}
.openbank.show{display:block}
button.cta{width:100%;border:0;border-radius:12px;padding:.9rem 1rem;font:inherit;font-weight:800;font-size:1rem;cursor:pointer;
background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 8px 24px #1d4ed855}
button.cta:active{transform:scale(.99)}
.bankpicker{display:none;margin-top:.65rem;padding:.75rem;border-radius:14px;background:#0f172a;border:1px solid var(--border)}
.bankpicker.open{display:block}
.bankgroup{margin:0 0 .75rem}.bankgroup:last-child{margin-bottom:0}
.bankgroup-title{font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 .45rem;font-weight:700}
.banklist{display:flex;flex-wrap:wrap;gap:.4rem}
button.bankbtn{flex:1 1 140px;border:1px solid var(--border);background:#121a2b;color:var(--text);border-radius:10px;
padding:.55rem .65rem;font:inherit;font-size:.82rem;font-weight:650;cursor:pointer;text-align:left;line-height:1.3}
button.bankbtn.primary{border-color:#3b82f688;background:#1e3a8a44}
button.bankbtn small{display:block;color:var(--muted);font-weight:500;font-size:.7rem;margin-top:.15rem}
.limits{font-size:.72rem;color:var(--muted);line-height:1.45;margin:.55rem 0 0}
.openstatus{font-size:.8rem;color:var(--ok);min-height:1.1em;margin:.4rem 0 0;text-align:center}
@media(max-width:640px){button.copy{padding:1rem;font-size:1.05rem;min-height:52px}.qrbox{margin:.4rem 0 .8rem}.qritem{max-width:46%;padding:.4rem}.qritem img{max-width:150px}.timer{margin:.3rem 0}.sub{font-size:.85rem}}
</style>
<link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head>
<body>
<div class="wrap"><div class="card">
  <div class="badge warn" id="badge">Načítavam…</div>
  <h1>Bankový prevod (SEPA)</h1>
  <p class="sub">Po zobrazení údajov odošlite <strong>presnú sumu</strong> a do správy pre prijímateľa vložte <strong>poznámku presne</strong>. Pred potvrdením urobte screenshot (poznámka musí byť viditeľná).</p>

  <div class="timer" id="timer">—:—:—</div>

  <div class="waitbox" id="waitBox" style="display:${ssrReady ? 'none' : 'block'}">
    <strong>Čakáme na platobné údaje</strong>
    <p class="muted" style="margin:0">Stránka sa automaticky aktualizuje, keď budú údaje pripravené.</p>
  <p class="muted" id="waitPollHint" style="margin:.5rem 0 0;font-size:.78rem">Kontrolujem stav…</p>
  </div>

  <div class="errbox" id="errBox"></div>

  <div class="bankbox" id="bankBox" style="display:${ssrReady ? 'block' : 'none'}">
    <h2>Údaje na prevod</h2>
    <p class="qrhint" id="qrHint" style="display:${ssrReady && (qrSpdSrc || qrEpcSrc) ? 'block' : 'none'}">Alebo naskenujte QR v bankovej appke (IBAN, suma a poznámka sa predvyplnia).</p>
    <div class="qrbox${ssrReady && (qrSpdSrc || qrEpcSrc) ? ' show' : ''}" id="qrBox">
      <div class="qritem" id="qrSpdWrap" style="display:${qrSpdSrc ? 'block' : 'none'}">
        <img id="qrSpd" src="${qrSpdSrc}" alt="QR pre SK/CZ banky" width="168" height="168"/>
        <div class="qrlbl">QR pre SK/CZ banky</div>
      </div>
      <div class="qritem" id="qrEpcWrap" style="display:${qrEpcSrc ? 'block' : 'none'}">
        <img id="qrEpc" src="${qrEpcSrc}" alt="QR SEPA / Revolut / Wise" width="168" height="168"/>
        <div class="qrlbl">QR SEPA / Revolut / Wise</div>
      </div>
    </div>

    <div class="field"><label>Suma</label><div class="val" id="vAmount" data-copy-val="${ssrAmountNum}">${ssrAmount}</div><button type="button" class="copy" data-copy="vAmount">Kopírovať sumu</button></div>
    <div class="field"><label>IBAN</label><div class="val" id="vIban">${ssrIban}</div><button type="button" class="copy" data-copy="vIban">Kopírovať IBAN</button></div>
    <div class="field recipient" id="benefField" style="display:${ssrBenef ? 'block' : 'none'}"><label>Príjemca</label><div class="val" id="vBenef">${ssrBenef}</div><button type="button" class="copy" data-copy="vBenef">Kopírovať príjemcu</button></div>
    <div style="background:#fee2e2;border:2px solid #dc2626;color:#991b1b;border-radius:10px;padding:12px;margin:10px 0;font-weight:700">⚠️ Tieto údaje platia len pre túto objednávku. Pri ďalšej platbe si vždy vytvor novú objednávku a neposielaj na staré údaje.</div>
    <div class="field note" id="noteField">
      <label>Poznámka / Payment note</label>
      <div class="val" id="vNote">${ssrNote}</div>
      <p class="notewarn">⚠ SK: Túto poznámku vložte do správy pre prijímateľa <em>presne</em> (znak po znaku). Je povinná — bez nej platbu nevieme overiť.<br/>EN: Enter this note in the payment reference / message to recipient <em>exactly</em>. It is mandatory — we use it to verify your payment.</p>
      <button type="button" class="copy" data-copy="vNote">Kopírovať poznámku / Copy note</button>
    </div>
    <div class="field" id="vsField" style="display:${ssrVs ? 'block' : 'none'}"><label>VS (voliteľné)</label><div class="val" id="vVs">${ssrVs}</div><button type="button" class="copy" data-copy="vVs">Kopírovať VS</button></div>
    <div class="val" id="vRef" hidden>${ssrRef}</div>

    <div class="openbank${ssrReady && ssrBankOpen ? ' show' : ''}" id="openBankBox">
      <button type="button" class="cta" id="openBankCta">Otvoriť v bankovej appke</button>
      <div class="bankpicker" id="bankPicker"></div>
      <p class="openstatus" id="openStatus"></p>
      <p class="limits" id="openLimits"></p>
    </div>

    ${order.guided ? `<div class="warnbox" style="display:block;border-color:#22c55e">
      <strong>Po zaplatení nahrajte doklad na electrocoin.eu</strong>
      <p class="muted" style="margin:.35rem 0">Otvorte objednávku z emailu od Electrocoin → <b>I have paid!</b> → <b>Confirm</b> → <b>Select a file</b> (screenshot/PDF z banky) → <b>Confirm</b>. My ho za vás nenahrávame.</p>
      <img src="/guides/electrocoin/ec-upload-steps.png" alt="Electrocoin upload" style="max-width:100%;border-radius:10px"/>
      <p class="muted" style="margin:.35rem 0 0">Kópiu môžete nahrať aj nižšie (pre našu evidenciu).</p>
    </div>` : ''}
    <div id="chainStatus"></div><script src="/chain-status.js" defer></script>
    <div class="warnbox" id="warnShot" style="display:block">
      <strong>Pred tlačidlom „Zaplatené“:</strong> urobte screenshot potvrdenia z banky tak, aby bola <em>viditeľná referencia / správa pre príjemcu</em>.
    </div>

    <div class="check">
      <input type="checkbox" id="shotConfirm" />
      <label for="shotConfirm">Potvrdzujem, že mám screenshot platby s viditeľnou referenciou.</label>
    </div>

    <label class="filebtn" id="fileLabel">Nahrať screenshot platby<input type="file" id="shotFile" accept="image/*,.pdf" /></label>
    <button type="button" class="primary" id="paidBtn" disabled>Zaplatené — odoslať screenshot</button>
  </div>

  <div class="warnbox" style="display:block;margin-top:.75rem">
    <strong>Screenshot nahrajte iba tu na stránke</strong>
    <p class="muted" style="margin:.35rem 0 0">Neposielajte fotku cez Messenger ani Telegram — len upload vyššie (prípadne to doplní admin).</p>
  </div>

  <div class="row"><span>Objednávka</span><strong>${safe(order.orderId)}</strong></div>
  ${((order.firstName||'') + ' ' + (order.lastName||'')).trim() ? `<div class="row"><span>Meno</span><strong>${safe((order.firstName||'') + ' ' + (order.lastName||''))}</strong></div>` : ''}
  <div class="status" id="upStatus"></div>
  <a class="ghost" href="/platby">← Späť na platby</a>
</div></div>
<script>
  const orderId = ${JSON.stringify(order.orderId)};
  let bankOpen = ${ssrBankOpenJson};
  const badge = document.getElementById('badge');
  const timerEl = document.getElementById('timer');
  const waitBox = document.getElementById('waitBox');
  const bankBox = document.getElementById('bankBox');
  const errBox = document.getElementById('errBox');
  const paidBtn = document.getElementById('paidBtn');
  const shotConfirm = document.getElementById('shotConfirm');
  const shotFile = document.getElementById('shotFile');
  const upStatus = document.getElementById('upStatus');
  let deadlineAt = ${ssrDeadline} ? Date.parse(${ssrDeadline}) : null;
  let bankReady = ${ssrReady ? 'true' : 'false'};
  let waitPolls = 0;

  function setBadge(text, cls) {
    badge.textContent = text;
    badge.className = 'badge' + (cls ? ' ' + cls : '');
  }
  function tick() {
    if (!deadlineAt) { timerEl.textContent = '—:—:—'; return requestAnimationFrame(() => setTimeout(tick, 400)); }
    const left = deadlineAt - Date.now();
    if (left <= 0) {
      timerEl.textContent = '00:00:00';
      timerEl.classList.add('expired');
      return;
    }
    const s = Math.floor(left / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    timerEl.textContent = h + ':' + m + ':' + sec;
    requestAnimationFrame(() => setTimeout(tick, 250));
  }
  tick();

  function rawCopyValue(id, el) {
    const raw = el ? (el.getAttribute('data-copy-val') || el.textContent || '') : '';
    const t = String(raw).trim();
    if (id === 'vIban') return t.replace(/\s+/g, '').toUpperCase();
    if (id === 'vAmount') {
      const m = t.replace(',', '.').match(/\d+(?:\.\d{1,2})?/);
      return m ? m[0] : t.replace(/[^\d.]/g, '');
    }
    // note, beneficiary, vs — exact value only
    return t;
  }
  document.querySelectorAll('button.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-copy');
      const el = document.getElementById(id);
      const text = rawCopyValue(id, el);
      const orig = btn.textContent;
      try { await navigator.clipboard.writeText(text); btn.textContent = 'Skopírované'; }
      catch { btn.textContent = 'Skopírujte ručne'; }
      setTimeout(() => { btn.textContent = orig; }, 1200);
    });
  });

  function syncPaidEnabled() {
    paidBtn.disabled = !(bankReady && shotConfirm.checked && shotFile.files && shotFile.files[0]);
  }
  shotConfirm.addEventListener('change', syncPaidEnabled);
  shotFile.addEventListener('change', () => {
    const f = shotFile.files && shotFile.files[0];
    document.getElementById('fileLabel').textContent = f ? ('Súbor: ' + f.name + ' (zmeniť)') : 'Nahrať screenshot platby';
    if (f) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.id = 'shotFile'; inp.accept = 'image/*,.pdf';
      // keep same handler by re-query — simpler: just update label child
    }
    syncPaidEnabled();
  });


  const openBankBox = document.getElementById('openBankBox');
  const openBankCta = document.getElementById('openBankCta');
  const bankPicker = document.getElementById('bankPicker');
  const openStatus = document.getElementById('openStatus');
  const openLimits = document.getElementById('openLimits');

  function setOpenStatus(msg) {
    if (openStatus) openStatus.textContent = msg || '';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch { return false; }
    }
  }

  function openRevolutApp(bank) {
    const scheme = (bank && bank.openScheme) || 'revolut://';
    const https = (bank && bank.openHttps) || 'https://revolut.com/app';
    try {
      const start = Date.now();
      window.location.href = scheme;
      setTimeout(function () {
        // If still visible after ~1.2s, scheme likely failed — HTTPS fallback.
        if (Date.now() - start < 1600 && !document.hidden) {
          window.location.href = https;
        }
      }, 1200);
    } catch (_) {
      window.location.href = https;
    }
  }

  async function runBankAction(bank) {
    if (!bankOpen || !bank) return;
    const action = bank.action;
    if (action === 'payme') {
      if (!bankOpen.paymeUrl) {
        setOpenStatus('Payme odkaz nie je dostupný — použite QR.');
        return;
      }
      setOpenStatus('Otváram payme.sk (SK banková appka)…');
      window.location.href = bankOpen.paymeUrl;
      return;
    }
    if (action === 'revolut') {
      const ok = await copyText(bankOpen.copyText || '');
      const epcWrap = document.getElementById('qrEpcWrap');
      if (epcWrap && epcWrap.style.display !== 'none') {
        try {
          epcWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
          epcWrap.style.outline = '2px solid #2d6cdf';
          epcWrap.style.outlineOffset = '4px';
          setTimeout(function () {
            epcWrap.style.outline = '';
            epcWrap.style.outlineOffset = '';
          }, 3500);
        } catch (_) {}
      }
      setOpenStatus(ok
        ? 'Údaje skopírované, otváram Revolut — doplňte IBAN/sumu/PURPOSE alebo naskenujte QR.'
        : 'Otváram Revolut — doplňte IBAN/sumu/PURPOSE alebo naskenujte QR.');
      openRevolutApp(bank);
      return;
    }
    setOpenStatus('Neznáma akcia — použite QR.');
  }

  function renderBankPicker() {
    if (!bankPicker || !bankOpen || !bankOpen.banks) return;
    if (openLimits) openLimits.textContent = bankOpen.limitsSk || '';
    const groups = [
      { region: 'sk', title: 'Slovensko — payme' },
      { region: 'eu', title: 'Revolut' },
    ];
    bankPicker.innerHTML = groups.map((g) => {
      const banks = bankOpen.banks.filter((b) => b.region === g.region);
      if (!banks.length) return '';
      return '<div class="bankgroup"><div class="bankgroup-title">' + g.title + '</div><div class="banklist">' +
        banks.map((b) => {
          const cls = 'bankbtn' + (b.primary ? ' primary' : '');
          const sub = b.subtitle ? '<small>' + b.subtitle + '</small>' : '';
          return '<button type="button" class="' + cls + '" data-bank="' + b.id + '">' + b.label + sub + '</button>';
        }).join('') +
        '</div></div>';
    }).join('');
    bankPicker.querySelectorAll('button.bankbtn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-bank');
        const bank = bankOpen.banks.find((x) => x.id === id);
        runBankAction(bank);
      });
    });
  }

  function showOpenBank(payload) {
    bankOpen = payload || null;
    if (!openBankBox) return;
    try {
      const hasCtas = bankOpen && Array.isArray(bankOpen.banks) && bankOpen.banks.length > 0;
      if (hasCtas) {
        openBankBox.classList.add('show');
        openBankBox.style.display = 'block';
        renderBankPicker();
      } else {
        openBankBox.classList.remove('show');
        openBankBox.style.display = 'none';
      }
    } catch (_) {
      // CTA optional — keep copyable bank fields only
      bankOpen = null;
      openBankBox.classList.remove('show');
      openBankBox.style.display = 'none';
    }
  }

  if (openBankCta) {
    openBankCta.addEventListener('click', () => {
      if (!bankOpen) {
        setOpenStatus('Bankové údaje ešte nie sú pripravené.');
        return;
      }
      if (!bankPicker) return;
      const opening = !bankPicker.classList.contains('open');
      bankPicker.classList.toggle('open', opening);
      if (opening) {
        renderBankPicker();
        // One-tap default: SK payme if available
        const primary = bankOpen.banks && bankOpen.banks.find((b) => b.id === 'payme' && bankOpen.paymeUrl);
        if (primary && /iPhone|iPad|Android/i.test(navigator.userAgent || '')) {
          // On mobile, expand picker; user picks. Don't auto-navigate (avoid surprise).
          setOpenStatus('Vyberte: SK payme alebo Revolut.');
        }
      }
    });
  }
  if (bankOpen) {
    try { showOpenBank(bankOpen); }
    catch (_) { showOpenBank(null); }
  }

  // If SSR already embedded QR data URLs, do not re-fetch; wire silent onerror hide.
  (function initSsrQr() {
    const spd = document.getElementById('qrSpd');
    const epc = document.getElementById('qrEpc');
    const box = document.getElementById('qrBox');
    const hint = document.getElementById('qrHint');
    const spdWrap = document.getElementById('qrSpdWrap');
    const epcWrap = document.getElementById('qrEpcWrap');
    const hasSsr = (spd && spd.getAttribute('src') && String(spd.getAttribute('src')).startsWith('data:'))
      || (epc && epc.getAttribute('src') && String(epc.getAttribute('src')).startsWith('data:'));
    if (hasSsr) window.__sepaQrTried = true;
    function hideEmpty() {
      const spdOk = spdWrap && spdWrap.style.display !== 'none' && spd && spd.getAttribute('src');
      const epcOk = epcWrap && epcWrap.style.display !== 'none' && epc && epc.getAttribute('src');
      if (!spdOk && !epcOk) {
        if (box) { box.classList.remove('show'); box.style.display = 'none'; }
        if (hint) hint.style.display = 'none';
      }
    }
    [[spd, spdWrap], [epc, epcWrap]].forEach(function (pair) {
      const img = pair[0], wrap = pair[1];
      if (!img) return;
      img.onerror = function () {
        img.removeAttribute('src');
        if (wrap) wrap.style.display = 'none';
        hideEmpty();
      };
    });
  })();

  async function poll() {
    try {
      const res = await fetch('/api/bank-sepa/' + encodeURIComponent(orderId));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Chyba stavu');
      if (data.deadlineAt) deadlineAt = Date.parse(data.deadlineAt);

      if (data.status === 'automation_failed') {
        waitBox.style.display = 'none';
        bankBox.style.display = 'none';
        errBox.style.display = 'block';
        errBox.textContent = data.automationError || 'Dočasne nedostupné. Skúste neskôr alebo iný spôsob platby.';
        setBadge('Nedostupné', 'danger');
        return;
      }

      if (data.bankDetailsPublic && data.bank && data.bank.iban) {
        bankReady = true;
        waitBox.style.display = 'none';
        errBox.style.display = 'none';
        bankBox.style.display = 'block';
        const benef = data.bank.beneficiary || '';
        const vBenef = document.getElementById('vBenef');
        if (vBenef) vBenef.textContent = benef;
        const benefField = document.getElementById('benefField');
        if (benefField) benefField.style.display = benef ? 'block' : 'none';
        document.getElementById('vIban').textContent = data.bank.iban || '';
        const amt = data.bank.amountExact || data.amountExact || '';
        const vAmt = document.getElementById('vAmount');
        if (vAmt) { vAmt.textContent = amt ? (amt + ' EUR') : ''; vAmt.setAttribute('data-copy-val', amt); }
        const note = data.bank.paymentNote || data.paymentNote || data.bank.purpose || data.purpose || '';
        const vNote = document.getElementById('vNote');
        if (vNote) vNote.textContent = note;
        const vRef = document.getElementById('vRef');
        if (vRef) vRef.textContent = note;
        const vs = data.bank.vs || data.vs || '';
        const vVs = document.getElementById('vVs');
        const vsField = document.getElementById('vsField');
        if (vVs) vVs.textContent = vs;
        if (vsField) vsField.style.display = vs ? 'block' : 'none';
        (function showQrOnce() {
          // One attempt only — never retry QR in the poll loop. On failure hide QR silently.
          if (window.__sepaQrTried) return;
          window.__sepaQrTried = true;
          const spd = document.getElementById('qrSpd');
          const epc = document.getElementById('qrEpc');
          const box = document.getElementById('qrBox');
          const hint = document.getElementById('qrHint');
          const spdWrap = document.getElementById('qrSpdWrap');
          const epcWrap = document.getElementById('qrEpcWrap');
          function hideQrUiIfEmpty() {
            const spdOk = spdWrap && spdWrap.style.display !== 'none' && spd && spd.getAttribute('src');
            const epcOk = epcWrap && epcWrap.style.display !== 'none' && epc && epc.getAttribute('src');
            if (!spdOk && spdWrap) spdWrap.style.display = 'none';
            if (!epcOk && epcWrap) epcWrap.style.display = 'none';
            if (!spdOk && !epcOk) {
              if (box) { box.classList.remove('show'); box.style.display = 'none'; }
              if (hint) hint.style.display = 'none';
            }
          }
          function bindFail(img, wrap) {
            if (!img) return;
            img.onerror = function () {
              img.removeAttribute('src');
              if (wrap) wrap.style.display = 'none';
              hideQrUiIfEmpty();
            };
          }
          const needFetch = (img) => !img || !img.getAttribute('src') || !String(img.getAttribute('src')).startsWith('data:');
          let any = false;
          if (spd && needFetch(spd)) {
            spd.src = '/api/bank-sepa/' + encodeURIComponent(orderId) + '/qr/spd.png';
            if (spdWrap) spdWrap.style.display = 'block';
            any = true;
          } else if (spd && spd.getAttribute('src')) {
            if (spdWrap) spdWrap.style.display = 'block';
            any = true;
          }
          if (epc && needFetch(epc)) {
            epc.src = '/api/bank-sepa/' + encodeURIComponent(orderId) + '/qr/epc.png';
            if (epcWrap) epcWrap.style.display = 'block';
            any = true;
          } else if (epc && epc.getAttribute('src')) {
            if (epcWrap) epcWrap.style.display = 'block';
            any = true;
          }
          bindFail(spd, spdWrap);
          bindFail(epc, epcWrap);
          if (any) {
            if (box) { box.classList.add('show'); box.style.display = 'flex'; }
            if (hint) hint.style.display = 'block';
          } else {
            hideQrUiIfEmpty();
          }
        })();
        try {
          if (data.bankOpen) showOpenBank(data.bankOpen);
          else showOpenBank(null);
        } catch (_) { showOpenBank(null); }
        setBadge(data.screenshotUploadedAt ? 'Screenshot odoslaný' : 'Čaká na prevod', data.screenshotUploadedAt ? '' : 'warn');
        syncPaidEnabled();
        if (data.screenshotUploadedAt || data.status === 'awaiting_confirm' || data.status === 'screenshot_uploaded') {
          setBadge('Screenshot prijatý', '');
          upStatus.textContent = 'Ďakujeme. Screenshot bol odoslaný — čakáme na potvrdenie platby.';
          if (waitBox) waitBox.style.display = 'none';
        }
        if (data.electrocoinProofUpload && data.electrocoinProofUpload.ok) {
          setBadge('Potvrdené u príjemcu', '');
          upStatus.textContent = 'Ďakujeme. Screenshot bol prijatý a odoslaný príjemcovi.';
          if (waitBox) waitBox.style.display = 'none';
        }
        // Proof-check verdict statuses (SEPA bot chain)
        if (data.status === 'proof_pending_review' || data.status === 'uploading_proof') {
          setBadge('Doklad na overení', 'warn');
          upStatus.textContent = (data.statusMessage || 'Doklad odoslaný — čakáme na verdikt bota.');
          if (waitBox) waitBox.style.display = 'none';
          setTimeout(poll, 4000);
          return;
        }
        if (data.status === 'proof_unverified') {
          setBadge('Čaká na manuálnu kontrolu', 'warn');
          upStatus.textContent = (data.statusMessage || 'Doklad neoverený – čaká na manuálnu kontrolu.');
          if (waitBox) waitBox.style.display = 'none';
        }
        if (data.status === 'proof_rejected') {
          setBadge('Doklad zamietnutý', 'danger');
          upStatus.textContent = (data.statusMessage || 'Doklad zamietnutý. Skontrolujte údaje a skúste znova.');
          if (waitBox) waitBox.style.display = 'none';
          paidBtn.disabled = false;
          syncPaidEnabled();
        }
        if (data.status === 'confirmed' || data.status === 'paid') {
          setBadge('Potvrdené', '');
          upStatus.textContent = data.statusMessage || 'Platba potvrdená';
          if (waitBox) waitBox.style.display = 'none';
        }
      } else if (data.screenshotUploadedAt || data.status === 'awaiting_confirm' || data.status === 'proof_pending_review' || data.status === 'proof_unverified' || data.status === 'proof_rejected' || data.status === 'paid') {
        bankReady = true;
        if (waitBox) waitBox.style.display = 'none';
        if (data.status === 'paid' || data.status === 'confirmed') {
          setBadge('Potvrdené', '');
          upStatus.textContent = data.statusMessage || 'Platba potvrdená';
        } else if (data.status === 'proof_rejected') {
          setBadge('Doklad zamietnutý', 'danger');
          upStatus.textContent = data.statusMessage || 'Doklad zamietnutý';
        } else if (data.status === 'proof_pending_review') {
          setBadge('Doklad na overení', 'warn');
          upStatus.textContent = data.statusMessage || 'Čakáme na verdikt…';
          setTimeout(poll, 4000);
        } else {
          setBadge('Screenshot prijatý', '');
          upStatus.textContent = data.statusMessage || 'Ďakujeme. Screenshot bol odoslaný — čakáme na potvrdenie platby.';
        }
        return;
      } else {
        setBadge('Pripravujeme údaje…', 'warn');
        // Soft poll + full page reload so mobile browsers always pick up bank details
        if (!window.__sepaWaitStarted) window.__sepaWaitStarted = Date.now();
        const waited = Date.now() - window.__sepaWaitStarted;
        if (waited > 12000 && waited % 15000 < 3500) {
          location.reload();
          return;
        }
        setTimeout(poll, 2500);
        return;
      }
      if (!data.screenshotUploadedAt && data.status === 'awaiting_payment') {
        setTimeout(poll, 8000);
      }
    } catch (e) {
      upStatus.textContent = e.message;
      setTimeout(poll, 2500);
    }
  }
  poll();
  // Hard auto-refresh while waiting (mobile-friendly); stops once bank box is shown
  setInterval(() => {
    if (!bankReady && waitBox && waitBox.style.display !== 'none') {
      location.reload();
    }
  }, 15000);

  paidBtn.addEventListener('click', async () => {
    if (paidBtn.disabled) return;
    if (!shotConfirm.checked) {
      upStatus.textContent = 'Najprv potvrďte, že máte screenshot s referenciou.';
      return;
    }
    const file = shotFile.files && shotFile.files[0];
    if (!file) {
      upStatus.textContent = 'Nahrajte screenshot platby.';
      return;
    }
    paidBtn.disabled = true;
    upStatus.textContent = 'Odosielam screenshot…';
    try {
      const fd = new FormData();
      fd.append('screenshot', file);
      fd.append('confirmed', '1');
      const res = await fetch('/api/bank-sepa/' + encodeURIComponent(orderId) + '/screenshot', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload zlyhal');
      upStatus.textContent = data.message
        || (data.electrocoinProofUpload && data.electrocoinProofUpload.ok
          ? 'Hotovo — screenshot uložený a odoslaný príjemcovi.'
          : 'Screenshot uložený. Dokončujeme potvrdenie…');
      if (data.status === 'proof_pending_review' || (data.chainProof && data.chainProof.verdict === 'pending')) {
        setBadge('Doklad na overení', 'warn');
      } else {
        setBadge('Screenshot odoslaný', '');
      }
      poll();
    } catch (e) {
      upStatus.textContent = e.message;
      paidBtn.disabled = false;
      syncPaidEnabled();
    }
  });
</script>
<script src="/chat-widget.js" defer></script><script src="/proof-form.js" defer></script></body>
</html>`);
}


app.get('/onramp-bridge', onrampBridgePage);
app.get('/switchere-pay', switcherePayPage);

async function guardarianPayPage(req, res) {
  const orderId = String(req.query.orderId || '');
  const o = loadOrders()[orderId];
  if (!o || !['guardarian_revolut', 'mtpelerin', 'meld', 'keyless'].includes(o.provider)) return res.status(404).send('Objednávka sa nenašla');
  // 🪙 admin per-method coin choice (o.coins set at checkout): show only those coins' addresses, each with a copy button
  const coinSel = Array.isArray(o.coins);
  const coinBlock = coinSel ? methodCoins.html(await methodCoins.ensure(o, o.coins, { loadOrders, saveOrders, log: appendLog }).catch(() => []), { amountEur: o.amountEur }) : '';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pName = o.providerName || { mtpelerin: 'Mt Pelerin', meld: 'Meld' }[o.provider] || 'Guardarian';
  const methodLabel = o.provider === 'mtpelerin' ? 'kartou / bankou (Mt Pelerin)' : o.provider === 'meld' ? 'cez Meld' : o.provider === 'keyless' ? `cez ${o.providerName}` : { card: 'kartou Revolut', revolut_pay: 'Revolut Pay', apple_pay: 'Apple Pay', google_pay: 'Google Pay' }[o.paymentMethod] || 'kartou';
  const state = req.query.done ? '<p class="ok">✅ Platba odoslaná. Krypto príde na adresu nižšie po potvrdení.</p>'
    : req.query.failed ? '<p class="err">❌ Platba zlyhala. Skúste znova.</p>'
    : req.query.cancelled ? '<p class="err">Platba zrušená.</p>' : '';
  const locked = o.lockedWallet;
  const linkOnly = o.customMethod && o.customMode === 'link';
  const instr = o.customMethod && o.customInstructions ? `<div class="box"><b>Pokyny</b><div style="margin-top:6px;white-space:pre-line">${esc(o.customInstructions)}</div></div>` : '';
  res.type('html').send(`<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Platba ${esc(methodLabel)}</title><style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
.row{display:flex;gap:8px;align-items:center}.row code{flex:1;word-break:break-all;background:#f5f5f5;padding:8px;border-radius:8px}
button,.btn{background:#8b5cf6;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-size:15px;cursor:pointer;text-decoration:none;display:inline-block}
.btn{width:100%;text-align:center;box-sizing:border-box;padding:14px;margin-top:8px}.ok{color:#15803d}.err{color:#b91c1c}small{color:#555}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body>
<h2>Platba ${esc(methodLabel)}</h2>${state}
<div class="box"><div>Suma</div><div class="cprow"><code id="amt" style="font-size:20px">${esc(o.amountEur)}</code><span class="unit">EUR</span><button class="big" data-cp="amt">Kopírovať sumu</button></div>
${coinSel ? '</div>' + coinBlock : linkOnly ? '</div>' : `<div style="margin-top:6px">Mena: <b>${esc(o.payoutCurrency)}</b> · sieť: <b>${o.payoutCurrency === 'BTC' ? 'Bitcoin' : esc(o.payoutCurrency)}</b></div></div>
<div class="box"><div>${locked ? 'Adresa (už predvyplnená):' : `<b>${esc(o.payoutCurrency)} adresa</b> — skopírujte a vložte ju u ${esc(pName)}:`}</div>
<code id="addr" style="display:block;font-size:16px;margin:8px 0;word-break:break-all;background:#f5f5f5;padding:8px;border-radius:8px">${esc(o.payoutAddress)}</code>
<button class="big" style="width:100%;padding:16px;font-size:17px" data-cp="addr">📋 Kopírovať adresu</button></div>`}
${instr}
${locked || linkOnly || o.customMethod ? '' : o.provider === 'mtpelerin' ? `<div class="box"><small><b>U ${pName} je už všetko vyplnené:</b> suma <b>${esc(o.amountEur)} EUR</b>, mena <b>${esc(o.payoutCurrency)}</b> aj adresa – nič nemeňte a stlačte „Buy“. E-mail / telefón a overenie (KYC) zadáte priamo u ${pName}.<br><span style="opacity:.75">Amount, coin and address are prefilled at ${pName} – change nothing, just tap “Buy”.</span></small></div>` : `<div class="box"><small><b>U ${pName} urobíte:</b> 1) zvoľte <b>EUR → ${esc(o.payoutCurrency)}</b>, 2) zadajte sumu <b>${esc(o.amountEur)} EUR</b>, 3) vložte skopírovanú adresu, 4) zvoľte platbu <b>${esc(methodLabel)}</b>, 5) e-mail a overenie (KYC) zadáte priamo u ${pName}.</small></div>`}
${o.customMethod && !linkOnly ? `<div class="box"><small><b>Postup:</b> 1) zadajte sumu <b>${esc(o.amountEur)} EUR</b>, 2) ak sa pýta adresa, vložte skopírovanú ${coinSel ? '' : 'BTC '}adresu, 3) dokončite platbu podľa pokynov poskytovateľa.</small></div>` : ''}
<script>function cp(id,b){navigator.clipboard.writeText(document.getElementById(id).textContent.trim()).then(function(){var o=b.textContent;b.textContent='✅ Skopírované';setTimeout(function(){b.textContent=o},1500)})}</script>
<a class="btn" href="${esc(o.providerCheckoutUrl)}" target="_blank" rel="noopener">Pokračovať na ${esc(pName)}</a>
${o.provider === 'mtpelerin' ? guideStore.html('mtpelerin', { amount: o.amountEur, coin: o.payoutCurrency }) : ''}
<p><small>${o.customMethod ? '' : `Overenie totožnosti (KYC) robí ${pName} priamo s vami. `}Objednávka ${esc(o.orderId)}</small></p>
${linkOnly ? '' : `<div id="chainStatus" data-order-id="${esc(o.orderId)}"></div><script src="/chain-status.js" defer></script>`}
${o.customMethod && o.proofForm !== false ? '<div id="proofSlot"></div><script src="/proof-form.js" defer></script>' : ''}
</body></html>`);
}
app.get('/guardarian-pay', (req, res) => guardarianPayPage(req, res).catch((e) => { appendLog('GUARDARIAN_PAY_PAGE_FAIL ' + e.message); if (!res.headersSent) res.status(500).send('Chyba'); }));

app.get('/api/storage/status', async (_req, res) => {
  res.json({ db: await orderDb.status(), proofs: await proofStore.check() });
});

function revolutPayLink(o) {
  // revolut.me has no documented prefill; ?amount=&currency= is community-reported and ignored if unsupported
  const u = new URL(`https://revolut.me/${encodeURIComponent(o.revtag)}`);
  u.searchParams.set('amount', String(o.amountEur));
  u.searchParams.set('currency', 'EUR');
  return u.toString();
}
app.get('/api/revolut/:orderId', (req, res) => {
  const o = loadOrders()[String(req.params.orderId)];
  if (!o || o.provider !== 'revolut_manual') return res.status(404).json({ error: 'Objednávka sa nenašla' });
  res.set('Cache-Control', 'no-store');
  res.json({ orderId: o.orderId, amountEur: o.amountEur, paymentNote: o.paymentNote, status: o.status,
    revtag: o.revtag || null, payUrl: o.revtag ? revolutPayLink(o) : null, paidMarkedAt: o.paidMarkedAt || null });
});
app.post('/api/revolut/:orderId/paid', async (req, res) => {
  const orders = loadOrders(); const o = orders[String(req.params.orderId)];
  if (!o || o.provider !== 'revolut_manual') return res.status(404).json({ error: 'Objednávka sa nenašla' });
  if (!o.revtag) return res.status(409).json({ error: 'Platobné údaje ešte nie sú pripravené' });
  const first = !o.paidMarkedAt;
  if (first) { o.paidMarkedAt = new Date().toISOString(); o.status = 'paid_marked'; saveOrders(orders); appendLog(`REVOLUT_PAID_MARKED ${o.orderId}`);
    try { if (global.__telegramBot) await global.__telegramBot.notifyRevolutPaid(o); } catch (e) { appendLog(`TELEGRAM_REVOLUT_PAID_FAIL ${o.orderId} ${e.message}`); } }
  res.json({ ok: true, status: o.status, alreadyMarked: !first });
});
app.get('/revolut-pay', async (req, res) => {
  const o = loadOrders()[String(req.query.orderId || '')];
  if (!o || o.provider !== 'revolut_manual') return res.status(404).send('Objednávka sa nenašla');
  const rvCoins = Array.isArray(o.coins) ? o.coins : payMethods.coinsFor(o.providerAlias || 'revolut_manual');
  const coinBlock = Array.isArray(rvCoins) && rvCoins.length ? methodCoins.html(await methodCoins.ensure(o, rvCoins, { loadOrders, saveOrders, log: appendLog }).catch(() => []), { title: 'Alebo zaplaťte kryptom', amountEur: o.amountEur }) : '';
  const id = JSON.stringify(o.orderId);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revolut platba</title><style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
code{display:block;word-break:break-all;background:#f5f5f5;padding:10px;border-radius:8px;font-size:18px;margin:8px 0}
button,.btn{background:#0666eb;color:#fff;border:0;border-radius:8px;padding:12px 14px;font-size:16px;cursor:pointer;text-decoration:none;display:inline-block}
.wide{width:100%;padding:16px;font-size:17px;box-sizing:border-box;text-align:center}.ok{background:#16a34a}.hint{background:#f0f9ff;border-color:#bae6fd}small{color:#555}
.spin{display:inline-block;width:18px;height:18px;border:3px solid #ccc;border-top-color:#0666eb;border-radius:50%;animation:s 1s linear infinite;vertical-align:middle}@keyframes s{to{transform:rotate(360deg)}}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body>
<h2>Revolut platba</h2>
<div id="wait" class="box"><span class="spin"></span> <b>Čakáme na platobné údaje</b><br><small>Stránka sa obnovuje automaticky, zvyčajne to trvá pár minút. Nechajte ju otvorenú.</small></div>
<div id="ready" style="display:none">
<div class="box"><div>Revtag príjemcu</div><code id="rt" style="font-size:24px"></code>
<button class="wide" data-cp="rt">📋 Kopírovať Revtag</button>
<div style="background:#fee2e2;border:2px solid #dc2626;color:#991b1b;border-radius:10px;padding:12px;margin:10px 0;font-weight:700">⚠️ Tento Revtag platí len pre túto objednávku. Pri ďalšej platbe si vždy vytvor novú objednávku a neposielaj na starý Revtag.</div></div>
<a id="open" class="btn wide" target="_blank" rel="noopener">Otvoriť v Revolut</a>
<div class="box"><div>Suma</div><div class="cprow"><code id="amt"></code><span class="unit">EUR</span><button data-cp="amt">Kopírovať sumu</button></div></div>
${guideStore.html('revolut_manual', { amount: o.amountEur, title: 'Návod – ako zaplatiť v Revolute' })}
<button id="paid" class="btn wide ok">Zaplatil som</button> <p id="pst"></p>
</div>${coinBlock}
<p><small>Objednávka ${o.orderId.replace(/[^a-z0-9_]/gi, '')}</small></p>
<script>
var ID=${id};
function cp(id,b){navigator.clipboard.writeText(document.getElementById(id).textContent.trim()).then(function(){var t=b.textContent;b.textContent='✅ Skopírované';setTimeout(function(){b.textContent=t},1500)})}
function show(j){document.getElementById('wait').style.display='none';document.getElementById('ready').style.display='block';
document.getElementById('rt').textContent='@'+j.revtag;document.getElementById('open').href=j.payUrl;
document.getElementById('amt').textContent=j.amountEur;
if(j.paidMarkedAt){document.getElementById('pst').textContent='✅ Ďakujeme, platbu overujeme.';document.getElementById('paid').disabled=true}}
var iv;function poll(){fetch('/api/revolut/'+encodeURIComponent(ID),{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(j.revtag){clearInterval(iv);show(j)}})}
poll();iv=setInterval(poll,5000);
document.getElementById('paid').addEventListener('click',function(){var b=this;b.disabled=true;fetch('/api/revolut/'+encodeURIComponent(ID)+'/paid',{method:'POST'}).then(function(r){return r.json()}).then(function(j){document.getElementById('pst').textContent=j.ok?'✅ Ďakujeme, platbu overujeme.':('❌ '+(j.error||'chyba'));if(!j.ok)b.disabled=false})});
</script><script src="/chat-widget.js" defer></script><script src="/proof-form.js" defer></script></body></html>`);
});



app.get('/api/btcpay/address-status', (req, res) => res.json(addressPool.btcpayStatus()));


app.get('/provider-pay', providerPayPage);
app.get('/onramper-pay', onramperPayPage);
app.get('/bank-sepa-pay', bankSepaPayPage);

app.get('/api/bank-sepa/:orderId', (req, res) => {
  const orders = loadOrders();
  const order = orders[req.params.orderId];
  if (!order || order.provider !== 'bank_sepa_manual') {
    return res.status(404).json({ error: 'not found' });
  }
  const view = sepaPublicView(order);
  view.bankOpen = null;
  if (view.bankDetailsPublic && view.bank && view.bank.iban) {
    try {
      const fields = sepaQr.fieldsFromBank(view.bank, { amountExact: view.amountExact, purpose: view.purpose || view.paymentNote, paymentNote: view.paymentNote || view.purpose, vs: view.vs, reference: view.reference });
      view.bankOpen = sepaQr.buildBankOpenPayload(fields);
    } catch (e) {
      appendLog('sepaQr bankOpen api skipped ' + req.params.orderId + ' ' + (e && e.message));
      view.bankOpen = null;
    }
  }
  res.json(view);
});

/** PNG QR for pay page — only when bankDetailsPublic (real IBAN). format=spd|epc */
app.get(['/api/bank-sepa/:orderId/qr/:format.png','/api/bank-sepa/:orderId/qr/:format'], async (req, res) => {
  try {
    const orders = loadOrders();
    const order = orders[req.params.orderId];
    if (!order || order.provider !== 'bank_sepa_manual') {
      return res.status(404).type('text').send('not found');
    }
    const view = sepaPublicView(order);
    if (!(view.bankDetailsPublic && view.bank && view.bank.iban)) {
      return res.status(404).type('text').send('bank details not ready');
    }
    const fmt = String(req.params.format || '').toLowerCase().replace(/\.png$/, '');
    const fields = sepaQr.fieldsFromBank(view.bank, { amountExact: view.amountExact, purpose: view.purpose || view.paymentNote, paymentNote: view.paymentNote || view.purpose, vs: view.vs, reference: view.reference });
    let payload = null;
    if (fmt === 'spd') payload = sepaQr.buildSpdPayload(fields);
    else if (fmt === 'epc') payload = sepaQr.buildEpcPayload(fields);
    else return res.status(404).type('text').send('unknown format');
    if (!payload) return res.status(404).type('text').send('cannot build qr');
    const buf = await sepaQr.toPngBuffer(payload, { width: 320 });
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.type('png').send(buf);
  } catch (e) {
    appendLog('sepaQr png failed ' + req.params.orderId + ' ' + (e && e.message));
    res.status(500).type('text').send('qr error');
  }
});

function readMultipartScreenshot(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType.includes('multipart/form-data')) {
      // JSON base64 fallback
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 20_000_000) reject(new Error('too large')); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          if (!j.dataBase64) return reject(new Error('Chýba screenshot'));
          const buf = Buffer.from(String(j.dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
          resolve({ buffer: buf, filename: j.filename || 'screenshot.png', confirmed: j.confirmed });
        } catch (e) { reject(e); }
      });
      req.on('error', reject);
      return;
    }
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return reject(new Error('multipart boundary missing'));
    const bufs = [];
    req.on('data', (c) => { total += c.length; if (total > 16_000_000) reject(new Error('Súbor je príliš veľký (max 15MB)')); bufs.push(c); });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(bufs);
        const parts = buf.toString('binary').split('--' + boundary);
        let fileBuf = null;
        let filename = 'screenshot.png';
        let confirmed = false;
        for (const part of parts) {
          if (/name="confirmed"/i.test(part)) {
            const v = part.split('\r\n\r\n')[1] || '';
            confirmed = /1|true|yes|on/i.test(v);
          }
          const fm = part.match(/filename="([^"]+)"/i);
          if (fm) {
            filename = fm[1];
            const idx = part.indexOf('\r\n\r\n');
            if (idx >= 0) {
              let binary = part.slice(idx + 4);
              if (binary.endsWith('\r\n')) binary = binary.slice(0, -2);
              fileBuf = Buffer.from(binary, 'binary');
            }
          }
        }
        if (!fileBuf || !fileBuf.length) return reject(new Error('Chýba screenshot súbor'));
        resolve({ buffer: fileBuf, filename, confirmed });
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

app.post('/api/bank-sepa/:orderId/screenshot', async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const orders = loadOrders();
    const order = orders[orderId];
    if (!order || order.provider !== 'bank_sepa_manual') {
      return res.status(404).json({ error: 'Objednávka sa nenašla' });
    }
    if (!(order.bank && order.bank.iban)) {
      return res.status(409).json({ error: 'Bankové údaje ešte nie sú pripravené' });
    }
    const parsed = await readMultipartScreenshot(req);
    if (!parsed.confirmed) {
      return res.status(400).json({
        error: 'Potvrďte, že máte screenshot s viditeľnou referenciou, potom nahrajte súbor.',
      });
    }
    // Only real images/PDF (magic bytes); extension forced from the sniffed type.
    const b0 = parsed.buffer;
    const kind = b0[0] === 0xff && b0[1] === 0xd8 ? 'jpg' : b0.slice(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'png'
      : b0.slice(0, 4).toString() === 'RIFF' && b0.slice(8, 12).toString() === 'WEBP' ? 'webp' : b0.slice(0, 5).toString() === '%PDF-' ? 'pdf' : null;
    if (!kind) return res.status(400).json({ error: 'Povolené sú len JPG, PNG, WEBP alebo PDF.' });
    const saved = electrocoin.saveScreenshot(orderId, parsed.buffer, String(parsed.filename || 'screenshot').replace(/\.[^.]*$/, '') + '.' + kind);
    order.screenshotPath = saved.path;
    try {
      const obj = await proofStore.uploadProof(orderId, saved.path, saved.filename);
      if (obj) { order.proofObject = obj; appendLog(`PROOF_S3 ${orderId} ${obj.key}`); }
    } catch (e) { appendLog(`PROOF_S3_FAIL ${orderId} ${e.name || e.message}`); }
    order.screenshotUploadedAt = new Date().toISOString();
    order.screenshotConfirmedByCustomer = true;
    order.paidMarkedAt = order.screenshotUploadedAt;
    order.status = 'uploading_proof';
    orders[orderId] = order;
    saveOrders(orders);
    appendLog(`SEPA_SCREENSHOT ${orderId} file=${saved.filename}`);

    // SEPA bot chain proof: channel #PROOF → checking bot verdict → email/TG Ryan.
    // Only for bank_sepa_manual when chain has steps; otherwise classic Electrocoin path.
    const mime =
      kind === 'jpg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : kind === 'webp' ? 'image/webp' : 'application/pdf';
    const useChainProof =
      sepaBotChain.isSepaManualOrder(order) &&
      sepaBotChain.getConfig().steps &&
      sepaBotChain.getConfig().steps.length;

    let upload = { ok: false, stage: 'skipped_chain', detail: '' };
    if (useChainProof) {
      order.status = 'proof_pending_review';
      order.proofReview = { status: 'waiting', startedAt: new Date().toISOString() };
      order.electrocoinProofUpload = { ok: false, stage: 'sepa_chain_proof', detail: 'pending' };
      orders[orderId] = order;
      saveOrders(orders);
      // Background: post to channel, wait for verdict, email/TG Ryan (may take up to proofTimeoutSec).
      const buf = parsed.buffer;
      const fname = saved.filename;
      setImmediate(() => {
        sepaBotChain
          .forwardProof(order, buf, fname, mime, appendLog, { loadOrders, saveOrders })
          .then((r) => appendLog(`SEPA_CHAIN_PROOF ${orderId} verdict=${r && r.verdict} status=${r && r.status}`))
          .catch((e) => appendLog('SEPA_CHAIN_PROOF_FAIL ' + (e && e.message)));
      });
    } else {
      upload = order.guided
        ? { ok: false, stage: 'guided_customer_uploads', detail: 'nahrajte doklad aj na electrocoin.eu (I have paid! → Select a file → Confirm)' }
        : await electrocoin.uploadProofToElectrocoin(order, saved.path);
      order.electrocoinProofUpload = upload;
      order.status = upload.ok ? 'awaiting_confirm' : 'screenshot_uploaded';
      orders[orderId] = order;
      saveOrders(orders);
      appendLog(`SEPA_EC_PROOF ${orderId} ok=${upload.ok} stage=${upload.stage}`);
    }

    res.json({
      ok: true,
      orderId,
      status: order.status,
      screenshotUploadedAt: order.screenshotUploadedAt,
      proofReview: order.proofReview || null,
      chainProof: useChainProof ? { verdict: 'pending', status: 'proof_pending_review' } : null,
      electrocoinProofUpload: {
        ok: upload.ok,
        stage: upload.stage,
        url: upload.url || null,
      },
      message: useChainProof
        ? 'Doklad odoslaný na overenie. Stav sa aktualizuje po verdikte bota.'
        : upload.ok
          ? 'Screenshot uložený a odoslaný na potvrdenie platby.'
          : 'Screenshot uložený u nás. Potvrdenie u príjemcu: ' + (upload.detail || upload.stage),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bank-sepa/:orderId/confirm', (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const secret = electrocoin.confirmSecret();
    const provided =
      String(req.headers['x-confirm-secret'] || '').trim() ||
      String((req.body && req.body.secret) || req.query.secret || '').trim();
    if (!secret) {
      return res.status(503).json({
        error:
          'SEPA_CONFIRM_SECRET nie je nastavený. Doplňte ho v .env pred manuálnym potvrdením.',
      });
    }
    if (!provided || provided !== secret) {
      return res.status(401).json({ error: 'Neplatný confirm secret' });
    }
    const orders = loadOrders();
    const order = orders[orderId];
    if (!order || order.provider !== 'bank_sepa_manual') {
      return res.status(404).json({ error: 'Objednávka sa nenašla' });
    }
    order.status = 'confirmed';
    order.confirmedAt = new Date().toISOString();
    order.confirmedBy = 'manual';
    order.paidAt = order.confirmedAt;
    orders[orderId] = order;
    saveOrders(orders);
    appendLog(`SEPA_CONFIRMED ${orderId} by=manual`);
    res.json({
      ok: true,
      orderId,
      status: order.status,
      confirmedAt: order.confirmedAt,
      reference: order.reference,
      amountEur: order.amountEur,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


function voucherGuideOnlyPage(req, res) {
  res.status(410).type('html').send('<!doctype html><html lang="sk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Len návod</title><body style="font-family:system-ui;background:#0b1020;color:#e5e7eb;padding:2rem;max-width:40rem;margin:auto"><h1>Len informačný návod</h1><p>PaysafeCard a darčekové karty (Amazon, Azteco, G2A) sú na tejto stránke len ako informačný návod. <strong>PIN ani kód kupónu nikomu neposielajte</strong> — ani nám, ani cez chat. Kód používajte len sami u obchodníka, ktorý ho priamo akceptuje.</p><p><a style="color:#93c5fd" href="/platby">Späť na platby</a></p></body></html>');
}
function voucherGone(req, res) {
  res.status(410).json({ error: 'Len informačný návod — PIN/kód sa neprijíma.', code: 'GUIDE_ONLY' });
}
app.get('/paysafe-pay', voucherGuideOnlyPage);

app.post('/api/paysafe/:orderId/pin-sent', voucherGone);

app.post('/api/paysafe/:orderId/confirm', voucherGone);

app.get('/api/paysafe/:orderId', (req, res) => {
  const orders = loadOrders();
  const order = orders[req.params.orderId];
  if (!order || order.provider !== 'paysafecard') {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({
    orderId: order.orderId,
    status: order.status,
    amountEur: order.amountEur,
    amountExact: order.amountExact,
    reference: order.reference,
    deadlineAt: order.deadlineAt,
    deadlineMinutes: order.deadlineMinutes || 60,
    email: order.email,
    customerPrompt: order.customerPrompt,
    pinShopUrl: order.pinShopUrl,
    suggestedPins: order.suggestedPins,
    pinMarkedAt: order.pinMarkedAt || null,
    screenshotUploadedAt: order.screenshotUploadedAt || null,
    confirmedAt: order.confirmedAt || null,
  });
});


app.get('/api/g2a/products', (req, res) => {
  const amount = Number(req.query.amount || req.query.eur || 0);
  const type = String(req.query.type || '').trim() || null;
  res.json({
    products: g2a.listProducts(),
    suggested: g2a.suggestProducts(amount, { type, limit: 8 }),
    status: g2a.status(),
  });
});


app.get('/g2a-pay', voucherGuideOnlyPage);

app.post('/api/g2a/:orderId/code-sent', voucherGone);

app.post('/api/g2a/:orderId/confirm', voucherGone);

app.get('/api/g2a/:orderId', (req, res) => {
  const orders = loadOrders();
  const order = orders[req.params.orderId];
  if (!order || order.provider !== 'g2a') {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({
    orderId: order.orderId,
    status: order.status,
    amountEur: order.amountEur,
    amountExact: order.amountExact,
    reference: order.reference,
    deadlineAt: order.deadlineAt,
    deadlineMinutes: order.deadlineMinutes || 60,
    email: order.email,
    productId: order.productId,
    productLabel: order.productLabel,
    buyUrl: order.buyUrl,
    customerPrompt: order.customerPrompt,
    suggestedProducts: order.suggestedProducts,
    codeMarkedAt: order.codeMarkedAt || null,
    screenshotUploadedAt: order.screenshotUploadedAt || null,
    confirmedAt: order.confirmedAt || null,
  });
});



app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    merchantWallet: config.merchantWallet,
    callbackBaseUrl: config.callbackBaseUrl,
    serverless: IS_SERVERLESS,
    btcpay: btcpay.status(),
    btcpay_onramp: onramp.status(),
    chain2pay_is: chain2payIs.status(),
    switchere: switchere.status(),
    kryptonim: kryptonim.status(),
    onramper: onramper.status(),
    bank_sepa_manual: electrocoin.status(),
    sepa_admin: {
      configured: adminSepa.isConfigured(),
    },
    paysafecard: paysafecard.status(),
    g2a: g2a.status(),
    destinations: destination.rankingDoc(),
    destinationPools: destination.poolSummary(),
    chain2pay_is_smoke: [...IS_SMOKE_PASSED],
    visible_methods_smoke: {
      loaded: VISIBLE_METHODS_SMOKE.loaded,
      ranAt: VISIBLE_METHODS_SMOKE.ranAt,
      passed: [...VISIBLE_METHODS_SMOKE.passed],
      failed: [...VISIBLE_METHODS_SMOKE.failed],
    },
  });
});


// Gift-card info page: card name, link to the shop, collapsible photo guide. No order, no data collected.
app.get('/giftcard/:method', (req, res) => {
  const id = String(req.params.method || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 60);
  let name = null, url = null, btn = null;
  if (id.startsWith('g2a_')) {
    const pr = require('./g2a').getProduct(id);
    if (pr) { name = pr.label || pr.shortLabel; url = pr.buyUrl; btn = 'Prejsť na G2A ↗'; }
  } else if (id.startsWith('gc_')) {
    const gc = giftCards.get(id);
    if (gc && gc.enabled !== false) { name = gc.name; url = gc.url; btn = `Kúpiť ${gc.name} ↗`; }
  } else if (id === 'paysafecard' || id.startsWith('paysafe')) {
    name = 'PaysafeCard'; url = 'https://www.herne-kupony.sk/paysafecard/'; btn = 'Kúpiť PaysafeCard (herne-kupony.sk) ↗';
  }
  if (!name) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p>Karta sa nenašla. <a href="/platby">Späť</a></p>');
  const e = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(name)}</title><style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:18px 14px 90px;background:#0b1220;color:#e2e8f0}
h1{font-size:1.45rem;margin:.3rem 0 1rem}a.back{color:#93c5fd;text-decoration:none;font-size:.95rem}
.go{display:block;text-align:center;padding:18px;border-radius:14px;background:#fb923c;color:#111827;font-weight:800;font-size:1.15rem;text-decoration:none;margin:14px 0}
.warn{background:#7f1d1d55;border:1px solid #ef4444;border-radius:10px;padding:10px 12px;font-size:.92rem}
details{border:1px solid #334155;border-radius:12px;margin:16px 0;background:#111827}summary{cursor:pointer;padding:14px;font-weight:700;font-size:1.05rem}
.st{padding:0 14px 14px}.st figure{margin:0 0 16px}.st img{width:100%;border-radius:10px;display:block;margin-bottom:6px}.st figcaption{font-size:.95rem;line-height:1.45}.n{display:inline-block;background:#3b82f6;color:#fff;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-size:.8rem;margin-right:6px}
</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body>
<a class="back" href="/platby">← Späť na výber platby</a>
<h1>${e(name)}</h1>
${url ? `<a class="go" href="${e(url)}" target="_blank" rel="noopener">${e(btn)}</a>` : ''}
<div class="warn">⚠️ Kód pošli iba cez formulár nižšie na tejto stránke – nikomu inému (ani do chatu).</div>
${guideStore.html(guideStore.keyFor(id) || '', { title: 'Návod krok za krokom' }) || '<details id="g"><summary>📖 Návod krok za krokom</summary><div class="st" id="steps"></div></details>'}
<div id="proofSlot"></div>
<p><a class="back" href="/platby">← Späť</a></p>
<script src="/guides/guides.js"></script>
<script>(function(){if(!document.getElementById('g'))return;var PG=window.PaymentGuides;var g=PG&&PG.resolveGuide(${JSON.stringify(id)});if(!g){document.getElementById('g').hidden=true;return}
var dev=PG.detectDevice?PG.detectDevice():'mobile';var st=PG.stepsForDevice(g,dev==='pc'?'pc':'mobile');var box=document.getElementById('steps');
if(g.note){var p=document.createElement('p');p.textContent=g.note;p.style.color='#fbbf24';box.appendChild(p)}
st.forEach(function(s,i){var f=document.createElement('figure');if(s.img){var a=document.createElement('a');a.href=s.img;a.target='_blank';var im=document.createElement('img');im.src=s.img;im.alt='Krok '+(i+1);im.loading='lazy';a.appendChild(im);f.appendChild(a)}var c=document.createElement('figcaption');c.innerHTML='<span class="n">'+(i+1)+'</span>';c.appendChild(document.createTextNode(s.caption));f.appendChild(c);box.appendChild(f)})})();</script>
<script src="/chat-widget.js" defer></script><script src="/proof-form.js" defer></script></body></html>`);
});

require('./proof')(app, { loadOrders, saveOrders, appendLog });
require('./chat')(app, { loadOrders, port: config.port, appendLog });
// Generic error handler: never leak stack traces / internals.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const st = Number(err && (err.status || err.statusCode)) || 500;
  if (st >= 500) appendLog(`HTTP_ERR ${req.method} ${req.path} ${err && err.message}`);
  if (res.headersSent) return;
  res.status(st).json({ error: st === 413 ? 'Payload too large' : st < 500 ? 'Bad request' : 'Server error' });
});

/** Started by lnkbio (pay/index.js). Data init always; inbound bots + jobs only when PAY_MODULE=on. */
async function payBoot() {
  const step = async (name, fn) => { try { await fn(); } catch (e) { appendLog(name + '_INIT_FAIL ' + (e && e.message)); } };
  await step('DB', () => orderDb.init(appendLog));
  await step('ADDRESS_STATE', () => addressPool.initState(appendLog));
  await step('STATUS', () => require('./statusLinks').init(appendLog));
  await step('PAYMETHODS', () => payMethods.init(appendLog));
  await step('GUIDES', () => guideStore.init(appendLog));
  await step('ADMIN_LINKS', () => adminCategories.init(appendLog));
  await step('METHOD_RANK', () => methodRank.init({ appendLog, pool: () => orderDb.pool(), loadOrders }));
  await step('WALLETS', () => wallets.init(appendLog));
  await step('GIFTCARDS', () => giftCards.init(appendLog));
  await step('GIFTPICK', () => giftPick.init(appendLog));
  await step('OXAPAY', () => oxapay.init(appendLog));
  await step('WALLET_GW', () => walletGw.init(appendLog));
  await step('AMOUNT_LINKS', () => amountLinks.init(appendLog, { methods: amountLinkMethods }));
  await step('SEPA_CHAIN', () => sepaBotChain.load(appendLog));
  const mode = require('./payMode').mode();
  // until the old checkout is switched to "moved" it may still write orders – pull its changes
  if (mode !== 'on') setInterval(() => { orderDb.sync(appendLog).catch(() => {}); }, 15000).unref();
  if (require('./payMode').jobs()) {
    require('./backup').start({ appendLog });
    __tg.boot().catch((e) => appendLog('TELEGRAM_BOOT_FAIL ' + (e && e.message)));
    { const b = ((config.callbackBaseUrl || '').replace(/\/callback\/?$/i, '') || process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''); __sup.boot(b.startsWith('http') ? b : b ? 'https://' + b : '').catch(() => {}); }
  }
  appendLog('PAY_MODULE_READY mode=' + mode);
  return mode;
}
app.payBoot = payBoot;

if (require.main === module) {
  // standalone (local dev / tests): same boot, then listen
  payBoot().finally(() => app.listen(config.port, () => console.log(`Platba: http://127.0.0.1:${config.port}/`)));
}

module.exports = app;
