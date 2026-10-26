'use strict';
// Admin: manual fallback for Azteco cards whose automatic processing failed – same flow as aztecoAuto (Ryan's own BTC address from „Adresy peňaženiek“, Telegram redeem link, on-chain watch). Codes + files AES-256-GCM encrypted
// at rest (key derived from BACKUP_ENC_KEY), viewable only behind /admin auth. Never rendered on public pages.
const az = require('./aztecoAuto');
const { layout, escapeHtml: e } = require('./adminSepa');
const MAX = 8 * 1024 * 1024;
const TYPES = { 'image/jpeg': [[0xff, 0xd8, 0xff]], 'image/png': [[0x89, 0x50, 0x4e, 0x47]], 'image/webp': [[0x52, 0x49, 0x46, 0x46]], 'application/pdf': [[0x25, 0x50, 0x44, 0x46]] };
const sniff = (b) => Object.keys(TYPES).find((t) => TYPES[t].some((sig) => sig.every((x, i) => b[i] === x)) && (t !== 'image/webp' || b.slice(8, 12).toString() === 'WEBP'));
let ready = null;
async function tables() {
  const pool = await az.table(); if (!pool) return null;
  if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS azteco_files (id SERIAL PRIMARY KEY, ref TEXT NOT NULL, order_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL, size INT NOT NULL, enc BYTEA NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => pool.query(`SELECT 1`));
  await ready; return pool;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || ''); const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!/^multipart\/form-data/i.test(ct) || !bm) return reject(new Error('Neplatný formulár'));
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX + 64 * 1024) { reject(new Error('Súbor je príliš veľký (max 8 MB)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks), sep = Buffer.from('--' + (bm[1] || bm[2])); const fields = {}, files = [];
      let i = buf.indexOf(sep);
      while (i >= 0) {
        const j = buf.indexOf(sep, i + sep.length); if (j < 0) break;
        const part = buf.subarray(i + sep.length + 2, j - 2), h = part.indexOf('\r\n\r\n');
        if (h > 0) {
          const head = part.subarray(0, h).toString('utf8'), body = part.subarray(h + 4), name = (head.match(/name="([^"]*)"/) || [])[1], fn = (head.match(/filename="([^"]*)"/) || [])[1];
          if (fn !== undefined) { if (body.length) files.push({ field: name, name: fn.replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'subor', buf: body }); } else if (name) fields[name] = body.toString('utf8');
        }
        i = j;
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}
// Admin pages send Referrer-Policy: no-referrer, so browsers post forms with `Origin: null` and no Referer.
// Prefer Sec-Fetch-Site (same check as payMethods.js); fall back to Origin/Referer host match.
const sameOrigin = (req) => {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const o = (req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '') || req.headers.referer || '';
  if (!o) return !req.headers.origin;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};
function mount(app, { loadOrders, saveOrders, appendLog }) {
  const page = (req, body, msg = '', err = '') => layout({ title: 'Azteco – ručné spracovanie', userEmail: req.adminSession.email, body: `${msg ? `<div class="ok">${e(msg)}</div>` : ''}${err ? `<div class="err">${e(err)}</div>` : ''}${body}` });
  const t = (d) => new Date(d).toLocaleString('sk-SK', { timeZone: 'Europe/Zurich' });
  const ST = { new: 'zaseknuté (spracovanie neprebehlo)', btcpay_down: 'BTCPay nedostupný (staré)', no_address: 'chýba zapnutá BTC adresa', timeout: '72 h bez platby', admin_saved: 'uložené, nespracované', awaiting_redeem: 'čaká na uplatnenie', received: 'v mempoole', confirmed: 'prijaté ✅', duplicate: 'duplikát' };
  const form = (ref = '', title = 'Spracovať ručne') => `<form method="post" action="/admin/platby/azteco" enctype="multipart/form-data">
<label>Referencia (ID objednávky / darčekovej karty zo zákazníckeho dokladu)</label><input name="ref" value="${e(ref)}" required maxlength="100">
<label>Kód Azteco (16 číslic)</label><input name="code" inputmode="numeric" autocomplete="off" maxlength="40" placeholder="1234 5678 9012 3456">
<label>alebo odkaz (https://azte.co/?c1=…)</label><input name="link" autocomplete="off" maxlength="300">
<label>Fotka / PDF karty (JPG, PNG, WebP, PDF – max 8 MB; uloží sa šifrovane a pošle s notifikáciou)</label><input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf">
<p><button>${e(title)}</button></p></form>`;
  async function list(req, msg, err) {
    const pool = await tables();
    if (!pool || !az.keyBuf()) return page(req, '<div class="card"><h1>Azteco</h1><p class="err">Chýba DATABASE_URL alebo BACKUP_ENC_KEY – spracovanie nie je možné.</p></div>');
    const FAILED = (global.__azteco && global.__azteco.FAILED) || ['new', 'btcpay_down', 'timeout', 'admin_saved'];
    const v = (await pool.query(`SELECT code_hash,ref,kind,status,sats,address,err,created_at,updated_at FROM azteco_vouchers ORDER BY updated_at DESC LIMIT 300`)).rows;
    const known = new Set(v.map((r) => r.ref));
    // customer submissions for Azteco where no code could be recognised automatically (photo only / unreadable code)
    let subs = [];
    try { subs = (await pool.query(`SELECT id,data,created_at FROM proof_submissions WHERE data->>'method' ILIKE '%azte%' ORDER BY created_at DESC LIMIT 200`)).rows.filter((r) => !known.has(r.data.id) && !String(r.data.code || '').startsWith('••••')); } catch { /* table may not exist yet */ }
    const fails = v.filter((r) => FAILED.includes(r.status)), rest = v.filter((r) => !FAILED.includes(r.status));
    const f = (await pool.query(`SELECT id,ref,name,type,size,created_at FROM azteco_files ORDER BY created_at DESC LIMIT 200`)).rows;
    const filesFor = (ref) => f.filter((x) => x.ref === ref).map((x) => `<a href="/admin/platby/azteco/file/${x.id}" target="_blank" rel="noopener">📎 ${e(x.name)}</a>`).join(' ');
    return page(req, `<div class="card"><h1>₿ Azteco – ručné spracovanie</h1><p class="muted">Záložný postup, keď automatické spracovanie zlyhá. Ide cez ten istý tok ako bot: vaša BTC adresa z <a href="/admin/platby/wallets">Adresy peňaženiek</a> (prvá zapnutá), odkaz na uplatnenie 1 klikom do Telegramu (Platby bot), potom sledovanie adresy až do potvrdenia → stav objednávky „potvrdené“. Azteco nemá serverové API, takže samotné uplatnenie na azte.co je 1 klik z odkazu.</p></div>
<div class="card"><h2>⚠️ Zlyhané automatické spracovanie (${fails.length + subs.length})</h2>
${fails.map((r) => `<div class="card"><b>${e(r.ref)}</b> <span class="badge bad">${e(ST[r.status] || r.status)}</span> <span class="muted">${e(t(r.updated_at))}${r.err ? ' · ' + e(r.err) : ''}</span><br>${filesFor(r.ref)}
<form method="post" action="/admin/platby/azteco/retry/${e(r.code_hash)}" style="display:inline"><button>↻ Spracovať znova (uložený kód)</button></form> <a href="/admin/platby/azteco/code/${e(r.code_hash)}">Zobraziť kód</a></div>`).join('')}
${subs.map((r) => `<div class="card"><b>${e(r.data.id)}</b> <span class="badge warn">kód nerozpoznaný</span> <span class="muted">${e(t(r.created_at))} · ${e(r.data.method || '')}${r.data.amount ? ' · ' + e(r.data.amount) + ' EUR' : ''}</span>
<p class="muted">Zadané zákazníkom: ${r.data.code ? 'kód „' + e(r.data.code) + '“' : 'bez kódu'}${r.data.link ? ' · odkaz ' + e(r.data.link) : ''}${r.data.note ? ' · ' + e(r.data.note) : ''}</p>
<p>${(r.data.files || []).filter((x) => x.key).map((x, i) => `<a href="/admin/platby/azteco/proof?key=${encodeURIComponent(x.key)}" target="_blank" rel="noopener">📎 súbor ${i + 1}</a>`).join(' ') || '<span class="muted">bez súborov</span>'}</p>
<details><summary>Zadať kód z fotky a spracovať</summary>${form(r.data.id, 'Spracovať')}</details></div>`).join('')}
${fails.length + subs.length ? '' : '<p class="muted">Nič na spracovanie. 👍</p>'}</div>
<div class="card"><h2>➕ Ručne zadať kartu</h2>${form()}</div>
<div class="card"><h2>Ostatné Azteco karty</h2><table class="stack"><tr class="head"><th>Čas</th><th>Ref</th><th>Stav</th><th></th></tr>${rest.map((r) => `<tr><td data-label="Čas">${e(t(r.updated_at))}</td><td data-label="Ref">${e(r.ref)}</td><td data-label="Stav"><span class="badge">${e(ST[r.status] || r.status)}</span>${r.sats ? ' ' + e(r.sats) + ' sats' : ''}</td><td><a href="/admin/platby/azteco/code/${e(r.code_hash)}">Detail</a> ${filesFor(r.ref)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Žiadne.</td></tr>'}</table></div>`, msg, err);
  }
  const nostore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  const show = async (req, res, status, msg, err) => res.status(status).type('html').send(await list(req, msg, err));
  app.get('/admin/platby/azteco', async (req, res) => { nostore(res); try { await show(req, res, 200, { ok: 'Spracované – BTC adresa a odkaz na uplatnenie sú v Telegrame.', saved: 'Uložené.' }[req.query.m] || ''); } catch (x) { appendLog('ADMIN_AZTECO_ERR ' + x.message); res.status(500).send('Chyba'); } });
  const result = (r) => (r && r.status === 'awaiting_redeem' ? 'ok' : null);
  app.post('/admin/platby/azteco', async (req, res) => {
    nostore(res);
    const fail = (msg) => show(req, res, 400, '', msg);
    try {
      if (!sameOrigin(req)) return res.status(403).send('Forbidden');
      const pool = await tables(); if (!pool || !az.keyBuf() || !global.__azteco) return fail('Azteco nie je nakonfigurované (DATABASE_URL / BACKUP_ENC_KEY).');
      const { fields, files } = await readBody(req);
      const ref = String(fields.ref || '').trim().slice(0, 100); if (!/^[\w:.\-]{1,100}$/.test(ref)) return fail('Chýba alebo je neplatná referencia.');
      const codeIn = String(fields.code || '').trim(), linkIn = String(fields.link || '').trim();
      if (linkIn && !/^https:\/\/(www\.)?azte\.co\//i.test(linkIn)) return fail('Odkaz musí začínať https://azte.co/');
      const code = codeIn || linkIn ? az.extract(codeIn, linkIn, 'azteco') : null;
      if ((codeIn || linkIn) && !code) return fail('Neplatný kód – očakáva sa 16 číslic alebo odkaz azte.co s c1–c4.');
      const file = files.find((x) => x.field === 'file'); let ftype = null;
      if (file) { if (file.buf.length > MAX) return fail('Súbor je príliš veľký (max 8 MB).'); ftype = sniff(file.buf); if (!ftype) return fail('Nepovolený typ súboru (len JPG, PNG, WebP, PDF).'); }
      if (!code && !file) return fail('Zadajte kód, odkaz alebo nahrajte fotku.');
      const who = req.adminSession.email;
      if (file) await pool.query(`INSERT INTO azteco_files (ref,name,type,size,enc,created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [ref, file.name, ftype, file.buf.length, az.encBuf(file.buf), who]);
      if (!code) { appendLog(`ADMIN_AZTECO_FILE_ONLY ref=${ref} by=${who}`); return show(req, res, 200, 'Fotka uložená. Azteco sa dá uplatniť len kódom – prečítajte 16 číslic z fotky a zadajte ich pre túto referenciu.'); }
      const h = az.hashCode(code);
      const prev = (await pool.query(`SELECT status FROM azteco_vouchers WHERE code_hash=$1`, [h])).rows[0];
      let r;
      if (prev && global.__azteco.FAILED.includes(prev.status)) r = await global.__azteco.retry(h);
      else r = await global.__azteco.handle({ ref, code, kind: 'onchain', origCode: az.mask(code), origLink: linkIn ? '[azte.co odkaz – admin]' : '', files: file ? [{ buf: file.buf, type: ftype, name: file.name }] : [] });
      appendLog(`ADMIN_AZTECO_MANUAL ref=${ref} status=${r && r.status} by=${who}`);
      if (result(r)) return res.redirect(303, '/admin/platby/azteco?m=ok');
      return fail(r && r.status === 'duplicate' ? 'Tento kód už bol spracovaný skôr – znova sa neuplatňuje.' : r && r.status === 'no_address' ? 'V „Adresy peňaženiek“ nie je zapnutá žiadna BTC adresa – zapnite ju a skúste „Spracovať znova“.' : r && r.status === 'btcpay_down' ? 'BTCPay je nedostupný – skúste „Spracovať znova“.' : 'Spracovanie neprebehlo (' + ((r && r.status) || 'neznámy stav') + ').');
    } catch (x) { appendLog('ADMIN_AZTECO_ERR ' + x.message); fail(x.message || 'Chyba'); }
  });
  app.post('/admin/platby/azteco/retry/:h([0-9a-f]{64})', async (req, res) => {
    nostore(res);
    try {
      if (!sameOrigin(req)) return res.status(403).send('Forbidden');
      if (!global.__azteco) throw new Error('Azteco nie je nakonfigurované');
      const r = await global.__azteco.retry(req.params.h);
      appendLog(`ADMIN_AZTECO_RETRY status=${r && r.status} by=${req.adminSession.email}`);
      if (result(r)) return res.redirect(303, '/admin/platby/azteco?m=ok');
      show(req, res, 400, '', 'Spracovanie neprebehlo (' + ((r && r.status) || '?') + ').');
    } catch (x) { show(req, res, 400, '', x.message); }
  });
  app.get('/admin/platby/azteco/code/:h([0-9a-f]{64})', async (req, res) => {
    nostore(res);
    const pool = await tables(); const r = pool && (await pool.query(`SELECT ref,enc_code,status,address,sats FROM azteco_vouchers WHERE code_hash=$1`, [req.params.h])).rows[0];
    if (!r) return res.status(404).send('Nenájdené');
    const c = az.dec(r.enc_code).toString('utf8');
    appendLog(`ADMIN_AZTECO_VIEW ref=${r.ref} by=${req.adminSession.email}`);
    res.type('html').send(page(req, `<div class="card"><h1>Azteco ${e(r.ref)}</h1><p>Kód: <code style="font-size:1.2rem">${e(c.replace(/(\d{4})(?=\d)/g, '$1 '))}</code></p><p>Odkaz na uplatnenie: <a href="${e(az.redeemLink(c))}" target="_blank" rel="noopener noreferrer">${e(az.redeemLink(c))}</a></p><p>Stav: ${e(ST[r.status] || r.status)}${r.address ? '<br>BTC adresa: <code>' + e(r.address) + '</code>' : ''}${r.sats ? '<br>' + e(r.sats) + ' sats' : ''}</p><p><a href="/admin/platby/azteco">← Späť</a></p></div>`));
  });
  const sendFile = (res, type, name, buf) => res.set({ 'Content-Type': type, 'Content-Disposition': `inline; filename="${String(name).replace(/[^\w.\-]/g, '_')}"`, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }).send(buf);
  app.get('/admin/platby/azteco/file/:id(\\d+)', async (req, res) => {
    nostore(res);
    const pool = await tables(); const r = pool && (await pool.query(`SELECT ref,name,type,enc FROM azteco_files WHERE id=$1`, [Number(req.params.id)])).rows[0];
    if (!r) return res.status(404).send('Nenájdené');
    appendLog(`ADMIN_AZTECO_FILE ref=${r.ref} by=${req.adminSession.email}`);
    sendFile(res, r.type, r.name, az.dec(r.enc.toString('base64')));
  });
  app.get('/admin/platby/azteco/proof', async (req, res) => {
    nostore(res);
    try {
      const key = String(req.query.key || ''); if (!/^proofs\/[\w:.\-]+\/[\w.\-]+$/.test(key)) return res.status(400).send('Bad key');
      const buf = await require('./proofStore').getBuffer(key); if (!buf) return res.status(404).send('Nenájdené');
      const type = sniff(buf); if (!type) return res.status(415).send('Nepodporovaný typ');
      appendLog(`ADMIN_AZTECO_PROOF ${key.split('/')[1]} by=${req.adminSession.email}`);
      sendFile(res, type, key.split('/').pop(), buf);
    } catch (x) { res.status(500).send('Chyba: ' + e(x.name)); }
  });
}
module.exports = { mount };
