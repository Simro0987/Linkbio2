'use strict';
/**
 * SEPA bot chain — server-orchestrated multi-step Telegram flow.
 *
 * Default mode: channel relay (b). Ryan creates a private Telegram channel;
 * his bots + the payments bot (@Plat4Bot) are admins. The server posts each
 * step's request into the channel (preferring that step's token, else the
 * payments bot). Default channel text is just the amount (`{amount}`); no
 * `#ORDER`/`#STEP` tags. Replies are matched by `reply_to_message`, then FIFO
 * among pending waits on that step (ambiguous same-amount → alert Ryan). Proof
 * is posted as a reply to the order's amount message. Legacy markers still parse.
 * Waits for a
 * channel_post from the next step's bot (matched by @username). The payments
 * bot receives channel_post updates (webhook/polling allowed_updates).
 *
 * Fallback modes kept: "managed" (server getUpdates on step token) and
 * "external" (POST /api/sepa-chain/reply). Any timeout / parse / send failure
 * → existing @Plat4Bot notifySepaOrder so the customer is never stuck.
 *
 * Limit: Ryan's bots only react if their code handles channel posts; many
 * simple bots only read private messages. Admin "Test kanála" checks this.
 *
 * Secrets: bot tokens encrypted at rest (AES-256-GCM). Never logged in full.
 * Chain is off by default.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sepaManual = require('./sepaManual');

const API = 'https://api.telegram.org';
const FILE = path.join(__dirname, '..', 'data', 'sepa-bot-chain.json');
const TABLE = 'sepa_bot_chain';

const EXTRACT_PRESETS = {
  iban: { label: 'IBAN', keys: ['iban'] },
  amount: { label: 'Suma', keys: ['amount'] },
  beneficiary: { label: 'Meno príjemcu', keys: ['beneficiary'] },
  note: { label: 'Poznámka / PURPOSE', keys: ['note', 'purpose', 'paymentNote'] },
  deadline: { label: 'Termín splatnosti (minúty alebo ISO)', keys: ['deadline'] },
  email: { label: 'Email', keys: ['email'] },
  raw: { label: 'Celá odpoveď (prev_reply)', keys: ['raw'] },
};

const DEFAULT_TEMPLATE = '{amount}\n{ltc_address}';

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function encKey() {
  const raw = env('BACKUP_ENC_KEY') || env('SEPA_CHAIN_ENC_KEY') || env('ADMIN_SESSION_SECRET') || env('SESSION_SECRET');
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return crypto.createHmac('sha256', Buffer.from(raw, 'hex')).update('sepa-bot-chain-v1').digest();
  }
  return crypto.createHmac('sha256', raw).update('sepa-bot-chain-v1').digest();
}

function encryptSecret(plain) {
  const k = encKey();
  if (!k || !plain) return null;
  const iv = crypto.randomBytes(12);
  const ci = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([ci.update(String(plain), 'utf8'), ci.final()]);
  const tag = ci.getAuthTag();
  return Buffer.concat([Buffer.from('v1'), iv, tag, ct]).toString('base64');
}

function decryptSecret(blob) {
  if (!blob) return '';
  const k = encKey();
  if (!k) return '';
  try {
    const buf = Buffer.from(String(blob), 'base64');
    if (buf.slice(0, 2).toString() !== 'v1') return '';
    const iv = buf.slice(2, 14);
    const tag = buf.slice(14, 30);
    const ct = buf.slice(30);
    const de = crypto.createDecipheriv('aes-256-gcm', k, iv);
    de.setAuthTag(tag);
    return Buffer.concat([de.update(ct), de.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function maskToken(t) {
  const s = String(t || '');
  if (!s) return '';
  if (s.length <= 10) return '••••';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

const DEFAULT_VERDICT_PASS = ['OK', 'PREŠLO', 'PRESLO', 'ZAPLATENÉ', 'ZAPLATENE', 'PAID', 'APPROVED', 'PASS'];
const DEFAULT_VERDICT_FAIL = ['NEPREŠLO', 'NEPRESLO', 'ZAMIETNUTÉ', 'ZAMIETNUTE', 'REJECTED', 'FAIL', 'DENIED', 'NIE'];

function emptyConfig() {
  return {
    enabled: false,
    // channel | managed | external — default channel (option b)
    mode: 'channel',
    channelId: '',
    // Last channel_post chat id seen by payments bot (admin helper)
    lastSeenChannelId: '',
    lastSeenChannelTitle: '',
    lastSeenChannelAt: null,
    preparedEmail: '',
    // Dedicated SEPA channel bot (ONLY for this SEPA chain). No env / @Plat4Bot fallback.
    channelBotTokenEnc: null,
    // Step id that verifies customer proof ("Krok, ktorý kontroluje platbu")
    proofCheckStepId: '',
    // Ryan notification email for proof + verdict
    notifyEmail: '',
    proofTimeoutSec: 300,
    verdictPass: DEFAULT_VERDICT_PASS.slice(),
    verdictFail: DEFAULT_VERDICT_FAIL.slice(),
    // Optional SMTP override (admin); else env SMTP_*
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPassEnc: null,
    smtpFrom: '',
    steps: [],
    updatedAt: null,
  };
}

function defaultStep(partial = {}) {
  return {
    id: partial.id || crypto.randomBytes(4).toString('hex'),
    name: String(partial.name || 'Krok').slice(0, 80),
    // token never stored plaintext in returned objects; see sanitizeForAdmin
    tokenEnc: partial.tokenEnc || null,
    // @username of this step's bot (no @); used to match channel_post authors
    botUsername: String(partial.botUsername || '').replace(/^@/, '').trim().slice(0, 64),
    chatId: String(partial.chatId || '').trim(),
    template: String(partial.template || DEFAULT_TEMPLATE).slice(0, 3500),
    extract: Array.isArray(partial.extract) && partial.extract.length
      ? partial.extract.filter((k) => EXTRACT_PRESETS[k]).slice(0, 8)
      : ['iban', 'note', 'beneficiary'],
    timeoutSec: Math.max(15, Math.min(3600, Number(partial.timeoutSec) || 120)),
    // managed_by_us: we may poll/webhook this token. external: only sendMessage.
    // Kept as fallback when mode !== channel.
    managedByUs: Boolean(partial.managedByUs),
    // channel reply: extract = parse with rules; next_post = take whole next post from this bot
    replyMode: String(partial.replyMode || 'extract') === 'next_post' ? 'next_post' : 'extract',
    // Optional: treat step as "attach prepared email" (forces email into ctx)
    attachPreparedEmail: Boolean(partial.attachPreparedEmail),
  };
}

/** In-memory + file + Neon mirror. */
let cfg = emptyConfig();
let fileMtime = 0;
/** orderId → AbortController / state */
const runs = new Map();
/** For managed steps: token → { offset, pending: Map msgId→resolver } */
const managedPollers = new Map();

function pool() {
  try {
    return require('./db').pool();
  } catch {
    return null;
  }
}

async function ensureTable(p) {
  if (!p) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz DEFAULT now()
    )`
  );
}

function readFile() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs === fileMtime && cfg.updatedAt) return cfg;
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    fileMtime = st.mtimeMs;
    cfg = normalizeConfig(j);
    return cfg;
  } catch {
    return cfg && cfg.updatedAt ? cfg : emptyConfig();
  }
}

function writeFile(c) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, FILE);
  try {
    fileMtime = fs.statSync(FILE).mtimeMs;
  } catch {
    /* */
  }
  cfg = c;
}

function normalizeConfig(j) {
  const base = emptyConfig();
  if (!j || typeof j !== 'object') return base;
  base.enabled = Boolean(j.enabled);
  const mode = String(j.mode || 'channel').toLowerCase();
  base.mode = mode === 'managed' || mode === 'external' ? mode : 'channel';
  base.channelId = String(j.channelId || '').trim();
  base.lastSeenChannelId = String(j.lastSeenChannelId || '').trim();
  base.lastSeenChannelTitle = String(j.lastSeenChannelTitle || '').trim().slice(0, 200);
  base.lastSeenChannelAt = j.lastSeenChannelAt || null;
  base.preparedEmail = String(j.preparedEmail || '').trim().slice(0, 200);
  // Legacy paymentsBotTokenEnc (old "@Plat4Bot / krok 1 / fallback" field) is intentionally
  // NOT migrated: the SEPA channel bot must be a separate, dedicated bot.
  base.channelBotTokenEnc = j.channelBotTokenEnc || null;
  base.proofCheckStepId = String(j.proofCheckStepId || '').trim();
  base.notifyEmail = String(j.notifyEmail || '').trim().slice(0, 200);
  base.proofTimeoutSec = Math.max(30, Math.min(3600, Number(j.proofTimeoutSec) || 300));
  base.verdictPass = Array.isArray(j.verdictPass) && j.verdictPass.length
    ? j.verdictPass.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
    : DEFAULT_VERDICT_PASS.slice();
  base.verdictFail = Array.isArray(j.verdictFail) && j.verdictFail.length
    ? j.verdictFail.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
    : DEFAULT_VERDICT_FAIL.slice();
  base.smtpHost = String(j.smtpHost || '').trim().slice(0, 200);
  base.smtpPort = Number(j.smtpPort) || 587;
  base.smtpSecure = Boolean(j.smtpSecure);
  base.smtpUser = String(j.smtpUser || '').trim().slice(0, 200);
  base.smtpPassEnc = j.smtpPassEnc || null;
  if (j.smtpPass && !base.smtpPassEnc) base.smtpPassEnc = encryptSecret(j.smtpPass);
  base.smtpFrom = String(j.smtpFrom || '').trim().slice(0, 200);
  // Never keep plaintext from older dumps
  if (j.channelBotToken && !base.channelBotTokenEnc) {
    base.channelBotTokenEnc = encryptSecret(j.channelBotToken);
  }
  base.steps = Array.isArray(j.steps)
    ? j.steps.map((s) => {
        const step = defaultStep(s);
        if (s.token && !step.tokenEnc) step.tokenEnc = encryptSecret(s.token);
        return step;
      })
    : [];
  base.updatedAt = j.updatedAt || null;
  return base;
}

async function load(log) {
  const p = pool();
  if (p) {
    try {
      await ensureTable(p);
      const { rows } = await p.query(`SELECT data FROM ${TABLE} WHERE id = 'main'`);
      if (rows[0] && rows[0].data) {
        cfg = normalizeConfig(rows[0].data);
        writeFile(cfg);
        if (log) log('SEPA_CHAIN_DB_LOADED steps=' + cfg.steps.length + ' enabled=' + cfg.enabled);
        try { ensureChannelPoller(log); } catch { /* */ }
        return cfg;
      }
    } catch (e) {
      if (log) log('SEPA_CHAIN_DB_LOAD_FAIL ' + e.message);
    }
  }
  cfg = readFile();
  if (log) log('SEPA_CHAIN_FILE_LOADED steps=' + cfg.steps.length + ' enabled=' + cfg.enabled);
  try { ensureChannelPoller(log); } catch { /* */ }
  return cfg;
}

async function save(next, log) {
  next = normalizeConfig(next);
  next.updatedAt = new Date().toISOString();
  writeFile(next);
  const p = pool();
  if (p) {
    try {
      await ensureTable(p);
      await p.query(
        `INSERT INTO ${TABLE} (id, data) VALUES ('main', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [JSON.stringify(next)]
      );
    } catch (e) {
      if (log) log('SEPA_CHAIN_DB_SAVE_FAIL ' + e.message);
    }
  }
  cfg = next;
  try { ensureChannelPoller(log); } catch { /* */ }
  return cfg;
}

