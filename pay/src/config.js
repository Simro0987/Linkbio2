'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const configPath = path.join(__dirname, '..', 'config.json');
let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  fileConfig = {};
}

const config = {
  merchantWallet:
    process.env.MERCHANT_WALLET || fileConfig.merchantWallet || '',
  affiliateWallet:
    process.env.AFFILIATE_WALLET || fileConfig.affiliateWallet || '',
  callbackBaseUrl: (
    process.env.CALLBACK_BASE_URL ||
    fileConfig.callbackBaseUrl ||
    'https://YOUR_VERCEL_DOMAIN/callback'
  ).replace(/\/$/, ''),
  apiBase: (
    process.env.API_BASE ||
    fileConfig.apiBase ||
    'https://api.chain2pay.net/control'
  ).replace(/\/$/, ''),
  checkoutBase: (
    process.env.CHECKOUT_BASE ||
    fileConfig.checkoutBase ||
    'https://checkout.chain2pay.net'
  ).replace(/\/$/, ''),
  port: Number(process.env.PORT || fileConfig.port || 3847),
  currencyConstraints: fileConfig.currencyConstraints || {},

  // Optional open-source / EU gateways (placeholders OK)
  btcpayUrl: (
    process.env.BTCPAY_URL ||
    process.env.BTCPay_URL ||
    fileConfig.btcpayUrl ||
    ''
  )
    .trim()
    .replace(/\/$/, ''),
  btcpayStoreId: (
    process.env.BTCPAY_STORE_ID ||
    fileConfig.btcpayStoreId ||
    ''
  ).trim(),
  btcpayApiKey: (process.env.BTCPAY_API_KEY || '').trim(),

  btcpayStoreSlug: (
    process.env.BTCPAY_STORE_SLUG ||
    fileConfig.btcpayStoreSlug ||
    ''
  ).trim(),
  btcpayStorePage: (
    process.env.BTCPAY_STORE_PAGE ||
    fileConfig.btcpayStorePage ||
    ''
  )
    .trim()
    .replace(/\/$/, ''),

  getblitzUrl: (process.env.GETBLITZ_URL || '').trim().replace(/\/$/, ''),
  getblitzApiKey: (process.env.GETBLITZ_API_KEY || '').trim(),

  mollieApiKey: (process.env.MOLLIE_API_KEY || '').trim(),

  // chain2pay.is Dashboard API (separate from .net API_BASE)
  chain2payIsApiKey: (process.env.CHAIN2PAY_IS_API_KEY || '').trim(),
  chain2payIsApiBase: (
    process.env.CHAIN2PAY_IS_API_BASE ||
    'https://chain2pay.is/api/v2'
  )
    .trim()
    .replace(/\/$/, ''),
};

if (!config.merchantWallet || !/^0x[a-fA-F0-9]{40}$/.test(config.merchantWallet)) {
  throw new Error(
    'Invalid MERCHANT_WALLET — set env MERCHANT_WALLET to a Polygon USDC address (recommended: 0x0A6336C680AF9D3C6b54A77BCAC7C552cD62708d)'
  );
}

module.exports = config;
