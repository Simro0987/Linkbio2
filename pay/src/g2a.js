'use strict';

/**
 * Manual G2A voucher flow (Azteco Lightning / on-chain + Amazon DE).
 *
 * Customer:
 * 1) Picks a gift-card amount (exact denomination)
 * 2) Buys on G2A with their own email
 * 3) Opens G2A email → Get order / Display item → copies code or redeem link
 * 4) NEPOSIELAJTE PIN/kód nikomu (len informačný návod)
 *
 * Ryan confirms manually. No merchant G2A API. No TG/FB contact URLs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = IS_SERVERLESS
  ? path.join('/tmp', 'chain2pay-data')
  : path.join(ROOT, 'data');
const TEMP_EMAIL_DIR = path.join(DATA_DIR, 'temp-emails');
const UPLOAD_DIR = path.join(DATA_DIR, 'g2a-uploads');

/** Fixed G2A product catalog — split by type + face value. */
const PRODUCTS = [
  {
    id: 'azteco_ln_10',
    aliasId: 'g2a_azteco_ln_10',
    type: 'azteco_ln',
    group: 'g2a_azteco',
    label: 'Darčeková karta Azteco 10 €',
    shortLabel: 'Darčeková karta Azteco 10 €',
    amountEur: 10,
    buyUrl:
      'https://www.g2a.com/azteco-bitcoin-lightning-voucher-10-eur-azteco-key-global-i10000337158001',
    codeHint: 'Azteco Lightning kód / redeem link',
  },
  {
    id: 'azteco_ln_50',
    aliasId: 'g2a_azteco_ln_50',
    type: 'azteco_ln',
    group: 'g2a_azteco',
    label: 'Darčeková karta Azteco 50 €',
    shortLabel: 'Darčeková karta Azteco 50 €',
    amountEur: 50,
    buyUrl:
      'https://www.g2a.com/azteco-bitcoin-lightning-voucher-50-eur-azteco-key-global-i10000337158007',
    codeHint: 'Azteco Lightning kód / redeem link',
  },
  {
    id: 'azteco_ln_200',
    aliasId: 'g2a_azteco_ln_200',
    type: 'azteco_ln',
    group: 'g2a_azteco',
    label: 'Darčeková karta Azteco 200 €',
    shortLabel: 'Darčeková karta Azteco 200 €',
    amountEur: 200,
    buyUrl:
      'https://www.g2a.com/azteco-bitcoin-lightning-voucher-200-eur-azteco-key-global-i10000337158008',
    codeHint: 'Azteco Lightning kód / redeem link',
  },
  {
    id: 'azteco_onchain_100',
    aliasId: 'g2a_azteco_onchain_100',
    type: 'azteco_onchain',
    group: 'g2a_azteco',
    label: 'Darčeková karta Azteco 100 €',
    shortLabel: 'Darčeková karta Azteco 100 €',
    amountEur: 100,
    buyUrl:
      'https://www.g2a.com/azteco-bitcoin-on-chain-voucher-100-eur-azteco-key-global-i10000337159005',
    codeHint: 'Azteco on-chain kód / redeem link',
  },
  {
    id: 'amazon_de_10',
    aliasId: 'g2a_amazon_de_10',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 10 €',
    shortLabel: 'Darčeková karta Amazon 10 €',
    amountEur: 10,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-10-eur-amazon-key-germany-i10000001698004',
    codeHint: 'Amazon DE gift card kód',
  },
  {
    id: 'amazon_de_25',
    aliasId: 'g2a_amazon_de_25',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 25 €',
    shortLabel: 'Darčeková karta Amazon 25 €',
    amountEur: 25,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-germany-25-eur-amazon-i10000001698002',
    codeHint: 'Amazon DE gift card kód',
  },
  {
    id: 'amazon_de_45',
    aliasId: 'g2a_amazon_de_45',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 45 €',
    shortLabel: 'Darčeková karta Amazon 45 €',
    amountEur: 45,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-45-eur-amazon-germany-i10000001698088',
    codeHint: 'Amazon DE gift card kód',
  },
  {
    id: 'amazon_de_50',
    aliasId: 'g2a_amazon_de_50',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 50 €',
    shortLabel: 'Darčeková karta Amazon 50 €',
    amountEur: 50,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-50-eur-amazon-key-germany-i10000001698012',
    codeHint: 'Amazon DE gift card kód',
  },
  {
    id: 'amazon_de_85',
    aliasId: 'g2a_amazon_de_85',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 85 €',
    shortLabel: 'Darčeková karta Amazon 85 €',
    amountEur: 85,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-85-eur-amazon-key-germany-i10000178883055',
    codeHint: 'Amazon DE gift card kód',
  },
  {
    id: 'amazon_de_100',
    aliasId: 'g2a_amazon_de_100',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 100 €',
    shortLabel: 'Darčeková karta Amazon 100 €',
    amountEur: 100,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-100-eur-amazon-key-germany-i10000001698005',
    codeHint: 'Amazon DE gift card kód',
  },
  {
    id: 'amazon_de_200',
    aliasId: 'g2a_amazon_de_200',
    type: 'amazon_de',
    group: 'g2a_amazon',
    label: 'Darčeková karta Amazon 200 €',
    shortLabel: 'Darčeková karta Amazon 200 €',
    amountEur: 200,
    buyUrl:
      'https://www.g2a.com/amazon-gift-card-200-eur-amazon-germany-i10000001698076',
    codeHint: 'Amazon DE gift card kód',
  },
];