function getConfig() {
  return readFile();
}

/**
 * @Plat4Bot (general notifications bot) — env only, never the admin SEPA channel token.
 * Used here only for alerts to Ryan + the Ryan proof backup.
 */
function plat4BotToken() {
  return env('TELEGRAM_PAYMENTS_BOT_TOKEN') || env('TELEGRAM_BOT_TOKEN');
}

function isPlat4Token(t) {
  const v = String(t || '').trim();
  if (!v) return false;
  return [env('TELEGRAM_PAYMENTS_BOT_TOKEN'), env('TELEGRAM_BOT_TOKEN')].filter(Boolean).includes(v);
}

function rawChannelBotToken(c) {
  return decryptSecret((c || getConfig()).channelBotTokenEnc);
}

/**
 * Dedicated SEPA channel bot token (admin field only). Used EXCLUSIVELY by the SEPA chain:
 * posting amount + LTC to the channel, reading channel_post, posting proofs.
 * No fallback to env / @Plat4Bot. Returns '' if unset or if it equals the @Plat4Bot token.
 */
function sepaChannelBotToken(c) {
  const t = rawChannelBotToken(c);
  if (!t || isPlat4Token(t)) return '';
  return t;
}

function stepToken(step) {
  return decryptSecret(step && step.tokenEnc);
}

function sanitizeForAdmin(c) {
  const out = {
    enabled: Boolean(c.enabled),
    mode: c.mode || 'channel',
    channelId: c.channelId || '',
    lastSeenChannelId: c.lastSeenChannelId || '',
    lastSeenChannelTitle: c.lastSeenChannelTitle || '',
    lastSeenChannelAt: c.lastSeenChannelAt || null,
    preparedEmail: c.preparedEmail || '',
    proofCheckStepId: c.proofCheckStepId || '',
    notifyEmail: c.notifyEmail || '',
    proofTimeoutSec: c.proofTimeoutSec || 300,
    verdictPass: (c.verdictPass || DEFAULT_VERDICT_PASS).slice(),
    verdictFail: (c.verdictFail || DEFAULT_VERDICT_FAIL).slice(),
    smtpHost: c.smtpHost || '',
    smtpPort: c.smtpPort || 587,
    smtpSecure: Boolean(c.smtpSecure),
    smtpUser: c.smtpUser || '',
    smtpPassSet: Boolean(decryptSecret(c.smtpPassEnc)),
    smtpFrom: c.smtpFrom || '',
    smtpEnvFallback: Boolean(env('SMTP_HOST') && env('SMTP_FROM')),
    channelBotTokenMasked: maskToken(rawChannelBotToken(c)),
    channelBotTokenSet: Boolean(sepaChannelBotToken(c)),
    channelBotTokenIsPlat4: isPlat4Token(rawChannelBotToken(c)),
    channelPoller: channelPollerStatus(),
    updatedAt: c.updatedAt,
    extractPresets: Object.keys(EXTRACT_PRESETS).map((k) => ({
      id: k,
      label: EXTRACT_PRESETS[k].label,
    })),
    defaultTemplate: DEFAULT_TEMPLATE,
    steps: (c.steps || []).map((s, i) => ({
      id: s.id,
      order: i + 1,
      name: s.name,
      tokenMasked: maskToken(stepToken(s)),
      tokenSet: Boolean(stepToken(s)),
      botUsername: s.botUsername || '',
      chatId: s.chatId || '',
      template: s.template,
      extract: s.extract,
      timeoutSec: s.timeoutSec,
      managedByUs: Boolean(s.managedByUs),
      replyMode: s.replyMode || 'extract',
      attachPreparedEmail: Boolean(s.attachPreparedEmail),
    })),
  };
  return out;
}

async function tgApi(token, method, body) {
  if (!token) throw new Error('Chýba bot token');
  const r = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    const e = new Error(j.description || `telegram ${method} failed`);
    e.body = j;
    throw e;
  }
  return j.result;
}

async function tgSendFile(token, chatId, kind, buffer, filename, caption, mime, extra = {}) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', String(caption).slice(0, 1000));
  if (extra.replyToMessageId != null) {
    fd.append('reply_to_message_id', String(extra.replyToMessageId));
  }
  fd.append(
    kind === 'photo' ? 'photo' : 'document',
    new Blob([buffer], { type: mime || 'application/octet-stream' }),
    filename
  );
  const r = await fetch(
    `${API}/bot${token}/${kind === 'photo' ? 'sendPhoto' : 'sendDocument'}`,
    { method: 'POST', body: fd }
  );
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'telegram send file failed');
  return j.result;
}

function renderTemplate(tpl, ctx) {
  return String(tpl || DEFAULT_TEMPLATE).replace(
    /\{(order_id|amount|currency|customer_name|email|prev_reply|step_name|step_index|ltc_address)\}/gi,
    (_, k) => {
      const key = String(k).toLowerCase();
      const map = {
        order_id: ctx.orderId,
        amount: ctx.amount,
        currency: ctx.currency || 'EUR',
        customer_name: ctx.customerName,
        email: ctx.email || '',
        prev_reply: ctx.prevReply || '',
        step_name: ctx.stepName || '',
        step_index: String(ctx.stepIndex || ''),
        ltc_address: ctx.ltcAddress || '',
      };
      return map[key] != null ? String(map[key]) : '';
    }
  );
}


/**
 * Build channel post body. Default: `{amount}\n{ltc_address}` (two lines).
 * No order id, name, or #ORDER/#STEP tags (matching uses reply_to / FIFO).
 * If ltcAddress is empty, trailing blank line is trimmed → amount only.
 */
function buildChannelMessage(step, ctx) {
  const body = renderTemplate(step.template || DEFAULT_TEMPLATE, {
    orderId: ctx.orderId,
    amount: ctx.amount,
    currency: ctx.currency || 'EUR',
    customerName: ctx.customerName,
    email: ctx.email || '',
    prevReply: ctx.prevReply || '',
    stepName: step.name,
    stepIndex: ctx.stepIndex,
    ltcAddress: ctx.ltcAddress || '',
  });
  return String(body || '').trim().slice(0, 4096);
}

/**
 * Next rotated enabled LTC address from Ryan's admin wallet pool
 * (addressPool → wallets.enabledAddresses('ltc')). Does not touch other coins.
 * @returns {{ address: string, index: number, poolSize: number, reused: boolean }|null}
 */
function pickLtcAddress(orderId) {
  try {
    const addressPool = require('./addressPool');
    return addressPool.nextAddress('ltc', orderId ? { orderId: String(orderId) } : {});
  } catch (e) {
    if (e && e.code === 'EMPTY_POOL') return null;
    throw e;
  }
}

/** Normalize amount for FIFO ambiguity checks (25 / 25.00 / 25 € → "25.00"). */
function normalizeAmountKey(v) {
  const n = Number(String(v == null ? '' : v).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

function parseOrderMarker(text) {
  const t = String(text || '');
  const m = t.match(/#ORDER\s+([A-Za-z0-9_-]+)/i);
  const s = t.match(/#STEP\s+(\d+)/i);
  return {
    orderId: m ? m[1] : '',
    stepIndex: s ? Number(s[1]) : null,
  };
}

/** Strip #ORDER / #STEP / #PROOF marker lines before field extraction. */
function stripChannelMarkers(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !/^\s*#(ORDER|STEP|PROOF)\b/i.test(line))
    .join('\n')
    .trim();
}

function normalizeUsername(u) {
  return String(u || '').replace(/^@/, '').trim().toLowerCase();
}

/** Parse a free-text bot/operator reply into extracted fields. */
function parseReply(text, extractKeys) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  const out = { raw };
  const keys = extractKeys && extractKeys.length ? extractKeys : ['raw'];

  // Prefer structured 3-line / 5-line when IBAN/note/beneficiary requested
  const lines = raw.split('\n').map((l) => l.trim()).filter((l, i, a) => l || i === 0);
  const nonEmpty = raw.split('\n').map((l) => l.trim());
  let start = 0;
  while (start < nonEmpty.length && !nonEmpty[start]) start++;

  const looksIban = (s) => /^[A-Za-z]{2}\d{2}[A-Za-z0-9 ]{10,42}$/.test(String(s || '').replace(/\s+/g, ' ').trim());

  if (keys.includes('iban') || keys.includes('note') || keys.includes('beneficiary')) {
    // 5-line: IBAN / amount / VS / beneficiary / note…
    if (nonEmpty.length - start >= 5 && looksIban(nonEmpty[start])) {
      const amt = nonEmpty[start + 1];
      if (/^\d+(?:[.,]\d{1,2})?$/.test(amt)) {
        out.iban = nonEmpty[start].replace(/\s+/g, '');
        out.amount = amt;
        out.vs = nonEmpty[start + 2];
        const benef5 = nonEmpty[start + 3];
        if (benef5) out.beneficiary = benef5;
        out.note = nonEmpty.slice(start + 4).join('\n').trim();
      }
    }
    // 2/3-line: IBAN / note / [beneficiary optional]
    if (!out.iban && nonEmpty.length - start >= 2 && looksIban(nonEmpty[start])) {
      out.iban = nonEmpty[start].replace(/\s+/g, '');
      out.note = nonEmpty[start + 1];
      if (nonEmpty.length - start >= 3 && nonEmpty[start + 2]) {
        out.beneficiary = nonEmpty[start + 2];
      }
    }
  }

  // Key: value lines
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(iban|amount|suma|beneficiary|príjemca|prijemca|meno|note|poznámka|purpose|email|deadline|termín|termin)\s*[:=]\s*(.+)\s*$/i);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (/iban/i.test(k)) out.iban = v.replace(/\s+/g, '');
    else if (/amount|suma/i.test(k)) out.amount = v;
    else if (/benef|príjem|prijem|meno/i.test(k)) out.beneficiary = v;
    else if (/note|pozn|purpose/i.test(k)) out.note = v;
    else if (/email/i.test(k)) out.email = v;
    else if (/dead|term/i.test(k)) out.deadline = v;
  }

  // Lone IBAN anywhere
  if (!out.iban && keys.includes('iban')) {
    const m = raw.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{10,30})\b/i);
    if (m) out.iban = m[1].toUpperCase();
  }

  // Email
  if (!out.email && keys.includes('email')) {
    const m = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (m) out.email = m[0];
  }

  // Deadline: minutes or ISO-ish
  if (!out.deadline && keys.includes('deadline')) {
    const mMin = raw.match(/(?:deadline|termín|termin|platnosť|platnost)\s*[:=]?\s*(\d+)\s*(?:min|m)?/i);
    if (mMin) out.deadline = mMin[1];
    else {
      const mIso = raw.match(/\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?/);
      if (mIso) out.deadline = mIso[0];
    }
  }

  if (keys.includes('amount') && !out.amount) {
    const m = raw.match(/\b(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|€)?\b/i);
    if (m) out.amount = m[1];
  }

  return out;
}

