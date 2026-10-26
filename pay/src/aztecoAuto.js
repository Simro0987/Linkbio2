'use strict';
// Azteco vouchers submitted by customers (gift-card proof form) → Ryan's own BTC receive address (first enabled BTC address
// in admin „Adresy peňaženiek“; BTCPay is used only for the BTCPay checkout option). Because that address can be reused,
// a baseline (funded sats at preparation) is stored and only an increase counts as the voucher payment.
// owner notified via Platby bot with one-click redeem link (Azteco has no public server-side redeem API; redeem is an
// interactive web flow), then the address is watched on-chain (mempool.space) until funds arrive.
// Idempotent per code (HMAC hash PK); codes AES-256-GCM encrypted at rest.
const crypto = require('crypto');
const orderDb = require('./db');
const WATCH_MS = 2 * 60e3, TIMEOUT_MS = 72 * 3600e3;
const keyBuf = () => { const k = String(process.env.BACKUP_ENC_KEY || '').trim(); return /^[0-9a-f]{64}$/i.test(k) ? crypto.createHmac('sha256', Buffer.from(k, 'hex')).update('azteco-codes-v1').digest() : null; };
const hashCode = (c) => crypto.createHmac('sha256', keyBuf()).update('h:' + c).digest('hex');
function enc(c) { const iv = crypto.randomBytes(12), ci = crypto.createCipheriv('aes-256-gcm', keyBuf(), iv); const ct = Buffer.concat([ci.update(c, 'utf8'), ci.final()]); return Buffer.concat([iv, ci.getAuthTag(), ct]).toString('base64'); }
const mask = (c) => '••••-••••-••••-' + c.slice(-4);
function extract(code, link, method) {
  const all = `${code || ''} ${link || ''}`;
  let m = all.match(/azte\.co\/?\S*?[?&]c1=(\d{4})&c2=(\d{4})&c3=(\d{4})&c4=(\d{4})/i);
  if (m) return m.slice(1).join('');
  const isAz = /azte/i.test(String(method || '')) || /azte\.co/i.test(all);
  if (!isAz) return null;
  m = all.replace(/[\s-]/g, '').match(/(?<!\d)\d{16}(?!\d)/);
  return m ? m[0] : null;
}
const redeemLink = (c) => `https://azte.co/?c1=${c.slice(0, 4)}&c2=${c.slice(4, 8)}&c3=${c.slice(8, 12)}&c4=${c.slice(12)}`;
let ready = null;
async function table() {
  const pool = orderDb.pool(); if (!pool) return null;
  if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS azteco_vouchers (code_hash TEXT PRIMARY KEY, ref TEXT NOT NULL, enc_code TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'onchain', address TEXT, status TEXT NOT NULL, sats BIGINT, txid TEXT, err TEXT, tg_meta TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await ready; await pool.query(`ALTER TABLE azteco_vouchers ADD COLUMN IF NOT EXISTS tg_meta TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE azteco_vouchers ADD COLUMN IF NOT EXISTS base_sats BIGINT`).catch(() => {}); return pool;
}
function create({ appendLog }) {
  const log = (m) => { if (appendLog) appendLog(m); };
  const bot = () => global.__telegramBot;
  const tgTok = () => require('./telegramBot').token();
  async function tg(method, body) { const r = await fetch(`https://api.telegram.org/bot${tgTok()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); const j = await r.json().catch(() => ({})); if (!j.ok) throw new Error(j.description || method); return j.result; }
  const chat = () => { const b = bot(); return b && b.loadAdminChatId(); };
  const STATUS = { ok: (sats) => `✅ Odoslané (${Number(sats).toLocaleString('sk-SK')} sats na vašu BTC adresu prijaté)`, wait: (why) => `⏳ Neodoslané / čaká sa${why ? ' – ' + why : ''}`, fail: (why) => `❌ Zlyhalo: ${why}` };
  // Every Azteco notification carries the ORIGINAL submission (code / link / photos-docs) + a clear status line.
  async function tell(meta, statusLine, detail = '') {
    const c = chat(); if (!c || !tgTok()) return meta;
    const orig = `Pôvodne odoslané zákazníkom:${meta.code ? '\nKód: ' + meta.code : ''}${meta.link ? '\nOdkaz: ' + meta.link : ''}${meta.files && meta.files.length ? `\nPrílohy: ${meta.files.length} (nižšie)` : ''}`;
    const text = `₿ Azteco · ${meta.ref}\n${statusLine}\n\n${orig}${detail ? '\n\n' + detail : ''}`.slice(0, 4000);
    try {
      if (meta.msgId) { try { await tg('editMessageText', { chat_id: c, message_id: meta.msgId, text, disable_web_page_preview: true }); } catch (e) { if (!/not modified/i.test(e.message)) log('AZTECO_TG_EDIT ' + e.message); } }
      const m = await tg('sendMessage', { chat_id: c, text, disable_web_page_preview: true, ...(meta.msgId ? { reply_to_message_id: meta.msgId, allow_sending_without_reply: true } : {}) });
      if (!meta.msgId) meta.msgId = m.message_id;
      const fids = [];
      for (const f of meta.files || []) {
        const photo = /jpeg|png|webp/.test(f.type);
        const cap = `${meta.ref} · ${statusLine}`.slice(0, 1000);
        if (f.fileId) await tg(f.photo ? 'sendPhoto' : 'sendDocument', { chat_id: c, [f.photo ? 'photo' : 'document']: f.fileId, caption: cap, reply_to_message_id: m.message_id });
        else if (f.buf) {
          const fd = new FormData(); fd.append('chat_id', c); fd.append('caption', cap); fd.append('reply_to_message_id', String(m.message_id));
          fd.append(photo ? 'photo' : 'document', new Blob([f.buf], { type: f.type }), f.name || 'subor');
          const j = await (await fetch(`https://api.telegram.org/bot${tgTok()}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })).json();
          if (j.ok) { f.fileId = photo ? j.result.photo.slice(-1)[0].file_id : j.result.document.file_id; f.photo = photo; delete f.buf; }
        }
        fids.push({ fileId: f.fileId, photo: f.photo, type: f.type });
      }
      meta.files = fids;
    } catch (e) { log('AZTECO_TG_FAIL ' + e.message); }
    return meta;
  }
  const metaJson = (m) => JSON.stringify({ ref: m.ref, code: m.code, link: m.link, msgId: m.msgId, files: (m.files || []).filter((f) => f.fileId) });
  const sl = () => require('./statusLinks');
  async function setStatus(pool, h, ref, patch) {
    const ks = Object.keys(patch);
    await pool.query(`UPDATE azteco_vouchers SET ${ks.map((k, i) => `${k}=$${i + 2}`).join(',')}, updated_at=now() WHERE code_hash=$1`, [h, ...Object.values(patch)]);
    try { sl().update(ref, { azteco: patch.status, ...(patch.status === 'confirmed' ? { decision: 'confirmed', decidedAt: new Date().toISOString() } : {}) }); } catch { /* */ }
  }
  async function saveMeta(pool, h, meta) { await pool.query(`UPDATE azteco_vouchers SET tg_meta=$2 WHERE code_hash=$1`, [h, enc(metaJson(meta))]); }
  function decMeta(b64) { try { const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', keyBuf(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString()); } catch { return null; } }
  async function handle({ ref, code, kind, origCode, origLink, files }) {
    const meta0 = { ref, code: origCode || '', link: origLink || '', files: (files || []).map((f) => ({ buf: f.buf, type: f.type, name: f.name })) };
    if (!keyBuf()) { log('AZTECO_AUTO_OFF no BACKUP_ENC_KEY'); return { handled: false }; }
    const pool = await table(); if (!pool) return { handled: false };
    const h = hashCode(code);
    const ins = await pool.query(`INSERT INTO azteco_vouchers (code_hash,ref,enc_code,kind,status) VALUES ($1,$2,$3,$4,'new') ON CONFLICT DO NOTHING RETURNING code_hash`, [h, ref, enc(code), kind]);
    if (!ins.rowCount) {
      const prev = (await pool.query(`SELECT ref,status FROM azteco_vouchers WHERE code_hash=$1`, [h])).rows[0] || {};
      log(`AZTECO_DUPLICATE ${ref} prev=${prev.ref}`);
      try { sl().update(ref, { azteco: 'duplicate' }); } catch { /* */ }
      await tell(meta0, STATUS.fail(`kód už bol odoslaný skôr (${prev.ref}, stav ${prev.status}) – znova sa neuplatňuje`));
      return { handled: true, status: 'duplicate' };
    }
    const w = require('./wallets').first('btc');
    if (!w || !w.address) {
      await setStatus(pool, h, ref, { status: 'no_address', err: 'no enabled BTC address' });
      const m = await tell(meta0, STATUS.fail('v admine „Adresy peňaženiek“ nie je zapnutá žiadna BTC adresa – pridajte/zapnite ju a dajte „Spracovať znova“'));
      await saveMeta(pool, h, m);
      return { handled: true, status: 'no_address' };
    }
    const a = { address: w.address };
    const base = await fundedSats(a.address).catch(() => null);
    await setStatus(pool, h, ref, { status: 'awaiting_redeem', address: a.address });
    await pool.query(`UPDATE azteco_vouchers SET base_sats=$2 WHERE code_hash=$1`, [h, base == null ? -1 : base]);
    log(`AZTECO_PREPARED ${ref} addr=${a.address.slice(0, 8)}… base=${base == null ? '?' : base}`);
    const m = await tell(meta0, STATUS.wait('uplatnite 1 klikom (Azteco nemá serverové API)'), `Kód (normalizovaný): ${code.replace(/(\d{4})(?=\d)/g, '$1 ')}\nVaša BTC adresa${w.label ? ' (' + w.label + ')' : ''}: ${a.address}\n👉 ${redeemLink(code)}\n(na azte.co zvoľte on-chain a vložte LEN túto adresu)${kind === 'ln' ? '\nℹ️ Lightning voucher: ak azte.co ponúka len LN, zvoľte on-chain možnosť.' : ''}\nSledujem adresu – príjem ohlásim automaticky.`);
    await saveMeta(pool, h, m);
    return { handled: true, status: 'awaiting_redeem' };
  }
  async function checkAll() {
    const pool = await table().catch(() => null); if (!pool) return;
    const rows = (await pool.query(`SELECT code_hash,ref,address,status,created_at,sats,tg_meta,base_sats FROM azteco_vouchers WHERE status IN ('awaiting_redeem','received') AND address IS NOT NULL`)).rows;
    for (const r of rows) {
      const meta = (r.tg_meta && decMeta(r.tg_meta)) || { ref: r.ref };
      const say = async (line, d) => { const m = await tell(meta, line, d); await saveMeta(pool, r.code_hash, m); };
      try {
        const j = await (await fetch(`https://mempool.space/api/address/${encodeURIComponent(r.address)}`, { signal: AbortSignal.timeout(15000) })).json();
        let conf = Number(j.chain_stats?.funded_txo_sum || 0), mem = Number(j.mempool_stats?.funded_txo_sum || 0);
        if (r.base_sats != null) { // reused own address: only funds above the baseline belong to this voucher
          let base = Number(r.base_sats);
          if (base < 0) { base = conf + mem; await pool.query(`UPDATE azteco_vouchers SET base_sats=$2 WHERE code_hash=$1`, [r.code_hash, base]); continue; }
          const total = Math.max(0, conf + mem - base); conf = Math.max(0, Math.min(total, conf - base)); mem = total - conf;
        }
        if (conf > 0) { await setStatus(pool, r.code_hash, r.ref, { status: 'confirmed', sats: conf }); log(`AZTECO_CONFIRMED ${r.ref} sats=${conf}`); await say(STATUS.ok(conf), `Azteco uplatnené, ${conf.toLocaleString('sk-SK')} sats prijaté ✅\nAdresa: ${r.address}`); }
        else if (mem > 0 && r.status !== 'received') { await setStatus(pool, r.code_hash, r.ref, { status: 'received', sats: mem }); await say(STATUS.wait(`${mem.toLocaleString('sk-SK')} sats v mempoole, čaká sa na potvrdenie siete`), `Adresa: ${r.address}`); }
        else if (r.status === 'awaiting_redeem' && Date.now() - new Date(r.created_at).getTime() > TIMEOUT_MS) { await setStatus(pool, r.code_hash, r.ref, { status: 'timeout', err: 'no funds in 72h' }); await say(STATUS.fail('do 72 h neprišli prostriedky (kód neuplatnený, neplatný alebo už použitý)'), `Adresa: ${r.address}`); }
      } catch (e) { log(`AZTECO_WATCH_ERR ${r.ref} ${e.name}`); }
    }
  }
  async function fundedSats(address) {
    const j = await (await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15000) })).json();
    if (!j || !j.chain_stats) throw new Error('mempool: no data');
    return Number(j.chain_stats.funded_txo_sum || 0) + Number(j.mempool_stats?.funded_txo_sum || 0);
  }
  function start() { setInterval(() => checkAll().catch(() => {}), WATCH_MS).unref(); setTimeout(() => checkAll().catch(() => {}), 30e3).unref(); }
  // manual fallback (admin): re-run the same flow for a stored code whose automatic processing failed
  const FAILED = ['new', 'btcpay_down', 'no_address', 'timeout', 'admin_saved'];
  async function retry(h) {
    const pool = await table(); if (!pool || !keyBuf()) throw new Error('Azteco nie je nakonfigurované');
    const r = (await pool.query(`SELECT ref,enc_code,kind,status FROM azteco_vouchers WHERE code_hash=$1`, [h])).rows[0];
    if (!r) throw new Error('Kód sa nenašiel'); if (!FAILED.includes(r.status)) throw new Error(`Kód je v stave ${r.status} – znova sa nespracúva`);
    const code = dec(r.enc_code).toString('utf8');
    await pool.query(`DELETE FROM azteco_vouchers WHERE code_hash=$1`, [h]);
    log(`AZTECO_MANUAL_RETRY ${r.ref}`);
    return handle({ ref: r.ref, code, kind: r.kind, origCode: mask(code), origLink: '' });
  }
  return { handle, start, checkAll, retry, FAILED };
}
function dec(b64) { const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', keyBuf(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); }
function encBuf(buf) { const iv = crypto.randomBytes(12), ci = crypto.createCipheriv('aes-256-gcm', keyBuf(), iv); const ct = Buffer.concat([ci.update(buf), ci.final()]); return Buffer.concat([iv, ci.getAuthTag(), ct]); }
module.exports = { create, extract, mask, table, keyBuf, hashCode, enc, encBuf, dec, redeemLink };
