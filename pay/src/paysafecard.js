'use strict';

/**
 * Manual PaysafeCard PIN flow (herne-kupony.sk style UX).
 *
 * Customer:
 * 1) Enters own email + amount
 * 2) Buys / gets a 16-digit PaysafeCard PIN on herne-kupony.sk/paysafecard/
 * 3) NEPOSIELAJTE PIN/kód nikomu (len informačný návod)
 *
 * Ryan confirms manually. No merchant Paysafe API. No TG/FB contact URLs required.
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
const UPLOAD_DIR = path.join(DATA_DIR, 'paysafe-uploads');

const PIN_SHOP_URL = 'https://www.herne-kupony.sk/paysafecard/';
const PIN_BUY_HINT =
  'Kúpte si 16-miestny PIN na herne-kupony.sk/paysafecard/ (suma → košík → dodacie údaje → PIN emailom).';

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
  const n = Number(env('PAYSAFE_DEADLINE_MINUTES', env('SEPA_DEADLINE_MINUTES', '60')));
  if (!Number.isFinite(n) || n < 5) return 60;
  if (n > 60 * 24 * 7) return 60 * 24 * 7;
  return Math.floor(n);
}

function notifyEmail() {
  return env('NOTIFY_EMAIL') || env('PAYSAFE_NOTIFY_EMAIL') || env('SEPA_NOTIFY_EMAIL');
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
    env('PAYSAFE_CONFIRM_SECRET') ||
    env('SEPA_CONFIRM_SECRET') ||
    env('ADMIN_CONFIRM_SECRET')
  );
}

function referencePrefix() {
  const p = env('PAYSAFE_REFERENCE_PREFIX', 'PSC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return (p || 'PSC').slice(0, 8);
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

/** Typical SK PaysafeCard denominations (herne-kupony style). */
function suggestedPins(amountEur) {
  const n = Number(amountEur);
  const dens = [10, 25, 50, 100];
  if (!Number.isFinite(n) || n <= 0) return dens;
  const exact = dens.filter((d) => d === Math.round(n));
  if (exact.length) return exact;
  const near = dens.filter((d) => d >= n).slice(0, 2);
  return near.length ? near : [dens[dens.length - 1]];
}

function isConfigured() {
  return true;
}

function status() {
  const smtp = smtpConfigured();
  const mode = emailMode();
  return {
    id: 'paysafecard',
    provider_name: 'PaysafeCard',
    configured: true,
    hint:
      'Kúpte 16-miestny PIN (váš email) → NEPOSIELAJTE PIN/kód nikomu (len informačný návod)',
    methods: ['paysafecard', 'prepaid_pin'],
    deadlineMinutes: deadlineMinutes(),
    emailMode: mode,
    smtpConfigured: smtp,
    confirmSecretSet: Boolean(confirmSecret()),
    pinShopUrl: PIN_SHOP_URL,
    customerPrompt: 'NEPOSIELAJTE PIN/kód nikomu (len informačný návod)',
    denominations: [10, 25, 50, 100],
  };
}

/**
 * @param {{ orderId: string, amountEur: number, email: string }} opts
 */
function buildOrder(opts) {
  const orderId = opts.orderId;
  const amountEur = Number(opts.amountEur);
  const email = String(opts.email || '').trim();
  if (!Number.isFinite(amountEur) || amountEur <= 0) {
    const err = new Error('Suma v EUR musí byť kladné číslo');
    err.code = 'BAD_AMOUNT';
    throw err;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Platný email je povinný (váš vlastný — na doručenie PINu)');
    err.code = 'BAD_EMAIL';
    throw err;
  }

  const reference = makeReference(orderId);
  const createdAt = new Date();
  const mins = deadlineMinutes();
  const deadlineAt = new Date(createdAt.getTime() + mins * 60 * 1000);
  const suggested = suggestedPins(amountEur);

  return {
    orderId,
    amountEur,
    amount: amountEur,
    email,
    currency: 'EUR',
    provider: 'paysafecard',
    gateway: 'paysafecard',
    reference,
    amountExact: amountEur.toFixed(2),
    deadlineMinutes: mins,
    deadlineAt: deadlineAt.toISOString(),
    createdAt: createdAt.toISOString(),
    status: 'awaiting_pin',
    screenshotPath: null,
    screenshotUploadedAt: null,
    pinMarkedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    emailDelivery: null,
    resolution: 'manual_paysafe',
    providerHost: 'local-paysafecard',
    customerPrompt: 'NEPOSIELAJTE PIN/kód nikomu (len informačný návod)',
    pinBuyHint: PIN_BUY_HINT,
    pinShopUrl: PIN_SHOP_URL,
    suggestedPins: suggested,
    inspiredBy: 'herne-kupony.sk/paysafecard/ (manual PIN handoff)',
  };
}

