'use strict';

/**
 * LIVE Electrocoin.eu SEPA automation (Playwright + temp mail + BTCPay).
 *
 * Customer checkout: meno + priezvisko + suma (no customer email).
 * Server: temp inbox → fill Electrocoin → captcha hold → Execute exchange →
 * email link → extract IBAN block → customer pay page (timer −2–3 min) →
 * Zaplatené + screenshot → re-upload proof on Electrocoin.
 *
 * Target: https://electrocoin.eu/en/buy?send=EUR&receive=BTC&receive_protocol=BTC_BTC&send_method=sepa&receive_method=coin
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const addressPool = require('./addressPool');
const destination = require('./destination');
const btcpay = require('./btcpay');

const ROOT = path.join(__dirname, '..');
const IS_SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
);
const DATA_DIR = IS_SERVERLESS
  ? path.join('/tmp', 'chain2pay-data')
  : path.join(ROOT, 'data');
const TEMP_EMAIL_DIR = path.join(DATA_DIR, 'temp-emails');
const UPLOAD_DIR = path.join(DATA_DIR, 'sepa-uploads');
const SESSION_DIR = path.join(DATA_DIR, 'electrocoin-sessions');
const BUY_URL =
  'https://electrocoin.eu/en/buy?send=EUR&receive=BTC&receive_protocol=BTC_BTC&send_method=sepa&receive_method=coin';

/** In-memory Playwright handles keyed by orderId (not serializable). */
const liveSessions = new Map();

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

function customerTimerBufferMinutes() {
  const n = Number(env('SEPA_CUSTOMER_TIMER_BUFFER_MINUTES', '2.5'));
  if (!Number.isFinite(n) || n < 1) return 2.5;
  if (n > 10) return 10;
  return n;
}

function confirmSecret() {
  return env('SEPA_CONFIRM_SECRET') || env('ADMIN_CONFIRM_SECRET');
}