function mergeExtracted(acc, parsed, keys) {
  const next = { ...acc };
  for (const k of keys || []) {
    const preset = EXTRACT_PRESETS[k];
    if (!preset) continue;
    for (const field of preset.keys) {
      if (parsed[field] != null && parsed[field] !== '') next[field] = parsed[field];
    }
    if (k === 'raw' && parsed.raw) next.prevReply = parsed.raw;
  }
  if (parsed.iban) next.iban = parsed.iban;
  if (parsed.note) next.note = parsed.note;
  if (parsed.beneficiary) next.beneficiary = parsed.beneficiary;
  if (parsed.amount) next.amount = parsed.amount;
  if (parsed.email) next.email = parsed.email;
  if (parsed.deadline) next.deadline = parsed.deadline;
  if (parsed.vs) next.vs = parsed.vs;
  if (parsed.raw) next.prevReply = parsed.raw;
  return next;
}

function waitForReply({ token, chatId, messageId, timeoutSec, managedByUs, log, label, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ms = Math.max(15, Number(timeoutSec) || 120) * 1000;
    const timer = setTimeout(() => {
      finish(() =>
        reject(Object.assign(new Error(`Timeout kroku „${label}“ (${timeoutSec}s)`), { code: 'STEP_TIMEOUT' }))
      );
    }, ms);

    function cleanup() {
      clearTimeout(timer);
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch { /* */ }
      }
      if (managedByUs) unregisterManagedWait(token, messageId);
      else {
        const key = `${chatId}:${messageId}`;
        externalWaits.delete(key);
      }
    }

    function finish(fn) {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    }

    function onReply(text, meta) {
      finish(() => resolve({ text, meta }));
    }

    function onAbort() {
      finish(() => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })));
    }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (managedByUs) {
      registerManagedWait(token, chatId, messageId, onReply, log);
      ensureManagedPoller(token, log);
    } else {
      // External bot: we cannot read its updates. getUpdates would steal them.
      // Wait for POST /api/sepa-chain/reply (or order-level wait in runStep).
      registerExternalWait(token, chatId, messageId, onReply);
    }
  });
}

const externalWaits = new Map(); // key = `${chatId}:${messageId}` or orderId → resolver
/** Channel-mode waits: orderId → { stepIndex, botUsername, onReply, messageId, amount, at } */
const channelWaits = new Map();

function registerExternalWait(token, chatId, messageId, onReply) {
  const key = `${chatId}:${messageId}`;
  externalWaits.set(key, { onReply, tokenHint: maskToken(token), at: Date.now() });
}

function registerChannelWait(orderId, { stepIndex, botUsername, onReply, messageId, amount }) {
  channelWaits.set(String(orderId), {
    stepIndex: Number(stepIndex) || 0,
    botUsername: normalizeUsername(botUsername),
    onReply,
    messageId: messageId != null ? String(messageId) : null,
    amount: amount != null ? String(amount) : '',
    amountKey: normalizeAmountKey(amount),
    at: Date.now(),
  });
}

function unregisterChannelWait(orderId) {
  channelWaits.delete(String(orderId));
}

/**
 * Remember last channel_post chat id for the admin "zistiť ID kanála" helper.
 * Persists lightly into config (best-effort).
 */
function noteChannelPostSighting(chat) {
  if (!chat || chat.id == null) return;
  const id = String(chat.id);
  const title = String(chat.title || '').slice(0, 200);
  try {
    const c = getConfig();
    if (c.lastSeenChannelId === id && c.lastSeenChannelTitle === title) return;
    c.lastSeenChannelId = id;
    c.lastSeenChannelTitle = title;
    c.lastSeenChannelAt = new Date().toISOString();
    writeFile(c);
  } catch { /* */ }
}

/**
 * Ingest a channel_post update received by the payments bot.
 *
 * Matching (no #ORDER tags required):
 *  1. Primary — reply_to_message.message_id equals a wait's posted message_id
 *  2. Legacy — #ORDER marker still resolves when present
 *  3. Fallback — oldest pending wait for that botUsername (FIFO); if several
 *     pending waits share the same amount, notify Ryan and do not guess
 *
 * Returns true if a wait was resolved (or an ambiguous case was reported).
 */
function ingestChannelPost(msg, log) {
  if (!msg || !msg.chat) return false;
  noteChannelPostSighting(msg.chat);

  const c = getConfig();
  const channelId = String(c.channelId || '').trim();
  const chatId = String(msg.chat.id);
  if (channelId && chatId !== channelId) {
    return false;
  }

  const text = String(msg.text || msg.caption || '');
  const fromUser = msg.from || msg.sender_chat || {};
  const fromUsername = normalizeUsername(fromUser.username || '');
  const replyToId =
    msg.reply_to_message && msg.reply_to_message.message_id != null
      ? String(msg.reply_to_message.message_id)
      : '';
  const marker = parseOrderMarker(text);
  const orderId = marker.orderId || '';

  function resolve(oid, via) {
    const w = channelWaits.get(oid);
    if (!w) return false;
    if (w.messageId && String(msg.message_id) === w.messageId) return false; // own echo
    channelWaits.delete(oid);
    if (log) log(`SEPA_CHAIN_CHANNEL_HIT order=${oid} via=${via} from=@${fromUsername || '-'} msg=${msg.message_id}`);
    w.onReply(text, {
      chatId,
      messageId: msg.message_id,
      orderId: oid,
      fromUsername,
      via: 'channel',
      matchVia: via,
    });
    return true;
  }

  function usernameOk(w) {
    if (!w.botUsername) return true;
    return !!fromUsername && fromUsername === w.botUsername;
  }

  // 1) Primary: Telegram reply to our amount/request message
  if (replyToId) {
    for (const [oid, w] of channelWaits) {
      if (!w.messageId || w.messageId !== replyToId) continue;
      if (!usernameOk(w)) continue;
      if (resolve(oid, 'reply_to')) return true;
    }
  }

  // 2) Legacy #ORDER marker (still supported if a bot includes it)
  if (orderId) {
    const exact = [];
    if (channelWaits.has(orderId)) exact.push(orderId);
    for (const [oid] of channelWaits) {
      if (exact.includes(oid)) continue;
      if (oid === orderId || oid.startsWith(orderId + '_')) exact.push(oid);
    }
    for (const oid of exact) {
      const w = channelWaits.get(oid);
      if (!w || !usernameOk(w)) continue;
      if (resolve(oid, 'order_marker')) return true;
    }
    // Marker present but no matching wait — do not FIFO-steal another order
    return false;
  }

  // 3) FIFO fallback among waits for this bot (no reply_to, no #ORDER)
  const candidates = [];
  for (const [oid, w] of channelWaits) {
    if (w.messageId && String(msg.message_id) === w.messageId) continue;
    if (!usernameOk(w)) continue;
    candidates.push([oid, w]);
  }
  if (!candidates.length) return false;

  candidates.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));

  // Ambiguity: multiple pending with the same amount → notify Ryan, don't guess
  const byAmount = new Map();
  for (const [oid, w] of candidates) {
    const k = w.amountKey || normalizeAmountKey(w.amount) || '_';
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(oid);
  }
  const ambiguousGroups = [...byAmount.values()].filter((g) => g.length > 1);
  if (ambiguousGroups.length && candidates.length > 1) {
    const detail = candidates
      .map(([oid, w]) => `${oid} amount=${w.amount || '?'} step=${w.stepIndex}`)
      .join('; ');
    if (log) log(`SEPA_CHAIN_CHANNEL_AMBIGUOUS from=@${fromUsername || '-'} ${detail}`);
    Promise.resolve()
      .then(() =>
        alertRyan(
          `⚠️ SEPA kanál: nejednoznačná odpoveď (rovnaká suma, bez reply)\n` +
            `Od: @${fromUsername || '-'}\n` +
            `Čakajúce: ${detail}\n` +
            `Text: ${String(text).slice(0, 400)}\n` +
            `Odpovedzte reply-om na správu so sumou danej objednávky.`
        )
      )
      .catch(() => {});
    return true; // consumed (reported), do not resolve
  }

  return resolve(candidates[0][0], 'fifo');
}

function registerManagedWait(token, chatId, messageId, onReply, log) {
  const key = maskToken(token) + ':' + token.slice(-8);
  let entry = managedPollers.get(key);
  if (!entry) {
    entry = { token, offset: 0, pending: new Map(), log };
    managedPollers.set(key, entry);
  }
  entry.pending.set(String(messageId), { chatId: String(chatId), onReply });
}

function unregisterManagedWait(token, messageId) {
  const key = maskToken(token) + ':' + token.slice(-8);
  const entry = managedPollers.get(key);
  if (entry) entry.pending.delete(String(messageId));
}

