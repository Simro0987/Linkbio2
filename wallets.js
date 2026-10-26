'use strict';
// 👛 Adresy peňaženiek + 🔗 Odkazy podľa sumy – správa priamo z lnkbio admina.
// Zdroj pravdy je checkout (Neon). Server-to-server most s HMAC podpisom (PAY_ADMIN_BRIDGE_SECRET, rovnaký ako pri platobných metódach):
//   /api/admin-bridge/wallets       – state / get / preview / create+update (confirm:true) / toggle
//   /api/admin-bridge/amount-links  – state / get / create / update / toggle / delete
// Všetky POSTy: needAuth + CSRF. Žiadny inline JS/CSS (CSP). Ukladajú sa len verejné adresy, ktoré admin zadá.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function install(ctx) {
  const { admin, page, esc, hid, csrf, needAuth, wrap, audit } = ctx;
  const ORIGIN = ['live', 'on'].includes(String(process.env.PAY_MODULE || '').trim().toLowerCase()) ? '' : String(process.env.CHECKOUT_PUBLIC_URL || 'https://chain2pay-checkout-gl.onrender.com').replace(/\/$/, '');
  const secret = () => { const v = String(process.env.PAY_ADMIN_BRIDGE_SECRET || ''); return v.length >= 32 ? v : ''; };
  const WB = '/admin/penazenky';
  const LB = '/admin/odkazy-podla-sumy';
  const V = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static', 'wl.js')) + fs.readFileSync(path.join(__dirname, 'static', 'wl.css')) + fs.readFileSync(path.join(__dirname, 'static', 'pm.css'))).digest('hex').slice(0, 10);
  const HEAD = `<link rel="stylesheet" href="/static/pm.css?v=${V}"><link rel="stylesheet" href="/static/wl.css?v=${V}"><script src="/static/wl.js?v=${V}" defer></script>`;
  const ID_RE = /^(w|al)_[a-f0-9]{6,32}$/;

  const MERGED = () => ['live', 'on'].includes(String(process.env.PAY_MODULE || '').trim().toLowerCase());
  class BridgeErr extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
  const bridge = (p) => async function call(action, extra = {}, timeoutMs = 45000) {
    // merged payment module (PAY_MODULE=live|on): call the same actions in-process – no HTTP, no HMAC, no second service
    const reg = MERGED() && global.__payBridge && global.__payBridge[p];
    if (reg) {
      const fn = Object.prototype.hasOwnProperty.call(reg, String(action)) ? reg[String(action)] : null;
      if (!fn) throw new BridgeErr('user', 'Neznáma akcia');
      let out;
      try { out = await fn(JSON.parse(JSON.stringify({ action, ...extra, actor: 'admin' }))); } catch (x) { throw new BridgeErr('user', (x && x.message) || 'Chyba'); }
      const j = out == null ? null : JSON.parse(JSON.stringify(out));
      if (!j || !j.ok) throw new BridgeErr('user', (j && j.error) || 'Chyba');
      return j;
    }
    const sec = secret();
    if (!sec) throw new BridgeErr('off', 'nie je prepojené');
    const body = JSON.stringify({ action, ...extra, actor: 'admin', n: crypto.randomBytes(12).toString('hex') });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', sec).update(ts + '.').update(body).digest('hex');
    let r;
    try {
      r = await fetch(ORIGIN + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-ts': String(ts), 'x-bridge-sig': sig }, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch { throw new BridgeErr('down', 'Checkout neodpovedá (možno sa práve prebúdza). Skúste to o chvíľu znova.'); }
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (r.status === 503 && j && j.error === 'not_configured') throw new BridgeErr('off', 'nie je prepojené');
    if (r.status === 401 || r.status === 409) throw new BridgeErr('auth', 'Checkout odmietol podpis – PAY_ADMIN_BRIDGE_SECRET sa na službách lnkbio a checkout nezhoduje.');
    if (r.status === 429) throw new BridgeErr('down', 'Príliš veľa požiadaviek – skúste to o minútu.');
    if (r.status === 404 && !j) throw new BridgeErr('off', 'nie je prepojené');
    if (!j) throw new BridgeErr('down', 'Checkout vrátil neplatnú odpoveď (HTTP ' + r.status + ').');
    if (!j.ok) throw new BridgeErr('user', j.error || 'Chyba');
    return j;
  };
  const W = bridge('/api/admin-bridge/wallets');
  const L = bridge('/api/admin-bridge/amount-links');

  const offBox = (e, adminPath) => e.kind === 'off'
    ? `<div class="msg err pmoff"><b>⚠️ Nie je prepojené s checkoutom.</b><br>Chýba premenná prostredia <code>PAY_ADMIN_BRIDGE_SECRET</code> (rovnaká hodnota na službách <b>lnkbio</b> aj <b>chain2pay-checkout-gl</b>). Dovtedy použite <a href="${esc(ORIGIN + adminPath)}" target="_blank" rel="noopener noreferrer">admin checkoutu ↗</a>.</div>`
    : `<div class="msg err pmoff"><b>⚠️ ${esc(e.message)}</b><br><a href="${esc(ORIGIN + adminPath)}" target="_blank" rel="noopener noreferrer">Otvoriť admin checkoutu ↗</a></div>`;
  const shell = (title, body) => page(title, `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="${WB}">👛 Adresy peňaženiek</a><a class="btnl" href="${LB}">🔗 Odkazy podľa sumy</a></p>${body}`, 'a adm', '', HEAD);
  const flash = (req, MS) => (MS[req.query.m] ? `<div class="msg">${esc(MS[req.query.m])}</div>` : '') + (req.query.e ? `<div class="msg err">${esc(String(req.query.e).slice(0, 300))}</div>` : '');
  const errTo = (res, to, e) => res.redirect(303, to + (to.includes('?') ? '&' : '?') + 'e=' + encodeURIComponent(e.kind === 'off' ? 'Nie je prepojené (chýba PAY_ADMIN_BRIDGE_SECRET).' : e.message));
  const when = (d) => (d ? new Date(d).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava', dateStyle: 'short', timeStyle: 'short' }) : '—');
  const short = (a) => { a = String(a || ''); return a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-6) : a; };
  const chunk = (a) => esc(String(a || '')).replace(/(.{4})/g, '$1 ').trim();
  const nocache = (res) => res.setHeader('Cache-Control', 'no-store');

  /* ======================= 👛 wallets ======================= */
  const WMS = { added: 'Adresa bola pridaná.', saved: 'Adresa bola uložená.', toggled: 'Stav adresy zmenený.' };
  function walletForm(req, st, r, err) {
    const isNew = !r.id;
    const net = (st.networks || []).find((n) => n.key === r.network);
    const opts = (st.networks || []).map((n) => `<option value="${esc(n.key)}"${(r.network || 'btc') === n.key ? ' selected' : ''}>${esc(n.label)}</option>`).join('');
    return `<form method="post" action="${WB}/kontrola" class="card wlform" id="${isNew ? 'nova' : 'upravit'}">${hid(req)}<h2>${isNew ? '➕ Pridať adresu' : '✏️ Upraviť adresu'}</h2>${err ? `<div class="msg err">${esc(err)}</div>` : ''}
<input type="hidden" name="id" value="${esc(r.id || '')}">
<div class="grid2"><div><label>Sieť / mena *</label>${isNew ? `<select name="network" required>${opts}</select>` : `<input type="hidden" name="network" value="${esc(r.network)}"><p><b>${esc(net ? net.label : r.network)}</b></p>`}</div>
<div><label>Názov (pre vás, voliteľné)</label><input name="label" maxlength="60" value="${esc(r.label || '')}" placeholder="napr. Trezor, Exodus…"></div></div>
<label>Verejná adresa na prijímanie *</label><input name="address" required maxlength="200" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(r.address || '')}" placeholder="Vložte adresu skopírovanú z peňaženky">
<p class="hint">Zadávajte len verejnú adresu na prijímanie – nikdy nie seed / súkromný kľúč. Adresa sa pred uložením overí (kontrolný súčet) a ukáže celá na potvrdenie.</p>
<div class="grid2"><div><label>Memo / Destination tag (len TON, XRP)</label><input name="memo" maxlength="120" value="${esc(r.memo || '')}"></div>
<div><label>Poradie (nižšie = skôr; checkout berie prvú zapnutú)</label><input type="number" name="sort" min="0" max="100000" step="1" value="${r.sort != null ? esc(r.sort) : ''}"></div></div>
<label class="ck"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnutá</label>
<p class="row"><button>🔎 Skontrolovať adresu</button>${isNew ? '' : `<a class="btnl g2" href="${WB}">Späť</a>`}</p></form>`;
  }
  function walletList(req, st) {
    const tok = hid(req);
    const by = new Map(); for (const r of st.rows || []) { if (!by.has(r.network)) by.set(r.network, []); by.get(r.network).push(r); }
    const blocks = (st.networks || []).filter((n) => by.has(n.key)).map((n) => {
      const rows = by.get(n.key); const on = rows.filter((r) => r.enabled).length;
      return `<details class="wlg"><summary>${esc(n.label)} <span class="tag ok">${on} zap.</span>${rows.length - on ? ` <span class="tag">${rows.length - on} vyp.</span>` : ''}${n.active ? ` <small class="wlm">checkout: ${esc(short(n.active))}</small>` : ' <small class="wlm">na checkoute skryté</small>'}</summary>
${rows.slice(0, 40).map((r) => `<div class="wlr${r.enabled ? '' : ' off'}"><div><b>${esc(r.label || n.short)}</b>${n.active === r.address && r.enabled ? ' <span class="tag ok">používa sa</span>' : ''}<div class="wla">${esc(r.address)}</div>${r.memo ? `<div class="wlm">Memo/tag: ${esc(r.memo)}</div>` : ''}<div class="wlm">poradie ${esc(r.sort)} · upravené ${esc(when(r.updatedAt))}${r.updatedBy ? ' · ' + esc(r.updatedBy) : ''}</div></div>
<div class="wlx"><a class="btnl sm g2" href="${WB}/upravit/${encodeURIComponent(r.id)}">✏️ Upraviť</a><form method="post" action="${WB}/prepnut" data-confirm="${esc(`${r.enabled ? 'Vypnúť' : 'Zapnúť'} adresu ${short(r.address)}?`)}">${tok}<input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="state" value="${r.enabled ? 'off' : 'on'}"><button class="${r.enabled ? 'd' : 'g'} sm">${r.enabled ? 'Vypnúť' : 'Zapnúť'}</button></form></div></div>`).join('')}${rows.length > 40 ? `<p class="hint">… a ďalších ${rows.length - 40} (všetky v <a href="${esc(ORIGIN)}/admin/wallets" target="_blank" rel="noopener noreferrer">admine checkoutu ↗</a>)</p>` : ''}</details>`;
    }).join('');
    const aud = (st.audit || []).slice(0, 15).map((a) => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.network || '')} ${a.old && a.new && a.old.address !== a.new.address ? esc(short(a.old.address)) + ' → ' : ''}${esc(short((a.new && a.new.address) || (a.old && a.old.address) || (a.new && a.new.count != null ? a.new.count + ' adries' : '')))}</td></tr>`).join('');
    return `<div class="card wlw"><h2>👛 Adresy peňaženiek</h2><p class="hint">Na tieto adresy posielajú zákazníci priame krypto platby (BTC, LTC, USDT, ETH…). Checkout použije prvú zapnutú adresu danej siete; sieť bez zapnutej adresy sa na checkoute skryje. BTCPay platba sa tým nemení.</p><p class="row"><a class="btnl sm" href="#nova">➕ Pridať adresu</a></p>${blocks || '<p class="hint">Zatiaľ žiadne adresy.</p>'}</div>
${walletForm(req, st, {})}<div class="card"><h2>🧾 História zmien</h2><table class="wlaud"><thead><tr><th>Kedy</th><th>Kto</th><th>Akcia</th><th>Zmena</th></tr></thead><tbody>${aud || '<tr><td colspan="4" class="hint">Zatiaľ žiadne zmeny.</td></tr>'}</tbody></table></div>`;
  }
  const wfields = (b) => { const o = {}; for (const k of ['network', 'label', 'address', 'memo', 'sort']) if (b[k] != null) o[k] = String(b[k]).slice(0, 200); o.enabled = b.enabled === '1'; return o; };

  admin.get('/penazenky', needAuth, wrap(async (req, res) => {
    nocache(res);
    let st; try { st = await W('state'); } catch (e) { return res.send(shell('Adresy peňaženiek', `<h1>👛 Adresy peňaženiek</h1>${offBox(e, '/admin/wallets')}`)); }
    res.send(shell('Adresy peňaženiek', `<h1>👛 Adresy peňaženiek</h1>${flash(req, WMS)}${walletList(req, st)}`));
  }));
  admin.get('/penazenky/upravit/:id', needAuth, wrap(async (req, res) => {
    nocache(res); const id = String(req.params.id);
    if (!ID_RE.test(id)) return res.redirect(303, WB);
    let st, d; try { [st, d] = await Promise.all([W('state'), W('get', { id })]); } catch (e) { return e.kind === 'user' ? errTo(res, WB, e) : res.send(shell('Adresy peňaženiek', offBox(e, '/admin/wallets'))); }
    res.send(shell('Upraviť adresu', `<h1>👛 Upraviť adresu</h1>${flash(req, WMS)}${walletForm(req, st, d.row)}`));
  }));
  admin.post('/penazenky/kontrola', needAuth, csrf, wrap(async (req, res) => {
    nocache(res); const id = String(req.body.id || ''); const f = wfields(req.body);
    if (id && !ID_RE.test(id)) return res.redirect(303, WB);
    let st; try { st = await W('state'); } catch (e) { return res.send(shell('Adresy peňaženiek', offBox(e, '/admin/wallets'))); }
    let p; try { p = (await W('preview', { id: id || undefined, fields: f })).preview; } catch (e) {
      if (e.kind !== 'user') return res.send(shell('Adresy peňaženiek', offBox(e, '/admin/wallets')));
      return res.status(400).send(shell('Skontrolovať adresu', `<h1>👛 ${id ? 'Upraviť' : 'Pridať'} adresu</h1>${walletForm(req, st, { ...f, id }, e.message)}`));
    }
    const hidden = ['network', 'label', 'address', 'memo', 'sort'].map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] == null ? '' : p[k])}">`).join('') + (p.enabled ? '<input type="hidden" name="enabled" value="1">' : '') + `<input type="hidden" name="id" value="${esc(id)}">`;
    res.send(shell('Potvrdiť adresu', `<h1>👛 Skontrolujte adresu pred uložením</h1><div class="card wlw">
<p><b>${esc(p.networkLabel)}</b>${p.label ? ' · ' + esc(p.label) : ''}</p><p class="hint">Porovnajte znak po znaku s adresou vo vašej peňaženke:</p><div class="wlbig">${chunk(p.address)}</div>
${p.memo ? `<p>Memo / tag: <b class="wla">${esc(p.memo)}</b></p>` : ''}${p.old && p.old.address !== p.address ? `<p class="wlm">Pôvodná adresa: ${esc(p.old.address)}</p>` : ''}
<p class="wlwarn">${p.enabled ? (p.willBeFirst ? '⚠️ Táto adresa sa začne <b>okamžite</b> používať na checkoute pre túto sieť.' : 'Adresa bude zapnutá ako záložná (checkout používa prvú zapnutú podľa poradia).') : 'Adresa bude uložená ako vypnutá.'}</p>
<div class="row"><form method="post" action="${WB}/ulozit">${hid(req)}${hidden}<input type="hidden" name="confirm" value="1"><button class="g">✅ Áno, adresa je správna – uložiť</button></form>
<form method="post" action="${WB}/opravit">${hid(req)}${hidden}<button class="g2">← Opraviť</button></form></div></div>`));
  }));
  admin.post('/penazenky/opravit', needAuth, csrf, wrap(async (req, res) => {
    nocache(res); let st; try { st = await W('state'); } catch (e) { return res.send(shell('Adresy peňaženiek', offBox(e, '/admin/wallets'))); }
    res.send(shell('Upraviť adresu', `<h1>👛 Upraviť adresu</h1>${walletForm(req, st, { ...wfields(req.body), id: String(req.body.id || '') })}`));
  }));
  admin.post('/penazenky/ulozit', needAuth, csrf, wrap(async (req, res) => {
    nocache(res); const id = String(req.body.id || ''); const f = wfields(req.body);
    if (id && !ID_RE.test(id)) return res.redirect(303, WB);
    if (req.body.confirm !== '1') return errTo(res, WB, new BridgeErr('user', 'Najprv adresu skontrolujte a potvrďte.'));
    try {
      const out = await W(id ? 'update' : 'create', { id: id || undefined, fields: f, confirm: true });
      await audit(req, id ? 'wallet_update' : 'wallet_add', `${out.row.network} ${short(out.row.address)} ${out.row.enabled ? 'on' : 'off'}`);
      res.redirect(303, WB + '?m=' + (id ? 'saved' : 'added'));
    } catch (e) { errTo(res, id ? WB + '/upravit/' + encodeURIComponent(id) : WB, e); }
  }));
  admin.post('/penazenky/prepnut', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || ''); const state = req.body.state === 'on' ? 'on' : req.body.state === 'off' ? 'off' : '';
    if (!ID_RE.test(id) || !state) return errTo(res, WB, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { const out = await W('toggle', { id, state }); await audit(req, 'wallet_toggle', `${out.row.network} ${short(out.row.address)} ${state}`); res.redirect(303, WB + '?m=toggled'); } catch (e) { errTo(res, WB, e); }
  }));

  /* ======================= 🔗 amount links ======================= */
  const LMS = { added: 'Odkaz bol pridaný.', saved: 'Odkaz bol uložený.', toggled: 'Stav odkazu zmenený.', del: 'Odkaz bol zmazaný.' };
  const eur = (c) => (Number(c) / 100).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  function linkForm(req, st, r, err) {
    const isNew = !r.id; const ms = st.methods || [];
    const sel = r.method || (ms.find((m) => m.id === 'revolut_manual') || ms[0] || {}).id;
    const o = (m) => `<option value="${esc(m.id)}"${m.id === sel ? ' selected' : ''}>${esc(m.label)}</option>`;
    const amount = r.amount != null ? r.amount : r.amountCents != null ? String(r.amountCents / 100).replace('.', ',') : '';
    return `<form method="post" action="${isNew ? LB + '/nova' : LB + '/ulozit/' + encodeURIComponent(r.id)}" class="card wlform" id="${isNew ? 'nova' : 'upravit'}">${hid(req)}<h2>${isNew ? '➕ Pridať odkaz' : '✏️ Upraviť odkaz'}</h2>${err ? `<div class="msg err">${esc(err)}</div>` : ''}
<div class="grid2"><div><label>Spôsob platby *</label><select name="method" required><optgroup label="Platby cez odkaz">${ms.filter((m) => m.linkBased).map(o).join('')}</optgroup><optgroup label="Ostatné">${ms.filter((m) => !m.linkBased).map(o).join('')}</optgroup></select></div>
<div><label>Suma (EUR) *</label><input name="amount" inputmode="decimal" required maxlength="12" value="${esc(amount)}" placeholder="napr. 25 alebo 19,99"></div></div>
<label>Platobný odkaz (https) *</label><input type="url" name="url" required maxlength="2000" autocomplete="off" spellcheck="false" value="${esc(r.url || '')}" placeholder="https://…">
<p class="hint">Zákazník odkaz neuvidí – pri presne tejto sume sa mu zobrazí len tlačidlo „Zaplatiť“. Pri inej sume ostáva pôvodný postup a návody.</p>
<div class="grid2"><div><label>Poznámka (pre vás, voliteľné)</label><input name="label" maxlength="60" value="${esc(r.label || '')}"></div><div><label class="ck"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnutý</label></div></div>
<p class="row"><button>💾 Uložiť</button>${isNew ? '' : `<a class="btnl g2" href="${LB}">Späť</a>`}</p></form>`;
  }
  function linkList(req, st) {
    const tok = hid(req); const lab = (id) => ((st.methods || []).find((m) => m.id === id) || { label: id }).label;
    const by = new Map(); for (const r of st.rows || []) { if (!by.has(r.method)) by.set(r.method, []); by.get(r.method).push(r); }
    const blocks = [...by.entries()].map(([m, rows]) => {
      rows.sort((a, b) => a.amountCents - b.amountCents); const on = rows.filter((r) => r.enabled).length;
      return `<details class="wlg" open><summary>${esc(lab(m))} <span class="tag ok">${on} zap.</span>${rows.length - on ? ` <span class="tag">${rows.length - on} vyp.</span>` : ''}</summary>
${rows.map((r) => `<div class="wlr${r.enabled ? '' : ' off'}"><div><span class="wlamt">${esc(eur(r.amountCents))}</span>${r.label ? ` · <b>${esc(r.label)}</b>` : ''} ${r.enabled ? '<span class="tag ok">zapnutý</span>' : '<span class="tag">vypnutý</span>'}<div class="wla">${esc(r.url)}</div><div class="wlm">upravené ${esc(when(r.updatedAt))}${r.updatedBy ? ' · ' + esc(r.updatedBy) : ''}</div></div>
<div class="wlx"><a class="btnl sm g2" href="${LB}/upravit/${encodeURIComponent(r.id)}">✏️ Upraviť</a><form method="post" action="${LB}/prepnut">${tok}<input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="state" value="${r.enabled ? 'off' : 'on'}"><button class="${r.enabled ? 'g2' : 'g'} sm">${r.enabled ? 'Vypnúť' : 'Zapnúť'}</button></form><form method="post" action="${LB}/zmazat" data-confirm="${esc(`Naozaj zmazať odkaz na ${eur(r.amountCents)} (${lab(m)})?`)}">${tok}<input type="hidden" name="id" value="${esc(r.id)}"><button class="d sm">🗑️ Zmazať</button></form></div></div>`).join('')}</details>`;
    }).join('');
    const aud = (st.audit || []).slice(0, 15).map((a) => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(lab(a.method))} · ${a.detail && a.detail.oldAmountCents != null && a.detail.oldAmountCents !== a.amountCents ? esc(eur(a.detail.oldAmountCents)) + ' → ' : ''}${esc(eur(a.amountCents))}${a.detail && a.detail.urlChanged ? ' · odkaz zmenený' : ''}</td></tr>`).join('');
    return `<div class="card wlw"><h2>🔗 Platobné odkazy podľa sumy</h2><p class="hint">Pre Revolut, Skrill a iné platby cez odkaz: suma v EUR + platobný odkaz (viac párov na metódu). Keď zákazník zadá presne túto sumu, na checkoute uvidí len tlačidlo „Zaplatiť“.</p><p class="row"><a class="btnl sm" href="#nova">➕ Pridať odkaz</a></p>${blocks || '<p class="hint">Zatiaľ žiadne odkazy.</p>'}</div>
${linkForm(req, st, {})}<div class="card"><h2>🧾 História zmien</h2><table class="wlaud"><thead><tr><th>Kedy</th><th>Kto</th><th>Akcia</th><th>Zmena</th></tr></thead><tbody>${aud || '<tr><td colspan="4" class="hint">Zatiaľ žiadne zmeny.</td></tr>'}</tbody></table></div>`;
  }
  const lfields = (b) => { const o = {}; for (const k of ['method', 'amount', 'url', 'label']) if (b[k] != null) o[k] = String(b[k]).slice(0, 2000); o.enabled = b.enabled === '1'; return o; };
  const lstate = async (res) => { try { return await L('state'); } catch (e) { res.send(shell('Odkazy podľa sumy', `<h1>🔗 Odkazy podľa sumy</h1>${offBox(e, '/admin/amount-links')}`)); return null; } };

  admin.get('/odkazy-podla-sumy', needAuth, wrap(async (req, res) => {
    nocache(res); const st = await lstate(res); if (!st) return;
    res.send(shell('Odkazy podľa sumy', `<h1>🔗 Odkazy podľa sumy</h1>${flash(req, LMS)}${linkList(req, st)}`));
  }));
  admin.get('/odkazy-podla-sumy/upravit/:id', needAuth, wrap(async (req, res) => {
    nocache(res); const id = String(req.params.id); if (!ID_RE.test(id)) return res.redirect(303, LB);
    const st = await lstate(res); if (!st) return;
    const r = (st.rows || []).find((x) => x.id === id); if (!r) return errTo(res, LB, new BridgeErr('user', 'Odkaz sa nenašiel.'));
    res.send(shell('Upraviť odkaz', `<h1>🔗 Upraviť odkaz</h1>${flash(req, LMS)}${linkForm(req, st, r)}`));
  }));
  const saveLink = (id) => async (req, res) => {
    nocache(res); const f = lfields(req.body);
    try {
      const out = await L(id ? 'update' : 'create', { id: id || undefined, fields: f });
      await audit(req, id ? 'amountlink_update' : 'amountlink_add', `${out.row.method} ${out.row.amountCents} ${out.row.enabled ? 'on' : 'off'}`);
      res.redirect(303, LB + '?m=' + (id ? 'saved' : 'added'));
    } catch (e) {
      if (e.kind !== 'user') return res.send(shell('Odkazy podľa sumy', offBox(e, '/admin/amount-links')));
      const st = await lstate(res); if (!st) return;
      res.status(400).send(shell('Odkaz podľa sumy', `<h1>🔗 ${id ? 'Upraviť' : 'Pridať'} odkaz</h1>${linkForm(req, st, { ...f, id }, e.message)}`));
    }
  };
  admin.post('/odkazy-podla-sumy/nova', needAuth, csrf, wrap((req, res) => saveLink('')(req, res)));
  admin.post('/odkazy-podla-sumy/ulozit/:id', needAuth, csrf, wrap((req, res) => { const id = String(req.params.id); if (!ID_RE.test(id)) return res.redirect(303, LB); return saveLink(id)(req, res); }));
  admin.post('/odkazy-podla-sumy/prepnut', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || ''); const state = req.body.state === 'on' ? 'on' : req.body.state === 'off' ? 'off' : '';
    if (!ID_RE.test(id) || !state) return errTo(res, LB, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { const out = await L('toggle', { id, state }); await audit(req, 'amountlink_toggle', `${out.row.method} ${out.row.amountCents} ${state}`); res.redirect(303, LB + '?m=toggled'); } catch (e) { errTo(res, LB, e); }
  }));
  admin.post('/odkazy-podla-sumy/zmazat', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || ''); if (!ID_RE.test(id)) return errTo(res, LB, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { await L('delete', { id }); await audit(req, 'amountlink_delete', id); res.redirect(303, LB + '?m=del'); } catch (e) { errTo(res, LB, e); }
  }));

  return {
    HEAD,
    links: () => `<a class="btnl" href="${WB}">👛 Adresy peňaženiek</a><a class="btnl" href="${LB}">🔗 Odkazy podľa sumy</a>`,
    dashCard: () => `<section class="card" id="penazenky"><h2>👛 Krypto adresy a 🔗 odkazy podľa sumy</h2><p class="hint">Adresy peňaženiek pre priame krypto platby a platobné odkazy (Revolut, Skrill…) pre konkrétne sumy – zmeny platia na checkoute okamžite.</p><p class="row"><a class="btnl sm" href="${WB}">👛 Adresy peňaženiek</a><a class="btnl sm" href="${LB}">🔗 Odkazy podľa sumy</a></p></section>`,
  };
};
