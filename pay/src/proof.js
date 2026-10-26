'use strict';
// "Poslať doklad": files (photo/PDF) + code/link + note → bucket + DB + Telegram admin.
const crypto = require('crypto');
const express = require('express');
const proofStore = require('./proofStore');
const orderDb = require('./db');
const { validateContact, contactText } = require('./contact');

const MAX_FILE = 10 * 1024 * 1024, MAX_FILES = 6;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf' };
const hits = new Map();
function limited(ip) {
  const now = Date.now(); const a = (hits.get(ip) || []).filter((t) => now - t < 3600000); a.push(now); hits.set(ip, a);
  return a.filter((t) => now - t < 600000).length > 5 || a.length > 20;
}
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.slice(4, 8).toString() === 'ftyp' && /heic|heix|mif1|msf1|heif/.test(buf.slice(8, 12).toString())) return 'image/heic';
  return null;
}
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

module.exports = function register(app, { loadOrders, saveOrders, appendLog }) {
  app.post('/api/proof', express.json({ limit: '90mb' }), async (req, res) => {
    const ip = String(req.ip || '');
    if (limited(ip)) return res.status(429).json({ error: 'Príliš veľa odoslaní, skúste neskôr.' });
    const b = req.body || {};
    const code = clip(b.code, 500), link = clip(b.link, 500), note = clip(b.note, 1000);
    if (link && !/^https?:\/\/\S+$/i.test(link)) return res.status(400).json({ error: 'Odkaz musí začínať http:// alebo https://' });
    const files = Array.isArray(b.files) ? b.files : [];
    if (files.length > MAX_FILES) return res.status(400).json({ error: `Najviac ${MAX_FILES} súborov.` });
    if (!files.length && !code && !link) return res.status(400).json({ error: 'Pridajte aspoň kód, odkaz alebo súbor (samotná poznámka nestačí).' });
    const vc0 = validateContact(b.contact || {});
    if (vc0.error) return res.status(400).json({ error: vc0.error, field: 'contact' });
    const bufs = [];
    for (const f of files) {
      const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
      if (!buf.length || buf.length > MAX_FILE) return res.status(400).json({ error: `Súbor ${clip(f.name, 60)} je prázdny alebo väčší ako 10 MB.` });
      const type = sniff(buf);
      if (!type) return res.status(400).json({ error: `Súbor ${clip(f.name, 60)}: povolené sú len JPG, PNG, WEBP, HEIC a PDF.` });
      bufs.push({ buf, type, name: clip(f.name, 80).replace(/[^\w.\-]+/g, '_') || 'subor' });
    }
    // Context: existing order, or gift-card submission
    let id, ctx;
    const orders = loadOrders();
    if (b.orderId && orders[String(b.orderId)]) {
      const o = orders[String(b.orderId)];
      id = o.orderId;
      ctx = { kind: 'order', method: o.provider || o.gateway, amount: o.amountExact || o.amountEur, contact: vc0.contact || o.contact || null };
    } else if (b.giftMethod) {
      const vc = validateContact(b.contact || {});
      if (vc.error) return res.status(400).json({ error: vc.error, field: 'contact' });
      id = 'gs_' + crypto.randomBytes(6).toString('hex');
      let label = clip(b.giftMethod, 60), amount = null;
      try { const p = require('./g2a').getProduct(label); if (p) { label = p.label; amount = p.amountEur || p.faceValueEur || null; } } catch { /* */ }
      ctx = { kind: 'gift', method: label, amount, contact: vc.contact };
    } else return res.status(400).json({ error: 'Objednávka sa nenašla.' });

    const stamp = Date.now();
    const stored = [];
    try {
      for (let i = 0; i < bufs.length; i++) {
        const f = bufs[i];
        const fn = `${stamp}-${i + 1}-${f.name}`.replace(/\.(jpe?g|png|webp|heic|heif|pdf)$/i, '') + '.' + TYPES[f.type];
        const obj = await proofStore.uploadBuffer(id, fn, f.buf, f.type);
        stored.push({ key: obj ? obj.key : null, type: f.type, size: f.buf.length });
      }
    } catch (e) { appendLog(`PROOF_UPLOAD_FAIL ${id} ${e.message}`); return res.status(502).json({ error: 'Nahranie zlyhalo, skúste znova.' }); }

    // private customer status link (orders already have one via saveOrders)
    const sl = require('./statusLinks');
    let st = sl.forRef(id);
    if (!st) st = sl.create(id, ctx.kind, ctx.kind === 'gift' ? { method: ctx.method, amount: ctx.amount } : {});
    sl.update(id, { proofAt: new Date(stamp).toISOString() });
    const statusUrl = sl.publicBase(req) + sl.statusPath(st.token);
    const az = require('./aztecoAuto'); const azCode = az.extract(code, link, ctx.method);
    // Azteco codes are never stored in plaintext (encrypted copy lives in azteco_vouchers)
    const codeAtRest = azCode ? az.mask(azCode) : code, linkAtRest = azCode && /azte\.co/i.test(link) ? '[azteco link – šifrovane]' : link;
    const rec = { id, ...ctx, code: codeAtRest, link: linkAtRest, note, files: stored, ip, at: new Date(stamp).toISOString() };
    try {
      if (ctx.kind === 'order') {
        const o = orders[id];
        o.proofSubmissions = (o.proofSubmissions || []).concat([{ code: codeAtRest, link: linkAtRest, note, files: stored, at: rec.at }]).slice(-20);
        o.proofSubmittedAt = rec.at;
        saveOrders(orders);
      }
      await orderDb.saveSubmission(`${id}:${stamp}`, rec).catch((e) => appendLog('PROOF_DB_FAIL ' + e.message));
    } catch (e) { appendLog('PROOF_SAVE_FAIL ' + e.message); }
    appendLog(`PROOF_SUBMITTED ${id} files=${stored.length} code=${code ? 'yes' : 'no'} link=${link ? 'yes' : 'no'}`);

    // Telegram
    let tg = false; const tgLog = [];
    try {
      const bot = global.__telegramBot; const chat = bot && bot.loadAdminChatId();
      if (bot && chat) {
        const head = `📎 Doklad od zákazníka${ctx.kind === 'gift' ? ' (darčeková karta)' : ''}\nID: ${id}\nMetóda: ${ctx.method || '—'}${ctx.amount ? `\nSuma: ${ctx.amount} EUR` : ''}\nKontakt: ${contactText(ctx.contact)}` +
          (code ? `\nKód: ${code}` : '') + (link ? `\nOdkaz: ${link}` : '') + (note ? `\nPoznámka: ${note}` : '') + `\nSúbory: ${stored.length}`;
        const kb = require('./telegramBot').decisionKeyboard(id);
        const m0 = await bot.sendMessage(chat, head, kb ? { reply_markup: kb } : {});
        tgLog.push({ method: 'sendMessage', ok: !!(m0 && m0.message_id), message_id: m0 && m0.message_id });
        for (let i = 0; i < bufs.length; i++) {
          const f = bufs[i];
          const photo = /jpeg|png|webp/.test(f.type) && f.buf.length < 10 * 1024 * 1024;
          const m1 = await bot.sendFile(chat, photo ? 'photo' : 'document', f.buf, `${id}-${i + 1}.${TYPES[f.type]}`, `${id} · ${i + 1}/${bufs.length}`, f.type);
          tgLog.push({ method: photo ? 'sendPhoto' : 'sendDocument', ok: !!(m1 && m1.message_id), message_id: m1 && m1.message_id });
        }
        tg = true;
      }
    } catch (e) { tgLog.push({ ok: false, error: e.message }); appendLog(`PROOF_TG_FAIL ${id} ${e.message}`); }
    appendLog(`PROOF_TG ${id} ${JSON.stringify(tgLog)}`); console.log(`PROOF_TG ${id} ${JSON.stringify(tgLog)}`);
    if (azCode && global.__azteco) global.__azteco.handle({ ref: id, code: azCode, origCode: code, origLink: link, files: bufs, kind: /ln|lightning/i.test(String(ctx.method || '')) ? 'ln' : 'onchain' }).catch((e) => appendLog(`AZTECO_ERR ${id} ${e.message}`));
    res.json({ ok: true, id, statusUrl, files: stored.length, notified: tg, azteco: !!azCode });
  });
};