function ensureManagedPoller(token, log) {
  const key = maskToken(token) + ':' + token.slice(-8);
  const entry = managedPollers.get(key);
  if (!entry || entry.looping) return;
  entry.looping = true;
  (async () => {
    while (entry.pending.size > 0) {
      try {
        // Only poll when managedByUs — never on external tokens.
        const r = await fetch(
          `${API}/bot${token}/getUpdates?timeout=20&offset=${entry.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message', 'channel_post']))}`
        );
        const j = await r.json();
        if (j.ok) {
          for (const u of j.result || []) {
            entry.offset = u.update_id + 1;
            const msg = u.message || u.edited_message || u.channel_post;
            if (!msg || !msg.chat) continue;
            const chatId = String(msg.chat.id);
            const text = String(msg.text || msg.caption || '');
            // Prefer reply_to match
            let hit = null;
            if (msg.reply_to_message) {
              hit = entry.pending.get(String(msg.reply_to_message.message_id));
            }
            if (!hit) {
              // Any pending for this chat that is waiting
              for (const [mid, p] of entry.pending) {
                if (p.chatId === chatId) {
                  hit = p;
                  entry.pending.delete(mid);
                  break;
                }
              }
            } else {
              entry.pending.delete(String(msg.reply_to_message.message_id));
            }
            if (hit && text) hit.onReply(text, { messageId: msg.message_id, chatId });
          }
        }
      } catch (e) {
        if (log) log('SEPA_CHAIN_POLL_ERR ' + e.message);
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      if (entry.pending.size === 0) break;
    }
    entry.looping = false;
  })();
}

/** Inbound reply from an external bot (or Ryan) posting to our server. */
function ingestExternalReply({ chatId, messageId, orderId, text, replyToMessageId }) {
  const candidates = [];
  if (replyToMessageId && chatId) candidates.push(`${chatId}:${replyToMessageId}`);
  if (messageId && chatId) candidates.push(`${chatId}:${messageId}`);
  if (orderId) candidates.push(`order:${orderId}`);
  for (const k of candidates) {
    const w = externalWaits.get(k);
    if (w) {
      externalWaits.delete(k);
      w.onReply(String(text || ''), { chatId, messageId, orderId });
      return true;
    }
  }
  // Also try any wait for this chat
  if (chatId) {
    for (const [k, w] of externalWaits) {
      if (k.startsWith(String(chatId) + ':')) {
        externalWaits.delete(k);
        w.onReply(String(text || ''), { chatId, messageId, orderId });
        return true;
      }
    }
  }
  return false;
}

function registerOrderWait(orderId, onReply) {
  externalWaits.set(`order:${orderId}`, { onReply, at: Date.now() });
}

async function runStep(step, ctx, log) {
  const c = getConfig();
  const mode = c.mode || 'channel';

  let email = ctx.email || '';
  if (step.attachPreparedEmail) {
    email = c.preparedEmail || email;
    ctx.email = email;
  }
  ctx.email = email;

  if (mode === 'channel') {
    return runStepChannel(step, ctx, log);
  }
  return runStepDirect(step, ctx, log, mode);
}

/** Channel relay: post into shared channel, wait for next bot's channel_post. */
async function runStepChannel(step, ctx, log) {
  const c = getConfig();
  const channelId = String(c.channelId || '').trim();
  if (!channelId) {
    throw Object.assign(new Error('Chýba ID Telegram kanála (režim kanál)'), { code: 'NO_CHANNEL' });
  }

  // Channel mode: ONLY the dedicated SEPA channel bot posts (never @Plat4Bot / env).
  const token = sepaChannelBotToken(c);
  if (!token) {
    throw Object.assign(new Error('Chýba token SEPA kanálového bota'), { code: 'NO_CHANNEL_BOT' });
  }

  const text = buildChannelMessage(step, ctx);
  if (log) {
    log(
      `SEPA_CHAIN_CHANNEL_SEND order=${ctx.orderId} step=${step.id} name=${step.name} ` +
        `bot=@${step.botUsername || '-'} channel=${channelId} text=${JSON.stringify(text).slice(0, 80)}`
    );
  }
  const msg = await tgApi(token, 'sendMessage', {
    chat_id: channelId,
    text,
    disable_web_page_preview: true,
  });

  // Who should reply? This step's botUsername (the bot that processes the request).
  // Matching: reply_to our message_id, else FIFO among pending for that bot.
  const expectUsername = step.botUsername || '';

  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let settled = false;
  const ms = Math.max(15, Number(step.timeoutSec) || 120) * 1000;

  const channelPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unregisterChannelWait(ctx.orderId);
      reject(Object.assign(new Error(`Timeout kroku „${step.name}“ v kanáli (${step.timeoutSec}s)`), { code: 'STEP_TIMEOUT' }));
    }, ms);
    registerChannelWait(ctx.orderId, {
      stepIndex: ctx.stepIndex,
      botUsername: expectUsername,
      messageId: msg.message_id,
      amount: ctx.amount,
      onReply: (t, meta) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ text: t, meta });
      },
    });
    if (ac) {
      ac.signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregisterChannelWait(ctx.orderId);
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      }, { once: true });
    }
  });

  // Also accept external HTTP reply as parallel path
  let orderResolver;
  const orderPromise = new Promise((resolve) => {
    orderResolver = resolve;
  });
  registerOrderWait(ctx.orderId, (t, meta) => orderResolver({ text: t, meta }));

  let raced;
  try {
    raced = await Promise.race([
      channelPromise,
      orderPromise.then((r) => {
        if (ac) ac.abort();
        unregisterChannelWait(ctx.orderId);
        return r;
      }),
    ]);
  } finally {
    externalWaits.delete(`order:${ctx.orderId}`);
    unregisterChannelWait(ctx.orderId);
  }

  let parsed;
  const replyText = stripChannelMarkers(raced.text);
  if (step.replyMode === 'next_post') {
    parsed = { raw: raced.text, ...(parseReply(replyText, step.extract)) };
  } else {
    parsed = parseReply(replyText, step.extract);
  }
  if (log) {
    const fields = Object.keys(parsed)
      .filter((k) => k !== 'raw' && parsed[k])
      .join(',');
    log(`SEPA_CHAIN_STEP_OK order=${ctx.orderId} step=${step.id} via=channel fields=${fields || 'raw'}`);
  }
  return { parsed, messageId: msg.message_id, via: 'channel' };
}

/** Direct (managed/external) mode — original per-chat relay. */
async function runStepDirect(step, ctx, log, mode) {
  const token = stepToken(step);
  if (!token) throw Object.assign(new Error(`Krok „${step.name}“ nemá token`), { code: 'NO_TOKEN' });
  if (!step.chatId) throw Object.assign(new Error(`Krok „${step.name}“ nemá chat ID`), { code: 'NO_CHAT' });

  const text = renderTemplate(step.template, {
    orderId: ctx.orderId,
    amount: ctx.amount,
    currency: ctx.currency || 'EUR',
    customerName: ctx.customerName,
    email: ctx.email || '',
    prevReply: ctx.prevReply || '',
    stepName: step.name,
    stepIndex: ctx.stepIndex,
    ltcAddress: ctx.ltcAddress || '',
  });

  const managed = mode === 'managed' || step.managedByUs;
  if (log) log(`SEPA_CHAIN_STEP_SEND order=${ctx.orderId} step=${step.id} name=${step.name} managed=${managed} chat=${step.chatId}`);
  const msg = await tgApi(token, 'sendMessage', {
    chat_id: step.chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
  });

  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let orderResolver;
  const orderPromise = new Promise((resolve) => {
    orderResolver = resolve;
  });
  registerOrderWait(ctx.orderId, (t, meta) => orderResolver({ text: t, meta }));

  const replyPromise = waitForReply({
    token,
    chatId: step.chatId,
    messageId: msg.message_id,
    timeoutSec: step.timeoutSec,
    managedByUs: managed,
    log,
    label: step.name,
    signal: ac && ac.signal,
  });
  replyPromise.catch(() => {});

  let raced;
  try {
    raced = await Promise.race([
      replyPromise,
      orderPromise.then((r) => {
        if (ac) ac.abort();
        return r;
      }),
    ]);
  } finally {
    externalWaits.delete(`order:${ctx.orderId}`);
  }

  const parsed = parseReply(raced.text, step.extract);
  if (log) {
    const fields = Object.keys(parsed)
      .filter((k) => k !== 'raw' && parsed[k])
      .join(',');
    log(`SEPA_CHAIN_STEP_OK order=${ctx.orderId} step=${step.id} fields=${fields || 'raw'}`);
  }
  return { parsed, messageId: msg.message_id, via: managed ? 'managed' : 'external' };
}

/**
 * Run the full chain for an order. On any failure → fallbackFn(order).
 * @returns {{ ok: boolean, via: 'chain'|'fallback', error?: string, extracted?: object }}
 */
function isSepaManualOrder(order) {
  const p = String((order && order.provider) || '').toLowerCase();
  return p === 'bank_sepa_manual' || p === 'bank_sepa';
}

