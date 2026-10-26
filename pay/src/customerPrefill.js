'use strict';

/**
 * Customer profile handling.
 * NO generated / placeholder identities. Customers enter their OWN name, address,
 * phone and email directly at the regulated provider (Switchere, Banxa, Revolut,
 * Ramp, Guardarian, …). We only pass through what the customer typed themselves.
 */

function normalizeCountry(country) {
  return String(country || 'SK').trim().toUpperCase().slice(0, 2) === 'CZ' ? 'CZ' : 'SK';
}

/** Pass-through of customer-supplied email + country only. Never invents data. */
function resolveCustomerProfile(input = {}, country) {
  const raw = input && typeof input === 'object' ? input : {};
  const cc = normalizeCountry(raw.country || country || 'SK');
  return {
    country: cc,
    countryLabel: cc === 'CZ' ? 'Česko' : 'Slovensko',
    email: raw.email ? String(raw.email).trim() : undefined,
    source: 'customer',
  };
}

const PROVIDER_PREFILL = {
  banxa: { email: 'customer_own', nameAddress: false },
  revolut: { email: false, countryCode: true, nameAddress: false },
  switchere: { email: 'customer_own', country: true, nameAddress: false },
};

module.exports = { resolveCustomerProfile, normalizeCountry, PROVIDER_PREFILL };
