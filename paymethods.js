'use strict';
// 💳 Platobné metódy – správa spôsobov platby platobnej stránky /platby (modul pay/, PAY_MODULE=on) priamo z lnkbio admina.
// Bezpečnosť: akcie sa volajú in-process (global.__payBridge), žiadny HTTP most ani druhá služba,
// všetky admin POSTy majú needAuth + CSRF, žiadny inline JS/CSS (CSP), logá sa načítavajú cez proxy len z /logos/* a /pm-logo/*.
// Checkout naďalej sám vynucuje vypnuté metódy (payMethods.isBuiltinDisabled / customFor).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

module.exports = function install(ctx) {
  const { admin, page, esc, hid, csrf, needAuth, wrap, audit } = ctx;
  const ORIGIN = ''; // payment module runs in-process (PAY_MODULE=on)
  const MERGED = () => ['live', 'on'].includes(String(process.env.PAY_MODULE || '').trim().toLowerCase());
  const BRIDGE = ORIGIN + '/api/admin-bridge/pay-methods';
  const BASE = '/admin/platobne-metody';
  const V = crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static', 'pm.js')) + fs.readFileSync(path.join(__dirname, 'static', 'pm.css'))).digest('hex').slice(0, 10);
  const HEAD = `<link rel="stylesheet" href="/static/pm.css?v=${V}"><script src="/static/pm.js?v=${V}" defer></script>`;
  const ID_RE = /^[a-z0-9_:-]{1,80}$/;
  const GROUP_RE = /^[a-z0-9_-]{1,40}$/;

  class BridgeErr extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
  async function call(action, extra = {}, timeoutMs = 45000, bridge = '/api/admin-bridge/pay-methods') {
    // merged payment module (PAY_MODULE=live|on): call the same actions in-process – no HTTP, no HMAC, no second service
    const reg = MERGED() && global.__payBridge && global.__payBridge[bridge];
    if (reg) {
      const fn = Object.prototype.hasOwnProperty.call(reg, String(action)) ? reg[String(action)] : null;
      if (!fn) throw new BridgeErr('user', 'Neznáma akcia');
      let out;
      try { out = await fn(JSON.parse(JSON.stringify({ action, ...extra }))); } catch (x) { throw new BridgeErr('user', (x && x.message) || 'Chyba'); }
      const j = out == null ? null : JSON.parse(JSON.stringify(out));
      if (!j || !j.ok) throw new BridgeErr('user', (j && j.error) || 'Chyba');
      return j;
    }
    throw new BridgeErr('off', 'platobný modul nie je zapnutý');
  }

  const logoSrc = (p) => (typeof p === 'string' && /^\/(logos\/[a-z0-9._-]+\.(svg|png|jpe?g|webp)|pm-logo\/[a-f0-9]{24})(\?v=[0-9a-z]{1,20})?$/i.test(p) ? `${BASE}/logo?p=${encodeURIComponent(p)}` : null);
  const logoTag = (p) => { const s = logoSrc(p); return s ? `<img src="${esc(s)}" alt="" loading="lazy" height="24">` : '<span class="pmno">💳</span>'; };
  const MSGS = { rank: 'Poradie na pokladni uložené.', ok: 'Uložené.', added: 'Spôsob platby bol pridaný.', saved: 'Zmeny boli uložené.', del: 'Odkaz bol presunutý do koša (dá sa obnoviť).', restored: 'Odkaz bol obnovený.', moved: 'Poradie zmenené.', toggled: 'Stav zmenený.', group: 'Skupina bola prepnutá.' };

  function offBox(e) {
    if (e.kind === 'off') return `<div class="msg err pmoff"><b>⚠️ Platobný modul nie je zapnutý.</b><br>Na službe lnkbio nastavte <code>PAY_MODULE=on</code>.</div>`;
    return `<div class="msg err pmoff"><b>⚠️ ${esc(e.message)}</b></div>`;
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
    return `<div class="pmhead"><p class="pmc"><span class="tag ok" data-pm="on">${c.on || 0} zapnutých</span> <span class="tag" data-pm="off">${c.off || 0} vypnutých</span> <span class="hint">z ${c.total || 0} · zmeny platia na /platby okamžite</span></p>
<p class="row">${full ? '' : `<a class="btnl sm" href="${BASE}">⚙️ Spravovať (poradie, mazanie)</a>`}<a class="btnl sm" href="${BASE}#nova">➕ Pridať vlastný odkaz</a><a class="btnl sm g2" href="/platby" target="_blank" rel="noopener noreferrer">↗ Otvoriť platobnú stránku</a></p></div>
<div class="pmgrid">${groups}</div>${del}`;
  }

  function logoFields(current, st, builtin) {
    const lib = (st.library || []).map((l) => `<label class="pmlib"><input type="radio" name="lib" value="${esc(l.file)}">${logoTag(l.src)}<span>${esc(l.file.replace(/\.(svg|png)$/, ''))}</span></label>`).join('');
    return `<fieldset class="pmfs"><legend>Logo</legend>${current ? `<p class="row">Aktuálne: <span class="pml">${logoTag(current)}</span> <label class="ck"><input type="checkbox" name="removeLogo" value="1"> Odstrániť ${builtin ? 'vlastné logo (použije sa predvolené)' : 'logo'}</label></p>` : ''}
<label>Nahrať súbor (SVG, PNG, JPG, WebP; max 512 kB)</label><input type="file" name="logo" accept="image/svg+xml,image/png,image/jpeg,image/webp">
<label>alebo URL loga (https://…)</label><input type="url" name="logoUrl" maxlength="500" placeholder="https://…">
<details><summary>alebo vybrať z knižnice (${(st.library || []).length} skutočných lôg)</summary><div class="pmlibs"><label class="pmlib"><input type="radio" name="lib" value="" checked><span>bez zmeny</span></label>${lib}</div></details></fieldset>`;
  }
  // 🪙 per-method coin choice: which of Ryan's crypto addresses the customer sees for this method (unchecked „vlastný výber“ = as before)
  function coinFields(r, choices) {
    if (!Array.isArray(choices) || !choices.length) return '';
    const sel = Array.isArray(r.coins) ? new Set(r.coins) : null;
    const groups = [];
    for (const c of choices) { let g = groups.find((x) => x.k === c.group); if (!g) groups.push(g = { k: c.group, items: [] }); g.items.push(c); }
    const box = (c) => `<label class="ck pmcoin${c.available ? '' : ' dis'}"><input type="checkbox" name="coins" value="${esc(c.id)}"${sel && sel.has(c.id) && c.available ? ' checked' : ''}${c.available ? '' : ' disabled'}> ${esc(c.label)} <small class="hint">${esc(c.note)}</small></label>`;
    return `<fieldset class="pmfs pmcoins"><legend>🪙 Kryptomeny pre zákazníka</legend><input type="hidden" name="coinsSent" value="1">
<label class="ck"><input type="checkbox" name="coinsCustom" value="1"${sel ? ' checked' : ''}> Vlastný výber – na platobnej stránke tejto metódy zobraziť adresy len vybraných mien</label>
<p class="hint">Nezaškrtnuté = ako doteraz. Pri BTC a LTC s nastaveným xpub dostane každá objednávka novú adresu, inak sa použije adresa z 👛 Adresy peňaženiek. Každá adresa má tlačidlo Kopírovať.</p>
<div class="pmcoing">${groups.map((g) => `<div><b class="hint">${esc(g.k)}</b>${g.items.map(box).join('')}</div>`).join('')}</div></fieldset>`;
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
${coinFields(r, st.coinChoices)}${logoFields(r.logo, st, false)}<p class="row"><button>${isNew ? '➕ Pridať spôsob platby' : '💾 Uložiť'}</button>${isNew ? '' : `<a class="btnl g2" href="${BASE}">Späť</a>`}</p></form>`;
  }
  function builtinForm(req, st, d) {
    const r = d.rec || {};
    return `<form method="post" action="${BASE}/ulozit/${encodeURIComponent(d.id)}" enctype="multipart/form-data" class="card pmform" id="upravit">${hid(req)}<h2>✏️ ${esc(d.label)}</h2>
<p class="hint">Vstavaný spôsob platby (${esc(d.id)}) v skupine „${esc(d.groupLabel)}“. Predvolené logá: <span class="pml">${(d.defaultLogos || []).map(logoTag).join('') || '—'}</span></p>
<label>Vlastný názov (prázdne = „${esc(d.label)}“)</label><input name="name" maxlength="60" value="${esc(r.name || '')}">
<label class="ck"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnuté (zobrazuje sa zákazníkom)</label>
<label class="ck"><input type="checkbox" name="hideLogo" value="1"${r.hideLogo ? ' checked' : ''}> Skryť logo</label>
${coinFields(r, d.coinChoices || st.coinChoices)}${logoFields(r.logo, st, true)}<p class="row"><button>💾 Uložiť</button><a class="btnl g2" href="${BASE}">Späť</a></p></form>`;
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
  // ---- ⚡ Bitcoin Lightning (Blink) settings – API key is write-only: shown only as (uložený)/(nenastavený), never echoed or logged ----
  const BLINK = BASE + '/blink';
  const callBlink = (action, extra) => call(action, extra, 45000, '/api/admin-bridge/blink');
  function blinkCard(b, full) {
    if (!b) return '';
    const state = b.configured ? '<span class="tag ok">pripojené</span>' : '<span class="tag">nenastavené</span>';
    if (!full) return `<div class="card pmw" id="blink"><h2>⚡ Bitcoin Lightning (Blink) ${state}</h2><p class="hint">Peňaženka: ${b.username ? esc(b.username) : '–'} · Lightning adresa: ${esc(b.lnAddressEffective || '–')} · API kľúč: ${esc(b.key)}. Metódu zapnete prepínačom „Bitcoin Lightning (Blink)“ nižšie (predvolene vypnutá).</p><p class="row"><a class="btnl sm g2" href="${BLINK}">⚙️ Nastaviť Blink</a></p></div>`;
    return '';
  }
  function blinkForm(req, b) {
    return `<form method="post" action="${BLINK}" class="card pmw" id="blink" autocomplete="off">${hid(req)}
<h2>⚡ Bitcoin Lightning (Blink) ${b.configured ? '<span class="tag ok">pripojené</span>' : '<span class="tag">nenastavené</span>'}</h2>
<p class="hint">Zákazník dostane Lightning faktúru (BOLT11) na presnú sumu objednávky v sats podľa aktuálneho kurzu BTC/EUR. Po zaplatení sa objednávka automaticky označí ako zaplatená a príde správa na Telegram. Na vytváranie faktúr stačí používateľské meno – API kľúč nie je potrebný.</p>
<label for="blu">Blink používateľské meno</label><input id="blu" name="username" maxlength="50" pattern="@?[A-Za-z0-9_]{3,50}" value="${esc(b.username)}" placeholder="napr. mojmeno" spellcheck="false" autocapitalize="off">
<p class="hint">Peňaženka: ${b.walletOk ? '<span class="tag ok">BTC peňaženka overená</span>' : '<span class="tag">neoverená</span>'} · overí sa pri uložení cez Blink API.</p>
<label for="bla">Lightning adresa (zobrazená zákazníkom)</label><input id="bla" name="lnAddress" maxlength="250" value="${esc(b.lnAddress)}" placeholder="${esc(b.lnAddressDefault || 'meno@blink.sv')}" spellcheck="false" autocapitalize="off">
<p class="hint">Prázdne = predvolená <code>${esc(b.lnAddressDefault || 'používateľské meno@blink.sv')}</code>. Zobrazí sa na platobnej stránke s tlačidlom Kopírovať a QR kódom.</p>
<label for="blk">Blink API kľúč (voliteľný) <span class="tag${b.keySet ? ' ok' : ''}">${esc(b.key)}</span></label><input id="blk" name="apiKey" type="password" maxlength="200" value="" autocomplete="new-password" placeholder="${b.keySet ? 'nechajte prázdne = ponechať uložený kľúč' : 'nepovinné'}">
<p class="hint">Použije sa len ako záloha, keď meno nestačí (oprávnenia Read + Receive). Kľúč sa uloží šifrovane a už sa nikdy nezobrazí.${b.encAvailable ? '' : ' <b>Chýba DATA_ENC_KEY – kľúč nie je možné uložiť.</b>'}</p>
${b.keySet ? '<label class="ck"><input type="checkbox" name="clearKey" value="1"> Vymazať uložený API kľúč</label>' : ''}
<p class="row"><button>💾 Uložiť Blink</button><a class="btnl g2" href="${BASE}">Späť</a></p></form>`;
  }
  const shellPage = (req, title, body) => page(title, `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="${BASE}">💳 Platobné metódy</a></p>${body}`, 'a adm pmw0', '', HEAD);
  const msgOf = (req) => (MSGS[req.query.m] ? `<div class="msg">${esc(MSGS[req.query.m])}</div>` : '') + (req.query.e ? `<div class="msg err">${esc(String(req.query.e).slice(0, 200))}</div>` : '');

  // ---- pages ----
  admin.get('/platobne-metody', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let st, rs = null;
    let bl = null, gc = null, ox = null, c2 = null, pg = null;
    try { [st, rs, bl, gc, ox, c2, pg] = await Promise.all([call('state'), call('rank_state').catch((e) => (e.kind === 'user' ? null : Promise.reject(e))), callBlink('blink_get').catch(() => null), callGc('gc_list').catch(() => null), callOx('ox_get').catch(() => null), callWg('card2crypto_get').catch(() => null), callWg('paygate_get').catch(() => null)]); } catch (e) { return res.send(shellPage(req, 'Platobné metódy', `<h1>💳 Platobné metódy</h1>${offBox(e)}`)); }
    res.send(shellPage(req, 'Platobné metódy', `<h1>💳 Platobné metódy</h1>${msgOf(req)}<p class="hint">Spôsoby platby na checkoute <a href="${esc(ORIGIN ? ORIGIN + "/" : "/platby")}" target="_blank" rel="noopener noreferrer">${esc(ORIGIN ? ORIGIN.replace(/^https:\/\//, '') : 'lnkbio.onrender.com/platby')}</a>. Vypnuté metódy platobná stránka zákazníkom nezobrazí a ani ich nedovolí použiť.</p>
${rankCard(req, rs)}${blinkCard(bl, false)}${extrasCard(gc, ox, c2, pg)}<div class="card pmw" id="platobne-metody">${render(req, st, true)}</div>${customForm(req, st, {})}`));
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

  admin.get('/platobne-metody/blink', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let b;
    try { b = await callBlink('blink_get'); } catch (e) { return res.send(shellPage(req, 'Bitcoin Lightning (Blink)', `<h1>⚡ Bitcoin Lightning (Blink)</h1>${offBox(e)}`)); }
    res.send(shellPage(req, 'Bitcoin Lightning (Blink)', `<h1>⚡ Bitcoin Lightning (Blink)</h1>${msgOf(req)}${blinkForm(req, b)}`));
  }));
  admin.post('/platobne-metody/blink', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body || {};
    try {
      const out = await callBlink('blink_save', { username: String(b.username || '').slice(0, 60), lnAddress: String(b.lnAddress || '').slice(0, 250), apiKey: String(b.apiKey || '').slice(0, 220), clearKey: b.clearKey === '1' ? '1' : '' });
      await audit(req, 'paymethod_blink', `user=${out.username || '-'} wallet=${out.walletOk ? 'ok' : 'none'} key=${out.keySet ? 'set' : 'none'}`);
      res.redirect(303, BLINK + '?m=saved');
    } catch (e) { fail(req, res, e, BLINK); }
  }));

  // ---- 🎁 Darčekové karty · 🪙 OxaPay · 💳 Card2Crypto / PayGate.to (secrets write-only: never echoed, only „uložený“ + masked hint) ----
  const GC = BASE + '/darcekove-karty';
  const OX = BASE + '/oxapay';
  const WG = { card2crypto: BASE + '/card2crypto', paygate: BASE + '/paygate' };
  const callGc = (action, extra) => call(action, extra, 30000, '/api/admin-bridge/giftcards');
  const callOx = (action, extra) => call(action, extra, 30000, '/api/admin-bridge/oxapay');
  const callWg = (action, extra) => call(action, extra, 45000, '/api/admin-bridge/wallet-gw');
  const tagOn = (on, a = 'zapnuté', b = 'vypnuté') => `<span class="tag${on ? ' ok' : ''}">${on ? a : b}</span>`;
  function extrasCard(gc, ox, c2, pg) {
    const li = (href, title, st, note) => `<li class="pmr"><span class="pmn"><b>${title}</b> ${st}<small>${note}</small></span><span class="pma"><a class="btnl sm g2" href="${href}">⚙️ Nastaviť</a></span></li>`;
    return `<div class="card pmw" id="pm-extras"><h2>➕ Ďalšie platobné možnosti</h2><ul class="pml0">
${li(GC, '🎁 Darčekové karty', gc ? tagOn(true, gc.cards.filter((c) => c.enabled).length + '/' + gc.cards.length + ' zapnutých') : tagOn(false, '', 'nedostupné'), 'Amazon, Google Play, Apple, Steam, Xbox, PlayStation, … – pridať, odobrať, poradie.')}
${li(OX, '🪙 OxaPay (krypto faktúra)', ox ? (ox.configured ? tagOn(true, 'aktívne') : tagOn(false, '', ox.keySet ? 'vypnuté' : 'nenastavené')) : tagOn(false, '', 'nedostupné'), 'Merchant API kľúč, zapnutie, meny, test spojenia.')}
${li(WG.card2crypto, '💳 Karta / Apple Pay / Google Pay – Card2Crypto', c2 ? (c2.configured ? tagOn(true, 'aktívne') : tagOn(false, '', c2.addressSet ? 'vypnuté' : 'nenastavené')) : tagOn(false, '', 'nedostupné'), 'Výplata v USDC (Polygon) na vašu adresu.')}
${li(WG.paygate, '💳 Karta / Apple Pay / Google Pay – PayGate.to', pg ? (pg.configured ? tagOn(true, 'aktívne') : tagOn(false, '', pg.addressSet ? 'vypnuté' : 'nenastavené')) : tagOn(false, '', 'nedostupné'), 'Rovnaký systém priamo od PayGate.to (bez prirážky sprostredkovateľa).')}
</ul></div>`;
  }

  // 🎁 gift cards
  function gcPage(req, v, editId) {
    const tok = hid(req);
    const n = v.cards.length;
    const rows = v.cards.map((c, i) => `<li class="pmr${c.enabled ? '' : ' off'}"><span class="pml">${logoTag(c.logo)}</span><span class="pmn"><b>${esc(c.name)}</b> ${tagOn(c.enabled)}<small>${esc(String(c.url).replace(/^https:\/\//, '').slice(0, 70))}</small></span><span class="pma">
<form method="post" action="${GC}/posun" class="pmf">${tok}<input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="dir" value="up"><button class="sm g2"${i === 0 ? ' disabled' : ''} title="Vyššie">↑</button></form>
<form method="post" action="${GC}/posun" class="pmf">${tok}<input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="dir" value="down"><button class="sm g2"${i === n - 1 ? ' disabled' : ''} title="Nižšie">↓</button></form>
<form method="post" action="${GC}/prepnut" class="pmf">${tok}<input type="hidden" name="id" value="${esc(c.id)}"><button class="sm ${c.enabled ? 'd' : 'g'}">${c.enabled ? '⛔ Vypnúť' : '✅ Zapnúť'}</button></form>
<a class="btnl sm g2" href="${GC}?upravit=${encodeURIComponent(c.id)}#gcform">✏️ Upraviť</a>
<form method="post" action="${GC}/zmazat" class="pmf" data-confirm="Odstrániť kartu ${esc(c.name)}?">${tok}<input type="hidden" name="id" value="${esc(c.id)}"><button class="sm d">🗑️</button></form></span></li>`).join('');
    const e = (editId && v.cards.find((c) => c.id === editId)) || null;
    const cur = e ? e.logo : '';
    const lib = (v.logos || []).map((l) => `<label class="pmlib"><input type="radio" name="logo" value="${esc(l)}"${l === cur ? ' checked' : ''}>${logoTag(l)}<span>${esc(l.replace(/^\/logos\//, '').replace(/\.(svg|png|webp|jpg)$/, ''))}</span></label>`).join('');
    const form = `<form method="post" action="${GC}/ulozit" class="card pmw" id="gcform" autocomplete="off">${tok}${e ? `<input type="hidden" name="id" value="${esc(e.id)}">` : ''}
<h2>${e ? '✏️ Upraviť kartu „' + esc(e.name) + '“' : '➕ Pridať darčekovú kartu'}</h2>
<label for="gcn">Názov</label><input id="gcn" name="name" maxlength="60" required value="${esc(e ? e.name : '')}" placeholder="napr. Steam">
<label for="gcu">Odkaz na kúpu (https://)</label><input id="gcu" name="url" type="url" maxlength="500" required value="${esc(e ? e.url : '')}" placeholder="https://dundle.com/sk/steam/">
<label for="gct">Poznámka pre zákazníka (nepovinné)</label><input id="gct" name="note" maxlength="200" value="${esc(e ? e.note || '' : '')}">
<fieldset class="pmfs"><legend>Logo</legend><div class="pmlibs">${lib}</div><p class="hint">Vlastné logo nahrajte cez „Upraviť“ pri vlastnom spôsobe platby, alebo použite knižnicu.</p></fieldset>
<label class="ck"><input type="checkbox" name="enabled" value="1"${!e || e.enabled ? ' checked' : ''}> Zapnutá (zobraziť zákazníkom)</label>
<p class="row"><button>💾 ${e ? 'Uložiť zmeny' : 'Pridať kartu'}</button>${e ? `<a class="btnl g2" href="${GC}">Zrušiť</a>` : ''}</p></form>`;
    return `<h1>🎁 Darčekové karty</h1>${msgOf(req)}<p class="hint">Karty, ktoré si zákazník môže kúpiť (SK/CZ) a zaplatiť kódom. Poradie tu = poradie na platobnej stránke v skupine „Poukážky / darčekové karty“.</p>
<div class="card pmw"><h2>Zoznam (${n})</h2><ul class="pml0">${rows || '<li class="hint">Žiadne karty.</li>'}</ul>
<form method="post" action="${GC}/obnovit" class="pmf" data-confirm="Obnoviť predvolený zoznam kariet? Vaše zmeny sa stratia.">${tok}<button class="sm g2">♻️ Obnoviť predvolené</button></form></div>${form}`;
  }
  admin.get('/platobne-metody/darcekove-karty', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let v; try { v = await callGc('gc_list'); } catch (e) { return res.send(shellPage(req, 'Darčekové karty', `<h1>🎁 Darčekové karty</h1>${offBox(e)}`)); }
    res.send(shellPage(req, 'Darčekové karty', gcPage(req, v, String(req.query.upravit || '').slice(0, 60))));
  }));
  const gcPost = (sub, action, pick, m) => admin.post('/platobne-metody/darcekove-karty/' + sub, needAuth, csrf, wrap(async (req, res) => {
    const b = req.body || {};
    try { await callGc(action, pick(b)); await audit(req, 'giftcards_' + sub, String(b.id || b.name || '').slice(0, 60)); res.redirect(303, GC + '?m=' + m); } catch (e) { fail(req, res, e, GC); }
  }));
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  gcPost('ulozit', 'gc_save', (b) => ({ id: s(b.id, 60), name: s(b.name, 60), url: s(b.url, 500), logo: s(b.logo, 120), note: s(b.note, 200), enabled: b.enabled === '1' ? '1' : '' }), 'saved');
  gcPost('zmazat', 'gc_delete', (b) => ({ id: s(b.id, 60) }), 'ok');
  gcPost('posun', 'gc_move', (b) => ({ id: s(b.id, 60), dir: b.dir === 'up' ? 'up' : 'down' }), 'moved');
  gcPost('prepnut', 'gc_toggle', (b) => ({ id: s(b.id, 60) }), 'toggled');
  gcPost('obnovit', 'gc_reset', () => ({}), 'ok');

  // 🪙 OxaPay
  function oxForm(req, o) {
    const coins = (o.allCoins || []).map(([c, n]) => `<label class="pmcoin"><input type="checkbox" name="coins" value="${esc(c)}"${o.coins.includes(c) ? ' checked' : ''}><span><b>${esc(c)}</b> <small>${esc(n)}</small></span></label>`).join('');
    const t = o.lastTest;
    return `<form method="post" action="${OX}" class="card pmw" id="oxapay" autocomplete="off">${hid(req)}
<h2>🪙 OxaPay ${o.configured ? '<span class="tag ok">aktívne</span>' : `<span class="tag">${o.keySet ? 'vypnuté' : 'nenastavené'}</span>`}</h2>
<p class="hint">Zákazník dostane faktúru na presnú sumu v EUR (platí 30 minút), zaplatí kryptom na stránke OxaPay a objednávka sa po potvrdení (podpis HMAC) označí ako zaplatená + príde Telegram. Bez kľúča a zapnutia sa zákazníkom nezobrazí.</p>
${o.encAvailable ? '' : '<div class="msg err">⚠️ Chýba DATA_ENC_KEY – kľúč nie je možné bezpečne uložiť.</div>'}
<label for="oxk">OxaPay Merchant API kľúč <span class="tag${o.keySet ? ' ok' : ''}">${o.keySet ? 'uložený ' + esc(o.keyHint) : 'nenastavený'}</span></label><input id="oxk" name="apiKey" type="password" maxlength="80" value="" autocomplete="new-password" spellcheck="false" placeholder="${o.keySet ? 'nechajte prázdne = ponechať uložený kľúč' : 'vložte Merchant API key'}">
<p class="hint">OxaPay → <b>Merchant Service</b> → <b>Generate API Key</b> (Merchant API key, nie Payout ani General). Uloží sa šifrovane, nikdy sa nezobrazí.</p>
${o.keySet ? '<label class="ck"><input type="checkbox" name="clearKey" value="1"> Odstrániť uložený kľúč</label>' : ''}
<fieldset class="pmfs"><legend>Prijímané kryptomeny (zobrazené zákazníkovi)</legend><div class="pmcoing">${coins}</div><p class="hint">Samotný zoznam mien na platobnej stránke určuje nastavenie API kľúča v OxaPay (Merchant Service → Edit → Accepted currencies). Tu zvolené meny sa zobrazia v popise metódy.</p></fieldset>
<label class="ck"><input type="checkbox" name="enabled" value="1"${o.enabled ? ' checked' : ''}> Zapnúť OxaPay pre zákazníkov</label>
<label class="ck"><input type="checkbox" name="sandbox" value="1"${o.sandbox ? ' checked' : ''}> Testovací režim (sandbox – bez skutočných platieb)</label>
${t ? `<div class="msg${t.ok ? '' : ' err'}">${t.ok ? '✅' : '⚠️'} ${esc(t.msg)} <small>(${esc(String(t.at || '').replace('T', ' ').slice(0, 16))} UTC)</small></div>` : ''}
<p class="row"><button>💾 Uložiť OxaPay</button><button formaction="${OX}/test" class="g2">🔌 Otestovať kľúč</button><a class="btnl g2" href="${BASE}">Späť</a></p></form>`;
  }
  admin.get('/platobne-metody/oxapay', needAuth, wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let o; try { o = await callOx('ox_get'); } catch (e) { return res.send(shellPage(req, 'OxaPay', `<h1>🪙 OxaPay</h1>${offBox(e)}`)); }
    res.send(shellPage(req, 'OxaPay', `<h1>🪙 OxaPay</h1>${msgOf(req)}${oxForm(req, o)}`));
  }));
  admin.post('/platobne-metody/oxapay', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body || {};
    try {
      const coins = (Array.isArray(b.coins) ? b.coins : b.coins ? [b.coins] : []).map((c) => s(c, 8)).join(',');
      const out = await callOx('ox_save', { apiKey: s(b.apiKey, 100), clearKey: b.clearKey === '1' ? '1' : '', coins, enabled: b.enabled === '1' ? '1' : '', sandbox: b.sandbox === '1' ? '1' : '' });
      await audit(req, 'paymethod_oxapay', `key=${out.keySet ? 'set' : 'none'} enabled=${out.enabled} sandbox=${out.sandbox}`);
      res.redirect(303, OX + '?m=saved');
    } catch (e) { fail(req, res, e, OX); }
  }));
  admin.post('/platobne-metody/oxapay/test', needAuth, csrf, wrap(async (req, res) => {
    try { const out = await callOx('ox_test'); await audit(req, 'paymethod_oxapay_test', out.lastTest && out.lastTest.ok ? 'ok' : 'fail'); res.redirect(303, OX); } catch (e) { fail(req, res, e, OX); }
  }));

  // 💳 Card2Crypto / PayGate.to
  function wgForm(req, b, w) {
    const url = WG[b];
    const provs = (w.providers || []).map((p) => `<option value="${esc(p.id)}"${p.id === w.provider ? ' selected' : ''}>${esc(p.name)} – min. ${esc(p.min)} ${esc(p.minCur)}</option>`).join('');
    return `<form method="post" action="${url}" class="card pmw" id="wg-${esc(b)}" autocomplete="off">${hid(req)}
<h2>💳 ${esc(w.name)} ${w.configured ? '<span class="tag ok">aktívne</span>' : `<span class="tag">${w.addressSet ? 'vypnuté' : 'nenastavené'}</span>`}</h2>
<p class="hint">Zákazník zaplatí kartou / Apple Pay / Google Pay u platobného partnera, peniaze prídu ako USDC na sieti Polygon priamo na vašu adresu (žiadny účet, nič sa nedrží u brány). Zákazník vidí iba „${esc(w.label || w.defaultLabel)}“ – bez poplatkov. Bez adresy, poskytovateľa a zapnutia sa nezobrazí.</p>
${w.encAvailable ? '' : '<div class="msg err">⚠️ Chýba DATA_ENC_KEY – adresu nie je možné bezpečne uložiť.</div>'}
<label for="wga">USDC (Polygon) adresa na výplatu <span class="tag${w.addressSet ? ' ok' : ''}">${w.addressSet ? 'uložená ' + esc(w.addressMasked) : 'nenastavená'}</span></label><input id="wga" name="address" maxlength="42" pattern="0x[0-9a-fA-F]{40}" value="" spellcheck="false" autocapitalize="off" placeholder="${w.addressSet ? 'nechajte prázdne = ponechať uloženú adresu' : '0x… (vaša peňaženka, ktorá podporuje Polygon)'}">
<p class="hint">Adresa vašej vlastnej EVM peňaženky (MetaMask, Trust Wallet, Ledger…) – rovnaká 0x adresa ako na Ethereum, peňaženka musí zobrazovať sieť Polygon. Nie adresa burzy bez podpory Polygon USDC. Uloží sa šifrovane.</p>
${w.addressSet ? '<label class="ck"><input type="checkbox" name="clearAddress" value="1"> Odstrániť uloženú adresu</label>' : ''}
<label for="wgp">Poskytovateľ platby kartou</label><select id="wgp" name="provider"><option value="">– vyberte –</option>${provs}</select>
<p class="hint">${w.providersAt ? 'Zoznam fungujúcich poskytovateľov načítaný ' + esc(String(w.providersAt).replace('T', ' ').slice(0, 16)) + ' UTC.' : 'Najprv načítajte zoznam fungujúcich poskytovateľov.'} Odporúčané pre SK/CZ: Stripe, Revolut alebo Google Pay / Apple Pay.</p>
<label for="wgl">Názov pre zákazníka</label><input id="wgl" name="label" maxlength="60" value="${esc(w.label)}" placeholder="${esc(w.defaultLabel)}">
<label for="wgt">Tolerancia sumy (%)</label><input id="wgt" name="tolerance" type="number" min="0" max="50" step="1" value="${esc(w.tolerance)}">
<p class="hint">Platba sa označí ako zaplatená, ak prijaté USDC ≥ očakávané − tolerancia (poplatky poskytovateľa). Inak príde Telegram „overiť“.</p>
<label class="ck"><input type="checkbox" name="enabled" value="1"${w.enabled ? ' checked' : ''}> Zapnúť pre zákazníkov</label>
<p class="row"><button>💾 Uložiť</button><button formaction="${url}/poskytovatelia" class="g2" formnovalidate>🔄 Načítať poskytovateľov</button><a class="btnl g2" href="${BASE}">Späť</a></p></form>`;
  }
  for (const b of Object.keys(WG)) {
    const title = b === 'card2crypto' ? 'Card2Crypto' : 'PayGate.to';
    admin.get('/platobne-metody/' + b, needAuth, wrap(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      let w; try { w = await callWg(b + '_get'); } catch (e) { return res.send(shellPage(req, title, `<h1>💳 ${title}</h1>${offBox(e)}`)); }
      res.send(shellPage(req, title, `<h1>💳 Karta / Apple Pay / Google Pay – ${title}</h1>${msgOf(req)}${wgForm(req, b, w)}`));
    }));
    admin.post('/platobne-metody/' + b, needAuth, csrf, wrap(async (req, res) => {
      const x = req.body || {};
      try {
        const out = await callWg(b + '_save', { address: s(x.address, 60).trim(), clearAddress: x.clearAddress === '1' ? '1' : '', provider: s(x.provider, 40), label: s(x.label, 60), tolerance: s(x.tolerance, 4), enabled: x.enabled === '1' ? '1' : '' });
        await audit(req, 'paymethod_' + b, `addr=${out.addressSet ? 'set' : 'none'} enabled=${out.enabled} provider=${out.provider || '-'}`);
        res.redirect(303, WG[b] + '?m=saved');
      } catch (e) { fail(req, res, e, WG[b]); }
    }));
    admin.post('/platobne-metody/' + b + '/poskytovatelia', needAuth, csrf, wrap(async (req, res) => {
      try { await callWg(b + '_providers'); res.redirect(303, WG[b] + '?m=ok'); } catch (e) { fail(req, res, e, WG[b]); }
    }));
  }

  // logo proxy (onrender.com is a public suffix → checkout logos are cross-site; serve them same-origin, sandboxed)
  const LC = new Map();
  admin.get('/platobne-metody/logo', needAuth, wrap(async (req, res) => {
    const p = String(req.query.p || '');
    if (!logoSrc(p)) return res.status(404).end();
    let hit = LC.get(p);
    if (!hit || Date.now() - hit.t > 3600e3) {
      try {
        const r = await fetch((ORIGIN || 'http://127.0.0.1:' + (process.env.PORT || 3000)) + p, { signal: AbortSignal.timeout(20000), redirect: 'error' });
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
    if (wantsJson(req)) return res.status(e.kind === 'user' ? 400 : 502).json({ ok: false, error: e.kind === 'off' ? 'Platobný modul nie je zapnutý (PAY_MODULE=on).' : e.message });
    res.redirect(303, (to || BASE) + (/\?/.test(to || BASE) ? '&' : '?') + 'e=' + encodeURIComponent(e.kind === 'off' ? 'Platobný modul nie je zapnutý (PAY_MODULE=on).' : e.message));
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

  const FIELDS = ['name', 'group', 'url', 'description', 'minEur', 'mode', 'proofForm', 'enabled', 'hideLogo', 'logoUrl', 'lib', 'removeLogo', 'coins', 'coinsSent', 'coinsCustom'];
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024, files: 1, fields: 80, fieldSize: 2000 } }).single('logo');
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