async function runChain(order, { loadOrders, saveOrders, appendLog, fallbackFn }) {
  const c = getConfig();
  // Hard rule: bot chain applies ONLY to manual SEPA — never other methods.
  if (!isSepaManualOrder(order)) {
    if (appendLog) appendLog('SEPA_CHAIN_SKIP non-sepa provider=' + (order && order.provider));
    return { ok: false, via: 'skipped', reason: 'not_sepa' };
  }
  if (!c.enabled || !c.steps.length) {
    if (fallbackFn) await fallbackFn(order);
    return { ok: true, via: 'fallback', reason: 'disabled' };
  }
  if ((c.mode || 'channel') === 'channel' && !sepaChannelBotToken(c)) {
    // No dedicated SEPA channel bot → chain cannot run; manual @Plat4Bot flow.
    if (appendLog) appendLog('SEPA_CHAIN_NO_CHANNEL_BOT order=' + order.orderId + ' → manual fallback');
    if (fallbackFn) await fallbackFn(order);
    return { ok: true, via: 'fallback', reason: 'no_channel_bot' };
  }

  const log = appendLog || (() => {});

  // One LTC address per SEPA chain run — channel only, never shown to customer.
  let ltcPick = null;
  try {
    ltcPick = pickLtcAddress(order.orderId);
  } catch (e) {
    log('SEPA_CHAIN_LTC_PICK_FAIL ' + (e && e.message));
  }
  const ltcAddress = ltcPick && ltcPick.address ? String(ltcPick.address) : '';
  if (!ltcAddress) {
    log(`SEPA_CHAIN_LTC_EMPTY order=${order.orderId} — channel post will be amount-only`);
    try {
      await alertRyan(
        `⚠️ SEPA reťaz: žiadna povolená LTC adresa v pooli\n` +
          `Objednávka: ${order.orderId}\n` +
          `Suma: ${order.amountExact || order.amountEur} EUR\n` +
          `Kanál dostane len sumu (bez LTC). Doplň LTC v Adresy peňaženiek.`
      );
    } catch { /* */ }
  } else {
    log(
      `SEPA_CHAIN_LTC order=${order.orderId} addr=${ltcAddress.slice(0, 12)}… ` +
        `idx=${ltcPick.index} pool=${ltcPick.poolSize} reused=${Boolean(ltcPick.reused)}`
    );
  }

  const ctx = {
    orderId: order.orderId,
    amount: order.amountExact || order.amountEur,
    currency: order.currency || 'EUR',
    customerName: order.fullName || `${order.firstName || ''} ${order.lastName || ''}`.trim(),
    email: c.preparedEmail || order.email || order.customerEmail || '',
    prevReply: '',
    stepIndex: 0,
    ltcAddress,
  };
  let acc = {
    amount: ctx.amount,
    email: ctx.email,
    prevReply: '',
  };

  // Mark order (+ store LTC for traceability; never exposed via publicOrderView)
  try {
    const orders = loadOrders();
    if (orders[order.orderId]) {
      orders[order.orderId].sepaChain = {
        status: 'running',
        startedAt: new Date().toISOString(),
        step: 0,
        stepsTotal: c.steps.length,
        ltcAddress: ltcAddress || null,
        ltcPick: ltcPick
          ? { index: ltcPick.index, poolSize: ltcPick.poolSize, reused: Boolean(ltcPick.reused) }
          : null,
      };
      saveOrders(orders);
    }
  } catch {
    /* */
  }

  const ctrl = { aborted: false };
  runs.set(order.orderId, ctrl);

  try {
    for (let i = 0; i < c.steps.length; i++) {
      if (ctrl.aborted) throw Object.assign(new Error('Zrušené'), { code: 'ABORTED' });
      const step = c.steps[i];
      ctx.stepIndex = i + 1;
      ctx.email = acc.email || ctx.email;
      ctx.prevReply = acc.prevReply || '';
      ctx.amount = acc.amount || ctx.amount;

      try {
        const orders = loadOrders();
        if (orders[order.orderId]) {
          orders[order.orderId].sepaChain = {
            ...(orders[order.orderId].sepaChain || {}),
            status: 'running',
            step: i + 1,
            stepName: step.name,
            stepsTotal: c.steps.length,
          };
          saveOrders(orders);
        }
      } catch {
        /* */
      }

      const stepResult = await runStep(step, ctx, log);
      const { parsed } = stepResult;
      // Persist Telegram message_id of each amount/request post for reply_to matching + proof reply
      if (stepResult.messageId != null) {
        try {
          const orders = loadOrders();
          if (orders[order.orderId]) {
            const sc = { ...(orders[order.orderId].sepaChain || {}) };
            const list = Array.isArray(sc.channelMessages) ? sc.channelMessages.slice() : [];
            list.push({
              step: i + 1,
              stepId: step.id,
              messageId: stepResult.messageId,
              at: new Date().toISOString(),
            });
            sc.channelMessages = list;
            if (sc.amountMessageId == null) sc.amountMessageId = stepResult.messageId;
            orders[order.orderId].sepaChain = sc;
            saveOrders(orders);
          }
        } catch { /* */ }
      }
      acc = mergeExtracted(acc, parsed, step.extract);
      if (step.attachPreparedEmail && c.preparedEmail) acc.email = c.preparedEmail;
    }

    // Apply bank details from accumulated extraction
    const orders = loadOrders();
    const o = orders[order.orderId];
    if (!o) throw new Error('Objednávka zmizla počas reťaze');

    if (!acc.iban || !acc.note) {
      throw Object.assign(
        new Error(
          `Reťaz nedodala povinné polia (iban=${acc.iban ? 'áno' : 'nie'}, note=${acc.note ? 'áno' : 'nie'})`
        ),
        { code: 'INCOMPLETE' }
      );
    }

    sepaManual.applyBankDetails(o, {
      iban: acc.iban,
      amount: acc.amount || o.amountExact,
      vs: acc.vs || null,
      beneficiary: acc.beneficiary || null,
      note: acc.note,
      via: 'sepa_bot_chain',
    });

    // Optional deadline override from chain
    if (acc.deadline) {
      const asMin = Number(String(acc.deadline).replace(/[^\d.]/g, ''));
      if (Number.isFinite(asMin) && asMin > 0 && asMin < 24 * 60 && !/T/.test(String(acc.deadline))) {
        o.deadlineMinutes = asMin;
        o.deadlineAt = new Date(Date.now() + asMin * 60000).toISOString();
      } else {
        const t = Date.parse(acc.deadline);
        if (Number.isFinite(t) && t > Date.now()) {
          o.deadlineAt = new Date(t).toISOString();
          o.deadlineMinutes = Math.round((t - Date.now()) / 60000);
        }
      }
    }

    const prevSc = o.sepaChain || {};
    o.sepaChain = {
      status: 'done',
      finishedAt: new Date().toISOString(),
      stepsTotal: c.steps.length,
      extractedKeys: Object.keys(acc).filter((k) => acc[k] && k !== 'prevReply'),
      amountMessageId: prevSc.amountMessageId || null,
      channelMessages: prevSc.channelMessages || [],
      ltcAddress: prevSc.ltcAddress || ltcAddress || null,
      ltcPick: prevSc.ltcPick || null,
    };
    // Never put full IBAN into logs
    orders[order.orderId] = o;
    saveOrders(orders);
    log(`SEPA_CHAIN_DONE order=${order.orderId} iban=${String(acc.iban).slice(0, 4)}…`);
    runs.delete(order.orderId);
    return { ok: true, via: 'chain', extracted: { ...acc, iban: String(acc.iban).slice(0, 4) + '…' } };
  } catch (e) {
    log(`SEPA_CHAIN_FAIL order=${order.orderId} code=${e.code || '-'} ${e.message}`);
    try {
      const orders = loadOrders();
      if (orders[order.orderId]) {
        orders[order.orderId].sepaChain = {
          status: 'failed',
          error: String(e.message || e).slice(0, 300),
          code: e.code || null,
          failedAt: new Date().toISOString(),
        };
        saveOrders(orders);
      }
    } catch {
      /* */
    }
    runs.delete(order.orderId);
    // Alert Ryan + fall back to manual Plat4Bot flow
    try {
      if (fallbackFn) await fallbackFn(order);
    } catch (fe) {
      log('SEPA_CHAIN_FALLBACK_FAIL ' + fe.message);
    }
    try {
      await alertRyan(
        `⚠️ SEPA reťaz zlyhala — prepínam na manuálny @Plat4Bot tok\nObjednávka: ${order.orderId}\nDôvod: ${e.message}`
      );
    } catch {
      /* */
    }
    return { ok: false, via: 'fallback', error: e.message, code: e.code };
  }
}

async function alertRyan(text) {
  // General alert to Ryan → @Plat4Bot (env), never the SEPA channel bot.
  const token = plat4BotToken();
  let chat = '';
  try {
    chat = require('./telegramBot').loadAdminChatId();
  } catch {
    chat = env('TELEGRAM_ADMIN_CHAT_ID');
  }
  if (!token || !chat) return null;
  return tgApi(token, 'sendMessage', {
    chat_id: chat,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  });
}

/**
 * Parse a proof-check bot's channel reply into pass | fail | unknown.
 */
function parseProofVerdict(text, passWords, failWords) {
  const raw = String(text || '');
  const upper = raw.toUpperCase();
  const pass = (passWords && passWords.length ? passWords : DEFAULT_VERDICT_PASS).map((w) => String(w).toUpperCase());
  const fail = (failWords && failWords.length ? failWords : DEFAULT_VERDICT_FAIL).map((w) => String(w).toUpperCase());
  // Prefer fail match if both somehow present
  for (const w of fail) {
    if (w && upper.includes(w)) return { verdict: 'fail', matched: w, raw };
  }
  for (const w of pass) {
    if (w && upper.includes(w)) return { verdict: 'pass', matched: w, raw };
  }
  return { verdict: 'unknown', matched: null, raw };
}

function resolveProofCheckStep(c) {
  if (!c.steps || !c.steps.length) return null;
  if (c.proofCheckStepId) {
    const hit = c.steps.find((s) => s.id === c.proofCheckStepId);
    if (hit) return hit;
  }
  // Default: last step (typically the IBAN provider)
  return c.steps[c.steps.length - 1];
}

function smtpSettings() {
  const c = getConfig();
  const host = c.smtpHost || env('SMTP_HOST');
  const from = c.smtpFrom || env('SMTP_FROM');
  if (!host || !from) return null;
  const port = Number(c.smtpPort || env('SMTP_PORT', '587')) || 587;
  const pass = decryptSecret(c.smtpPassEnc) || env('SMTP_PASS');
  const user = c.smtpUser || env('SMTP_USER');
  const secure = c.smtpSecure || env('SMTP_SECURE') === '1' || port === 465;
  return { host, port, secure, user, pass, from };
}

