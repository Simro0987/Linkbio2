'use strict';
/**
 * Admin-only Telegram bot for SEPA IBAN delivery + chain payment alerts.
 * Ignores every chat except TELEGRAM_ADMIN_CHAT_ID (or one-time /start bootstrap).
 */
const fs = require('fs');
const path = require('path');
const sepaManual = require('./sepaManual');

const API = 'https://api.telegram.org';
const ADMIN_FILE = path.join(__dirname, '..', 'data', 'telegram-admin.json');

function token() {
  // @Plat4Bot = env only. The admin "SEPA kanálový bot" token is NEVER read here —
  // it belongs exclusively to the SEPA chain module (its own poller).
  return String(process.env.TELEGRAM_PAYMENTS_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

function webhookSecret() {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

function loadAdminChatId() {
  const env = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  if (env) return env;
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    return j.chatId ? String(j.chatId) : '';
  } catch { return ''; }
}

function persistAdminChatId(chatId) {
  try {
    fs.mkdirSync(path.dirname(ADMIN_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ chatId: String(chatId), setAt: new Date().toISOString() }, null, 2));
  } catch { /* ignore */ }
  process.env.TELEGRAM_ADMIN_CHAT_ID = String(chatId);
}

async function api(method, body) {
  const t = token();
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const r = await fetch(`${API}/bot${t}/${method}`, {
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

// ---- inline ✅/❌ decision buttons (callback_data = d:<c|r>:<ref>:<hmac>) ----
const crypto = require('crypto');
function cbKey() { return 'tgcb:' + (webhookSecret() || token()); }
function cbSig(action, ref) { return crypto.createHmac('sha256', cbKey()).update(`${action}:${ref}`).digest('base64url').slice(0, 16); }
function decisionKeyboard(ref) {
  const id = String(ref);
  if (Buffer.byteLength(`d:c:${id}:`) + 16 > 64) return undefined;
  return { inline_keyboard: [[
    { text: '✅ Potvrdiť', callback_data: `d:c:${id}:${cbSig('c', id)}` },
    { text: '❌ Zamietnuť', callback_data: `d:r:${id}:${cbSig('r', id)}` },
  ]] };
}
function parseDecision(data) {
  const m = String(data || '').match(/^d:([cr]):(.+):([A-Za-z0-9_-]{16})$/);
  if (!m) return null;
  const a = Buffer.from(cbSig(m[1], m[2])), b = Buffer.from(m[3]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { action: m[1] === 'c' ? 'confirmed' : 'rejected', ref: m[2] };
}

function ct(order) { try { return '\nKontakt: ' + require('./contact').contactText(order && order.contact); } catch { return ''; } }

async function sendFile(chatId, kind, buffer, filename, caption, mime) {
  const t = token();
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) fd.append('caption', String(caption).slice(0, 1000));
  fd.append(kind === 'photo' ? 'photo' : 'document', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
  const r = await fetch(`${API}/bot${t}/${kind === 'photo' ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || 'telegram send file failed');
  return j.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return api('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

/**
 * Preferred format — IBAN + note; recipient name optional (amount from order):
 *
 * Reply to order notification:
 *   <IBAN>
 *   <poznámka>
 *   [<meno príjemcu>]   ← optional
 *
 * Command:
 *   /iban <orderId>
 *   <IBAN>
 *   <poznámka>
 *   [<meno príjemcu>]
 *
 * Fallbacks: 5-line format and legacy one-line `… | <poznámka>`.
 */
function splitNote(raw) {
  const str = String(raw || '');
  const i = str.indexOf('|');
  if (i < 0) return { head: str.trim(), note: '' };
  return { head: str.slice(0, i).trim(), note: str.slice(i + 1).trim() };
}

function parseThreeLines(lines) {
  const cleaned = (lines || []).map((l) => String(l == null ? '' : l));
  let start = 0;
  while (start < cleaned.length && !String(cleaned[start]).trim()) start++;
  // Need IBAN + note; 3rd line (beneficiary) is optional
  if (cleaned.length - start < 2) return null;
  const iban = String(cleaned[start]).trim();
  // Keep note exactly as typed (trim only the line edges Telegram adds)
  const note = String(cleaned[start + 1]).trim();
  const beneficiary =
    cleaned.length - start >= 3 ? String(cleaned[start + 2]).trim() : '';
  if (!iban || !note) return null;
  const ibanCompact = iban.replace(/\s+/g, '');
  if (!/^[A-Za-z]{2}\d{2}/.test(ibanCompact)) return null;
  return { iban, note, beneficiary: beneficiary || null, amount: null, vs: null };
}

function parseFiveLines(lines) {
  const cleaned = (lines || []).map((l) => String(l == null ? '' : l).trim());
  if (cleaned.length < 5) return null;
  const iban = cleaned[0];
  const amount = cleaned[1];
  const vs = cleaned[2];
  const beneficiary = cleaned[3] || '';
  const note = cleaned.slice(4).join('\n').trim();
  if (!iban || !amount || !note) return null;
  const ibanCompact = iban.replace(/\s+/g, '');
  if (!/^[A-Za-z]{2}\d{2}/.test(ibanCompact)) return null;
  return { iban, amount, vs, beneficiary, note };
}

function parseIbanCommand(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  const multi = raw.match(/^\/iban(?:@\w+)?\s+(\S+)\s*\n([\s\S]+)$/i);
  if (multi) {
    const orderId = multi[1];
    const bodyLines = multi[2].split('\n');
    const five = parseFiveLines(bodyLines);
    // Prefer 5-line when 2nd row looks like an amount (legacy fallback)
    if (five && /^\d+(?:[.,]\d{1,2})?$/.test(String(five.amount).trim())) {
      return { orderId, ...five };
    }
    const three = parseThreeLines(bodyLines);
    if (three) return { orderId, ...three };
    if (five) return { orderId, ...five };
  }
  const { head, note } = splitNote(raw);
  const cmd = head.match(/^\/iban(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/i);
  if (!cmd) return null;
  return {
    orderId: cmd[1],
    iban: cmd[2],
    amount: cmd[3],
    vs: cmd[4],
    beneficiary: (cmd[5] || '').trim() || null,
    note: note || null,
  };
}

/** Reply body — orderId from replied notification. */
function parseIbanReply(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  const lines = raw.split('\n');
  const five = parseFiveLines(lines);
  // Prefer 5-line when 2nd row looks like an amount (legacy fallback)
  if (five && /^\d+(?:[.,]\d{1,2})?$/.test(String(five.amount).trim())) return five;
  const three = parseThreeLines(lines);
  if (three) return three;
  if (five) return five;
  const { head, note } = splitNote(raw);
  const m = head.match(/^([A-Za-z]{2}\d{2}[A-Za-z0-9 ]{10,42})\s+(\d+(?:[.,]\d{1,2})?)\s+(\S+)(?:\s+(.+))?$/);
  if (m) {
    return {
      iban: m[1],
      amount: m[2],
      vs: m[3],
      beneficiary: (m[4] || '').trim() || null,
      note: note || null,
    };
  }
  return null;
}
// Revtag: "@ryan123", "ryan123", "revolut.me/ryan123", "https://revolut.me/ryan123/..."
function parseRevtag(raw) {
  let t = String(raw || '').trim();
  if (!t || /\s/.test(t)) return null;
  const m = t.match(/^(?:https?:\/\/)?(?:www\.)?revolut\.me\/@?([^/?#\s]+)/i);
  if (m) t = m[1];
  t = t.replace(/^@/, '');
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/i.test(t)) return null;
  return t.toLowerCase();
}

function parseRevtagCommand(text) {
  const m = String(text || '').trim().match(/^\/revtag(?:@\w+)?\s+(\S+)\s+(\S+)\s*$/i);
  if (!m) return null;
  return { orderId: m[1], raw: m[2], revtag: parseRevtag(m[2]) };
}

function orderIdFromNotifyText(text) {
  const m = String(text || '').match(/Objednávka:\s*(\S+)/i) || String(text || '').match(/\b(ord_[A-Za-z0-9]+)\b/);
  return m ? m[1] : null;
}

function createBot({ loadOrders, saveOrders, appendLog, publicBase }) {
  let offset = 0;
  let polling = false;
  const pendingByMsg = new Map(); // telegram message_id -> orderId

  async function notifySepaOrder(order) {
    const chat = loadAdminChatId();
    if (!chat) {
      if (appendLog) appendLog('TELEGRAM_SKIP no admin chat id');
      return null;
    }
    const cust = (order.fullName || `${order.firstName || ''} ${order.lastName || ''}`).trim();
    const text =
      `🆕 SEPA objednávka\n` +
      `Objednávka: ${order.orderId}\n` +
      (cust ? `Meno: ${cust}\n` : '') +
      `Suma: ${order.amountExact || order.amountEur} EUR`+`\n\n` +
      `Odpovedzte na túto správu (IBAN + poznámka; meno príjemcu voliteľné; suma ${order.amountExact || order.amountEur} EUR sa vezme z objednávky):\n` +
      `<IBAN>\n` +
      `<poznámka>\n` +
      `[<meno príjemcu>]\n\n` +
      `Príklad (bez mena):\n` +
      `HR2926190417610279016\n` +
      `263929-293629-29272\n\n` +
      `Alebo príkaz:\n` +
      `/iban ${order.orderId}\n` +
      `<IBAN>\n` +
      `<poznámka>\n` +
      `[<meno príjemcu>]`;
    const msg = await sendMessage(chat, text, { reply_markup: decisionKeyboard(order.orderId) });
    pendingByMsg.set(msg.message_id, order.orderId);
    const orders = loadOrders();
    if (orders[order.orderId]) {
      orders[order.orderId].telegramMessageId = msg.message_id;
      orders[order.orderId].telegramChatId = chat;
      saveOrders(orders);
    }
    if (appendLog) appendLog(`TELEGRAM_SEPA_NOTIFY ${order.orderId} msg=${msg.message_id}`);
    return msg;
  }

  async function notifyRevolutOrder(order) {
    const chat = loadAdminChatId();
    if (!chat) { if (appendLog) appendLog('TELEGRAM_SKIP no admin chat id'); return null; }
    const text =
      `🆕 Revolut objednávka\n` +
      `Objednávka: ${order.orderId}\n` +
      `Suma: ${order.amountEur} EUR`+`\n` +
      `\n` +
      `👉 Stačí ODPOVEDAŤ (Reply) na túto správu iba Revtagom, napr.:\n@ryan123\n(číslo objednávky netreba; funguje aj odkaz https://revolut.me/ryan123)\n\n` +
      `Alternatíva: /revtag ${order.orderId} @ryan123`;
    const msg = await sendMessage(chat, text, { reply_markup: decisionKeyboard(order.orderId) });
    pendingByMsg.set(msg.message_id, order.orderId);
    const orders = loadOrders();
    if (orders[order.orderId]) {
      orders[order.orderId].telegramMessageId = msg.message_id;
      orders[order.orderId].telegramChatId = chat;
      saveOrders(orders);
    }
    if (appendLog) appendLog(`TELEGRAM_REVOLUT_NOTIFY ${order.orderId} msg=${msg.message_id}`);
    return msg;
  }

  async function notifyRevolutPaid(order) {
    const chat = loadAdminChatId();
    if (!chat) return null;
    return sendMessage(chat,
      `💶 Zákazník kliknul „Zaplatil som“\nObjednávka: ${order.orderId}\nSuma: ${order.amountEur} EUR\nRevtag: @${order.revtag}\n\nSkontrolujte príjem v Revolute.`,
      order.telegramMessageId ? { reply_to_message_id: order.telegramMessageId } : {});
  }

  async function applyRevtag(orderId, revtag, replyCtx) {
    const orders = loadOrders();
    const order = orders[orderId];
    if (!order || order.provider !== 'revolut_manual') throw new Error(`Revolut objednávka ${orderId} sa nenašla`);
    if (!revtag) throw new Error('Neplatný Revtag. Formát: @ryan123 alebo https://revolut.me/ryan123 (3–32 znakov: písmená, čísla, . _ -)');
    order.revtag = revtag;
    order.status = 'awaiting_payment';
    order.revtagSetAt = new Date().toISOString();
    orders[orderId] = order;
    saveOrders(orders);
    if (appendLog) appendLog(`TELEGRAM_REVTAG ${orderId} revtag=@${revtag}`);
    await sendMessage(loadAdminChatId(),
      `✅ Revtag @${revtag} odoslaný zákazníkovi k objednávke ${orderId}\nSuma ${order.amountEur} EUR`,
      replyCtx && replyCtx.message_id ? { reply_to_message_id: replyCtx.message_id } : {});
    return order;
  }

  async function notifyChain(order, status) {
    const chat = loadAdminChatId();
    if (!chat) return null;
    const label = status === 'confirmed' ? 'potvrdené' : status === 'unconfirmed' ? 'prijaté – nepotvrdené' : status;
    const text =
      `💸 Chain platba · ${label}\n` +
      `Objednávka: ${order.orderId}\n` +
      `Meno: ${order.fullName || '-'}\n` +
      `Suma: ${order.amountExact || order.amountEur || '-'} EUR\n` +
      `Mena: ${String(order.payoutCoin || '').toUpperCase()}\n` +
      `Adresa: ${order.payoutAddress || '-'}`;
    return sendMessage(chat, text);
  }

  async function applyFromRyan(orderId, parsed, replyCtx) {
    const orders = loadOrders();
    const order = orders[orderId];
    if (!order || order.provider !== 'bank_sepa_manual') {
      throw new Error(`Objednávka ${orderId} sa nenašla`);
    }
    if (!parsed.note) throw new Error('Chýba poznámka (2. riadok)');
    // Recipient name (3. riadok) is optional
    sepaManual.applyBankDetails(order, {
      iban: parsed.iban,
      amount: parsed.amount != null && parsed.amount !== '' ? parsed.amount : order.amountExact,
      vs: parsed.vs,
      beneficiary: parsed.beneficiary,
      note: parsed.note,
      via: 'telegram',
    });
    orders[orderId] = order;
    saveOrders(orders);
    if (appendLog) appendLog(`TELEGRAM_IBAN ${orderId} iban=${order.bank.iban.slice(0, 4)}… note=${String(order.paymentNote).slice(0, 40)}`);
    const chat = loadAdminChatId();
    await sendMessage(
      chat,
      `✅ Uložené pre ${orderId}\nIBAN ${order.bank.iban}\nSuma ${order.amountExact} EUR\nVS ${order.vs || '—'}\nPríjemca ${order.bank.beneficiary || '—'}\nPoznámka ${order.paymentNote}\nZákazník uvidí údaje + QR na /bank-sepa-pay`,
      replyCtx && replyCtx.message_id ? { reply_to_message_id: replyCtx.message_id } : {}
    );
    return order;
  }

  async function handleCallback(cq) {
    const admin = String(loadAdminChatId() || '');
    const fromOk = admin && String(cq.from && cq.from.id) === admin && cq.message && String(cq.message.chat.id) === admin;
    if (!fromOk) {
      if (appendLog) appendLog(`TELEGRAM_CB_DENY from=${cq.from && cq.from.id}`);
      return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Nepovolené.', show_alert: false }).catch(() => {});
    }
    const d = parseDecision(cq.data);
    if (!d) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Neplatné tlačidlo.' }).catch(() => {});
    const sl = require('./statusLinks');
    const at = new Date().toISOString();
    let rec = sl.forRef(d.ref);
    const orders = loadOrders();
    const o = orders[d.ref];
    if (o) {
      if (!rec) { sl.ensureOrder(o); rec = sl.forRef(d.ref); }
      o.adminDecision = d.action; o.adminDecisionAt = at;
      saveOrders(orders);
    }
    if (!rec) return api('answerCallbackQuery', { callback_query_id: cq.id, text: `Záznam ${d.ref} sa nenašiel.`, show_alert: true }).catch(() => {});
    sl.update(d.ref, { decision: d.action, decidedAt: at });
    const label = d.action === 'confirmed' ? '✅ POTVRDENÉ' : '❌ ZAMIETNUTÉ';
    const when = new Date(at).toLocaleString('sk-SK', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' });
    const base = String(cq.message.text || cq.message.caption || '').replace(/\n\n(✅ POTVRDENÉ|❌ ZAMIETNUTÉ)[^\n]*$/, '');
    try {
      await api('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: `${base}\n\n${label} · ${when}`.slice(0, 4096), disable_web_page_preview: true });
    } catch (e) { if (appendLog) appendLog('TELEGRAM_CB_EDIT_FAIL ' + e.message); }
    await api('answerCallbackQuery', { callback_query_id: cq.id, text: `${label}: ${d.ref}` }).catch(() => {});
    if (appendLog) appendLog(`TELEGRAM_DECISION ${d.ref} ${d.action}`);
  }

  async function handleUpdate(update) {
    if (update.callback_query) return handleCallback(update.callback_query);

    // channel_post is not handled by @Plat4Bot — the dedicated SEPA channel bot polls it itself.
    if (update.channel_post) return;

    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return;
    const chatId = String(msg.chat.id);
    let admin = loadAdminChatId();

    // /start: lock admin when unset; confirm when already this chat
    if (msg.chat.type === 'private' && /^\/start(?:@\w+)?(?:\s|$)/i.test(String(msg.text || ''))) {
      if (!admin) {
        persistAdminChatId(chatId);
        admin = chatId;
        await sendMessage(chatId, 'Admin chat nastavený. Budem sem posielať SEPA objednávky a chain alerty.\n\nFormát odpovede:\n<IBAN>\n<poznámka>\n[<meno príjemcu — voliteľné>]');
        if (appendLog) appendLog(`TELEGRAM_ADMIN_BOOTSTRAP ${chatId}`);
        return;
      }
      if (chatId === String(admin)) {
        await sendMessage(chatId, 'Už ste admin. Formát:\n<IBAN>\n<poznámka>\n[<meno príjemcu — voliteľné>]\n\n/help pre detail.');
        return;
      }
      // other private chats: ignore
      return;
    }

    if (!admin || chatId !== String(admin)) {
      // ignore everyone else — no reply
      return;
    }

    const text = String(msg.text || '').trim();
    if (!text) return;

    if (/^\/help(?:@\w+)?$/i.test(text)) {
      await sendMessage(
        chatId,
        'SEPA bot — formát (suma z objednávky):\n\n' +
          '1) Odpoveď na notifikáciu:\n' +
          '<IBAN>\n' +
          '<poznámka>\n' +
          '[<meno príjemcu — voliteľné>]\n\n' +
          'Príklad (bez mena):\n' +
          'HR2926190417610279016\n' +
          '263929-293629-29272\n\n' +
          '2) Príkaz:\n' +
          '/iban <orderId>\n' +
          '<IBAN>\n' +
          '<poznámka>\n' +
          '[<meno príjemcu>]\n\n' +
          'IBAN sa kontroluje checksumom (mod 97). Poznámka sa zachová presne. Meno príjemcu je voliteľné (bez neho sa skryje EPC QR).\n\n' +
          'Starší 5-riadkový formát (IBAN / suma / VS / meno / poznámka) a jednoriadkový stále fungujú.\n\n' +
          'Revolut objednávky: odpovedzte jedným riadkom @revtag (alebo revolut.me odkaz), alebo /revtag <orderId> @revtag'
      );
      return;
    }

    try {
      if (/^\/revtag/i.test(text)) {
        const rc = parseRevtagCommand(text);
        if (!rc) { await sendMessage(chatId, 'Formát:\n/revtag <orderId> @revtag'); return; }
        await applyRevtag(rc.orderId, rc.revtag, msg);
        return;
      }
      const asCmd = parseIbanCommand(text);
      if (asCmd) {
        await applyFromRyan(asCmd.orderId, asCmd, msg);
        return;
      }
      if (msg.reply_to_message && global.__chatReplyHook && await global.__chatReplyHook(msg)) return;
      if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text || '';
        let oid =
          pendingByMsg.get(msg.reply_to_message.message_id) ||
          orderIdFromNotifyText(replyText);
        if (!oid) {
          const orders = loadOrders();
          const hit = Object.values(orders).find((o) => o.telegramMessageId === msg.reply_to_message.message_id);
          if (hit) oid = hit.orderId;
        }
        const isRevolutNotify = /Revolut objednávka/i.test(replyText);
        if (oid) {
          const o = loadOrders()[oid];
          if ((o && o.provider === 'revolut_manual') || (!o && isRevolutNotify)) {
            // applyRevtag replies with ✅ or throws → ❌ explanation (never silent)
            await applyRevtag(oid, parseRevtag(text), msg);
            return;
          }
        }
        if (!oid && (isRevolutNotify || parseRevtag(text))) {
          throw new Error('Neviem, ku ktorej objednávke patrí táto odpoveď. Použi /revtag <orderId> @revtag');
        }
        const parsed = parseIbanReply(text);
        if (oid && parsed) {
          await applyFromRyan(oid, parsed, msg);
          return;
        }
      }
      if (/^\/iban/i.test(text)) {
        await sendMessage(chatId, 'Formát:\n/iban <orderId>\n<IBAN>\n<poznámka>\n[<meno príjemcu — voliteľné>]');
      }
    } catch (e) {
      await sendMessage(chatId, `❌ ${e.message}`, msg.message_id ? { reply_to_message_id: msg.message_id } : {});
    }
  }

  async function setWebhook(baseUrl) {
    const secret = webhookSecret();
    const url = `${String(baseUrl).replace(/\/$/, '')}/api/telegram/webhook`;
    const body = { url, allowed_updates: ['message', 'edited_message', 'callback_query'] };
    if (secret) body.secret_token = secret;
    return api('setWebhook', body);
  }

  async function deleteWebhook() {
    return api('deleteWebhook', { drop_pending_updates: false });
  }

  function startPolling() {
    if (polling || !token()) return;
    polling = true;
    const loop = async () => {
      while (polling) {
        try {
          const t = token();
          const r = await fetch(`${API}/bot${t}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message','edited_message','callback_query']))}`);
          const j = await r.json();
          if (j.ok) {
            for (const u of j.result || []) {
              offset = u.update_id + 1;
              try { await handleUpdate(u); } catch (e) { if (appendLog) appendLog('TELEGRAM_UPD_ERR ' + e.message); }
            }
          }
        } catch (e) {
          if (appendLog) appendLog('TELEGRAM_POLL_ERR ' + e.message);
          await new Promise((ok) => setTimeout(ok, 3000));
        }
      }
    };
    loop();
  }

  function register(app) {
    app.post('/api/telegram/webhook', async (req, res) => {
      const secret = webhookSecret();
      if (secret) {
        const hdr = req.get('x-telegram-bot-api-secret-token') || '';
        const a = crypto.createHash('sha256').update(String(hdr)).digest(), b = crypto.createHash('sha256').update(secret).digest();
        if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad secret' });
      } else if (process.env.RENDER) return res.status(503).json({ error: 'webhook secret not configured' });
      res.json({ ok: true });
      { const m = (req.body || {}).message || {}; if (appendLog) appendLog(`TELEGRAM_WH_UPDATE ${(req.body || {}).update_id} reply_to=${m.reply_to_message ? m.reply_to_message.message_id : '-'}`); }
      try { await handleUpdate(req.body || {}); } catch (e) { if (appendLog) appendLog('TELEGRAM_WH_ERR ' + e.message); }
    });

    app.get('/api/telegram/status', (_req, res) => {
      res.json({
        configured: Boolean(token()),
        adminChatSet: Boolean(loadAdminChatId()),
        webhookSecretSet: Boolean(webhookSecret()),
      });
    });
  }

  async function boot() {
    if (!token()) {
      if (appendLog) appendLog('TELEGRAM_OFF no token');
      return { mode: 'off' };
    }
    const base = publicBase || process.env.CALLBACK_BASE_URL?.replace(/\/callback\/?$/i, '') || process.env.PUBLIC_URL || '';
    const onRender = Boolean(process.env.RENDER || /onrender\.com/i.test(base));
    if (onRender && base) {
      try {
        const baseUrl = base.startsWith('http') ? base : `https://${base}`;
        await setWebhook(baseUrl);
        if (appendLog) appendLog('TELEGRAM_WEBHOOK ' + baseUrl + ' admin=' + (loadAdminChatId() || 'none'));
        // Self-heal: another instance with the same token may delete/replace our webhook.
        const want = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
        setInterval(async () => {
          try {
            const info = await api('getWebhookInfo');
            if (info.url !== want) { await setWebhook(baseUrl); if (appendLog) appendLog('TELEGRAM_WEBHOOK_RESET was=' + (info.url || 'empty')); }
          } catch (e) { if (appendLog) appendLog('TELEGRAM_WEBHOOK_CHECK_ERR ' + e.message); }
        }, 60000).unref();
        return { mode: 'webhook', base: baseUrl };
      } catch (e) {
        if (appendLog) appendLog('TELEGRAM_WEBHOOK_FAIL ' + e.message + ' → poll');
      }
    }
    if (!onRender && process.env.TELEGRAM_POLL !== '1') {
      if (appendLog) appendLog('TELEGRAM_OFF local (set TELEGRAM_POLL=1 to poll)');
      return { mode: 'off' };
    }
    try { await deleteWebhook(); } catch { /* */ }
    startPolling();
    if (appendLog) appendLog('TELEGRAM_POLL start');
    return { mode: 'polling' };
  }

  return {
    notifySepaOrder,
    notifyRevolutOrder,
    notifyRevolutPaid,
    notifyChain,
    handleUpdate,
    register,
    boot,
    setWebhook,
    sendMessage,
    sendFile,
    loadAdminChatId,
    tokenConfigured: () => Boolean(token()),
  };
}

module.exports = { decisionKeyboard, parseDecision, parseRevtag, parseRevtagCommand, createBot, parseIbanCommand, parseIbanReply, token, loadAdminChatId };
