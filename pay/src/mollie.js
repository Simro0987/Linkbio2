'use strict';

/**
 * Mollie stub — optional EU methods (iDEAL, Bancontact, SEPA, Przelewy24, BLIK).
 * Env: MOLLIE_API_KEY
 * Without a key the UI still lists Mollie as "dostupné po nastavení kľúča".
 */

const MOLLIE_METHODS = [
  'ideal',
  'bancontact',
  'banktransfer',
  'przelewy24',
  'blik',
];

function getEnv() {
  const apiKey = (process.env.MOLLIE_API_KEY || '').trim();
  return { apiKey };
}

function isConfigured() {
  return Boolean(getEnv().apiKey);
}

function status() {
  return {
    id: 'mollie',
    provider_name: 'Mollie (iDEAL / Bancontact / SEPA / P24 / BLIK)',
    configured: isConfigured(),
    methods: MOLLIE_METHODS,
    hint: isConfigured()
      ? null
      : 'dostupné po nastavení MOLLIE_API_KEY',
  };
}

/**
 * Create a Mollie payment. method: ideal | bancontact | banktransfer (SEPA).
 * @param {number} amountEur
 * @param {string} email
 * @param {string} orderId
 * @param {string} [method]
 * @param {string} [redirectUrl]
 * @param {string} [webhookUrl]
 */
async function createPayment(
  amountEur,
  email,
  orderId,
  method = 'ideal',
  redirectUrl,
  webhookUrl
) {
  if (!isConfigured()) {
    const err = new Error(
      'Mollie nie je nastavený. Doplňte MOLLIE_API_KEY v .env.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const amount = Number(amountEur);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Suma v EUR musí byť kladné číslo');
  }

  const normalized = String(method || 'ideal').toLowerCase();
  const allowed = new Set([
    'ideal',
    'bancontact',
    'banktransfer',
    'przelewy24',
    'blik',
  ]);
  let mollieMethod =
    normalized === 'sepa' || normalized === 'banktransfer'
      ? 'banktransfer'
      : normalized === 'p24'
        ? 'przelewy24'
        : normalized;
  if (!allowed.has(mollieMethod)) {
    mollieMethod = 'banktransfer';
  }

  const { apiKey } = getEnv();
  const body = {
    amount: {
      currency: 'EUR',
      value: amount.toFixed(2),
    },
    description: `Objednávka ${orderId}`,
    redirectUrl:
      redirectUrl ||
      process.env.MOLLIE_REDIRECT_URL ||
      'https://example.com/thanks',
    metadata: { orderId, email: email || undefined },
    method: mollieMethod,
  };
  if (webhookUrl || process.env.MOLLIE_WEBHOOK_URL) {
    body.webhookUrl = webhookUrl || process.env.MOLLIE_WEBHOOK_URL;
  }

  const res = await fetch('https://api.mollie.com/v2/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(
      `Mollie chyba ${res.status}: ${data?.detail || data?.title || text.slice(0, 200)}`
    );
    err.body = data;
    err.status = res.status;
    throw err;
  }

  const checkoutUrl =
    data._links?.checkout?.href || data.checkoutUrl || null;
  if (!checkoutUrl) {
    const err = new Error('Mollie nevrátil checkout URL');
    err.body = data;
    throw err;
  }

  return {
    configured: true,
    paymentId: data.id,
    checkoutUrl,
    status: data.status,
    method: mollieMethod,
    amount,
    currency: 'EUR',
    orderId,
    raw: data,
  };
}

module.exports = {
  isConfigured,
  status,
  createPayment,
  MOLLIE_METHODS,
  getEnv,
};