const BY_ID = Object.create(null);
const BY_ALIAS = Object.create(null);
for (const p of PRODUCTS) {
  BY_ID[p.id] = p;
  BY_ALIAS[p.aliasId] = p;
  BY_ALIAS[p.id] = p;
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function boolEnv(name) {
  const v = env(name).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function deadlineMinutes() {
  const n = Number(env('G2A_DEADLINE_MINUTES', env('SEPA_DEADLINE_MINUTES', '60')));
  if (!Number.isFinite(n) || n < 5) return 60;
  if (n > 60 * 24 * 7) return 60 * 24 * 7;
  return Math.floor(n);
}

function notifyEmail() {
  return env('NOTIFY_EMAIL') || env('G2A_NOTIFY_EMAIL') || env('SEPA_NOTIFY_EMAIL');
}

function emailMode() {
  const m = env('EMAIL_MODE', '').toLowerCase();
  if (['customer', 'notify', 'both', 'none'].includes(m)) return m;
  if (notifyEmail()) return 'notify';
  return 'notify';
}

function smtpConfigured() {
  return Boolean(env('SMTP_HOST') && env('SMTP_FROM'));
}

function confirmSecret() {
  return (
    env('G2A_CONFIRM_SECRET') ||
    env('PAYSAFE_CONFIRM_SECRET') ||
    env('SEPA_CONFIRM_SECRET') ||
    env('ADMIN_CONFIRM_SECRET')
  );
}

function referencePrefix() {
  const p = env('G2A_REFERENCE_PREFIX', 'G2A')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return (p || 'G2A').slice(0, 8);
}

function makeReference(orderId) {
  const short = String(orderId || '')
    .replace(/^ord_/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8)
    .toUpperCase();
  const rnd = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${referencePrefix()}-${short || rnd}-${rnd}`;
}

function listProducts() {
  return PRODUCTS.map((p) => ({ ...p }));
}

function getProduct(key) {
  if (!key) return null;
  const k = String(key).trim().toLowerCase();
  return BY_ALIAS[k] || BY_ID[k] || null;
}

/** Resolve product from checkout alias / body.productId / nearest amount. */
function resolveProduct({ productId, alias, amountEur, type } = {}) {
  if (productId) {
    const p = getProduct(productId);
    if (p) return p;
  }
  if (alias) {
    const p = getProduct(alias);
    if (p) return p;
  }
  const matches = suggestProducts(amountEur, { type, limit: 1 });
  return matches[0] || null;
}

/**
 * Suggest products matching (or nearest above) customer EUR amount.
 * Exact face values first, then nearest higher within type groups.
 */
function suggestProducts(amountEur, opts = {}) {
  const n = Number(amountEur);
  const typeFilter = opts.type ? String(opts.type) : null;
  const limit = Math.max(1, Number(opts.limit) || 6);
  let pool = PRODUCTS;
  if (typeFilter) {
    pool = pool.filter((p) => p.type === typeFilter || p.group === typeFilter);
  }
  if (!Number.isFinite(n) || n <= 0) {
    return pool.slice(0, limit);
  }
  const exact = pool.filter((p) => p.amountEur === Math.round(n));
  if (exact.length) return exact.slice(0, limit);
  const rounded = Math.round(n * 100) / 100;
  const higher = pool
    .filter((p) => p.amountEur >= rounded)
    .sort((a, b) => a.amountEur - b.amountEur || a.label.localeCompare(b.label));
  if (higher.length) return higher.slice(0, limit);
  return [...pool].sort((a, b) => b.amountEur - a.amountEur).slice(0, limit);
}

function isConfigured() {
  return true;
}

function status() {
  const smtp = smtpConfigured();
  const mode = emailMode();
  const amounts = [...new Set(PRODUCTS.map((p) => p.amountEur))].sort((a, b) => a - b);
  return {
    id: 'g2a',
    provider_name: 'G2A kupóny',
    configured: true,
    hint:
      'Kúpte kupón na G2A (váš email) → Get order / Display item → NEPOSIELAJTE PIN/kód nikomu (len informačný návod)',
    methods: ['g2a', 'voucher', 'gift_card'],
    deadlineMinutes: deadlineMinutes(),
    emailMode: mode,
    smtpConfigured: smtp,
    notifyEmail: notifyEmail() || null,
    confirmSecretSet: Boolean(confirmSecret()),
    customerPrompt: 'NEPOSIELAJTE PIN/kód nikomu (len informačný návod)',
    denominations: amounts,
    products: listProducts(),
    groups: {
      g2a_azteco: 'Darčekové karty Azteco',
      g2a_amazon: 'Darčekové karty Amazon',
    },
  };
}

/**
 * @param {{ orderId: string, amountEur?: number, email: string, productId?: string, alias?: string }} opts
 */
function buildOrder(opts) {
  const orderId = opts.orderId;
  const email = String(opts.email || '').trim();
  const product = resolveProduct({
    productId: opts.productId,
    alias: opts.alias,
    amountEur: opts.amountEur,
    type: opts.type,
  });
  if (!product) {
    const err = new Error(
      'Neznámy G2A produkt — vyberte Azteco alebo Amazon DE nominál'
    );
    err.code = 'BAD_PRODUCT';
    throw err;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error(
      'Platný email je povinný (váš vlastný — na doručenie G2A objednávky)'
    );
    err.code = 'BAD_EMAIL';
    throw err;
  }

  const amountEur = product.amountEur;
  const requested = Number(opts.amountEur);
  const reference = makeReference(orderId);
  const createdAt = new Date();
  const mins = deadlineMinutes();
  const deadlineAt = new Date(createdAt.getTime() + mins * 60 * 1000);
  const suggested = suggestProducts(requested || amountEur, { limit: 4 });

  return {
    orderId,
    amountEur,
    amount: amountEur,
    requestedAmountEur: Number.isFinite(requested) ? requested : amountEur,
    email,
    currency: 'EUR',
    provider: 'g2a',
    gateway: 'g2a',
    providerAlias: product.aliasId,
    productId: product.id,
    productType: product.type,
    productLabel: product.label,
    productGroup: product.group,
    buyUrl: product.buyUrl,
    codeHint: product.codeHint,
    reference,
    amountExact: amountEur.toFixed(2),
    deadlineMinutes: mins,
    deadlineAt: deadlineAt.toISOString(),
    createdAt: createdAt.toISOString(),
    status: 'awaiting_code',
    screenshotPath: null,
    screenshotUploadedAt: null,
    codeMarkedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    emailDelivery: null,
    resolution: 'manual_g2a',
    providerHost: 'local-g2a',
    customerPrompt: 'NEPOSIELAJTE PIN/kód nikomu (len informačný návod)',
    buyHint:
      'Na G2A kúpte tento kupón na VÁŠ email → v emaile Get order / Display item → skopírujte kód alebo odkaz → NEPOSIELAJTE PIN/kód nikomu (len informačný návod).',
    suggestedProducts: suggested.map((p) => ({
      id: p.id,
      aliasId: p.aliasId,
      label: p.shortLabel || p.label,
      amountEur: p.amountEur,
      type: p.type,
      buyUrl: p.buyUrl,
    })),
  };
}

function customerEmailText(order, publicBase) {
  const payUrl = `${publicBase}/g2a-pay?orderId=${encodeURIComponent(order.orderId)}`;
  return [
    'Dobrý deň,',
    '',
    `ďakujeme za objednávku. Platba prebieha cez G2A kupón: ${order.productLabel}.`,
    '',
    `Objednávka: ${order.orderId}`,
    `Suma: ${order.amountExact || order.amountEur} EUR`,
    `Referencia: ${order.reference}`,
    `Termín: ${order.deadlineAt}`,
    '',
    'Postup:',
    `1) Otvorte G2A a kúpte: ${order.buyUrl}`,
    '2) Pri nákupe použite VÁŠ email — kľúč / kód príde emailom od G2A.',
    '3) V emaile kliknite Get order / Display item (Zobraziť položku).',
    `4) Skopírujte ${order.codeHint || 'kód / odkaz'} a NEPOSIELAJTE PIN/kód nikomu (len informačný návod).`,
    '   Do správy uveďte aj referenciu: ' + order.reference,
    '',
    `Stránka s návodom: ${payUrl}`,
    '',
    'Ďakujeme',
  ].join('\n');
}

function notifyEmailText(order, publicBase) {
  const payUrl = `${publicBase}/g2a-pay?orderId=${encodeURIComponent(order.orderId)}`;
  const confirmHint = confirmSecret()
    ? `Potvrdiť: POST ${publicBase}/api/g2a/${order.orderId}/confirm  Header x-confirm-secret`
    : `Potvrdiť: nastavte G2A_CONFIRM_SECRET (alebo SEPA_CONFIRM_SECRET) a POST /api/g2a/${order.orderId}/confirm`;
  return [
    'G2A — nová objednávka len návod)',
    '',
    `Produkt: ${order.productLabel} (${order.productId})`,
    `G2A link: ${order.buyUrl}`,
    `Zákazník email: ${order.email}`,
    `Objednávka: ${order.orderId}`,
    `Suma: ${order.amountExact || order.amountEur} EUR`,
    `Referencia: ${order.reference}`,
    `Deadline: ${order.deadlineAt} (${order.deadlineMinutes || 60} min)`,
    `Stránka zákazníka: ${payUrl}`,
    '',
    'Zákazník: kúpiť na G2A vlastným emailom → Get order / Display item → NEPOSIELAJTE PIN/kód nikomu (len informačný návod).',
    'Žiadne kontaktné URL v UI — zákazník už vie kam písať.',
    '',
    confirmHint,
  ].join('\n');
}

async function sendSmtp({ to, subject, text }) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    const err = new Error('nodemailer nie je nainštalovaný — npm install nodemailer');
    err.code = 'NO_NODEMAILER';
    throw err;
  }
  const port = Number(env('SMTP_PORT', '587')) || 587;
  const secure = boolEnv('SMTP_SECURE') || port === 465;
  const transporter = nodemailer.createTransport({
    host: env('SMTP_HOST'),
    port,
    secure,
    auth:
      env('SMTP_USER') || env('SMTP_PASS')
        ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') }
        : undefined,
  });
  const info = await transporter.sendMail({
    from: env('SMTP_FROM'),
    to,
    subject,
    text,
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

function writeTempEmail(order, payloads) {
  ensureDir(TEMP_EMAIL_DIR);
  const file = path.join(TEMP_EMAIL_DIR, `${order.orderId}.json`);
  const instructions = path.join(TEMP_EMAIL_DIR, `${order.orderId}.INSTRUCTIONS.txt`);
  const doc = {
    writtenAt: new Date().toISOString(),
    orderId: order.orderId,
    kind: 'g2a',
    reason: smtpConfigured()
      ? 'EMAIL_MODE=none or SMTP send skipped/failed — TEMP copy'
      : 'SMTP not configured — TEMP mailbox',
    howTo:
      '1) Open this JSON + .INSTRUCTIONS.txt\n' +
      '2) NEPOSIELAJTE PIN/kód nikomu (len informačný návod)\n' +
      '3) Redeem / settle, then POST /api/g2a/:orderId/confirm',
    notifyEmail: notifyEmail() || null,
    emailMode: emailMode(),
    smtpConfigured: smtpConfigured(),
    payloads,
    orderSnapshot: {
      orderId: order.orderId,
      email: order.email,
      amountExact: order.amountExact,
      reference: order.reference,
      productId: order.productId,
      productLabel: order.productLabel,
      buyUrl: order.buyUrl,
      deadlineAt: order.deadlineAt,
      deadlineMinutes: order.deadlineMinutes,
      status: order.status,
      customerPrompt: order.customerPrompt,
    },
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const instr = [
    'TEMP EMAIL / G2A — RYAN',
    '=======================',
    '',
    doc.howTo,
    '',
    `Product: ${order.productLabel}`,
    `Buy: ${order.buyUrl}`,
    `Customer: ${order.email}`,
    `Amount: ${order.amountExact} EUR`,
    `Reference: ${order.reference}`,
    `Notify: ${notifyEmail() || '(unset)'}`,
    `File: ${file}`,
  ].join('\n');
  fs.writeFileSync(instructions, instr);
  return { jsonPath: file, instructionsPath: instructions };
}

async function deliverEmails(order, publicBase) {
  const mode = emailMode();
  const payloads = [];
  const report = {
    mode,
    smtpConfigured: smtpConfigured(),
    sent: [],
    skipped: [],
    temp: null,
    errors: [],
  };

  if (mode === 'customer' || mode === 'both') {
    payloads.push({
      role: 'customer',
      to: order.email,
      subject: `Objednávka ${order.reference} · ${order.amountExact} EUR — ${order.productLabel}`,
      text: customerEmailText(order, publicBase),
    });
  }
  if ((mode === 'notify' || mode === 'both') && notifyEmail()) {
    payloads.push({
      role: 'notify',
      to: notifyEmail(),
      subject: `[G2A] ${order.amountExact} EUR · ${order.productLabel} · ${order.reference} · ${order.email}`,
      text: notifyEmailText(order, publicBase),
    });
  }
  if ((mode === 'notify' || mode === 'both') && !notifyEmail()) {
    report.skipped.push('notify: NOTIFY_EMAIL unset — using TEMP files');
  }
  if (mode === 'none') {
    report.skipped.push('EMAIL_MODE=none');
  }

  const wantSmtp = smtpConfigured() && mode !== 'none' && payloads.length > 0;
  if (wantSmtp) {
    for (const p of payloads) {
      try {
        const r = await sendSmtp(p);
        report.sent.push({ role: p.role, to: p.to, messageId: r.messageId });
      } catch (e) {
        report.errors.push({ role: p.role, to: p.to, error: e.message });
      }
    }
  } else if (payloads.length) {
    report.skipped.push(
      smtpConfigured() ? 'mode blocked SMTP' : 'SMTP not configured'
    );
  }

  if (!report.sent.length || mode === 'notify' || mode === 'none' || !smtpConfigured()) {
    const withBodies = payloads.length
      ? payloads
      : [
          {
            role: 'notify_fallback',
            to: notifyEmail() || 'NOTIFY_EMAIL unset',
            subject: `[G2A] ${order.reference} · čaká kód`,
            text: notifyEmailText(order, publicBase),
          },
        ];
    report.temp = writeTempEmail(order, withBodies);
  }

  return report;
}

function saveScreenshot(orderId, buffer, originalName) {
  ensureDir(UPLOAD_DIR);
  const safe = String(originalName || 'screenshot.png')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  const ext = path.extname(safe) || '.png';
  const base = path.basename(safe, ext).slice(0, 40) || 'screenshot';
  const filename = `${orderId}_${Date.now()}_${base}${ext}`;
  const full = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(full, buffer);
  return { filename, path: full, relative: path.relative(ROOT, full) };
}

/** METHOD_GROUPS entries for server.js */
function methodGroupEntries() {
  return {
    g2a_azteco: PRODUCTS.filter((p) => p.group === 'g2a_azteco').map((p) => ({
      providerId: 'g2a',
      aliasId: p.aliasId,
      gateway: 'g2a',
      label: p.label,
      productId: p.id,
      amountEur: p.amountEur,
      buyUrl: p.buyUrl,
      hint: `G2A: ${p.shortLabel} → email → Get order / Display item len návod)`,
      preferred: false,
    })),
    g2a_amazon: PRODUCTS.filter((p) => p.group === 'g2a_amazon').map((p) => ({
      providerId: 'g2a',
      aliasId: p.aliasId,
      gateway: 'g2a',
      label: p.label,
      productId: p.id,
      amountEur: p.amountEur,
      buyUrl: p.buyUrl,
      hint: `G2A: ${p.shortLabel} → email → Get order / Display item len návod)`,
      preferred: false,
    })),
  };
}

function aliasMap() {
  const map = { g2a_voucher: 'g2a', g2a_gift: 'g2a' };
  for (const p of PRODUCTS) {
    map[p.aliasId] = 'g2a';
    map[p.id] = 'g2a';
  }
  return map;
}

module.exports = {
  PRODUCTS,
  status,
  isConfigured,
  buildOrder,
  deliverEmails,
  customerEmailText,
  notifyEmailText,
  saveScreenshot,
  confirmSecret,
  deadlineMinutes,
  emailMode,
  notifyEmail,
  smtpConfigured,
  listProducts,
  getProduct,
  resolveProduct,
  suggestProducts,
  methodGroupEntries,
  aliasMap,
  TEMP_EMAIL_DIR,
  UPLOAD_DIR,
};
