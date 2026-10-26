'use strict';

/**
 * Thin client for chain2pay.is Dashboard API v2.
 * Separate from src/client.js (chain2pay.net / paygate) — do not mix bases.
 *
 * Auth: Authorization: Bearer c2p_live_… (wallet bound to key).
 * Docs: https://docs.chain2pay.is/
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_API_BASE = 'https://chain2pay.is/api/v2';

/** EU / CEE–useful providers we may force via `provider` on create payment. */
const EU_PROVIDER_IDS = [
  'ramp', 'guardarian', 'banxa', 'banxa2', 'revolut', 'transak',
  'paypal', 'stripe', 'multihosted', 'topper', 'moonpay', 'paybis', 'coinbase',
  'alchemy',
];

const PROVIDER_LABELS_SK = {
  ramp: 'Ramp Network (.is)',
  guardarian: 'Guardarian (.is)',
  banxa: 'Banxa (.is)',
  banxa2: 'Banxa 2 (.is)',
  revolut: 'Revolut (.is)',
  transak: 'Transak (.is)',
  multihosted: 'Rýchla platba (.is · auto)',
  paypal: 'PayPal (.is)',
  stripe: 'Stripe (.is)',
  topper: 'Topper (.is)',
  moonpay: 'MoonPay (.is)',
  paybis: 'Paybis (.is)',
  coinbase: 'Coinbase (.is)',
  alchemy: 'Alchemy Pay (.is)',
};

function maskKey(key) {
  const k = String(key || '');
  if (k.length < 16) return k ? '***' : '';
  return `${k.slice(0, 12)}…${k.slice(-4)}`;
}

function getEnv() {
  const apiKey = (process.env.CHAIN2PAY_IS_API_KEY || '').trim();
  const apiBase = (
    process.env.CHAIN2PAY_IS_API_BASE ||
    DEFAULT_API_BASE
  )
    .trim()
    .replace(/\/$/, '');
  return { apiKey, apiBase };
}

function isConfigured() {
  const { apiKey } = getEnv();
  return Boolean(apiKey && /^c2p_(live|sandbox)_/.test(apiKey));
}

function status() {
  const { apiKey, apiBase } = getEnv();
  const configured = isConfigured();
  return {
    id: 'chain2pay_is',
    provider_name: 'Chain2Pay.is (Dashboard API)',
    configured,
    apiBase,
    keyPrefix: configured ? maskKey(apiKey) : null,
    providers: EU_PROVIDER_IDS,
    hint: configured
      ? null
      : 'dostupné po nastavení CHAIN2PAY_IS_API_KEY (c2p_live_…)',
  };
}

async function apiFetch(pathname, options = {}) {
  const { apiKey, apiBase } = getEnv();
  if (!apiKey) {
    const err = new Error(
      'chain2pay.is nie je nastavený. Doplňte CHAIN2PAY_IS_API_KEY v .env.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const url = pathname.startsWith('http')
    ? pathname
    : `${apiBase}${pathname.startsWith('/') ? '' : '/'}${pathname}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
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
    const msg =
      (data && data.error && data.error.message) ||
      (data && data.message) ||
      `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    err.code = res.status === 401 ? 'AUTH' : 'API_ERROR';
    // Never attach the API key to errors
    throw err;
  }
  return data;
}

/**
 * List active providers + limits.
 * @returns {Promise<{object:string, data: Array}>}
 */
async function listProviders() {
  return apiFetch('/providers');
}

/**
 * Create a hosted payment. Redirect customer to checkout_url.
 * @param {object} opts
 * @param {number} opts.amount
 * @param {string} [opts.currency='EUR']
 * @param {string} [opts.callbackUrl]
 * @param {string} [opts.customerEmail]
 * @param {string} [opts.provider] — e.g. ramp, guardarian, banxa, revolut, transak
 * @param {object} [opts.metadata]
 */
async function createPayment(opts = {}) {
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const body = {
    amount,
    currency: String(opts.currency || 'EUR').toUpperCase(),
  };
  if (opts.callbackUrl) body.callback_url = opts.callbackUrl;
  if (opts.customerEmail) body.customer_email = opts.customerEmail;
  if (opts.provider) body.provider = String(opts.provider).toLowerCase();
  if (opts.metadata && typeof opts.metadata === 'object') {
    body.metadata = opts.metadata;
  }

  return apiFetch('/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Get payment by id (C2P-…).
 */
async function getPayment(id) {
  if (!id) throw new Error('payment id is required');
  return apiFetch(`/payments/${encodeURIComponent(id)}`);
}

/**
 * Build callback URL that preserves our local orderId.
 */
function buildCallbackUrl(orderId, callbackBaseUrl) {
  const base = String(callbackBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('callbackBaseUrl is required');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}orderId=${encodeURIComponent(orderId)}&source=chain2pay_is`;
}

/**
 * Minimum EUR amount for smoke / UI (from docs currency_specific.EUR or USD).
 */
function minEurForProvider(providerId, providersList) {
  const id = String(providerId || '').toLowerCase();
  const row = (providersList || []).find(
    (p) => String(p.id).toLowerCase() === id
  );
  if (row) {
    const cs = row.currency_specific || {};
    if (cs.EUR != null) return Number(cs.EUR);
    if (row.minimum_amount != null && row.minimum_currency === 'EUR') {
      return Number(row.minimum_amount);
    }
    if (row.minimum_amount != null) return Number(row.minimum_amount);
  }
  const fallback = {
    ramp: 5,
    guardarian: 20,
    banxa: 10,
    banxa2: 10,
    revolut: 6,
    transak: 6,
    multihosted: 6,
    paypal: 5,
    stripe: 3,
    topper: 10,
    moonpay: 20,
    paybis: 10,
    coinbase: 10,
    alchemy: 15,
  };
  return fallback[id] || 10;
}

module.exports = {
  EU_PROVIDER_IDS,
  PROVIDER_LABELS_SK,
  maskKey,
  getEnv,
  isConfigured,
  status,
  apiFetch,
  listProviders,
  createPayment,
  getPayment,
  buildCallbackUrl,
  minEurForProvider,
};