function customerEmailText(order, publicBase) {
  const payUrl = `${publicBase}/paysafe-pay?orderId=${encodeURIComponent(order.orderId)}`;
  return [
    'Dobrý deň,',
    '',
    'ďakujeme za objednávku. Platba prebieha cez PaysafeCard PIN.',
    '',
    `Objednávka: ${order.orderId}`,
    `Suma: ${order.amountExact || order.amountEur} EUR`,
    `Referencia: ${order.reference}`,
    `Termín: ${order.deadlineAt}`,
    '',
    'Postup:',
    '1) Na https://www.herne-kupony.sk/paysafecard/ si kúpte 16-miestny PIN — v dodacích údajoch uveďte VÁŠ email.',
    '2) PIN dostanete emailom / na účtenke.',
    '3) NEPOSIELAJTE PIN/kód nikomu (len informačný návod).',
    '   Do správy uveďte aj referenciu: ' + order.reference,
    '',
    `Stránka s návodom: ${payUrl}`,
    '',
    'Ďakujeme',
  ].join('\n');
}

function notifyEmailText(order, publicBase) {
  const payUrl = `${publicBase}/paysafe-pay?orderId=${encodeURIComponent(order.orderId)}`;
  const confirmHint = confirmSecret()
    ? `Potvrdiť: POST ${publicBase}/api/paysafe/${order.orderId}/confirm  Header x-confirm-secret`
    : `Potvrdiť: nastavte PAYSAFE_CONFIRM_SECRET (alebo SEPA_CONFIRM_SECRET) a POST /api/paysafe/${order.orderId}/confirm`;
  return [
    'PAYSAFECARD — nová objednávka len návod)',
    '',
    `Zákazník email: ${order.email}`,
    `Objednávka: ${order.orderId}`,
    `Suma: ${order.amountExact || order.amountEur} EUR`,
    `Referencia: ${order.reference}`,
    `Deadline: ${order.deadlineAt} (${order.deadlineMinutes || 60} min)`,
    `Odporúčané nominály PIN: ${(order.suggestedPins || []).join(', ')} €`,
    `Stránka zákazníka: ${payUrl}`,
    '',
    'Zákazník má: kúpiť PIN vlastným emailom → NEPOSIELAJTE PIN/kód nikomu (len informačný návod).',
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
    kind: 'paysafecard',
    reason: smtpConfigured()
      ? 'EMAIL_MODE=none or SMTP send skipped/failed — TEMP copy'
      : 'SMTP not configured — TEMP mailbox',
    howTo:
      '1) Open this JSON + .INSTRUCTIONS.txt\n' +
      '2) NEPOSIELAJTE PIN/kód nikomu (len informačný návod)\n' +
      '3) Redeem / settle, then POST /api/paysafe/:orderId/confirm',
    notifyEmail: notifyEmail() || null,
    emailMode: emailMode(),
    smtpConfigured: smtpConfigured(),
    payloads,
    orderSnapshot: {
      orderId: order.orderId,
      email: order.email,
      amountExact: order.amountExact,
      reference: order.reference,
      deadlineAt: order.deadlineAt,
      deadlineMinutes: order.deadlineMinutes,
      status: order.status,
      customerPrompt: order.customerPrompt,
      suggestedPins: order.suggestedPins,
    },
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const instr = [
    'TEMP EMAIL / PAYSAFECARD — RYAN',
    '================================',
    '',
    doc.howTo,
    '',
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
      subject: `Objednávka ${order.reference} · ${order.amountExact} EUR — PaysafeCard PIN`,
      text: customerEmailText(order, publicBase),
    });
  }
  if ((mode === 'notify' || mode === 'both') && notifyEmail()) {
    payloads.push({
      role: 'notify',
      to: notifyEmail(),
      subject: `[PSC] ${order.amountExact} EUR · ${order.reference} · ${order.email} · čaká PIN`,
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
            subject: `[PSC] ${order.reference} · čaká PIN`,
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

module.exports = {
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
  suggestedPins,
  PIN_SHOP_URL,
  PIN_BUY_HINT,
  TEMP_EMAIL_DIR,
  UPLOAD_DIR,
};
