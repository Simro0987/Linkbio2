'use strict';
// 💳 Platobné metódy – správa spôsobov platby checkoutu (chain2pay-checkout-gl) priamo z lnkbio admina.
// Bezpečnosť: server-to-server most s HMAC podpisom (env PAY_ADMIN_BRIDGE_SECRET na oboch službách, nikdy nie heslo admina),
// všetky admin POSTy majú needAuth + CSRF, žiadny inline JS/CSS (CSP), logá sa načítavajú cez proxy len z /logos/* a /pm-logo/*.
// Checkout naďalej sám vynucuje vypnuté metódy (payMethods.isBuiltinDisabled / customFor).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

module.exports = function install(ctx) {
  const { admin, page, esc, hid, csrf, needAuth, wrap, audit } = ctx;
  const ORIGIN = String(process.env.CHECKOUT_PUBLIC_URL || 'https://chain2pay-checkout-gl.onrender.com').replace(/\/$/, '');
  const BRIDGE = ORIGIN + '/api/admin-bridge/pay-methods';
  const secret = () => { const v = String(process.env.PAY_ADMIN_BRIDGE_SECRET || ''); return v.length >= 32 ? v : ''; };
  const BASE = '/admin/platobne-metody';
  const V = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static', 'pm.js')) + fs.readFileSync(path.join(__dirname, 'static', 'pm.css'))).digest('hex').slice(0, 10);
  const HEAD = `<link rel="stylesheet" href="/static/pm.css?v=${V}"><script src="/static/pm.js?v=${V}" defer></script>`;
  const ID_RE = /^[a-z0-9_:-]{1,80}$/;
  const GROUP_RE = /^[a-z0-9_-]{1,40}$/;

  class BridgeErr extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
  async function call(action, extra = {}, timeoutMs = 45000) {
    const sec = secret();
    if (!sec) throw new BridgeErr('off', 'nie je prepojené');
    const body = JSON.stringify({ action, ...extra, n: crypto.randomBytes(12).toString('hex') });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', sec).update(ts + '.').update(body).digest('hex');
    let r;
    try {
      r = await fetch(BRIDGE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-ts': String(ts), 'x-bridge-sig': sig }, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (e) { throw new BridgeErr('down', 'Checkout neodpovedá (možno sa práve prebúdza). Skúste to o chvíľu znova.'); }
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (r.status === 503 && j && j.error === 'not_configured') throw new BridgeErr('off', 'nie je prepojené');
    if (r.status === 401 || r.status === 409) throw new BridgeErr('auth', 'Checkout odmietol podpis – PAY_ADMIN_BRIDGE_SECRET sa na službách lnkbio a checkout nezhoduje.');
    if (r.status === 404 && !j) throw new BridgeErr('off', 'nie je prepojené');
    if (!j) throw new BridgeErr('down', 'Checkout vrátil neplatnú odpoveď (HTTP ' + r.status + ').');
    if (!j.ok) throw new BridgeErr('user', j.error || 'Chyba');
    return j;
  }

  const logoSrc = (p) => (typeof p === 'string' && /^\/(logos\/[a-z0-9._-]+\.(svg|png|jpe?g|webp)|pm-logo\/[a-f0-9]{24})(\?v=[0-9a-z]{1,20})?$/i.test(p) ? `${BASE}/logo?p=${encodeURIComponent(p)}` : null);
  const logoTag = (p) => { const s = logoSrc(p); return s ? `<img src="${esc(s)}" alt="" loading="lazy" height="24">` : '<span class="pmno">💳</span>'; };
  const MSGS = { rank: 'Poradie na pokladni uložené.', ok: 'Uložené.', added: 'Spôsob platby bol pridaný.', saved: 'Zmeny boli uložené.', del: 'Odkaz bol presunutý do koša (dá sa obnoviť).', restored: 'Odkaz bol obnovený.', moved: 'Poradie zmenené.', toggled: 'Stav zmenený.', group: 'Skupina bola prepnutá.' };

  function offBox(e) {
    if (e.kind === 'off') return `<div class="msg err pmoff"><b>⚠️ Platobné metódy nie sú prepojené.</b><br>Chýba premenná prostredia <code>PAY_ADMIN_BRIDGE_SECRET</code> (rovnaká hodnota na Render službách <b>lnkbio</b> aj <b>chain2pay-checkout-gl</b>). Dovtedy ich spravujte v <a href="${esc(ORIGIN)}/admin/methods" target="_blank" rel="noopener noreferrer">admine checkoutu ↗</a>.</div>`;
    return `<div class="msg err pmoff"><b>⚠️ ${esc(e.message)}</b><br><a href="${esc(ORIGIN)}/admin/methods" target="_blank" rel="noopener noreferrer">Otvoriť admin checkoutu ↗</a></div>`;
  }

  function render(req, st, full) {
    const back = full ? 'full' : 'dash';
    const tok = hid(req);
    const c = st.counts || {};
    const groups = st.groups.map((g) => {
      const allOn = g.items.every((x) => x.on), allOff = g.items.every((x) => !x.on);
      const gform = (state, lbl, cls) => `<form method="post" action="${BASE}/skupina" class="pmf" data-confirm="${esc(`${state === 'on' ? 'Zapnúť' : 'Vypnúť'} všetky metódy v skupine „${g.label}“ (${g.items.length})?`)}">${tok}<input type="hidden" name="group" value="${esc(g.key)}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="back" value="${back}"><button class="${cls}">${lbl}</button></form>`;
      const items = g.items.map((x, i) => {
        const mv = (dir, lbl, dis) => `<form method="post" action="${BASE}/posun" class="pmf">${tok}<input type="hidden" name="id" value="${esc(x.id)}"><input type="hidden" name="group" value="${esc(g.key)}"><input type="hidden" name="dir" value="${dir}"><button class="g sm" ${dis ? 'disabled' : ''} title="${dir === 'up' ? 'Posunúť vyššie' : 'Posunúť nižšie'}" aria-label="${dir === 'up' ? 'Posunúť vyššie' : 'Posunúť nižšie'}">${lbl}</button></form>`;
        const status = `${x.on ? '<span class="tag ok pms">zapnuté</span>' : '<span class="tag pms">vypnuté</span>'}${x.soon ? ` <span class="tag pmsoon">${esc(x.soonLabel || 'nedostupné')}</span>` : ''}${x.minEur ? ` <span class="tag pmi">min. ${esc(x.minEur)} €</span>` : ''}`;
        const meta = x.kind === 'custom' ? 'vlastný odkaz' + (x.target ? ' · ' + esc(String(x.target).replace(/^https:\/\//, '').slice(0, 48)) : '') : 'vstavaný · ' + esc(x.id) + (x.origName && x.origName !== x.name ? ' · pôvodne „' + esc(x.origName) + '“' : '');
        return `<li class="pmr${x.on ? '' : ' off'}" data-id="${esc(x.id)}"><span class="pml">${(x.logos && x.logos.length ? x.logos.slice(0, 4) : [null]).map(logoTag).join('')}</span>
<span class="pmn"><b>${esc(x.name)}</b><small>${meta}</small><span class="pmst">${status}</span></span>
<span class="pma"><form method="post" action="${BASE}/prepnut" class="pmf pmt">${tok}<input type="hidden" name="id" value="${esc(x.id)}"><input type="hidden" name="state" value="${x.on ? 'off' : 'on'}"><input type="hidden" name="back" value="${back}"><button class="${x.on ? 'g' : ''} sm pmtb">${x.on ? 'Vypnúť' : 'Zapnúť'}</button></form>
${x.url ? `<a class="btnl sm" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer" title="Otvoriť odkaz">↗ Otvoriť</a>` : ''}<a class="btnl sm g2" href="${BASE}/upravit/${encodeURIComponent(x.id)}">✏️ Upraviť</a>
${full ? mv('up', '↑', i === 0) + mv('down', '↓', i === g.items.length - 1) : ''}
${full && x.kind === 'custom' ? `<form method="post" action="${BASE}/zmazat" class="pmf" data-confirm="${esc(`Presunúť „${x.name}“ do koša?`)}">${tok}<input type="hidden" name="id" value="${esc(x.id)}"><button class="d sm">🗑️ Zmazať</button></form>` : ''}</span></li>`;
      }).join('');
      return `<details class="pmg" data-group="${esc(g.key)}"${full ? ' open' : ''}><summary class="pmgh"><h3>${esc(g.label)} <small class="hint">${g.items.filter((x) => x.on).length}/${g.items.length}</small></h3><span class="pmlogos">${g.items.slice(0, 6).map((x) => logoTag((x.logos || [])[0] || null)).join('')}</span></summary><div class="row pmgb">${allOn ? '' : gform('on', '✅ Zapnúť všetky', 'g sm')}${allOff ? '' : gform('off', '⛔ Vypnúť všetky', 'd sm')}</div><ul class="pml0">${items}</ul></details>`;
    }).join('');
    const del = full && st.deleted && st.deleted.length ? `<div class="card"><h2>🗑️ Zmazané vlastné odkazy</h2><ul class="pml0">${st.deleted.map((d) => `<li class="pmr off"><span class="pml">${logoTag(d.logo)}</span><span class="pmn"><b>${esc(d.name)}</b><small>${esc(String(d.url || '').replace(/^https:\/\//, '').slice(0, 60))}</small></span><span class="pma"><form method="post" action="${BASE}/obnovit" class="pmf">${tok}<input type="hidden" name="id" value="${esc(d.id)}"><button class="g sm">♻️ Obnoviť</button></form></span></li>`).join('')}</ul></div>` : '';
    return `<div class="pmhead"><p class="pmc"><span class="tag ok" data-pm="on">${c.on || 0} zapnutých</span> <span class="tag" data-pm="off">${c.off || 0} vypnutých</span> <span class="hint">z ${c.total || 0} · zmeny platia v checkoute okamžite</span></p>
<p class="row">${full ? '' : `<a class="btnl sm" href="${BASE}">⚙️ Spravovať (poradie, mazanie)</a>`}<a class="btnl sm" href="${BASE}#nova">➕ Pridať vlastný odkaz</a><a class="btnl sm g2" href="${esc(ORIGIN)}/" target="_blank" rel="noopener noreferrer">↗ Otvoriť checkout</a></p></div>
<div class="pmgrid">${groups}</div>${del}`;
  }

  function logoFields(current, st, builtin) {
    const lib = (st.library || []).map((l) => `<label class="pmlib"><input type="radio" name="lib" value="${esc(l.file)}">${logoTag(l.src)}<span>${esc(l.file.replace(/\.(svg|png)$/, ''))}</span></label>`).join('');
    return `<fieldset class="pmfs"><legend>Logo</legend>${current ? `<p class="row">Aktuálne: <span class="pml">${logoTag(current)}</span> <label class="ck"><input type="checkbox" name="removeLogo" value="1"> Odstrániť ${builtin ? 'vlastné logo (použije sa predvolené)' : 'logo'}</label></p>` : ''}
<label>Nahrať súbor (SVG, PNG, JPG, WebP; max 512 kB)</label><input type="file" name="logo" accept="image/svg+xml,image/png,image/jpeg,image/webp">
<label>alebo URL loga (https://…)</label><input type="url" name="logoUrl" maxlength="500" placeholder="https://…">
<details><summary>alebo vybrať z knižnice (${(st.library || []).length} skutočných lôg)</summary><div class="pmlibs"><label class="pmlib"><input type="radio" name="lib" value="" checked><span>bez zmeny</span></label>${lib}</div></details></fieldset>`;
  }
  function customForm(req, st, r) {
    const isNew = !r.id;
    const opt = (st.groupChoices || []).map(([k, v]) => `<option value="${esc(k)}"${(r.group || 'keyless') === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
    return `<form method="post" action="${isNew ? BASE + '/nova' : BASE + '/ulozit/' + encodeURIComponent(r.id)}" enctype="multipart/form-data" class="card pmform" id="${isNew ? 'nova' : 'upravit'}">${hid(req)}<h2>${isNew ? '➕ Pridať vlastný platobný odkaz' : '✏️ Upraviť „' + esc(r.name) + '“'}</h2>
<div class="grid2"><div><label>Názov (zobrazí sa na tlačidle) *</label><input name="name" required maxlength="60" value="${esc(r.name || '')}" placeholder="napr. Platba cez XY"></div>
<div><label>Kategória / skupina *</label><select name="group">${opt}</select></div></div>
<label>Platobný odkaz (URL) *</label><input type="url" name="url" required maxlength="1000" value="${esc(r.url || '')}" placeholder="https://…">
<p class="hint">Do odkazu môžete vložiť <code>{amount}</code> (suma v EUR) a <code>{orderId}</code> – doplnia sa automaticky.</p>
<label>Krátky popis / pokyny pre zákazníka (voliteľné)</label><textarea name="description" rows="3" maxlength="600">${esc(r.description || '')}</textarea>
<div class="grid2"><div><label>Minimálna suma v EUR (voliteľné)</label><input type="number" name="minEur" min="0" step="0.01" value="${r.minEur != null ? esc(r.minEur) : ''}"></div>
<div><label>Postup po kliknutí</label><select name="mode"><option value="btc"${(r.mode || 'btc') === 'btc' ? ' selected' : ''}>BTC adresa + odkaz (ako ChangeNOW / Paybis)</option><option value="link"${r.mode === 'link' ? ' selected' : ''}>Len suma, pokyny a odkaz (bez BTC adresy)</option></select></div></div>
<label class="ck"><input type="checkbox" name="proofForm" value="1"${r.proofForm !== false ? ' checked' : ''}> Zobraziť formulár „Poslať doklad“ (doklad príde do Telegramu)</label>
<label class="ck"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnuté (zobrazuje sa zákazníkom)</label>
${logoFields(r.logo, st, false)}<p class="row"><button>${isNew ? '➕ Pridať spôsob platby' : '💾 Uložiť'}</button>${isNew ? '' : `<a class="btnl g2" href="${BASE}">Späť</a>`}</p></form>`;
  }
  function builtinForm(req, st, d) {
    const r = d.rec || {};
    return `<form method="post" action="${BASE}/ulozit/${encodeURIComponent(d.id)}" enctype="multipart/form-data" class="card pmform" id="upravit">${hid(req)}<h2>✏️ ${esc(d.label)}</h2>
<p class="hint">Vstavaný spôsob platby (${esc(d.id)}) v skupine „${esc(d.groupLabel)}“. Predvolené logá: <span class="pml">${(d.defaultLogos || []).map(logoTag).join('') || '—'}</span></p>
<label>Vlastný názov (prázdne = „${esc(d.label)}“)</label><input name="name" maxlength="60" value="${esc(r.name || '')}">
<label class="ck"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnuté (zobrazuje sa zákazníkom)</label>
<label class="ck"><input type="checkbox" name="hideLogo" value="1"${r.hideLogo ? ' checked' : ''}> Skryť logo</label>
${logoFields(r.logo, st, true)}<p class="row"><button>💾 Uložiť</button><a class="btnl g2" href="${BASE}">Späť</a></p></form>`;
  }
  // ↕️ checkout order by usage (auto / manual, pins, usage numbers) — admin only, via the same signed bridge
  function rankCard(req, rs) {
    if (!rs) return '';
    const tok = hid(req);
    const when = rs.computedAt ? new Date(rs.computedAt).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }) : '—';
    const pin = (m) => `<form method="post" action="${BASE}/poradie/pin" class="pmf">${tok}<input type="hidden" name="id" value="${esc(m.id)}"><input type="hidden" name="pin" value="${m.pinned ? 0 : 1}"><button class="sm${m.pinned ? ' d' : ' g2'}">${m.pinned ? '📌 Odopnúť' : '📌 Pripnúť'}</button></form>`;
    const rows = (rs.methods || []).map((m) => `<tr class="${m.pinned ? 'rkpin' : ''}"><td class="rkn">${esc(m.pos)}.</td><td><b>${esc(m.name)}</b>${m.pinned ? ' <span class="tag ok">pripnuté</span>' : ''}<small>${esc(m.groupLabel)} · ${esc(m.id)}</small></td>
<td class="rkn" data-l="Objednávky">${esc(m.orders)}</td><td class="rkn" data-l="S dokladom">${esc(m.proof)}</td><td class="rkn" data-l="Zaplatené">${esc(m.paid)}</td><td class="rkn" data-l="Kliky">${esc(m.clicks)}</td><td class="rkn" data-l="Skóre"><b>${esc(m.score)}</b>${m.enough ? '' : ' <small>málo dát</small>'}</td><td class="rkf" data-l="Poplatok">${esc(m.fee || '—')}</td><td>${pin(m)}</td></tr>`).join('');
    const gm = (k, dir, lbl, dis) => `<form method="post" action="${BASE}/poradie/skupina" class="pmf">${tok}<input type="hidden" name="group" value="${esc(k)}"><input type="hidden" name="dir" value="${dir}"><button class="sm g2"${dis ? ' disabled' : ''}>${lbl}</button></form>`;
    const groups = (rs.groups || []).map((g, i, a) => `<li><span>${i + 1}. ${esc(g.label)}</span><span class="row">${gm(g.key, 'up', '↑', i === 0)}${gm(g.key, 'down', '↓', i === a.length - 1)}</span></li>`).join('');
    const w = rs.weights || {};
    return `<div class="card rk" id="poradie"><h2>↕️ Poradie na pokladni</h2>
<form method="post" action="${BASE}/poradie/auto" class="pmf row rkauto">${tok}<input type="hidden" name="auto" value="${rs.auto ? 0 : 1}"><span class="tag${rs.auto ? ' ok' : ''}" role="switch" aria-checked="${rs.auto ? 'true' : 'false'}">Zoradiť automaticky podľa používania: <b>${rs.auto ? 'ZAPNUTÉ' : 'VYPNUTÉ'}</b></span><button class="sm${rs.auto ? ' g2' : ' g'}">${rs.auto ? 'Prepnúť na manuálne poradie' : 'Zapnúť automatické poradie'}</button></form>
<p class="hint">${rs.auto ? `Skóre za posledných ${esc(rs.days)} dní: objednávka ×${esc(w.started)}, s dokladom ×${esc(w.proof)}, zaplatená ×${esc(w.paid)}, klik ×${esc(w.click)}. Pod ${esc(rs.minScore)} („málo dát“) rozhoduje predvolené poradie (Revolut, karta / Apple / Google Pay, SEPA, krypto, darčekové karty).` : 'Manuálne: poradie skupín nižšie, poradie v skupine šípkami v zozname metód.'} Pripnuté metódy sú vždy hore. Zákazník čísla ani poplatky nevidí.</p>
<div class="row rkmeta"><span class="hint">Prepočítané: ${esc(when)} · objednávok: ${esc(rs.ordersCounted)} · automaticky každú hodinu</span><form method="post" action="${BASE}/poradie/prepocitat" class="pmf">${tok}<button class="sm g2">🔄 Prepočítať teraz</button></form></div>
<div class="rkwrap"><table class="rkt"><thead><tr><th>#</th><th>Spôsob platby</th><th>Objednávky</th><th>S dokladom</th><th>Zaplatené</th><th>Kliky</th><th>Skóre</th><th>Poplatok (admin)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
${rs.auto ? '' : `<h3>Poradie skupín</h3><ul class="rkg">${groups}</ul>`}</div>`;
  }
  const shellPage = (req, title, body) => page(title, `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="${BASE}">💳 Platobné metódy</a></p>${body}`, 'a adm pmw0', '', HEAD);
  const msgOf = (req) => (MSGS[req.query.m] ? `<div class="msg">${esc(MSGS[req.query.m])}</div>` : '') + (req.query.e ? `<div class="msg err">${esc(String(req.query.e).slice(0, 200))}</div>` : '');

  // ---- pages ----
  admin.get('/platobne-metody', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let st, rs = null;
    try { [st, rs] = await Promise.all([call('state'), call('rank_state').catch((e) => (e.kind === 'user' ? null : Promise.reject(e)))]); } catch (e) { return res.send(shellPage(req, 'Platobné metódy', `<h1>💳 Platobné metódy</h1>${offBox(e)}`)); }
    res.send(shellPage(req, 'Platobné metódy', `<h1>💳 Platobné metódy</h1>${msgOf(req)}<p class="hint">Spôsoby platby na checkoute <a href="${esc(ORIGIN)}/" target="_blank" rel="noopener noreferrer">${esc(ORIGIN.replace(/^https:\/\//, ''))}</a>. Vypnuté metódy checkout zákazníkom nezobrazí a ani ich nedovolí použiť.</p>
${rankCard(req, rs)}<div class="card pmw" id="platobne-metody">${render(req, st, true)}</div>${customForm(req, st, {})}`));
  }));
  // dashboard fragment (loaded by /static/pm.js so a sleeping checkout never blocks /admin)
  admin.get('/platobne-metody/panel', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.type('html').send(render(req, await call('state'), false)); } catch (e) { res.type('html').send(offBox(e)); }
  }));
  admin.get('/platobne-metody/upravit/:id', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.params.id).toLowerCase();
    if (!ID_RE.test(id)) return res.redirect(303, BASE);
    let st, d;
    try { [st, d] = await Promise.all([call('state'), call('get', { id })]); } catch (e) {
      if (e.kind === 'user') return res.redirect(303, BASE + '?e=' + encodeURIComponent(e.message));
      return res.send(shellPage(req, 'Platobné metódy', `<h1>💳 Platobné metódy</h1>${offBox(e)}`));
    }
    res.send(shellPage(req, 'Upraviť spôsob platby', `<h1>💳 Upraviť spôsob platby</h1>${msgOf(req)}${d.kind === 'custom' ? customForm(req, st, d.rec) : builtinForm(req, st, d)}`));
  }));

  // logo proxy (onrender.com is a public suffix → checkout logos are cross-site; serve them same-origin, sandboxed)
  const LC = new Map();
  admin.get('/platobne-metody/logo', needAuth, wrap(async (req, res) => {
    const p = String(req.query.p || '');
    if (!logoSrc(p)) return res.status(404).end();
    let hit = LC.get(p);
    if (!hit || Date.now() - hit.t > 3600e3) {
      try {
        const r = await fetch(ORIGIN + p, { signal: AbortSignal.timeout(20000), redirect: 'error' });
        const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!r.ok || !/^image\/(svg\+xml|png|jpeg|webp|gif)$/.test(type)) return res.status(404).end();
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 600 * 1024) return res.status(404).end();
        hit = { t: Date.now(), type, buf };
        if (LC.size > 300) LC.delete(LC.keys().next().value);
        LC.set(p, hit);
      } catch { return res.status(502).end(); }
    }
    res.setHeader('Content-Type', hit.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(hit.buf);
  }));

  // ---- actions ----
  const wantsJson = (req) => /application\/json/.test(String(req.headers.accept || ''));
  const backTo = (req, m) => (req.body && req.body.back === 'dash' ? '/admin?m=pmok#platobne-metody' : BASE + '?m=' + m);
  function fail(req, res, e, to) {
    if (wantsJson(req)) return res.status(e.kind === 'user' ? 400 : 502).json({ ok: false, error: e.kind === 'off' ? 'Platobné metódy nie sú prepojené (chýba PAY_ADMIN_BRIDGE_SECRET).' : e.message });
    res.redirect(303, (to || BASE) + (/\?/.test(to || BASE) ? '&' : '?') + 'e=' + encodeURIComponent(e.kind === 'off' ? 'Platobné metódy nie sú prepojené (chýba PAY_ADMIN_BRIDGE_SECRET).' : e.message));
  }
  admin.post('/platobne-metody/prepnut', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || '').toLowerCase(); const state = req.body.state === 'on' ? 'on' : req.body.state === 'off' ? 'off' : '';
    if (!ID_RE.test(id) || !state) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try {
      const out = await call('toggle', { id, state });
      await audit(req, 'paymethod_toggle', `${id} ${out.enabled ? 'on' : 'off'}`);
      if (wantsJson(req)) return res.json({ ok: true, id: out.id, enabled: out.enabled, counts: out.counts });
      res.redirect(303, backTo(req, 'toggled'));
    } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/skupina', needAuth, csrf, wrap(async (req, res) => {
    const group = String(req.body.group || ''); const state = req.body.state === 'on' ? 'on' : req.body.state === 'off' ? 'off' : '';
    if (!GROUP_RE.test(group) || !state) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { const out = await call('group', { group, state }); await audit(req, 'paymethod_group', `${group} ${state} (${out.changed})`); res.redirect(303, backTo(req, 'group')); } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/posun', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || '').toLowerCase(); const group = String(req.body.group || ''); const dir = req.body.dir === 'up' ? 'up' : 'down';
    if (!ID_RE.test(id) || !GROUP_RE.test(group)) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { await call('move', { id, group, dir }); res.redirect(303, BASE + '?m=moved#platobne-metody'); } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/zmazat', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || '').toLowerCase();
    if (!ID_RE.test(id)) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { const out = await call('delete', { id }); await audit(req, 'paymethod_delete', `${id} ${out.name || ''}`); res.redirect(303, BASE + '?m=del'); } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/obnovit', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || '').toLowerCase();
    if (!ID_RE.test(id)) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { const out = await call('restore', { id }); await audit(req, 'paymethod_restore', `${id} ${out.name || ''}`); res.redirect(303, BASE + '?m=restored'); } catch (e) { fail(req, res, e); }
  }));

  const toRank = (res) => res.redirect(303, BASE + '?m=rank#poradie');
  admin.post('/platobne-metody/poradie/auto', needAuth, csrf, wrap(async (req, res) => {
    const on = String(req.body.auto) === '1';
    try { await call('rank_auto', { auto: on }); await audit(req, 'paymethod_rank_auto', on ? 'on' : 'off'); toRank(res); } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/poradie/pin', needAuth, csrf, wrap(async (req, res) => {
    const id = String(req.body.id || '').toLowerCase(); const pin = String(req.body.pin) === '1';
    if (!ID_RE.test(id)) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { await call('rank_pin', { id, pin }); await audit(req, pin ? 'paymethod_pin' : 'paymethod_unpin', id); toRank(res); } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/poradie/skupina', needAuth, csrf, wrap(async (req, res) => {
    const group = String(req.body.group || ''); const dir = req.body.dir === 'up' ? 'up' : 'down';
    if (!GROUP_RE.test(group)) return fail(req, res, new BridgeErr('user', 'Neplatná požiadavka.'));
    try { await call('rank_group_move', { group, dir }); await audit(req, 'paymethod_rank_group', `${group} ${dir}`); toRank(res); } catch (e) { fail(req, res, e); }
  }));
  admin.post('/platobne-metody/poradie/prepocitat', needAuth, csrf, wrap(async (req, res) => {
    try { await call('rank_recompute'); await audit(req, 'paymethod_rank_recompute', ''); toRank(res); } catch (e) { fail(req, res, e); }
  }));

  const FIELDS = ['name', 'group', 'url', 'description', 'minEur', 'mode', 'proofForm', 'enabled', 'hideLogo', 'logoUrl', 'lib', 'removeLogo'];
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024, files: 1, fields: 20, fieldSize: 2000 } }).single('logo');
  const withLogo = (to) => [needAuth, (req, res, next) => up(req, res, (e) => (e ? res.redirect(303, to(req) + '?e=' + encodeURIComponent(e.code === 'LIMIT_FILE_SIZE' ? 'Logo je príliš veľké (max 512 kB).' : 'Neplatný súbor.')) : next())), csrf];
  const fieldsOf = (b) => { const o = {}; for (const k of FIELDS) if (b[k] != null && b[k] !== '') o[k] = String(b[k]).slice(0, 1000); return o; };
  const logoOf = (f) => (f && f.buffer && f.buffer.length ? { b64: f.buffer.toString('base64'), name: String(f.originalname || 'logo').slice(0, 80) } : null);
  admin.post('/platobne-metody/nova', ...withLogo(() => BASE), wrap(async (req, res) => {
    try {
      const out = await call('create', { fields: fieldsOf(req.body), logo: logoOf(req.file) });
      await audit(req, 'paymethod_add', `${out.id} ${out.name || ''}`);
      res.redirect(303, BASE + '?m=added');
    } catch (e) { fail(req, res, e, BASE); }
  }));
  admin.post('/platobne-metody/ulozit/:id', ...withLogo((req) => BASE + '/upravit/' + encodeURIComponent(String(req.params.id))), wrap(async (req, res) => {
    const id = String(req.params.id).toLowerCase();
    if (!ID_RE.test(id)) return res.redirect(303, BASE);
    try {
      await call('save', { id, fields: fieldsOf(req.body), logo: logoOf(req.file) });
      await audit(req, 'paymethod_save', id);
      res.redirect(303, BASE + '?m=saved');
    } catch (e) { fail(req, res, e, BASE + '/upravit/' + encodeURIComponent(id)); }
  }));

  return { HEAD, dashCard: () => `<section class="card pmw" id="platobne-metody" data-pm-src="${BASE}/panel"><h2>💳 Platobné metódy</h2><div class="pmbody"><p class="hint">Načítavam spôsoby platby z checkoutu… <a href="${BASE}">otvoriť samostatne</a></p></div></section>` };
};
