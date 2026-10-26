'use strict';
/**
 * Guardarian — Revolut card / Revolut Pay / Apple Pay / Google Pay → BTC (LTC/BCH fallback)
 * straight to a pool address. Customer does own KYC at Guardarian.
 *
 * With GUARDARIAN_API_KEY: POST /v1/transaction → redirect_url with payout address
 *   locked (skip_choose_payout_address) and payment category preselected.
 * Without: public buy page (guardarian.com/buy-btc) + local copy button for the address.
 * Docs: https://docs.guardarian.com/
 */
const API = (process.env.GUARDARIAN_API_BASE || 'https://api-payments.guardarian.com/v1').replace(/\/$/, '');

const CATEGORY = {
  card: 'VISA_MC',
  revolut_pay: 'REVOLUT_PAY',
  apple_pay: 'APPLE_PAY',
  google_pay: 'GOOGLE_PAY',
};

function apiKey() { return String(process.env.GUARDARIAN_API_KEY || '').trim(); }
function isConfigured() { return Boolean(apiKey()); }

function buildPublicUrl({ ticker = 'BTC', fiatAmount }) {
  const t = String(ticker).toUpperCase();
  const u = new URL(`https://guardarian.com/buy-${t.toLowerCase()}`);
  u.searchParams.set('from', 'EUR');
  u.searchParams.set('to', t);
  if (fiatAmount) u.searchParams.set('amount', String(fiatAmount));
  return u.toString();
}

async function createTransaction({ ticker, fiatAmount, address, method, email, successUrl, cancelUrl, failUrl }) {
  const t = String(ticker || 'BTC').toUpperCase();
  const body = {
    from_amount: Number(fiatAmount),
    from_currency: 'EUR',
    from_network: 'EUR',
    to_currency: t,
    to_network: t,
    payout_info: { payout_address: address, skip_choose_payout_address: true },
    redirects: { successful: successUrl, cancelled: cancelUrl, failed: failUrl },
  };
  const cat = CATEGORY[method];
  if (cat) body.deposit = { payment_category: cat, skip_choose_payment_category: true };
  if (email) body.customer = { contact_info: { email } };
  const r = await fetch(`${API}/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.redirect_url) {
    const e = new Error(`Guardarian ${r.status}: ${j.message || j.code || 'no redirect_url'}`);
    e.status = r.status; e.body = j; e.code = 'GUARDARIAN_API';
    throw e;
  }
  return { url: j.redirect_url, id: j.id, lockedWallet: true };
}

/** Returns { mode, url, lockedWallet, guardarianId? } */
async function resolveCheckout(opts) {
  if (isConfigured()) {
    try {
      const tx = await createTransaction(opts);
      return { mode: 'api', url: tx.url, lockedWallet: true, guardarianId: tx.id };
    } catch (e) {
      // Bad/expired key → don't break checkout; public flow + copy button.
      if (e.status !== 401 && e.status !== 403) throw e;
      return { mode: 'public', url: buildPublicUrl(opts), lockedWallet: false, apiError: e.message };
    }
  }
  return { mode: 'public', url: buildPublicUrl(opts), lockedWallet: false };
}

module.exports = { resolveCheckout, buildPublicUrl, createTransaction, isConfigured, CATEGORY };
