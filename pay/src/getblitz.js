'use strict';

/**
 * GetBlitz SEPA Instant challenge helper (production).
 * Docs: https://docs.getblitz.io · Status: ../SEPA-STATUS.md
 *
 * Production requires:
 *   GETBLITZ_URL          e.g. https://app.getblitz.io or self-host
 *   GETBLITZ_API_KEY      sk_live_... from GetBlitz dashboard
 *   Connected business bank (Qonto / Revolut Business / Wise)
 *
 * Settlement: EUR → merchant bank IBAN (NOT USDC). For bank→USDC without
 * merchant KYC use Chain2Pay Banxa (banxa_bank) instead.
 *
 * Demo: GETBLITZ_DEMO=1 enables local /sepa-demo setup page only (not a payment).
 */

function getEnv() {
  const url = (process.env.GETBLITZ_URL || '').trim().replace(/\/$/, '');
  const apiKey = (process.env.GETBLITZ_API_KEY || '').trim();
  const demo =
    String(process.env.GETBLITZ_DEMO || '').trim() === '1' ||
    String(process.env.GETBLITZ_DEMO || '').toLowerCase() === 'true';
  return { url, apiKey, demo };
}

function hasProduction() {
  const { url, apiKey } = getEnv();
  return Boolean(url && apiKey);
}

function isConfigured() {
  return hasProduction() || getEnv().demo;
}

function status() {
  const env = getEnv();
  const prod = hasProduction();
  const demoOnly = Boolean(env.demo && !prod);
  return {
    id: 'getblitz',
    provider_name: prod
      ? 'GetBlitz SEPA Instant'
      : demoOnly
        ? 'SEPA Instant (setup page)'
        : 'GetBlitz SEPA Instant',
    configured: isConfigured(),
    production: prod,
    demo: demoOnly,
    methods: ['sepa_instant', 'bank_transfer'],
    settlesTo: prod ? 'merchant_bank_iban_eur' : null,
    blocking: prod
      ? null
      : 'Potrebuje GETBLITZ_URL + GETBLITZ_API_KEY a firemný účet Qonto / Revolut Business / Wise. Settlement ide na EUR IBAN, nie na USDC. Pozri SEPA-STATUS.md.',
    hint: prod
      ? 'produkčný GetBlitz — EUR na tvoj bankový účet'
      : demoOnly
        ? 'iba stránka s inštrukciami — nie skutočná platba'
        : 'blokované: chýba GetBlitz URL + API kľúč + business banka (Qonto/Revolut/Wise)',
  };
}

/**
 * Create a SEPA Instant payment challenge.
 * Amount is in EUR; API expects cents.
 */
async function createChallenge(amountEur, email, orderId, { publicBase } = {}) {
  const env = getEnv();
  const amount = Number(amountEur);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Suma v EUR musí byť kladné číslo');
  }

  if (env.url && env.apiKey) {
    const cents = Math.round(amount * 100);
    if (cents < 1) {
      throw new Error('Suma je príliš nízka pre SEPA Instant');
    }

    const endpoint = `${env.url}/api/v1/challenge`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        amount: cents,
        currency: 'EUR',
        merchantReferenceId: orderId,
        metadata: email ? { email } : undefined,
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
        `GetBlitz chyba ${res.status}: ${data?.message || data?.error || text.slice(0, 200)}`
      );
      err.body = data;
      err.status = res.status;
      throw err;
    }

    const paymentUrl = data.paymentUrl || data.payment_url;
    if (!paymentUrl) {
      const err = new Error('GetBlitz nevrátil paymentUrl');
      err.body = data;
      throw err;
    }

    return {
      configured: true,
      demo: false,
      production: true,
      sessionId: data.sessionId,
      clientToken: data.clientToken,
      referenceId: data.referenceId,
      paymentUrl,
      expiresAt: data.expiresAt,
      amount,
      currency: 'EUR',
      orderId,
      settlesTo: 'merchant_bank_iban_eur',
      raw: data,
    };
  }

  if (env.demo) {
    const ref = `SEPA-${String(orderId).replace(/[^a-zA-Z0-9]/g, '').slice(-10).toUpperCase()}`;
    const qs =
      `orderId=${encodeURIComponent(orderId)}` +
      `&amount=${encodeURIComponent(String(amount))}` +
      `&email=${encodeURIComponent(email || '')}` +
      `&ref=${encodeURIComponent(ref)}`;
    const paymentUrl = `/sepa-setup?${qs}`;
    return {
      configured: true,
      demo: true,
      production: false,
      sessionId: `setup_${orderId}`,
      referenceId: ref,
      paymentUrl,
      amount,
      currency: 'EUR',
      orderId,
      raw: { setup: true, referenceId: ref },
    };
  }

  const err = new Error(
    'GetBlitz SEPA Instant nie je nastavený. Dodajte GETBLITZ_URL + GETBLITZ_API_KEY a pripojte Qonto/Revolut Business/Wise. Detail: SEPA-STATUS.md'
  );
  err.code = 'NOT_CONFIGURED';
  throw err;
}

module.exports = {
  isConfigured,
  hasProduction,
  status,
  createChallenge,
  getEnv,
};