function chromePath() {
  return (
    env('PLAYWRIGHT_CHROME_PATH') ||
    env('CHROME_PATH') ||
    '/usr/bin/google-chrome-stable'
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function persistSessionMeta(orderId, meta) {
  ensureDir(SESSION_DIR);
  const file = path.join(SESSION_DIR, `${orderId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2));
  return file;
}

function loadSessionMeta(orderId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${orderId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/* -------------------- Temp email providers -------------------- */

async function createMailTm() {
  const domainsRes = await fetch('https://api.mail.tm/domains');
  if (!domainsRes.ok) throw new Error(`mail.tm domains ${domainsRes.status}`);
  const domains = await domainsRes.json();
  const domain = (domains['hydra:member'] || []).find((d) => d.isActive)?.domain;
  if (!domain) throw new Error('mail.tm: no active domain');
  const address = `ec${crypto.randomBytes(6).toString('hex')}@${domain}`;
  const password = `Ec${crypto.randomBytes(8).toString('hex')}A1!`;
  const create = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (!create.ok) throw new Error(`mail.tm create ${create.status} ${await create.text()}`);
  const tok = await (
    await fetch('https://api.mail.tm/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password }),
    })
  ).json();
  if (!tok.token) throw new Error('mail.tm: no token');
  return {
    provider: 'mail.tm',
    address,
    password,
    token: tok.token,
    readable: true,
    note: 'API receive works; Electrocoin may warn "Potentially incorrect email" — click Execute again to acknowledge.',
  };
}

async function createGuerrilla() {
  const r = await (
    await fetch('https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=en')
  ).json();
  if (!r.email_addr || !r.sid_token) throw new Error('guerrillamail create failed');
  return {
    provider: 'guerrillamail',
    address: r.email_addr,
    sid: r.sid_token,
    readable: true,
    note: 'API receive works; Electrocoin often flags as potentially incorrect — prefer mail.tm + re-Execute.',
  };
}


async function createTempMailLol() {
  const r = await (await fetch('https://api.tempmail.lol/generate')).json();
  if (!r.address || !r.token) throw new Error('tempmail.lol generate failed');
  return {
    provider: 'tempmail.lol',
    address: r.address,
    token: r.token,
    readable: true,
    note: 'Primary — create + inbox API; prefer over mail.tm delivery flakiness',
  };
}

async function pollTempMailLol(token, { timeoutMs = 45000, everyMs = 1200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await (
      await fetch(`https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(token)}`)
    ).json();
    const list = r.emails || r || [];
    const arr = Array.isArray(list) ? list : [];
    for (const m of arr) {
      const html = m.html || m.body || m.message || '';
      const text = m.text || m.body || '';
      const subject = m.subject || '';
      if (/electrocoin|purchase|EUR|BTC|order/i.test(`${subject} ${html} ${text}`)) {
        return { subject, from: m.from || m.sender, html, text };
      }
    }
    if (arr.length) {
      const m = arr[0];
      return {
        subject: m.subject || '',
        from: m.from || m.sender,
        html: m.html || m.body || m.message || '',
        text: m.text || m.body || '',
      };
    }
    await sleep(everyMs);
  }
  return null;
}

async function createTempMailIo() {
  const r = await (
    await fetch('https://api.internal.temp-mail.io/api/v3/email/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: '{}',
    })
  ).json();
  if (!r.email || !r.token) throw new Error('temp-mail.io create failed');
  return {
    provider: 'temp-mail.io',
    address: r.email,
    token: r.token,
    readable: true,
  };
}

async function pollTempMailIo(mailbox, { timeoutMs = 45000, everyMs = 1200 } = {}) {
  const start = Date.now();
  const email = mailbox.address;
  const token = mailbox.token;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `https://api.internal.temp-mail.io/api/v3/email/${encodeURIComponent(email)}/messages`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }
    );
    const list = await res.json().catch(() => []);
    const arr = Array.isArray(list) ? list : list.messages || [];
    if (arr.length) {
      const m = arr[0];
      // may need body fetch
      let html = m.body_html || m.html || m.body || '';
      let text = m.body_text || m.text || m.body || '';
      if (m.id && !html && !/electrocoin\.eu\/en\/order/.test(text)) {
        const full = await (
          await fetch(
            `https://api.internal.temp-mail.io/api/v3/email/${encodeURIComponent(email)}/messages/${m.id}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
            }
          )
        ).json().catch(() => ({}));
        html = full.body_html || full.html || html;
        text = full.body_text || full.text || text;
      }
      return { subject: m.subject || '', from: m.from || '', html, text };
    }
    await sleep(everyMs);
  }
  return null;
}

/**
 * Create a readable temp inbox. Prefer tempmail.lol (delivery) → temp-mail.io → mail.tm → Guerrilla.
 * beeinbox.com / tempmailso.com: no stable public read API — not used.
 */
async function createTempEmail() {
  const errors = [];
  // Prefer providers that deliver to Electrocoin; mail.tm often never arrives.
  for (const [name, fn] of [
    ['tempmail.lol', createTempMailLol],
    ['temp-mail.io', createTempMailIo],
    ['mail.tm', createMailTm],
    ['guerrillamail', createGuerrilla],
  ]) {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  const err = new Error(
    `Dočasný email sa nepodarilo vytvoriť (${errors.join('; ')}). Metóda dočasne nedostupná.`
  );
  err.code = 'TEMP_EMAIL_FAILED';
  throw err;
}

async function pollMailTm(token, { timeoutMs = 45000, everyMs = 1200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = await (
      await fetch('https://api.mail.tm/messages', {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    const list = msgs['hydra:member'] || [];
    if (list.length) {
      const full = await (
        await fetch(`https://api.mail.tm/messages/${list[0].id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      return {
        subject: full.subject,
        from: full.from,
        html: Array.isArray(full.html) ? full.html.join('\n') : full.html || '',
        text: full.text || '',
      };
    }
    await sleep(everyMs);
  }
  return null;
}

async function pollGuerrilla(sid, { timeoutMs = 45000, everyMs = 1200 } = {}) {
  const start = Date.now();
  let seq = 0;
  while (Date.now() - start < timeoutMs) {
    const r = await (
      await fetch(
        `https://api.guerrillamail.com/ajax.php?f=check_email&sid_token=${encodeURIComponent(sid)}&seq=${seq}`
      )
    ).json();
    for (const m of r.list || []) {
      seq = Math.max(seq, Number(m.mail_id) || 0);
      if (/electrocoin|purchase|EUR|BTC/i.test(`${m.mail_subject} ${m.mail_from}`)) {
        const full = await (
          await fetch(
            `https://api.guerrillamail.com/ajax.php?f=fetch_email&sid_token=${encodeURIComponent(sid)}&email_id=${m.mail_id}`
          )
        ).json();
        return {
          subject: full.mail_subject || m.mail_subject,
          from: full.mail_from || m.mail_from,
          html: full.mail_body || '',
          text: full.mail_body || '',
        };
      }
    }
    await sleep(everyMs);
  }
  return null;
}

async function pollTempInbox(mailbox, opts) {
  if (mailbox.provider === 'tempmail.lol') return pollTempMailLol(mailbox.token, opts);
  if (mailbox.provider === 'temp-mail.io') return pollTempMailIo(mailbox, opts);
  if (mailbox.provider === 'mail.tm') return pollMailTm(mailbox.token, opts);
  if (mailbox.provider === 'guerrillamail') return pollGuerrilla(mailbox.sid, opts);
  return null;
}

function extractOrderLink(htmlOrText) {
  const s = String(htmlOrText || '');
  const links = s.match(/https?:\/\/electrocoin\.eu\/en\/order\/[A-Za-z0-9_\-]+/gi) || [];
  return (links[0] || '').replace(/&amp;/g, '&') || null;
}

/* -------------------- BTC destination -------------------- */

function nextBtcDestination(orderId) {
  return addressPool.nextAddress('btc', orderId ? { orderId } : {});
}

function nextPoolDestination(orderId) {
  return destination.pickDestination({
    orderId,
    provider: 'switchere',
    allowEvmFallback: false,
  });
}

async function resolveBtcPayDestination(opts) {
  if (btcpay.isConfigured && btcpay.isConfigured()) {
    try {
      const inv = await btcpay.createInvoiceWithOnChain(
        opts.amountEur,
        opts.email,
        opts.orderId,
        { sepaManual: true, electrocoin: true }
      );
      return {
        source: 'btcpay',
        address: inv.btcAddress,
        btcAmount: inv.btcAmount,
        invoiceId: inv.invoiceId,
        checkoutLink: inv.checkoutLink || null,
        paymentLink: inv.paymentLink || null,
        index: null,
      };
    } catch (e) {
      const payout = nextBtcDestination(opts.orderId);
      return {
        source: 'pool_fallback',
        error: e.message,
        address: payout.address,
        btcAmount: null,
        invoiceId: null,
        checkoutLink: null,
        paymentLink: null,
        index: payout.index,
      };
    }
  }
  const payout = nextBtcDestination(opts.orderId);
  return {
    source: 'pool',
    address: payout.address,
    btcAmount: null,
    invoiceId: null,
    checkoutLink: null,
    paymentLink: null,
    index: payout.index,
  };
}

/* -------------------- Playwright / captcha -------------------- */

async function launchBrowser() {
  const { chromium } = require('playwright');
  const cdp = env('ELECTROCOIN_CDP_URL'); // e.g. http://127.0.0.1:9225
  if (cdp) {
    try {
      const browser = await chromium.connectOverCDP(cdp);
      const context = browser.contexts()[0] || (await browser.newContext());
      return { browser, context, shared: true };
    } catch (e) {
      /* fall through to launch */
    }
  }
  const browser = await chromium.launch({
    headless: boolEnv('ELECTROCOIN_HEADLESS') || false,
    executablePath: chromePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1365, height: 950 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Europe/Zagreb',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  return { browser, context, shared: false };
}

async function turnstileTokenLen(page) {
  return page.evaluate(
    () => (document.querySelector('[name="cf-turnstile-response"]') || {}).value?.length || 0
  );
}

/**
 * Cloudflare Turnstile (sitekey 0x4AAAAAAASAU4ihWwXx7e-B).
 * Widget: checkbox / managed — real mouse press-and-hold until token fills.
 */
async function solveTurnstile(page, { maxHoldMs = 18000, rounds = 3 } = {}) {
  const report = { widget: 'cloudflare-turnstile', sitekey: '0x4AAAAAAASAU4ihWwXx7e-B', solved: false, method: null };
  for (let round = 0; round < rounds; round++) {
    let len = await turnstileTokenLen(page);
    if (len > 20) {
      report.solved = true;
      report.method = round === 0 ? 'already-token' : `hold-round-${round}`;
      return report;
    }
    const loc = page
      .locator(
        'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], #recaptcha-container, #captcha-en'
      )
      .first();
    await loc.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
    const box = await loc.boundingBox().catch(() => null);
    if (!box) {
      await sleep(600);
      continue;
    }
    const x = box.x + Math.min(30, Math.max(12, box.width * 0.12));
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await sleep(80);
    await page.mouse.down();
    const holdMs = maxHoldMs + round * 3000;
    const start = Date.now();
    while (Date.now() - start < holdMs) {
      await page.mouse.move(x + Math.sin((Date.now() - start) / 180), y + Math.cos((Date.now() - start) / 180));
      await sleep(80);
      if ((await turnstileTokenLen(page)) > 20) break;
    }
    await page.mouse.up();
    for (let i = 0; i < 20; i++) {
      if ((await turnstileTokenLen(page)) > 20) {
        report.solved = true;
        report.method = `press-and-hold-${holdMs}ms-round-${round}`;
        return report;
      }
      await sleep(500);
    }
    // extra: click then hold again
    await page.mouse.click(x, y, { delay: 40 });
    await sleep(250);
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 0; i < 80; i++) {
      await sleep(80);
      if ((await turnstileTokenLen(page)) > 20) break;
      await page.mouse.move(x + Math.sin(i / 9), y + Math.cos(i / 9));
    }
    await page.mouse.up();
    if ((await turnstileTokenLen(page)) > 20) {
      report.solved = true;
      report.method = `click-then-hold-round-${round}`;
      return report;
    }
  }
  const finalLen = await turnstileTokenLen(page);
  if (finalLen > 20) {
    report.solved = true;
    report.method = 'token-after-wait';
  }
  return report;
}

function parseBankFromOrderPageText(text) {
  const raw = String(text || '');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const after = (label) => {
    const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
    if (i < 0) return null;
    // Skip "Copy" / empty decorative lines
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const v = lines[j];
      if (!v || /^copy$/i.test(v)) continue;
      return v;
    }
    return null;
  };
  const timerMin =
    Number((raw.match(/Time remaining:\s*([0-9]+)\s*minutes?/i) || [])[1]) || null;
  let amountRaw = after('AMOUNT') || '';
  if (!amountRaw) {
    const am = raw.match(/AMOUNT\s*\n\s*([\d.,]+\s*EUR)/i) || raw.match(/\b([\d.,]+)\s*EUR\b/i);
    amountRaw = am ? am[1] : '';
  }
  const amountMatch = amountRaw.match(/([\d.,]+)/);
  const amountEur = amountMatch
    ? Number(String(amountMatch[1]).replace(',', '.'))
    : null;

  // Label-based first, then regex fallbacks (CF/SPA sometimes mangled labels)
  let iban = after('RECIPIENT BANK ACCOUNT NUMBER (IBAN)');
  if (!iban || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/i.test(iban.replace(/\s+/g, ''))) {
    const m =
      raw.match(
        /RECIPIENT BANK ACCOUNT NUMBER \(IBAN\)\s*\n\s*([A-Z]{2}\d{2}[A-Z0-9\s]+)/i
      ) || raw.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/);
    iban = m ? m[1].replace(/\s+/g, '') : null;
  } else {
    iban = iban.replace(/\s+/g, '');
  }

  let beneficiary = after('RECIPIENT');
  if (!beneficiary || /bank account|iban|address/i.test(beneficiary)) {
    const m = raw.match(/\bRECIPIENT\b\s*\n\s*([^\n]+)/i);
    beneficiary = m ? m[1].trim() : beneficiary;
  }
  if (beneficiary && /^(copy|address|amount)$/i.test(beneficiary)) beneficiary = null;

  let beneficiaryAddress = after('ADDRESS');
  if (!beneficiaryAddress) {
    const m = raw.match(/\bADDRESS\b\s*\n\s*([^\n]+)/i);
    beneficiaryAddress = m ? m[1].trim() : null;
  }

  let reference =
    after('PURPOSE/DESCRIPTION') || after('TRANSACTION ID (REFERENCE)');
  if (!reference) {
    const m =
      raw.match(/PURPOSE\/DESCRIPTION\s*\n\s*([0-9A-Z\-]{6,})/i) ||
      raw.match(/TRANSACTION ID \(REFERENCE\)\s*\n\s*([0-9A-Z\-]{6,})/i) ||
      raw.match(/Order #([0-9A-Z\-]+)/i);
    reference = m ? m[1].trim() : null;
  }

  const orderRef = (raw.match(/Order #([0-9A-Z\-]+)/i) || [])[1] || null;

  return {
    iban: iban || null,
    beneficiary: beneficiary || null,
    beneficiaryAddress: beneficiaryAddress || null,
    amountLabel: amountRaw,
    amountEur: Number.isFinite(amountEur) ? amountEur : null,
    reference: reference || orderRef,
    orderRef,
    timerMinutesRaw: timerMin,
  };
}

function applyCustomerDeadline(order, electrocoinDeadlineAt, rawMinutes) {
  const bufferMin = customerTimerBufferMinutes();
  const rawMs = electrocoinDeadlineAt
    ? Date.parse(electrocoinDeadlineAt)
    : Date.now() + (Number(rawMinutes) || 13) * 60 * 1000;
  const customerMs = rawMs - bufferMin * 60 * 1000;
  order.electrocoinDeadlineAt = new Date(rawMs).toISOString();
  order.deadlineAt = new Date(Math.max(Date.now() + 60_000, customerMs)).toISOString();
  order.deadlineMinutes = Math.max(
    1,
    Math.round((Date.parse(order.deadlineAt) - Date.now()) / 60000)
  );
  order.electrocoinTimerMinutesRaw = rawMinutes || null;
  order.customerTimerBufferMinutes = bufferMin;
  return order;
}

async function fillAndExecuteElectrocoin(page, { email, btcAddress, amountEur }) {
  await page.goto(BUY_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(700);
  const accept = page.getByRole('button', { name: /Accept all/i });
  if (await accept.isVisible().catch(() => false)) await accept.click().catch(() => {});

  await page.locator('#label_direct_src').click();
  await page.locator('#label_direct_src').fill(String(Number(amountEur).toFixed(2)));
  await sleep(500);
  await page.waitForSelector('#email-input', { timeout: 15000 });
  await page.locator('#email-input').fill(email);
  await page.locator('#send_coin_address-input').fill(btcAddress);
  if (!(await page.locator('#tos_checkbox').isChecked().catch(() => false))) {
    await page.locator('#tos_checkbox').evaluate((el) => el.click());
  }

  const captcha = await solveTurnstile(page);
  if (!captcha.solved && (await turnstileTokenLen(page)) < 20) {
    const err = new Error(
      'Cloudflare Turnstile sa nepodarilo vyriešiť (verify you are human). Metóda dočasne nedostupná.'
    );
    err.code = 'CAPTCHA_FAILED';
    err.captcha = captcha;
    throw err;
  }

  await page.locator('#exchange_button').click();
  await sleep(1200);
  let body = await page.evaluate(() => document.body.innerText);
  // "Potentially incorrect email" → Execute again (Electrocoin acknowledge)
  if (/Potentially incorrect email|incorrect email/i.test(body)) {
    await page.locator('#exchange_button').click();
    await sleep(1800);
    body = await page.evaluate(() => document.body.innerText);
  }
  if (/unable to confirm that you are a human/i.test(body)) {
    const err = new Error('Electrocoin odmietol captcha token. Skúste znova.');
    err.code = 'CAPTCHA_REJECTED';
    throw err;
  }
  // Wait for check-email OR direct order page (prefer order)
  for (let i = 0; i < 40; i++) {
    if (/\/en\/order\//i.test(page.url())) break;
    if (/check-email/i.test(page.url())) break;
    if (/unable to confirm/i.test(await page.evaluate(() => document.body.innerText))) {
      const err = new Error('Captcha zlyhala po Execute exchange.');
      err.code = 'CAPTCHA_REJECTED';
      throw err;
    }
    await sleep(400);
  }
  if (!/check-email|\/en\/order\//i.test(page.url())) {
    const err = new Error(
      `Electrocoin neprešiel na check-email (url=${page.url()}). Bankové údaje nie sú k dispozícii.`
    );
    err.code = 'EXECUTE_FAILED';
    throw err;
  }
  return { captcha, url: page.url() };
}

async function openOrderAndExtract(page, orderUrl) {
  // Prefer staying on current order tab if already there
  const wantId = orderUrl ? String(orderUrl).split('/').pop() : '';
  if (!/\/en\/order\//i.test(page.url()) || (wantId && !page.url().includes(wantId))) {
    await page.goto(orderUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }

  let pageText = '';
  let bank = { iban: null, beneficiary: null };
  const deadline = Date.now() + 45000;
  let solvedChallenge = false;

  while (Date.now() < deadline) {
    pageText = await page.evaluate(() => document.body.innerText);
    if (
      !solvedChallenge &&
      /Confirming you are not a robot|Verify you are human|just a moment/i.test(pageText)
    ) {
      await solveTurnstile(page, { maxHoldMs: 18000, rounds: 3 });
      solvedChallenge = true;
      await sleep(1000);
      continue;
    }
    if (/^\s*Loading\.?\.?\.?\s*$/im.test(pageText) || /\nLoading\.\.\.\n/i.test(pageText)) {
      await sleep(700);
      continue;
    }
    bank = parseBankFromOrderPageText(pageText);
    if (bank.iban && bank.beneficiary) break;
    // Payment instructions visible but parse missed — brief wait then retry
    if (/Payment instructions|PURPOSE\/DESCRIPTION|I have paid/i.test(pageText)) {
      await sleep(600);
      pageText = await page.evaluate(() => document.body.innerText);
      bank = parseBankFromOrderPageText(pageText);
      if (bank.iban && bank.beneficiary) break;
    }
    await sleep(800);
  }

  if (!bank.iban || !bank.beneficiary) {
    const err = new Error(
      'Nepodarilo sa extrahovať IBAN/príjemcu z Electrocoin — nezobrazujeme falošné údaje.'
    );
    err.code = 'BANK_EXTRACT_FAILED';
    err.snippet = pageText.slice(0, 1500);
    err.orderUrl = orderUrl || page.url();
    throw err;
  }
  return { bank, text: pageText, url: page.url() };
}

/**
 * Mark paid on Electrocoin and upload customer proof screenshot.
 * @returns {{ ok: boolean, url: string, stage: string, detail?: string }}
 */
async function uploadProofToElectrocoin(order, screenshotPath) {
  if (!order.electrocoinOrderUrl) {
    return { ok: false, stage: 'no_order_url', detail: 'Chýba Electrocoin order URL' };
  }
  if (!screenshotPath || !fs.existsSync(screenshotPath)) {
    return { ok: false, stage: 'no_file', detail: 'Chýba screenshot súbor' };
  }

  let browserWrap = liveSessions.get(order.orderId);
  let page;
  let openedHere = false;
  try {
    if (browserWrap?.page && !browserWrap.page.isClosed?.()) {
      page = browserWrap.page;
    } else {
      browserWrap = await launchBrowser();
      page = await browserWrap.context.newPage();
      openedHere = true;
      liveSessions.set(order.orderId, { ...browserWrap, page });
    }

    await page.goto(order.electrocoinOrderUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await sleep(2500);

    const text0 = await page.evaluate(() => document.body.innerText);
    if (/Canceled|Cancelled/i.test(text0)) {
      return { ok: false, stage: 'canceled', url: page.url(), detail: 'Electrocoin order is canceled' };
    }

    // I have paid!
    const paid = page.getByRole('button', { name: /I have paid/i });
    if (await paid.isVisible().catch(() => false)) {
      await paid.click();
      await sleep(1500);
    }
    // Confirm payment dialog
    const confirm1 = page.getByRole('button', { name: /^Confirm$/i });
    if (await confirm1.isVisible().catch(() => false)) {
      await confirm1.click();
      await sleep(2000);
    }

    // Wait for proof upload UI (appears after Confirm payment)
    await page.waitForSelector('input[type=file], text=Select a file', { timeout: 15000 }).catch(() => {});
    await sleep(800);
    const fileInputs = page.locator('input[type=file]');
    let count = await fileInputs.count();
    let set = false;
    for (let i = 0; i < count; i++) {
      try {
        await fileInputs.nth(i).setInputFiles(screenshotPath);
        set = true;
        break;
      } catch {
        /* try next */
      }
    }
    if (!set) {
      const chooserP = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
      await page.getByText(/Select a file/i).first().click().catch(() => {});
      const chooser = await chooserP;
      if (chooser) {
        await chooser.setFiles(screenshotPath);
        set = true;
      }
    }
    if (!set) {
      return {
        ok: false,
        stage: 'no_file_input',
        url: page.url(),
        detail: 'Electrocoin upload pole nenájdené',
      };
    }
    await sleep(1500);
    // Confirm upload
    const confirm2 = page.getByRole('button', { name: /^Confirm$/i });
    if (await confirm2.isVisible().catch(() => false)) {
      await confirm2.click();
      await sleep(4000);
    }
    const text = await page.evaluate(() => document.body.innerText);
    ensureDir(path.join(SESSION_DIR, 'shots'));
    const shot = path.join(SESSION_DIR, 'shots', `${order.orderId}-after-upload.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    if (/Canceled|Cancelled/i.test(text)) {
      return { ok: false, stage: 'canceled', url: page.url(), detail: text.slice(0, 500), screenshotPath: shot };
    }
    if (/Select a file \(max/i.test(text)) {
      return { ok: false, stage: 'still_select', url: page.url(), detail: text.slice(0, 500), screenshotPath: shot };
    }
    return {
      ok: true,
      stage: 'uploaded',
      url: page.url(),
      detail: text.slice(0, 500),
      screenshotPath: shot,
    };
  } catch (e) {
    return { ok: false, stage: 'error', detail: e.message, url: order.electrocoinOrderUrl };
  } finally {
    if (openedHere && browserWrap && !browserWrap.shared) {
      // keep session for possible retry — do not close immediately
    }
  }
}

/* -------------------- Order build / automation -------------------- */

function isConfigured() {
  return true;
}

function status() {
  return {
    id: 'bank_sepa_manual',
    provider_name: 'SEPA Elektrocoin',
    configured: true,
    hint: 'Automatický SEPA prevod · meno + priezvisko + suma · po platbe screenshot',
    methods: ['sepa', 'bank_transfer'],
    liveElectrocoin: true,
    customerTimerBufferMinutes: customerTimerBufferMinutes(),
    confirmSecretSet: Boolean(confirmSecret()),
    btcpayConfigured: Boolean(btcpay.isConfigured && btcpay.isConfigured()),
    tempEmailProviders: {
      'tempmail.lol': 'OK — primary (create + inbox)',
      'temp-mail.io': 'OK — secondary',
      'mail.tm': 'FALLBACK — create + read (delivery often flaky)',
      guerrillamail: 'OK — create + read API (fallback; often flagged by Electrocoin)',
      'beeinbox.com': 'SKIP — no stable programmatic inbox read API',
      'tempmailso.com': 'SKIP — Livewire UI only, no public read API',
    },
    destinationNote:
      'SEPA Elektrocoin settles via BTCPay bc1 (BTC). Customer never sees BTC/email/Electrocoin URL.',
  };
}

/**
 * @param {{ orderId: string, amountEur: number, firstName: string, lastName: string, email?: string }} opts
 */
async function buildOrder(opts) {
  const orderId = opts.orderId;
  const amountEur = Number(opts.amountEur);
  const firstName = String(opts.firstName || '').trim();
  const lastName = String(opts.lastName || '').trim();
  if (!Number.isFinite(amountEur) || amountEur < 5) {
    const err = new Error('Suma v EUR musí byť aspoň 5');
    err.code = 'BAD_AMOUNT';
    throw err;
  }
  if (!firstName || !lastName) {
    const err = new Error('Meno a priezvisko sú povinné');
    err.code = 'BAD_NAME';
    throw err;
  }

  const mailbox = await createTempEmail();
  ensureDir(TEMP_EMAIL_DIR);
  fs.writeFileSync(
    path.join(TEMP_EMAIL_DIR, `${orderId}.mailbox.json`),
    JSON.stringify({ ...mailbox, orderId, createdAt: new Date().toISOString() }, null, 2)
  );

  const dest = await resolveBtcPayDestination({
    orderId,
    amountEur,
    email: mailbox.address,
  });

  const createdAt = new Date();
  const order = {
    orderId,
    amountEur,
    amount: amountEur,
    amountExact: amountEur.toFixed(2),
    currency: 'EUR',
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email: mailbox.address,
    customerEmail: null,
    tempMailbox: {
      provider: mailbox.provider,
      address: mailbox.address,
      // secrets kept server-side only in mailbox file / session
    },
    provider: 'bank_sepa_manual',
    gateway: 'bank_sepa_manual',
    bank: null,
    bankDetailsPublic: false,
    status: 'automating',
    automationStage: 'starting',
    automationError: null,
    captcha: null,
    payoutAddress: dest.address,
    payoutCoin: 'btc',
    payoutIndex: dest.index,
    btcAddress: dest.address,
    btcAmount: dest.btcAmount,
    invoiceId: dest.invoiceId,
    btcpayCheckout: dest.checkoutLink,
    paymentLink: dest.paymentLink,
    btcSource: dest.source,
    btcSourceError: dest.error || null,
    electrocoinOrderUrl: null,
    electrocoinReference: null,
    reference: null,
    createdAt: createdAt.toISOString(),
    deadlineAt: null,
    electrocoinDeadlineAt: null,
    deadlineMinutes: null,
    screenshotPath: null,
    screenshotUploadedAt: null,
    screenshotConfirmedByCustomer: false,
    electrocoinProofUpload: null,
    paidMarkedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    resolution: 'electrocoin_live_sepa',
    providerHost: 'electrocoin.eu',
    inspiredBy: BUY_URL,
  };

  persistSessionMeta(orderId, {
    orderId,
    mailbox: {
      provider: mailbox.provider,
      address: mailbox.address,
      password: mailbox.password || null,
      token: mailbox.token || null,
      sid: mailbox.sid || null,
    },
    btcAddress: dest.address,
  });

  return order;
}

/**
 * Background automation. Mutates order via onUpdate callback (persist).
 */
async function runAutomation(order, { onUpdate } = {}) {
  const save = async (patch) => {
    Object.assign(order, patch);
    if (typeof onUpdate === 'function') await onUpdate(order);
  };

  try {
    await save({ status: 'automating', automationStage: 'browser' });
    const meta = loadSessionMeta(order.orderId);
    const mailbox = meta?.mailbox;
    if (!mailbox?.address) throw new Error('Chýba temp mailbox meta');

    const wrap = await launchBrowser();
    const page = await wrap.context.newPage();
    liveSessions.set(order.orderId, { ...wrap, page });

    await save({ automationStage: 'fill_execute' });
    // If Execute lands back on buy (no check-email), rotate temp email and retry
    // instead of failing permanently (Electrocoin often rejects certain domains).
    let exec = null;
    let activeMailbox = { ...mailbox };
    const maxEmailTries = 3;
    for (let tryN = 1; tryN <= maxEmailTries; tryN++) {
      try {
        exec = await fillAndExecuteElectrocoin(page, {
          email: activeMailbox.address,
          btcAddress: order.btcAddress,
          amountEur: order.amountEur,
        });
        break;
      } catch (e) {
        const onBuy =
          e.code === 'EXECUTE_FAILED' ||
          (/neprešiel na check-email/i.test(e.message || '') && /\/en\/buy/i.test(e.message || ''));
        if (!onBuy || tryN >= maxEmailTries) throw e;
        console.warn(
          '[electrocoin] Execute stayed on buy — retry with new email',
          order.orderId,
          `try=${tryN}`,
          activeMailbox.address
        );
        await save({
          automationStage: 'retry_email',
          automationError: null,
          status: 'automating',
        });
        const fresh = await createTempEmail();
        activeMailbox = {
          provider: fresh.provider,
          address: fresh.address,
          password: fresh.password || null,
          token: fresh.token || null,
          sid: fresh.sid || null,
        };
        ensureDir(TEMP_EMAIL_DIR);
        fs.writeFileSync(
          path.join(TEMP_EMAIL_DIR, `${order.orderId}.mailbox.json`),
          JSON.stringify({ ...fresh, orderId: order.orderId, createdAt: new Date().toISOString() }, null, 2)
        );
        persistSessionMeta(order.orderId, {
          orderId: order.orderId,
          mailbox: activeMailbox,
          btcAddress: order.btcAddress,
        });
        await save({
          email: fresh.address,
          tempMailbox: { provider: fresh.provider, address: fresh.address },
          automationStage: 'fill_execute',
        });
      }
    }
    // Prefer direct /en/order/ — skip email wait when already there
    let orderUrl = /\/en\/order\//i.test(exec.url || page.url())
      ? (exec.url || page.url()).split('?')[0]
      : null;

    if (orderUrl) {
      await save({
        automationStage: 'extract_bank',
        captcha: exec.captcha,
        electrocoinOrderUrl: orderUrl,
        status: 'extracting_bank',
      });
    } else {
      await save({
        automationStage: 'awaiting_email',
        captcha: exec.captcha,
        status: 'awaiting_email',
      });

      const fullMailbox = {
        provider: activeMailbox.provider,
        token: activeMailbox.token,
        sid: activeMailbox.sid,
        address: activeMailbox.address,
      };

      // Race: watch /en/order/ first; email is short fallback only (mail often never arrives)
      const mailPromise = pollTempInbox(fullMailbox, { timeoutMs: 35000, everyMs: 1000 });
      let msg = null;
      const raceStart = Date.now();
      while (Date.now() - raceStart < 35000) {
        if (/\/en\/order\//i.test(page.url())) {
          orderUrl = page.url().split('?')[0];
          break;
        }
        const settled = await Promise.race([
          mailPromise.then((m) => ({ m })),
          sleep(800).then(() => null),
        ]);
        if (settled && settled.m) {
          msg = settled.m;
          break;
        }
      }
      if (!orderUrl) {
        if (!msg) msg = await mailPromise;
        if (!msg) {
          const err = new Error('Electrocoin email s odkazom na platbu neprišiel včas.');
          err.code = 'EMAIL_TIMEOUT';
          throw err;
        }
        orderUrl = extractOrderLink(msg.html || msg.text);
      }
      if (!orderUrl) {
        const err = new Error('V Electrocoin emaile chýba odkaz na objednávku.');
        err.code = 'NO_ORDER_LINK';
        throw err;
      }
      await save({
        automationStage: 'extract_bank',
        electrocoinOrderUrl: orderUrl,
        status: 'extracting_bank',
      });
    }

    const { bank } = await openOrderAndExtract(page, orderUrl);
    applyCustomerDeadline(order, null, bank.timerMinutesRaw || 13);
    await save({
      status: 'awaiting_payment',
      automationStage: 'bank_ready',
      bank: {
        iban: bank.iban,
        bic: null,
        bankName: null,
        beneficiary: bank.beneficiary,
        beneficiaryAddress: bank.beneficiaryAddress,
        currency: 'EUR',
        purpose: bank.reference || bank.orderRef,
        paymentNote: bank.reference || bank.orderRef,
        reference: bank.reference || bank.orderRef,
      },
      reference: bank.reference || bank.orderRef,
      purpose: bank.reference || bank.orderRef,
      electrocoinReference: bank.orderRef || bank.reference,
      amountExact: bank.amountEur ? bank.amountEur.toFixed(2) : order.amountExact,
      amountEur: bank.amountEur || order.amountEur,
      bankDetailsPublic: true,
      deadlineAt: order.deadlineAt,
      electrocoinDeadlineAt: order.electrocoinDeadlineAt,
      deadlineMinutes: order.deadlineMinutes,
      electrocoinTimerMinutesRaw: order.electrocoinTimerMinutesRaw,
      customerTimerBufferMinutes: order.customerTimerBufferMinutes,
    });
    persistSessionMeta(order.orderId, {
      ...meta,
      mailbox: activeMailbox,
      electrocoinOrderUrl: orderUrl,
      bank,
      captcha: exec.captcha,
    });
    return order;
  } catch (e) {
    await save({
      status: 'automation_failed',
      automationStage: 'failed',
      automationError: e.message,
      automationErrorCode: e.code || null,
      captcha: e.captcha || order.captcha,
      bankDetailsPublic: false,
      bank: null,
    });
    throw e;
  }
}

function startAutomationBackground(order, { onUpdate } = {}) {
  const p = runAutomation(order, { onUpdate }).catch((e) => {
    console.error('[electrocoin] automation failed', order.orderId, e.message);
    return order;
  });
  liveSessions.set(order.orderId + ':promise', p);
  return p;
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

/** Customer-facing failure text — never leak Electrocoin URLs / technical detail. */
function publicAutomationError(order) {
  if (order.status !== 'automation_failed') return null;
  const code = order.automationErrorCode || '';
  if (code === 'CAPTCHA_FAILED' || code === 'CAPTCHA_REJECTED') {
    return 'Platba zlyhala. Skúste to znova o chvíľu.';
  }
  if (code === 'TEMP_EMAIL_FAILED' || code === 'EMAIL_TIMEOUT' || code === 'NO_ORDER_LINK') {
    return 'Dočasne nedostupné. Skúste neskôr alebo iný spôsob platby.';
  }
  if (code === 'EXECUTE_FAILED' || code === 'BANK_EXTRACT_FAILED') {
    return 'Dočasne nedostupné. Skúste neskôr alebo iný spôsob platby.';
  }
  return 'Platba zlyhala. Skúste neskôr alebo iný spôsob platby.';
}

/** Public customer-safe order view (no BTC, no temp email, no Electrocoin URL). */
function publicOrderView(order) {
  const expired = order.deadlineAt ? Date.now() > Date.parse(order.deadlineAt) : false;
  const showBank =
    Boolean(order.bank?.iban) &&
    ['awaiting_payment', 'awaiting_confirm', 'screenshot_uploaded', 'confirmed', 'paid'].includes(
      order.status
    );
  const bankReady = showBank;
  return {
    orderId: order.orderId,
    status: order.status,
    automationStage: order.automationStage || null,
    automationError: publicAutomationError(order),
    amountEur: order.amountEur,
    amountExact: order.amountExact,
    firstName: order.firstName,
    lastName: order.lastName,
    reference: bankReady ? order.reference : null,
    deadlineAt: order.deadlineAt,
    electrocoinDeadlineAt: undefined, // hidden
    deadlineMinutes: order.deadlineMinutes,
    bankDetailsPublic: Boolean(bankReady),
    bank: bankReady
      ? {
          beneficiary: order.bank.beneficiary,
          iban: order.bank.iban,
          amountExact: order.amountExact,
          reference: order.reference,
          purpose: order.purpose || order.reference,
          paymentNote: order.purpose || order.reference,
          beneficiaryAddress: order.bank.beneficiaryAddress || null,
        }
      : null,
    purpose: bankReady ? order.purpose || order.reference : null,
    screenshotUploadedAt: order.screenshotUploadedAt || null,
    screenshotConfirmedByCustomer: Boolean(order.screenshotConfirmedByCustomer),
    electrocoinProofUpload: order.electrocoinProofUpload
      ? { ok: order.electrocoinProofUpload.ok, stage: order.electrocoinProofUpload.stage }
      : null,
    confirmedAt: order.confirmedAt || null,
    expired,
    waitingMessage:
      order.status === 'automating' ||
      order.status === 'awaiting_email' ||
      order.status === 'extracting_bank'
        ? 'Pripravujeme bankové údaje… chvíľu strpenia.'
        : null,
  };
}

module.exports = {
  status,
  isConfigured,
  buildOrder,
  runAutomation,
  startAutomationBackground,
  resolveBtcPayDestination,
  saveScreenshot,
  uploadProofToElectrocoin,
  publicOrderView,
  publicAutomationError,
  confirmSecret,
  createTempEmail,
  customerTimerBufferMinutes,
  parseBankFromOrderPageText,
  applyCustomerDeadline,
  solveTurnstile,
  openOrderAndExtract,
  TEMP_EMAIL_DIR,
  UPLOAD_DIR,
  SESSION_DIR,
  BUY_URL,
  liveSessions,
};