async function sendProofEmail({ to, subject, text, buffer, filename, mime }) {
  const smtp = smtpSettings();
  if (!smtp || !to) {
    const err = new Error('SMTP alebo notify email nie je nastavený');
    err.code = 'NO_SMTP';
    throw err;
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    const err = new Error('nodemailer nie je nainštalovaný');
    err.code = 'NO_NODEMAILER';
    throw err;
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user || smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  const attachments = [];
  if (buffer && filename) {
    attachments.push({
      filename: String(filename).slice(0, 180),
      content: buffer,
      contentType: mime || 'application/octet-stream',
    });
  }
  const info = await transporter.sendMail({
    from: smtp.from,
    to,
    subject: String(subject).slice(0, 200),
    text: String(text).slice(0, 20000),
    attachments,
  });
  return { messageId: info.messageId, accepted: info.accepted };
}

/**
 * Forward customer proof into the channel as a reply to the order's amount
 * message (caption empty or just the amount). Wait for a verdict from the
 * proof-check step bot, update order status, and email + Telegram Ryan.
 * On timeout: notify Ryan "neoverené". Only for bank_sepa_manual / bank_sepa.
 */
async function forwardProof(order, buffer, filename, mime, appendLog, { loadOrders, saveOrders } = {}) {
  const c = getConfig();
  const log = appendLog || (() => {});
  const results = [];

  if (!isSepaManualOrder(order)) {
    log('SEPA_CHAIN_PROOF_SKIP non-sepa provider=' + (order && order.provider));
    return [{ target: 'skip', ok: false, reason: 'not_sepa' }];
  }

  const checkStep = resolveProofCheckStep(c);
  const channelId = String(c.channelId || '').trim();
  const mode = c.mode || 'channel';

  // Always Telegram-notify Ryan with the file (backup) — via @Plat4Bot (env)
  try {
    const token = plat4BotToken();
    let chat = '';
    try {
      chat = require('./telegramBot').loadAdminChatId();
    } catch {
      chat = env('TELEGRAM_ADMIN_CHAT_ID');
    }
    if (token && chat) {
      const caption =
        `📎 SEPA doklad\nObjednávka: ${order.orderId}\nSuma: ${order.amountExact || order.amountEur} EUR\nZákazník: ${order.fullName || ''}\n(čaká na verdikt bota)`;
      const photo = /jpeg|png|webp/i.test(mime || '') && buffer.length < 10 * 1024 * 1024;
      await tgSendFile(token, chat, photo ? 'photo' : 'document', buffer, filename, caption, mime);
      results.push({ target: 'ryan_telegram', ok: true });
    }
  } catch (e) {
    log('SEPA_CHAIN_PROOF_RYAN_TG_FAIL ' + e.message);
    results.push({ target: 'ryan_telegram', ok: false, error: e.message });
  }

  // Post proof into channel as a *reply* to this order's amount message
  // (caption empty or just the amount — no #ORDER/#PROOF tags).
  let channelMsgId = null;
  const amountMsgId =
    (order.sepaChain && order.sepaChain.amountMessageId) ||
    (order.sepaChain &&
      Array.isArray(order.sepaChain.channelMessages) &&
      order.sepaChain.channelMessages[0] &&
      order.sepaChain.channelMessages[0].messageId) ||
    null;
  const amountCaption = String(order.amountExact || order.amountEur || '').trim();
  if (mode === 'channel' && channelId) {
    try {
      const token = sepaChannelBotToken(c);
      if (!token) throw new Error('chýba token SEPA kanálového bota');
      const photo = /jpeg|png|webp/i.test(mime || '') && buffer.length < 10 * 1024 * 1024;
      const msg = await tgSendFile(
        token,
        channelId,
        photo ? 'photo' : 'document',
        buffer,
        filename,
        amountCaption || '',
        mime,
        amountMsgId != null ? { replyToMessageId: amountMsgId } : {}
      );
      channelMsgId = msg && msg.message_id;
      results.push({
        target: 'channel',
        ok: true,
        messageId: channelMsgId,
        replyTo: amountMsgId,
        checkStep: checkStep && checkStep.name,
      });
      log(
        `SEPA_CHAIN_PROOF_CHANNEL order=${order.orderId} step=${checkStep && checkStep.id} ` +
          `msg=${channelMsgId} reply_to=${amountMsgId || '-'}`
      );
    } catch (e) {
      log('SEPA_CHAIN_PROOF_CHANNEL_FAIL ' + e.message);
      results.push({ target: 'channel', ok: false, error: e.message });
    }
  } else if (checkStep && checkStep.chatId) {
    try {
      const token = stepToken(checkStep);
      if (token) {
        const photo = /jpeg|png|webp/i.test(mime || '') && buffer.length < 10 * 1024 * 1024;
        await tgSendFile(
          token,
          checkStep.chatId,
          photo ? 'photo' : 'document',
          buffer,
          filename,
          amountCaption || '',
          mime,
          amountMsgId != null ? { replyToMessageId: amountMsgId } : {}
        );
        results.push({ target: 'check_step', ok: true, replyTo: amountMsgId });
      }
    } catch (e) {
      log('SEPA_CHAIN_PROOF_STEP_FAIL ' + e.message);
      results.push({ target: 'check_step', ok: false, error: e.message });
    }
  }

  // Mark order waiting for proof verdict
  try {
    if (loadOrders && saveOrders) {
      const orders = loadOrders();
      if (orders[order.orderId]) {
        orders[order.orderId].status = 'proof_pending_review';
        orders[order.orderId].proofReview = {
          status: 'waiting',
          startedAt: new Date().toISOString(),
          checkStepId: checkStep && checkStep.id,
          checkStepName: checkStep && checkStep.name,
        };
        saveOrders(orders);
      }
    }
  } catch (e) {
    log('SEPA_CHAIN_PROOF_STATUS_FAIL ' + e.message);
  }

  // Wait for channel verdict from the check bot
  const timeoutSec = c.proofTimeoutSec || 300;
  let verdictResult = { verdict: 'timeout', matched: null, raw: '' };

  if (mode === 'channel' && channelId && checkStep) {
    const waitKey = String(order.orderId) + '_proof';
    try {
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unregisterChannelWait(waitKey);
          reject(Object.assign(new Error('proof timeout'), { code: 'PROOF_TIMEOUT' }));
        }, timeoutSec * 1000);
        registerChannelWait(waitKey, {
          stepIndex: 0,
          botUsername: checkStep.botUsername || '',
          messageId: channelMsgId,
          amount: order.amountExact || order.amountEur,
          onReply: (t, meta) => {
            clearTimeout(timer);
            resolve({ text: t, meta });
          },
        });
      });
      verdictResult = parseProofVerdict(stripChannelMarkers(reply.text), c.verdictPass, c.verdictFail);
      if (verdictResult.verdict === 'unknown') {
        // Still accept raw as unknown — don't treat as pass
        verdictResult.raw = reply.text;
      }
    } catch (e) {
      verdictResult = { verdict: 'timeout', matched: null, raw: '', error: e.message };
    } finally {
      unregisterChannelWait(waitKey);
    }
  } else {
    // No channel wait — treat as unverified so Ryan is notified
    verdictResult = { verdict: 'timeout', matched: null, raw: '', error: 'no_channel_wait' };
  }

  // Map verdict → order status
  let newStatus = 'proof_unverified';
  let customerLabel = 'Doklad čaká na manuálnu kontrolu';
  if (verdictResult.verdict === 'pass') {
    newStatus = 'paid';
    customerLabel = 'Platba potvrdená';
  } else if (verdictResult.verdict === 'fail') {
    newStatus = 'proof_rejected';
    customerLabel = 'Doklad zamietnutý';
  } else {
    newStatus = 'proof_unverified';
    customerLabel = 'Doklad neoverený – čaká na manuálnu kontrolu';
  }

  try {
    if (loadOrders && saveOrders) {
      const orders = loadOrders();
      if (orders[order.orderId]) {
        orders[order.orderId].status = newStatus;
        if (verdictResult.verdict === 'pass') {
          orders[order.orderId].confirmedAt = new Date().toISOString();
          orders[order.orderId].paidMarkedAt = orders[order.orderId].paidMarkedAt || new Date().toISOString();
        }
        orders[order.orderId].proofReview = {
          status: verdictResult.verdict === 'timeout' ? 'timeout' : verdictResult.verdict,
          matched: verdictResult.matched,
          finishedAt: new Date().toISOString(),
          checkStepId: checkStep && checkStep.id,
          checkStepName: checkStep && checkStep.name,
          customerLabel,
        };
        saveOrders(orders);
        order.status = newStatus;
        order.proofReview = orders[order.orderId].proofReview;
      }
    }
  } catch (e) {
    log('SEPA_CHAIN_PROOF_APPLY_FAIL ' + e.message);
  }

  const verdictSk =
    verdictResult.verdict === 'pass'
      ? 'PREŠLO / OK'
      : verdictResult.verdict === 'fail'
        ? 'NEPREŠLO / ZAMIETNUTÉ'
        : 'neoverené – skontroluj ručne';

  const emailBody =
    `SEPA doklad — verdikt\n\n` +
    `Objednávka: ${order.orderId}\n` +
    `Suma: ${order.amountExact || order.amountEur} EUR\n` +
    `Zákazník: ${order.fullName || ((order.firstName || '') + ' ' + (order.lastName || '')).trim()}\n` +
    `IBAN: ${order.bank && order.bank.iban ? order.bank.iban : '?'}\n` +
    `Poznámka: ${order.paymentNote || order.purpose || ''}\n` +
    `Kontrolný bot: ${checkStep ? checkStep.name + (checkStep.botUsername ? ' @' + checkStep.botUsername : '') : '?'}\n` +
    `Verdikt: ${verdictSk}\n` +
    (verdictResult.matched ? `Zhoda kľúčového slova: ${verdictResult.matched}\n` : '') +
    (verdictResult.raw ? `\nOdpoveď bota:\n${String(verdictResult.raw).slice(0, 1500)}\n` : '') +
    `\nStav objednávky: ${newStatus}\n`;

  // Email Ryan
  if (c.notifyEmail) {
    try {
      await sendProofEmail({
        to: c.notifyEmail,
        subject: `SEPA doklad ${order.orderId} — ${verdictSk}`,
        text: emailBody,
        buffer,
        filename,
        mime,
      });
      results.push({ target: 'ryan_email', ok: true, to: c.notifyEmail });
      log(`SEPA_CHAIN_PROOF_EMAIL order=${order.orderId} verdict=${verdictResult.verdict}`);
    } catch (e) {
      log('SEPA_CHAIN_PROOF_EMAIL_FAIL ' + e.message);
      results.push({ target: 'ryan_email', ok: false, error: e.message });
    }
  } else {
    results.push({ target: 'ryan_email', ok: false, error: 'notifyEmail not set' });
  }

  // Telegram backup with verdict text
  try {
    await alertRyan(
      `📎 SEPA doklad verdikt: ${verdictSk}\nObjednávka: ${order.orderId}\nSuma: ${order.amountExact || order.amountEur} EUR\nZákazník: ${order.fullName || ''}\nStav: ${newStatus}`
    );
    results.push({ target: 'ryan_telegram_verdict', ok: true });
  } catch (e) {
    results.push({ target: 'ryan_telegram_verdict', ok: false, error: e.message });
  }

  log(`SEPA_CHAIN_PROOF_DONE order=${order.orderId} verdict=${verdictResult.verdict} status=${newStatus}`);
  return {
    results,
    verdict: verdictResult.verdict,
    status: newStatus,
    customerLabel,
  };
}


/** Single-step dry run with fake order (notifies the configured chat). */
async function testStep(stepId, appendLog) {
  const c = getConfig();
  const step = (c.steps || []).find((s) => s.id === stepId);
  if (!step) throw Object.assign(new Error('Krok sa nenašiel'), { code: 'NOT_FOUND' });
  const fakeId = 'ord_test_' + crypto.randomBytes(3).toString('hex');
  const ctx = {
    orderId: fakeId,
    amount: '12.34',
    currency: 'EUR',
    customerName: 'Test Zákazník',
    email: c.preparedEmail || 'test@example.com',
    prevReply: '(test — žiadna predošlá odpoveď)',
    stepIndex: (c.steps.findIndex((s) => s.id === stepId) + 1) || 1,
  };
  const token = c.mode === 'channel' ? sepaChannelBotToken(c) : stepToken(step);
  if (!token) {
    throw Object.assign(
      new Error(c.mode === 'channel' ? 'Chýba token SEPA kanálového bota' : 'Krok nemá token'),
      { code: c.mode === 'channel' ? 'NO_CHANNEL_BOT' : 'NO_TOKEN' }
    );
  }
  const targetChat =
    c.mode === 'channel' && c.channelId ? c.channelId : step.chatId;
  if (!targetChat) {
    throw Object.assign(
      new Error(c.mode === 'channel' ? 'Chýba ID kanála' : 'Krok nemá chat ID'),
      { code: c.mode === 'channel' ? 'NO_CHANNEL' : 'NO_CHAT' }
    );
  }
  const bodyText =
    (c.mode === 'channel'
      ? '🧪 TEST SEPA reťaze (nepoužívať ako ostrú platbu)\n' + buildChannelMessage(step, ctx)
      : '🧪 TEST SEPA reťaze (nepoužívať ako ostrú platbu)\n' + renderTemplate(step.template, ctx)) +
    `\n\n(Timeout ${step.timeoutSec}s — odpovedzte testovacími údajmi, alebo ignorujte.)`;
  const msg = await tgApi(token, 'sendMessage', {
    chat_id: targetChat,
    text: bodyText.slice(0, 4096),
    disable_web_page_preview: true,
  });
  if (appendLog) appendLog(`SEPA_CHAIN_TEST step=${step.id} order=${fakeId} msg=${msg.message_id}`);

  // Optionally wait briefly for a reply when managed
  let reply = null;
  if (step.managedByUs && c.mode !== 'channel') {
    try {
      const r = await waitForReply({
        token,
        chatId: targetChat,
        messageId: msg.message_id,
        timeoutSec: Math.min(step.timeoutSec, 60),
        managedByUs: true,
        log: appendLog,
        label: step.name + ' (test)',
      });
      reply = parseReply(r.text, step.extract);
    } catch (e) {
      reply = { error: e.message, code: e.code };
    }
  }

  return {
    ok: true,
    testOrderId: fakeId,
    messageId: msg.message_id,
    step: { id: step.id, name: step.name },
    reply,
  };
}

