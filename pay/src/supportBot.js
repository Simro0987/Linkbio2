'use strict';
// Secondary Telegram bot: SUPPORT (chat escalations + customer DMs; owner replies flow back).
// Token TELEGRAM_SUPPORT_BOT_TOKEN; if missing, everything falls back to the main (payments) bot.
// Own webhook /api/telegram/support/webhook with its own secret (TELEGRAM_SUPPORT_WEBHOOK_SECRET,
// or derived via HMAC from TELEGRAM_WEBHOOK_SECRET so it always differs from the main one).
const crypto = require('crypto');
const API = 'https://api.telegram.org';
const tok = () => String(process.env.TELEGRAM_SUPPORT_BOT_TOKEN || '').trim();
const adminChat = () => String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
function secret() {
  const own = String(process.env.TELEGRAM_SUPPORT_WEBHOOK_SECRET || '').trim(); if (own) return own;
  const base = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim(); if (!base) return '';
  return crypto.createHmac('sha256', base).update('support-webhook').digest('base64url');
}
async function api(method, body) {
  const r = await fetch(`${API}/bot${tok()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({})); if (!j.ok) throw new Error(j.description || method + ' failed'); return j.result;
}
const dmByMsg = new Map(); // forwarded message_id -> customer chat id
const hits = new Map();
function limited(id) { const n = Date.now(), a = (hits.get(id) || []).filter((t) => n - t < 600000); a.push(n); hits.set(id, a); return a.length > 10; }

function create({ appendLog, mainBot }) {
  const enabled = () => Boolean(tok());
  // Bot used for support traffic: support bot if configured, else main bot.
  const send = (chat, text, extra = {}) => (enabled() ? api('sendMessage', { chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra }) : mainBot().sendMessage(chat, text, extra));
  async function onUpdate(u) {
    const m = u.message || u.edited_message; if (!m || !m.chat) return;
    const own = String(m.chat.id) === adminChat();
    if (own) {
      if (m.reply_to_message && global.__chatReplyHook && await global.__chatReplyHook(m, send)) return;
      const to = m.reply_to_message && dmByMsg.get(m.reply_to_message.message_id);
      if (to && m.text) { await api('sendMessage', { chat_id: to, text: String(m.text).slice(0, 3500) }); await api('sendMessage', { chat_id: m.chat.id, text: '✅ Odoslané zákazníkovi', reply_to_message_id: m.message_id }); return; }
      if (/^\/start/.test(m.text || '')) await api('sendMessage', { chat_id: m.chat.id, text: '🛟 Support bot aktívny. Eskalácie z chatu a správy zákazníkov prídu sem – odpovedzte cez Reply.' });
      return;
    }
    if (m.chat.type !== 'private') return;
    if (limited(m.chat.id)) return;
    if (/^\/start/.test(m.text || '')) { await api('sendMessage', { chat_id: m.chat.id, text: 'Dobrý deň 👋 Napíšte svoju otázku, odpovieme čo najskôr. / Hi, write your question and we will reply soon.' }); return; }
    const txt = String(m.text || m.caption || '[bez textu]').slice(0, 1500);
    const who = [m.from && m.from.first_name, m.from && m.from.username ? '@' + m.from.username : ''].filter(Boolean).join(' ');
    if (!adminChat()) return;
    const f = await api('sendMessage', { chat_id: adminChat(), text: `🛟 Zákazník (Telegram) ${who}\n\n${txt}\n\n👉 Odpovedz (Reply) – odpoveď dostane zákazník.` });
    dmByMsg.set(f.message_id, m.chat.id); if (dmByMsg.size > 5000) dmByMsg.delete(dmByMsg.keys().next().value);
    await api('sendMessage', { chat_id: m.chat.id, text: 'Ďakujeme, správa bola odovzdaná. / Thanks, message delivered.' });
    if (appendLog) appendLog('TG_SUPPORT_DM');
  }
  function register(app) {
    app.post('/api/telegram/support/webhook', async (req, res) => {
      const s = secret();
      if (!s || !enabled()) return res.status(503).json({ error: 'not configured' });
      const a = crypto.createHash('sha256').update(String(req.get('x-telegram-bot-api-secret-token') || '')).digest(), b = crypto.createHash('sha256').update(s).digest();
      if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad secret' });
      res.json({ ok: true });
      try { await onUpdate(req.body || {}); } catch (e) { if (appendLog) appendLog('TG_SUPPORT_ERR ' + e.message); }
    });
  }
  async function boot(base) {
    if (!enabled() || !base || !secret()) { if (appendLog) appendLog('TG_SUPPORT ' + (enabled() ? 'no base/secret' : 'off → main bot fallback')); return; }
    try { await api('setWebhook', { url: base.replace(/\/$/, '') + '/api/telegram/support/webhook', secret_token: secret(), allowed_updates: ['message', 'edited_message'] }); if (appendLog) appendLog('TG_SUPPORT_WEBHOOK ok'); }
    catch (e) { if (appendLog) appendLog('TG_SUPPORT_WEBHOOK_FAIL ' + e.message); }
  }
  return { enabled, send, register, boot };
}
module.exports = { create };
