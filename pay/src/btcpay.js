'use strict';

/**
 * BTCPay Server (Greenfield) invoice helper.
 * Env: BTCPAY_URL (or BTCPay_URL), BTCPAY_STORE_ID, BTCPAY_API_KEY
 */

function getEnv() {
  const url = (process.env.BTCPAY_URL || process.env.BTCPay_URL || '')
    .trim()
    .replace(/\/$/, '');
  const storeId = (process.env.BTCPAY_STORE_ID || '').trim();
  const apiKey = (process.env.BTCPAY_API_KEY || '').trim();
  const storeSlug = (process.env.BTCPAY_STORE_SLUG || '').trim();
  const storePage = (
    process.env.BTCPAY_STORE_PAGE ||
    (storeSlug ? `https://btcpaylite.com/${storeSlug}` : '')
  )
    .trim()
    .replace(/\/$/, '');
  return { url, storeId, apiKey, storeSlug, storePage };
}

function authHeaders(json = false) {
  const { apiKey } = getEnv();
  const h = {
    Authorization: `token ${apiKey}`,
    Accept: 'application/json',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function isConfigured() {
  const { url, storeId, apiKey } = getEnv();
  return Boolean(url && storeId && apiKey);
}

function status() {
  const { storeSlug, storePage, url } = getEnv();
  const configured = isConfigured();
  return {
    id: 'btcpay',
    provider_name: 'BTCPay (Bitcoin / Lightning)',
    configured,
    storeSlug: storeSlug || null,
    storePage: storePage || null,
    apiHost: url
      ? (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return null;
          }
        })()
      : null,
    hint: configured
      ? storeSlug
        ? `BTC / Lightning`
        : null
      : 'vyžaduje BTCPay Server',
  };
}

/**
 * Create a BTCPay invoice and return checkoutLink.
 * @param {number} amountEur
 * @param {string} email
 * @param {string} orderId
 */
async function createInvoice(amountEur, email, orderId, extraMeta = {}) {
  if (!isConfigured()) {
    const err = new Error(
      'BTCPay nie je nastavený. Doplňte BTCPAY_URL, BTCPAY_STORE_ID a BTCPAY_API_KEY v .env.'
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const { url, storeId } = getEnv();
  const amount = Number(amountEur);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Suma v EUR musí byť kladné číslo');
  }

  const endpoint = `${url}/api/v1/stores/${encodeURIComponent(storeId)}/invoices`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({
      amount: String(amount),
      currency: 'EUR',
      metadata: {
        orderId,
        buyerEmail: email || undefined,
        payoutBtc: extraMeta.payoutBtc || undefined,
        payoutLightning: extraMeta.payoutLightning || undefined,
        onramp: extraMeta.onramp || undefined,
      },
      checkout: {
        redirectURL: extraMeta.redirectURL || undefined,
      },
    }),
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
      `BTCPay chyba ${res.status}: ${data?.message || data?.error || text.slice(0, 200)}`
    );
    err.body = data;
    err.status = res.status;
    throw err;
  }

  const checkoutLink = data.checkoutLink || data.checkoutlink;
  if (!checkoutLink) {
    const err = new Error('BTCPay nevrátil checkoutLink');
    err.body = data;
    throw err;
  }

  return {
    configured: true,
    invoiceId: data.id,
    checkoutLink,
    amount,
    currency: 'EUR',
    orderId,
    raw: data,
  };
}

async function activatePaymentMethod(invoiceId, paymentMethodId = 'BTC-CHAIN') {
  const { url, storeId } = getEnv();
  const endpoint = `${url}/api/v1/stores/${encodeURIComponent(
    storeId
  )}/invoices/${encodeURIComponent(invoiceId)}/payment-methods/${encodeURIComponent(
    paymentMethodId
  )}/activate`;
  const res = await fetch(endpoint, { method: 'POST', headers: authHeaders() });
  // 200 even when method filtered by criteria; caller checks destination
  return res.status;
}

async function getPaymentMethods(invoiceId) {
  const { url, storeId } = getEnv();
  const endpoint = `${url}/api/v1/stores/${encodeURIComponent(
    storeId
  )}/invoices/${encodeURIComponent(invoiceId)}/payment-methods`;
  const res = await fetch(endpoint, { headers: authHeaders() });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = [];
  }
  if (!res.ok) {
    const err = new Error(`BTCPay payment-methods ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Create invoice + activate BTC-CHAIN → on-chain receive address for fiat on-ramps.
 */
async function createInvoiceWithOnChain(amountEur, email, orderId, extraMeta = {}) {
  const inv = await createInvoice(amountEur, email, orderId, {
    ...extraMeta,
    onramp: true,
  });
  await activatePaymentMethod(inv.invoiceId, 'BTC-CHAIN');
  const methods = await getPaymentMethods(inv.invoiceId);
  const chain = methods.find(
    (m) =>
      String(m.paymentMethodId || '').toUpperCase() === 'BTC-CHAIN' &&
      m.destination
  );
  if (!chain || !chain.destination) {
    const err = new Error(
      'BTCPay invoice nemá on-chain BTC adresu (BTC-CHAIN). Skontrolujte wallet xpub/zpub v BTCPay store a payment method criteria.'
    );
    err.code = 'NO_ONCHAIN_ADDRESS';
    err.methods = methods.map((m) => m.paymentMethodId);
    throw err;
  }
  return {
    ...inv,
    btcAddress: chain.destination,
    btcAmount: String(chain.due || chain.amount),
    paymentLink: chain.paymentLink || null,
    paymentMethods: methods,
  };
}

async function getInvoice(invoiceId) {
  const { url, storeId } = getEnv();
  const endpoint = `${url}/api/v1/stores/${encodeURIComponent(
    storeId
  )}/invoices/${encodeURIComponent(invoiceId)}`;
  const res = await fetch(endpoint, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `BTCPay invoice ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

module.exports = {
  isConfigured,
  status,
  createInvoice,
  createInvoiceWithOnChain,
  activatePaymentMethod,
  getPaymentMethods,
  getInvoice,
  getEnv,
};