/** Resolve chat ID helper: getUpdates on a managed token, or getChat. */
async function discoverChatId(stepId, appendLog) {
  const c = getConfig();
  const step = (c.steps || []).find((s) => s.id === stepId);
  if (!step) throw Object.assign(new Error('Krok sa nenašiel'), { code: 'NOT_FOUND' });
  const token = stepToken(step);
  if (!token) throw Object.assign(new Error('Krok nemá token'), { code: 'NO_TOKEN' });
  if (!step.managedByUs) {
    return {
      ok: false,
      error:
        'Zistenie chat ID cez getUpdates je možné len keď je krok nastavený ako „spravovaný naším serverom“. Inak by sme ukradli updaty vášmu botovi. Napíšte botovi /start a vložte chat ID ručne (napr. z @userinfobot).',
      code: 'NOT_MANAGED',
    };
  }
  // Short non-consuming peek is still getUpdates — warn clearly; only OK because managed.
  const r = await fetch(
    `${API}/bot${token}/getUpdates?timeout=0&limit=20&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'channel_post']))}`
  );
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || 'getUpdates failed');
  const chats = [];
  for (const u of j.result || []) {
    const msg = u.message || u.channel_post;
    if (!msg || !msg.chat) continue;
    const id = String(msg.chat.id);
    if (!chats.find((x) => x.id === id)) {
      chats.push({
        id,
        type: msg.chat.type,
        title: msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || '',
      });
    }
  }
  if (appendLog) appendLog(`SEPA_CHAIN_CHAT_DISCOVER step=${step.id} n=${chats.length}`);
  return { ok: true, chats };
}

function applyAdminUpdate(body) {
  const cur = getConfig();
  const next = emptyConfig();
  next.enabled = Boolean(body.enabled);
  const mode = String(body.mode || cur.mode || 'channel').toLowerCase();
  next.mode = mode === 'managed' || mode === 'external' ? mode : 'channel';
  next.channelId = body.channelId != null ? String(body.channelId).trim() : (cur.channelId || '');
  next.lastSeenChannelId = cur.lastSeenChannelId || '';
  next.lastSeenChannelTitle = cur.lastSeenChannelTitle || '';
  next.lastSeenChannelAt = cur.lastSeenChannelAt || null;
  next.preparedEmail = String(body.preparedEmail || '').trim().slice(0, 200);
  next.proofCheckStepId = body.proofCheckStepId != null ? String(body.proofCheckStepId).trim() : (cur.proofCheckStepId || '');
  next.notifyEmail = body.notifyEmail != null ? String(body.notifyEmail).trim().slice(0, 200) : (cur.notifyEmail || '');
  next.proofTimeoutSec = body.proofTimeoutSec != null
    ? Math.max(30, Math.min(3600, Number(body.proofTimeoutSec) || 300))
    : (cur.proofTimeoutSec || 300);
  if (Array.isArray(body.verdictPass)) {
    next.verdictPass = body.verdictPass.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  } else if (typeof body.verdictPass === 'string') {
    next.verdictPass = body.verdictPass.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  } else {
    next.verdictPass = (cur.verdictPass || DEFAULT_VERDICT_PASS).slice();
  }
  if (Array.isArray(body.verdictFail)) {
    next.verdictFail = body.verdictFail.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  } else if (typeof body.verdictFail === 'string') {
    next.verdictFail = body.verdictFail.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  } else {
    next.verdictFail = (cur.verdictFail || DEFAULT_VERDICT_FAIL).slice();
  }
  next.smtpHost = body.smtpHost != null ? String(body.smtpHost).trim().slice(0, 200) : (cur.smtpHost || '');
  next.smtpPort = body.smtpPort != null ? (Number(body.smtpPort) || 587) : (cur.smtpPort || 587);
  next.smtpSecure = body.smtpSecure != null ? Boolean(body.smtpSecure) : Boolean(cur.smtpSecure);
  next.smtpUser = body.smtpUser != null ? String(body.smtpUser).trim().slice(0, 200) : (cur.smtpUser || '');
  next.smtpFrom = body.smtpFrom != null ? String(body.smtpFrom).trim().slice(0, 200) : (cur.smtpFrom || '');
  next.smtpPassEnc = cur.smtpPassEnc || null;
  if (body.smtpPass === '__clear__') {
    next.smtpPassEnc = null;
  } else if (body.smtpPass != null && String(body.smtpPass).trim()) {
    const t = String(body.smtpPass).trim();
    if (!(t.includes('…') || t.includes('••'))) next.smtpPassEnc = encryptSecret(t);
  }
  next.channelBotTokenEnc = cur.channelBotTokenEnc || null;

  // Dedicated SEPA channel bot token: empty = keep; '__clear__' = remove; masked = keep; else replace.
  const cbt = body.channelBotToken;
  if (cbt === '' || cbt == null) {
    // keep existing
  } else if (cbt === '__clear__') {
    next.channelBotTokenEnc = null;
  } else if (String(cbt).trim()) {
    const t = String(cbt).trim();
    if (t.includes('…') || t.includes('••')) {
      // masked value submitted — keep
    } else if (isPlat4Token(t)) {
      throw Object.assign(
        new Error('Token SEPA kanálového bota nesmie byť token @Plat4Bot — vytvorte v BotFather nového bota.'),
        { code: 'SAME_AS_PLAT4' }
      );
    } else if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(t)) {
      throw Object.assign(new Error('Neplatný formát tokenu SEPA kanálového bota (123456:AA…)'), {
        code: 'BAD_TOKEN',
      });
    } else {
      next.channelBotTokenEnc = encryptSecret(t);
    }
  }

  const stepsIn = Array.isArray(body.steps) ? body.steps : [];
  next.steps = stepsIn.map((s, idx) => {
    const prev = (cur.steps || []).find((p) => p.id === s.id) || {};
    const step = defaultStep({
      id: s.id || prev.id,
      name: s.name != null ? s.name : prev.name || `Krok ${idx + 1}`,
      botUsername: s.botUsername != null ? s.botUsername : prev.botUsername,
      chatId: s.chatId != null ? s.chatId : prev.chatId,
      template: s.template != null ? s.template : prev.template,
      extract: Array.isArray(s.extract) ? s.extract : prev.extract,
      timeoutSec: s.timeoutSec != null ? s.timeoutSec : prev.timeoutSec,
      managedByUs: s.managedByUs != null ? s.managedByUs : prev.managedByUs,
      replyMode: s.replyMode != null ? s.replyMode : prev.replyMode,
      attachPreparedEmail:
        s.attachPreparedEmail != null ? s.attachPreparedEmail : prev.attachPreparedEmail,
      tokenEnc: prev.tokenEnc || null,
    });
    if (s.token === '__clear__') {
      step.tokenEnc = null;
    } else if (s.token != null && String(s.token).trim()) {
      const t = String(s.token).trim();
      if (!(t.includes('…') || t.includes('••'))) {
        step.tokenEnc = encryptSecret(t);
      }
    }
    return step;
  });

  return next;
}

/**
 * Admin helper: return last seen channel id from payments-bot channel_post updates.
 * Optionally peek getUpdates on payments bot (only when we own it).
 */
async function discoverChannelId(appendLog) {
  const c = getConfig();
  const fromSighting = c.lastSeenChannelId
    ? {
        id: c.lastSeenChannelId,
        title: c.lastSeenChannelTitle || '',
        at: c.lastSeenChannelAt,
        source: 'last_seen',
      }
    : null;

  const token = sepaChannelBotToken(c);
  let peeked = [];
  // While the dedicated poller runs it already records sightings; a parallel getUpdates would 409.
  if (token && !channelPoller.running) {
    try {
      const r = await fetch(
        `${API}/bot${token}/getUpdates?timeout=0&limit=30&allowed_updates=${encodeURIComponent(JSON.stringify(['channel_post']))}`
      );
      const j = await r.json();
      if (j.ok) {
        for (const u of j.result || []) {
          const msg = u.channel_post;
          if (!msg || !msg.chat) continue;
          const id = String(msg.chat.id);
          if (!peeked.find((x) => x.id === id)) {
            peeked.push({
              id,
              title: msg.chat.title || '',
              type: msg.chat.type,
              source: 'getUpdates',
            });
          }
          noteChannelPostSighting(msg.chat);
        }
      }
    } catch (e) {
      if (appendLog) appendLog('SEPA_CHAIN_CHANNEL_DISCOVER_ERR ' + e.message);
    }
  }

  const c2 = getConfig();
  if (appendLog) {
    appendLog(
      `SEPA_CHAIN_CHANNEL_DISCOVER last=${c2.lastSeenChannelId || '-'} peeked=${peeked.length}`
    );
  }
  return {
    ok: true,
    lastSeen: c2.lastSeenChannelId
      ? {
          id: c2.lastSeenChannelId,
          title: c2.lastSeenChannelTitle || '',
          at: c2.lastSeenChannelAt,
          source: 'last_seen',
        }
      : fromSighting,
    channels: peeked,
    hint:
      !c2.lastSeenChannelId && !peeked.length
        ? token
          ? 'Pridajte SEPA kanálového bota ako admina do kanála (Post Messages), napíšte ľubovoľnú správu do kanála, potom kliknite znova.'
          : 'Najprv uložte token SEPA kanálového bota (BotFather → nový bot), pridajte ho ako admina do kanála a napíšte správu.'
        : null,
  };
}

/**
 * Test kanála: post a test amount message per step (or one combined), wait briefly
 * for each step's bot to respond in the channel. Reports who replied.
 */
