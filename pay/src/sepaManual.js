'use strict';
/**
 * Plain SEPA platba — customer enters amount only (no personal details).
 * Ryan / bot chain supplies IBAN + payment note (+ optional beneficiary name).
 */
const destination = require('./destination');

const cleanIban = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function validIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const r = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}

function normalizeVs(vs) {
  const s = String(vs == null ? '' : vs).trim();
  if (!s || s === '-' || s.toLowerCase() === 'none' || s.toLowerCase() === 'n/a') return null;
  return s.slice(0, 35);
}

async function buildOrder({ orderId, amountEur, firstName, lastName }) {
  amountEur = Number(amountEur);
  if (!Number.isFinite(amountEur) || amountEur < 5) {
    const e = new Error('Suma v EUR musí byť aspoň 5'); e.code = 'BAD_AMOUNT'; throw e;
  }
  // Customer name is optional / unused — never required on the form.
  const fn = String(firstName || '').trim();
  const ln = String(lastName || '').trim();
  const full = [fn, ln].filter(Boolean).join(' ').trim();
  const dest = destination.pickDestination({
    orderId,
    provider: 'bank_sepa_manual',
    coin: 'btc',
    allowedCoins: ['btc'],
    allowEvmFallback: false,
  });
  if (!dest || !dest.address) {
    const e = new Error('BTC adresa z poolu nie je dostupná'); e.code = 'NOT_CONFIGURED'; throw e;
  }
  const now = new Date().toISOString();
  return {
    orderId,
    amountEur,
    amount: amountEur,
    amountExact: amountEur.toFixed(2),
    currency: 'EUR',
    firstName: fn || null,
    lastName: ln || null,
    fullName: full || null,
    email: null,
    customerEmail: null,
    provider: 'bank_sepa_manual',
    gateway: 'bank_sepa_manual',
    guided: false,
    bank: null,
    bankDetailsPublic: false,
    status: 'awaiting_iban',
    automationStage: null,
    automationError: null,
    payoutAddress: dest.address,
    payoutCoin: dest.coin || 'btc',
    payoutIndex: dest.index,
    btcAddress: dest.address,
    btcAmount: null,
    invoiceId: null,
    btcSource: dest.reason || 'pool',
    reference: null,
    vs: null,
    purpose: null,
    paymentNote: null,
    createdAt: now,
    deadlineAt: null,
    deadlineMinutes: null,
    screenshotPath: null,
    screenshotUploadedAt: null,
    screenshotConfirmedByCustomer: false,
    resolution: 'sepa_manual_telegram',
    providerHost: null,
    telegramMessageId: null,
  };
}

function publicOrderView(order) {
  const expired = order.deadlineAt ? Date.now() > Date.parse(order.deadlineAt) : false;
  const bankReady =
    Boolean(order.bank && order.bank.iban) &&
    [
      'awaiting_payment',
      'awaiting_confirm',
      'screenshot_uploaded',
      'uploading_proof',
      'proof_pending_review',
      'proof_unverified',
      'proof_rejected',
      'confirmed',
      'paid',
    ].includes(order.status);
  const note = order.paymentNote || order.purpose || order.reference || null;
  const vs = order.vs || null;
  const proofReview = order.proofReview || null;
  let statusMessage = null;
  if (order.status === 'paid' || order.status === 'confirmed') statusMessage = 'Platba potvrdená';
  else if (order.status === 'proof_rejected') statusMessage = (proofReview && proofReview.customerLabel) || 'Doklad zamietnutý';
  else if (order.status === 'proof_unverified' || order.status === 'proof_pending_review') {
    statusMessage = (proofReview && proofReview.customerLabel) || 'Doklad čaká na overenie';
  } else if (order.status === 'uploading_proof' || order.status === 'screenshot_uploaded') {
    statusMessage = 'Doklad nahratý';
  }
  return {
    orderId: order.orderId,
    status: order.status,
    statusMessage,
    proofReview,
    automationStage: null,
    automationError: null,
    amountEur: order.amountEur,
    amountExact: order.amountExact,
    firstName: order.firstName,
    lastName: order.lastName,
    reference: bankReady ? vs || note : null,
    vs: bankReady ? vs : null,
    paymentNote: bankReady ? note : null,
    deadlineAt: order.deadlineAt,
    deadlineMinutes: order.deadlineMinutes,
    bankDetailsPublic: Boolean(bankReady),
    bank: bankReady
      ? {
          beneficiary: order.bank.beneficiary,
          iban: order.bank.iban,
          amountExact: order.amountExact,
          reference: vs || note,
          vs,
          purpose: note,
          paymentNote: note,
          beneficiaryAddress: order.bank.beneficiaryAddress || null,
        }
      : null,
    purpose: bankReady ? note : null,
    screenshotUploadedAt: order.screenshotUploadedAt || null,
    screenshotConfirmedByCustomer: Boolean(order.screenshotConfirmedByCustomer),
    confirmedAt: order.confirmedAt || null,
    expired,
    waitingMessage:
      order.status === 'awaiting_iban' || !bankReady
        ? 'Čakáme na platobné údaje'
        : null,
  };
}

/**
 * @param {object} order
 * @param {{ iban: string, amount?: string|number, vs?: string|null, beneficiary?: string, note?: string, message?: string }} p
 */
function applyBankDetails(order, p) {
  const clean = cleanIban(p.iban);
  if (!validIban(clean)) {
    const e = new Error('IBAN nie je platný (checksum)'); e.code = 'BAD_IBAN'; throw e;
  }
  const amt = Number(String(p.amount ?? order.amountExact).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amt) || amt <= 0) {
    const e = new Error('Neplatná suma'); e.code = 'BAD_AMOUNT'; throw e;
  }
  const note = String(p.note || p.message || '').trim().slice(0, 140);
  if (!note) {
    const e = new Error('Poznámka / správa pre prijímateľa je povinná (text za |)'); e.code = 'BAD_NOTE'; throw e;
  }
  const vs = normalizeVs(p.vs);
  // Beneficiary / recipient name is optional (Ryan or bot may omit it).
  const benef = String(p.beneficiary || '').trim().slice(0, 140);
  const deadlineMin = Number(process.env.SEPA_DEADLINE_MINUTES || 50);
  order.bank = { iban: clean, beneficiary: benef || null };
  order.amountExact = amt.toFixed(2);
  order.amountEur = amt;
  order.paymentNote = note;
  order.purpose = note; // remittance / MSG / EPC unstructured
  order.vs = vs;
  order.reference = vs || note;
  order.bankDetailsPublic = true;
  order.status = 'awaiting_payment';
  order.deadlineMinutes = deadlineMin;
  order.deadlineAt = new Date(Date.now() + deadlineMin * 60000).toISOString();
  order.bankEnteredAt = new Date().toISOString();
  order.bankEnteredVia = p.via || 'telegram';
  return order;
}

module.exports = { buildOrder, publicOrderView, applyBankDetails, validIban, cleanIban, normalizeVs };
