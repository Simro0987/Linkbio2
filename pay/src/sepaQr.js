/**
 * SEPA payment QR payloads + mobile open-in-bank helpers for /bank-sepa-pay.
 *
 * - SPD 1.0 (Short Payment Descriptor / PAY by Square) — SK & CZ bank apps (QR only)
 * - EPC069-12 (BCD / SCT) — Revolut, Wise, and other EU apps that scan SEPA QR
 * - payme.sk Payment Link 2.0 — SK bank deep links (HTTPS → preferred bank app)
 *
 * Mobile reality (documented in UI):
 * - SK: one payme.sk CTA when URL builds; no per-bank button list.
 * - CZ: no reliable universal HTTPS deep link from mobile web — no CZ open buttons.
 *   Keep SPD/EPC QR for scanning.
 * - Revolut: copy clean fields + open revolut:// (fallback https://revolut.com/app) + EPC QR hint.
 *
 * Only call with real bankDetailsPublic fields — never invent IBAN.
 */

'use strict';

const QRCode = require('qrcode');

const SPD_MSG_MAX = 60;
const EPC_NAME_MAX = 70;
const EPC_REMIT_MAX = 140;
const PAYME_CN_MAX = 70;
const PAYME_MSG_MAX = 140;

function cleanIban(iban) {
  return String(iban || '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function cleanAmount(amount) {
  const n = Number(String(amount == null ? '' : amount).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

function truncate(s, max) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * Build SPD*1.0 payload used by Slovak / Czech banks (PAY by Square ecosystem).
 * @param {{ iban: string, beneficiary?: string, amount?: string|number, currency?: string, remittance?: string }} p
 */
function buildSpdPayload(p) {
  const iban = cleanIban(p.iban);
  if (!iban || iban.length < 15) return null;
  const am = cleanAmount(p.amount);
  const cc = String(p.currency || 'EUR').toUpperCase().slice(0, 3);
  const parts = ['SPD*1.0', `ACC:${iban}`];
  if (am) {
    parts.push(`AM:${am}`);
    parts.push(`CC:${cc}`);
  }
  const name = truncate(p.beneficiary, 35);
  if (name) parts.push(`RN:${name}`);
  const msg = truncate(p.remittance, SPD_MSG_MAX);
  if (msg) parts.push(`MSG:${msg}`);
  // Prefer explicit VS; else derive digits from remittance for SK apps
  const vsExplicit = String(p.vs || '').trim();
  const vs = vsExplicit
    ? vsExplicit.replace(/[^0-9A-Za-z-]/g, '').slice(0, 35)
    : String(p.remittance || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 35);
  if (vs) parts.push(`X-VS:${vs}`);
  return parts.join('*');
}

/**
 * Build EPC069-12 version 002 SEPA Credit Transfer QR payload.
 * @param {{ iban: string, beneficiary?: string, amount?: string|number, currency?: string, remittance?: string, bic?: string }} p
 */
function buildEpcPayload(p) {
  const iban = cleanIban(p.iban);
  if (!iban || iban.length < 15) return null;
  const name = truncate(p.beneficiary, EPC_NAME_MAX);
  if (!name) return null;
  const am = cleanAmount(p.amount);
  const cc = String(p.currency || 'EUR').toUpperCase().slice(0, 3);
  const amountLine = am ? `${cc}${am}` : '';
  const bic = String(p.bic || '').replace(/\s+/g, '').toUpperCase();
  const remittance = truncate(p.remittance, EPC_REMIT_MAX);
  // BCD / 002 / UTF-8 / SCT / BIC / Name / IBAN / Amount / Purpose / Struct RF / Unstruct / Info
  const lines = [
    'BCD',
    '002',
    '1',
    'SCT',
    bic,
    name,
    iban,
    amountLine,
    '', // purpose code (AT-44) unused
    '', // structured creditor reference unused
    remittance,
    '', // beneficiary to originator info
  ];
  return lines.join('\n');
}

/**
 * Slovak Banking Association Payment Link Standard 2.0 (payme.sk).
 * Type /e/ (e-commerce) requires IBAN, CN, AM, CC — opens preferred SK bank app
 * when installed; otherwise payme.sk shows PAY by square QR fallback.
 *
 * Payment Link Standard 2.0 PI (payer identification / payment identifiers).
 * Live payme.sk rejects PI that starts or ends with "/" or contains "//" (E06005:
 * "Nesprávne zadaná referencia platiteľa (použitie lomky na začiatku)").
 * Official historical examples used "/VS…"; the 2026 validator forbids leading slash.
 * Electrocoin matching needs the exact PURPOSE string in MSG — never mangle into /VS.
 * Charset for PI: A–Z 0–9 and / - ? : ( ) . , ' + space (no leading/trailing /).
 */
const PAYME_PI_CHARSET = /^[A-Z0-9 \/\-?:().,'+]+$/i;

function sanitizePaymeCn(name) {
  // Recommended ASCII-ish CN: keep letters/digits/common punctuation; strip odd Unicode.
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 .,'+\-()\/?:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPaymePi(remittance) {
  const raw = String(remittance || '').trim();
  if (!raw) return null;
  // Prefer exact remittance (e.g. Electrocoin PURPOSE 0022-0751-8148) when charset-safe.
  const asPi = truncate(raw, 35);
  if (asPi && PAYME_PI_CHARSET.test(asPi) && !asPi.startsWith('/') && !asPi.endsWith('/') && !asPi.includes('//')) {
    return asPi;
  }
  // Fallback: digits only — never prefix /VS (E06005).
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length >= 4) return digits;
  return null;
}

/**
 * @param {{ iban: string, beneficiary?: string, amount?: string|number, currency?: string, remittance?: string }} p
 * @returns {string|null}
 */
function buildPaymeUrl(p) {
  const iban = cleanIban(p.iban);
  if (!iban || iban.length < 15) return null;
  const am = cleanAmount(p.amount);
  if (!am) return null;
  const cc = String(p.currency || 'EUR').toUpperCase().slice(0, 3);
  if (cc !== 'EUR') return null; // payme v2 only EUR
  const cnRaw = truncate(p.beneficiary, PAYME_CN_MAX);
  const cn = sanitizePaymeCn(cnRaw);
  if (!cn) return null;
  // PURPOSE / remittance ONLY in MSG (exact trim, max 140) — Electrocoin matches this.
  const msg = truncate(p.remittance, PAYME_MSG_MAX);
  const params = new URLSearchParams();
  params.set('IBAN', iban);
  params.set('AM', am);
  params.set('CC', 'EUR');
  params.set('CN', cn);
  if (msg) {
    params.set('MSG', msg);
    // /e/ type requires PI; must NOT start/end with "/" (payme E06005).
    const pi = buildPaymePi(msg);
    if (pi) params.set('PI', pi);
  }
  const url = `https://payme.sk/2/e/PME?${params.toString()}`;
  // Self-check: never emit leading-slash PI (E06005).
  if (/[?&]PI=\/|[?&]PI=%2F/i.test(url) || /PI=\/VS/i.test(url)) {
    throw new Error('buildPaymeUrl E06005 guard: PI must not start with / or /VS');
  }
  return url;
}

/**
 * Experimental Android Chrome intent for SPAYD MIME (CZ bank apps that register
 * application/x-shortpaymentdescriptor). Often ignored by browsers; keep as best-effort.
 */
function buildSpaydAndroidIntent(spd) {
  if (!spd) return null;
  const once = encodeURIComponent(spd);
  return `intent:#Intent;action=android.intent.action.VIEW;type=application/x-shortpaymentdescriptor;S.spayd=${once};end`;
}

/**
 * RFC 8905 payto URI — rarely handled by consumer bank apps; useful for copy/share.
 */
function buildPaytoUri(p) {
  const iban = cleanIban(p.iban);
  if (!iban || iban.length < 15) return null;
  const am = cleanAmount(p.amount);
  const q = new URLSearchParams();
  if (am) q.set('amount', `EUR:${am}`);
  const msg = truncate(p.remittance, 140);
  if (msg) q.set('message', msg);
  const name = truncate(p.beneficiary, 70);
  if (name) q.set('receiver-name', name);
  const qs = q.toString();
  return `payto://iban/${iban}${qs ? `?${qs}` : ''}`;
}

/**
 * Open-in-bank CTAs for the pay page.
 * Rule: only include buttons that reliably open a useful app / URL.
 * - SK: single payme CTA (hidden when paymeUrl is null).
 * - CZ: none (no reliable mobile-web deep link; keep QR only).
 * - Revolut: open app + clean copy + EPC QR hint.
 */
const BANK_OPEN_OPTIONS = [
  {
    id: 'payme',
    region: 'sk',
    label: 'Otvoriť v SK bankovej appke (payme)',
    subtitle: 'SLSP · Tatra · VÚB · ČSOB · 365 · Fio · Prima · Poštová',
    action: 'payme',
    primary: true,
  },
  {
    id: 'revolut',
    region: 'eu',
    label: 'Revolut',
    subtitle: 'Skopírovať údaje + otvoriť appku (+ QR SEPA)',
    action: 'revolut',
    primary: true,
    openScheme: 'revolut://',
    openHttps: 'https://revolut.com/app',
    storeAndroid: 'https://play.google.com/store/apps/details?id=com.revolut.revolut',
    storeIos: 'https://apps.apple.com/app/id932493382',
  },
];

/**
 * Build open-in-bank payloads for the pay page CTA.
 * @returns {{ paymeUrl, spd, epc, payto, androidSpaydIntent, banks, limitsSk } | null}
 */
/** Value-only multi-line paste for Revolut / bank apps (no Slovak labels). */
function buildCleanCopyText(fields) {
  if (!fields || !fields.iban) return '';
  const am = cleanAmount(fields.amount);
  return [
    fields.beneficiary ? String(fields.beneficiary).trim() : null,
    cleanIban(fields.iban),
    am || null,
    fields.remittance ? String(fields.remittance).trim() : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildBankOpenPayload(fields) {
  if (!fields || !fields.iban) return null;
  const spd = buildSpdPayload(fields);
  const epc = buildEpcPayload(fields);
  const paymeUrl = buildPaymeUrl(fields);
  const payto = buildPaytoUri(fields);
  const androidSpaydIntent = buildSpaydAndroidIntent(spd);
  // Hide SK payme CTA when URL cannot be built; never list CZ open buttons.
  const banks = BANK_OPEN_OPTIONS.filter((b) => {
    if (b.action === 'payme') return Boolean(paymeUrl);
    if (b.region === 'cz') return false;
    return true;
  });
  return {
    paymeUrl,
    spd,
    epc,
    payto,
    androidSpaydIntent,
    copyText: buildCleanCopyText(fields),
    banks,
    limitsSk:
      'SK: payme.sk otvorí predvyplnenú platbu (ak máte appku; inak QR na payme.sk). ' +
      'CZ: z mobilného webu nie je spoľahlivý deep link — naskenujte QR. ' +
      'Revolut: skopírujeme IBAN/sumu/PURPOSE a otvoríme appku; doplňte údaje alebo naskenujte QR SEPA.',
  };
}

/**
 * Normalize bank fields from an Electrocoin order / public view.
 */
function fieldsFromBank(bank, extras = {}) {
  if (!bank || !bank.iban) return null;
  const remittance =
    bank.paymentNote ||
    bank.purpose ||
    extras.paymentNote ||
    extras.purpose ||
    bank.reference ||
    extras.reference ||
    '';
  const amount = bank.amountExact || extras.amountExact || extras.amountEur;
  return {
    iban: bank.iban,
    beneficiary: bank.beneficiary || extras.beneficiary || '',
    amount,
    currency: bank.currency || 'EUR',
    remittance,
    vs: bank.vs || extras.vs || null,
    bic: bank.bic || '',
  };
}

async function toDataUrl(payload, opts = {}) {
  if (!payload) return null;
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: opts.errorCorrectionLevel || 'M',
    margin: 2,
    width: opts.width || 280,
    type: 'image/png',
  });
}

async function toPngBuffer(payload, opts = {}) {
  if (!payload) return null;
  return QRCode.toBuffer(payload, {
    errorCorrectionLevel: opts.errorCorrectionLevel || 'M',
    margin: 2,
    width: opts.width || 320,
    type: 'png',
  });
}

/**
 * Generate both QR variants for a bank payload.
 * Returns { spd, epc } each with { payload, dataUrl } or null if not buildable.
 * Never throws — QR is optional; callers must still show copyable bank fields.
 */
async function generatePaymentQrs(fields) {
  if (!fields || !fields.iban) {
    return { spd: null, epc: null };
  }
  try {
    const spdPayload = buildSpdPayload(fields);
    const epcPayload = buildEpcPayload(fields);
    const safeUrl = async (payload) => {
      if (!payload) return null;
      try {
        return await toDataUrl(payload);
      } catch (_) {
        return null;
      }
    };
    const [spdUrl, epcUrl] = await Promise.all([
      safeUrl(spdPayload),
      safeUrl(epcPayload),
    ]);
    return {
      spd: spdPayload && spdUrl
        ? {
            format: 'SPD*1.0',
            labelSk: 'QR pre SK/CZ banky',
            payload: spdPayload,
            dataUrl: spdUrl,
          }
        : null,
      epc: epcPayload && epcUrl
        ? {
            format: 'EPC069-12',
            labelSk: 'QR SEPA / Revolut / Wise',
            payload: epcPayload,
            dataUrl: epcUrl,
          }
        : null,
    };
  } catch (_) {
    return { spd: null, epc: null };
  }
}

module.exports = {
  buildSpdPayload,
  buildEpcPayload,
  buildPaymeUrl,
  buildPaytoUri,
  buildSpaydAndroidIntent,
  buildBankOpenPayload,
  buildCleanCopyText,
  fieldsFromBank,
  generatePaymentQrs,
  toDataUrl,
  toPngBuffer,
  cleanIban,
  cleanAmount,
  BANK_OPEN_OPTIONS,
};