async function testChannel(appendLog, { timeoutSec } = {}) {
  const c = getConfig();
  const channelId = String(c.channelId || '').trim();
  if (!channelId) {
    throw Object.assign(new Error('Najprv nastavte ID kanála'), { code: 'NO_CHANNEL' });
  }
  if (!c.steps || !c.steps.length) {
    throw Object.assign(new Error('Pridajte aspoň jeden krok'), { code: 'NO_STEPS' });
  }
  const waitSec = Math.max(10, Math.min(90, Number(timeoutSec) || 25));
  const fakeId = 'ord_chtest_' + crypto.randomBytes(3).toString('hex');
  const results = [];
  const log = appendLog || (() => {});

  for (let i = 0; i < c.steps.length; i++) {
    const step = c.steps[i];
    const token = sepaChannelBotToken(c);
    if (!token) {
      results.push({ stepId: step.id, name: step.name, ok: false, error: 'chýba token SEPA kanálového bota' });
      continue;
    }
    const ctx = {
      orderId: fakeId,
      amount: '1.00',
      currency: 'EUR',
      customerName: 'Test Kanál',
      email: c.preparedEmail || 'test@example.com',
      prevReply: '',
      stepIndex: i + 1,
      stepName: step.name,
    };
    const text =
      '🧪 TEST KANÁLA (ignorujte ak to nie je váš bot)\n' +
      buildChannelMessage(step, ctx) +
      `\n\nOčakávaná odpoveď od @${step.botUsername || '?'} do ${waitSec}s.`;

    let msg;
    try {
      msg = await tgApi(token, 'sendMessage', {
        chat_id: channelId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
      });
    } catch (e) {
      results.push({ stepId: step.id, name: step.name, ok: false, error: e.message });
      continue;
    }

    let replied = false;
    let replyMeta = null;
    const waitKey = fakeId + '_s' + (i + 1);
    try {
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unregisterChannelWait(waitKey);
          reject(Object.assign(new Error('timeout'), { code: 'STEP_TIMEOUT' }));
        }, waitSec * 1000);
        registerChannelWait(waitKey, {
          stepIndex: i + 1,
          botUsername: step.botUsername,
          messageId: msg.message_id,
          onReply: (t, meta) => {
            clearTimeout(timer);
            resolve({ text: t, meta });
          },
        });
      });
      replied = true;
      replyMeta = {
        fromUsername: reply.meta && reply.meta.fromUsername,
        preview: String(reply.text || '').slice(0, 120),
      };
    } catch (e) {
      replied = false;
      replyMeta = { error: e.message, code: e.code };
    } finally {
      unregisterChannelWait(waitKey);
    }

    results.push({
      stepId: step.id,
      name: step.name,
      botUsername: step.botUsername || '',
      messageId: msg.message_id,
      responded: replied,
      ok: replied,
      detail: replyMeta,
      note: replied
        ? 'Bot odpovedal v kanáli — OK'
        : 'Bot neodpovedal. Väčšina jednoduchých botov číta len súkromné správy — upravte kód bota aby spracúval channel_post, alebo použite režim „externý“ / „spravovaný“.',
    });
    log(`SEPA_CHAIN_CHANNEL_TEST step=${step.id} responded=${replied}`);
  }

  return {
    ok: results.every((r) => r.ok),
    testOrderId: fakeId,
    channelId,
    timeoutSec: waitSec,
    steps: results,
    honesty:
      'Upozornenie: vaše boty reagujú na príspevky v kanáli len ak ich kód spracúva channel_post. Ak „Test kanála“ zlyhá a bot v DM funguje, treba upraviť bota (alebo použiť fallback režim).',
  };
}

function isEnabled() {
  const c = getConfig();
  return Boolean(c.enabled && c.steps && c.steps.length);
}

/** True only when chain is on AND the order is manual SEPA. */
// ─── Dedicated SEPA channel bot poller (channel_post only) ───────────────────
// Separate token from @Plat4Bot → its own getUpdates offset, no 409 conflict.
// One long-poll fetch at a time (timeout=25) — negligible memory on Render free tier.
const channelPoller = {
  running: false,
  gen: 0,
  tokenHash: '',
  offset: 0,
  startedAt: null,
  lastOkAt: null,
  lastError: '',
  botUsername: '',
  log: null,
};

function channelPollerStatus() {
  return {
    running: channelPoller.running,
    startedAt: channelPoller.startedAt,
    lastOkAt: channelPoller.lastOkAt,
    lastError: channelPoller.lastError,
    botUsername: channelPoller.botUsername,
    disabledByEnv: env('SEPA_CHANNEL_POLL') === '0' || !require('./payMode').receive(),
  };
}

function stopChannelPoller() {
  channelPoller.gen++;
  channelPoller.running = false;
  channelPoller.tokenHash = '';
  channelPoller.offset = 0;
}

function pollSleep(ms) {
  return new Promise((ok) => {
    const t = setTimeout(ok, ms);
    if (t && t.unref) t.unref();
  });
}

async function channelPollLoop(gen, token) {
  const log = (m) => {
    try { if (channelPoller.log) channelPoller.log(m); } catch { /* */ }
  };
  try {
    const me = await tgApi(token, 'getMe', {});
    channelPoller.botUsername = (me && me.username) || '';
  } catch (e) {
    channelPoller.lastError = 'getMe: ' + String(e.message || e).slice(0, 160);
  }
  // Dedicated bot: if a webhook is set, getUpdates can't work — clear it (never @Plat4Bot; guarded).
  try {
    const info = await tgApi(token, 'getWebhookInfo', {});
    if (info && info.url && channelPoller.gen === gen && !isPlat4Token(token)) {
      await tgApi(token, 'deleteWebhook', { drop_pending_updates: false });
      log('SEPA_CHANNEL_BOT_WEBHOOK_CLEARED');
    }
  } catch { /* */ }
  log(`SEPA_CHANNEL_POLL_START bot=@${channelPoller.botUsername || '?'}`);
  let backoff = 2000;
  while (channelPoller.gen === gen) {
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const tm = ctrl ? setTimeout(() => ctrl.abort(), 40000) : null;
      if (tm && tm.unref) tm.unref();
      const r = await fetch(
        `${API}/bot${token}/getUpdates?timeout=25&offset=${channelPoller.offset}&allowed_updates=${encodeURIComponent(
          JSON.stringify(['channel_post'])
        )}`,
        ctrl ? { signal: ctrl.signal } : undefined
      );
      if (tm) clearTimeout(tm);
      const j = await r.json().catch(() => ({}));
      if (channelPoller.gen !== gen) break;
      if (!j.ok) {
        channelPoller.lastError = `${j.error_code || r.status} ${j.description || ''}`.trim().slice(0, 200);
        log('SEPA_CHANNEL_POLL_ERR ' + channelPoller.lastError);
        if (j.error_code === 401 || j.error_code === 404) {
          // Revoked / wrong token — stop; admin must paste a valid one.
          channelPoller.running = false;
          break;
        }
        await pollSleep(j.error_code === 409 ? 15000 : backoff);
        backoff = Math.min(backoff * 2, 60000);
        continue;
      }
      backoff = 2000;
      channelPoller.lastOkAt = new Date().toISOString();
      channelPoller.lastError = '';
      for (const u of j.result || []) {
        channelPoller.offset = u.update_id + 1;
        if (!u.channel_post) continue;
        try {
          const hit = ingestChannelPost(u.channel_post, channelPoller.log);
          if (hit) log('SEPA_CHANNEL_POST_CHAIN_HIT');
          else {
            const ch = u.channel_post.chat;
            log(`SEPA_CHANNEL_POST chat=${ch && ch.id} title=${(ch && ch.title) || ''}`.slice(0, 200));
          }
        } catch (e) {
          log('SEPA_CHANNEL_POST_ERR ' + e.message);
        }
      }
    } catch (e) {
      if (channelPoller.gen !== gen) break;
      channelPoller.lastError = String((e && e.message) || e).slice(0, 200);
      log('SEPA_CHANNEL_POLL_ERR ' + channelPoller.lastError);
      await pollSleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
  if (channelPoller.gen === gen) channelPoller.running = false;
}

/**
 * Start / restart / stop the dedicated poller to match config.
 * Runs only when chain enabled + channel mode + dedicated token set. Idempotent.
 */
function ensureChannelPoller(log) {
  if (log) channelPoller.log = log;
  const c = getConfig();
  const want = c.enabled && (c.mode || 'channel') === 'channel' ? sepaChannelBotToken(c) : '';
  const h = want ? crypto.createHash('sha256').update(want).digest('hex').slice(0, 16) : '';
  if (h && h === channelPoller.tokenHash && channelPoller.running) return channelPollerStatus();
  if (!h && !channelPoller.running) return channelPollerStatus();
  if (channelPoller.running && channelPoller.log) {
    try { channelPoller.log('SEPA_CHANNEL_POLL_STOP'); } catch { /* */ }
  }
  stopChannelPoller();
  if (!want || env('SEPA_CHANNEL_POLL') === '0' || !require('./payMode').receive()) return channelPollerStatus();
  channelPoller.tokenHash = h;
  channelPoller.running = true;
  channelPoller.startedAt = new Date().toISOString();
  channelPoller.lastError = '';
  channelPoller.botUsername = '';
  const gen = channelPoller.gen;
  channelPollLoop(gen, want).catch(() => {
    if (channelPoller.gen === gen) channelPoller.running = false;
  });
  return channelPollerStatus();
}

function shouldRunForOrder(order) {
  if (!isEnabled() || !isSepaManualOrder(order)) return false;
  const c = getConfig();
  // Channel mode needs the dedicated SEPA channel bot; else manual @Plat4Bot flow.
  if ((c.mode || 'channel') === 'channel' && !sepaChannelBotToken(c)) return false;
  return true;
}

module.exports = {
  EXTRACT_PRESETS,
  DEFAULT_TEMPLATE,
  normalizeAmountKey,
  pickLtcAddress,
  DEFAULT_VERDICT_PASS,
  DEFAULT_VERDICT_FAIL,
  load,
  save,
  getConfig,
  sanitizeForAdmin,
  applyAdminUpdate,
  sepaChannelBotToken,
  plat4BotToken,
  isPlat4Token,
  ensureChannelPoller,
  stopChannelPoller,
  channelPollerStatus,
  isEnabled,
  shouldRunForOrder,
  isSepaManualOrder,
  runChain,
  testStep,
  testChannel,
  discoverChatId,
  discoverChannelId,
  forwardProof,
  parseProofVerdict,
  resolveProofCheckStep,
  sendProofEmail,
  smtpSettings,
  ingestExternalReply,
  ingestChannelPost,
  registerChannelWait,
  unregisterChannelWait,
  noteChannelPostSighting,
  alertRyan,
  parseReply,
  parseOrderMarker,
  stripChannelMarkers,
  buildChannelMessage,
  renderTemplate,
  maskToken,
  encryptSecret,
  decryptSecret,
};
