'use strict';
/**
 * Per-amount payment links (Ryan): for link-based methods (Revolut, Skrill, custom links, …) Ryan stores
 * EUR amount → https payment link pairs. When a customer's order amount matches an ENABLED pair exactly,
 * the checkout creates an order and shows only a „Zaplatiť“ button (/link-pay); the URL is never printed —
 * the button hits /link-pay/go/:orderId which 302-redirects. No match → the method's normal flow/guide (unchanged).
 * Storage: Neon pay_amount_links (+ audit rows in pay_amount_links_audit); file fallback data/amount-links.json.
 * Managed in /admin/platby/amount-links and over the signed bridge /api/admin-bridge/amount-links (lnkbio admin).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const orderDb = require('./db');
const { layout, escapeHtml: e } = require('./adminSepa');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'amount-links.json');
const BRIDGE_PATH = '/api/admin-bridge/amount-links';
const S = { rows: new Map(), audit: [], loaded: false };
let log = () => {};
let methodsFn = () => [];
let ready = null;
const pool = () => orderDb.pool();

async function tables() {
  const p = pool(); if (!p) return null;
  if (!ready) {
    ready = p.query(`CREATE TABLE IF NOT EXISTS pay_amount_links (
        id text PRIMARY KEY, method text NOT NULL, amount_cents integer NOT NULL, url text NOT NULL, label text NOT NULL DEFAULT '',
        enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        created_by text, updated_by text)`)
      .then(() => p.query(`CREATE UNIQUE INDEX IF NOT EXISTS pay_amount_links_uniq ON pay_amount_links (method, amount_cents)`))
      .then(() => p.query(`CREATE TABLE IF NOT EXISTS pay_amount_links_audit (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
        actor text NOT NULL, action text NOT NULL, link_id text, method text, amount_cents integer, detail jsonb)`))
      .catch((x) => { ready = null; throw x; });
  }
  await ready; return p;
}
const pub = (r) => r && ({ id: r.id, method: r.method, amountCents: Number(r.amountCents), url: r.url, label: r.label || '', enabled: r.enabled !== false,
  createdAt: r.createdAt || null, updatedAt: r.updatedAt || null, createdBy: r.createdBy || null, updatedBy: r.updatedBy || null });
const fromRow = (x) => pub({ id: x.id, method: x.method, amountCents: x.amount_cents, url: x.url, label: x.label, enabled: x.enabled,
  createdAt: x.created_at && new Date(x.created_at).toISOString(), updatedAt: x.updated_at && new Date(x.updated_at).toISOString(), createdBy: x.created_by, updatedBy: x.updated_by });
function persistLocal() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ rows: [...S.rows.values()], audit: S.audit.slice(0, 300) }, null, 1)); } catch { /* ro */ } }

async function init(appendLog, opts = {}) {
  if (appendLog) log = appendLog;
  if (opts.methods) methodsFn = opts.methods;
  const p = await tables().catch((x) => { log('AMOUNT_LINKS_DB_FAIL ' + x.message); return null; });
  if (p) {
    const { rows } = await p.query('SELECT * FROM pay_amount_links');
    S.rows.clear(); rows.forEach((x) => S.rows.set(x.id, fromRow(x)));
    const au = await p.query('SELECT * FROM pay_amount_links_audit ORDER BY id DESC LIMIT 100');
    S.audit = au.rows.map((x) => ({ at: new Date(x.at).toISOString(), actor: x.actor, action: x.action, linkId: x.link_id, method: x.method, amountCents: x.amount_cents, detail: x.detail }));
  } else {
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); (j.rows || []).forEach((r) => S.rows.set(r.id, pub(r))); S.audit = j.audit || []; } catch { /* none */ }
  }
  S.loaded = true;
  log(`AMOUNT_LINKS_READY ${S.rows.size}`);
}

/* ---------- helpers ---------- */
const fmt = (c) => (Number(c) / 100).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const toCents = (eur) => Math.round(Number(eur) * 100);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
function methods() {
  let list = []; try { list = methodsFn() || []; } catch { list = []; }
  const seen = new Set(); const out = [];
  for (const m of list) { const id = String(m.id || '').toLowerCase(); if (id && !seen.has(id)) { seen.add(id); out.push({ id, label: String(m.label || id), linkBased: !!m.linkBased }); } }
  for (const r of S.rows.values()) if (!seen.has(r.method)) { seen.add(r.method); out.push({ id: r.method, label: r.method + ' (už nie je v checkoute)', linkBased: false }); }
  return out.sort((a, b) => (b.linkBased - a.linkBased) || a.label.localeCompare(b.label, 'sk'));
}
const methodLabel = (id) => (methods().find((m) => m.id === id) || { label: id }).label;
function list(method) {
  return [...S.rows.values()].filter((r) => !method || r.method === method)
    .sort((a, b) => a.method.localeCompare(b.method) || a.amountCents - b.amountCents);
}
/** Exact enabled match for a checkout (method = provider select id, amount in EUR). */
function match(method, amountEur) {
  if (!S.loaded) return null;
  const m = String(method || '').toLowerCase(); const c = toCents(amountEur);
  if (!m || !(c > 0)) return null;
  return list(m).find((r) => r.enabled && r.amountCents === c) || null;
}
/** Public, URL-free hint for the checkout UI: method id → enabled amounts (EUR). */
function amountsByMethod() {
  const out = {}; if (!S.loaded) return out;
  for (const r of S.rows.values()) if (r.enabled) (out[r.method] = out[r.method] || []).push(r.amountCents / 100);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b);
  return out;
}

function parseFields(f, prev) {
  const method = String(f.method || (prev && prev.method) || '').trim().toLowerCase();
  if (!/^[a-z0-9_:-]{2,64}$/.test(method) || !methods().some((m) => m.id === method)) throw new Error('Vyberte spôsob platby.');
  const amt = String(f.amount == null ? '' : f.amount).trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(amt)) throw new Error('Suma musí byť číslo v EUR, najviac 2 desatinné miesta (napr. 25 alebo 19,99).');
  const amountCents = toCents(amt);
  if (amountCents < 1 || amountCents > 100000000) throw new Error('Suma musí byť od 0,01 do 1 000 000 €.');
  const url = String(f.url || '').trim();
  let u; try { u = new URL(url); } catch { throw new Error('Odkaz nie je platná adresa URL.'); }
  if (u.protocol !== 'https:') throw new Error('Povolené sú len odkazy začínajúce https://');
  if (u.username || u.password) throw new Error('Odkaz nesmie obsahovať meno ani heslo.');
  if (!u.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw new Error('Odkaz musí smerovať na verejnú doménu.');
  if (url.length > 2000) throw new Error('Odkaz je príliš dlhý (max. 2000 znakov).');
  const label = String(f.label || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  const enabled = f.enabled === true || f.enabled === '1' || f.enabled === 'on' || f.enabled === 'true';
  const dup = list(method).find((r) => r.amountCents === amountCents && (!prev || r.id !== prev.id));
  if (dup) throw new Error(`Pre ${methodLabel(method)} už existuje odkaz na sumu ${fmt(amountCents)} – upravte ho namiesto pridania nového.`);
  return { method, amountCents, url: u.toString(), label, enabled };
}
function notify(text) {
  try { const bot = global.__telegramBot; const chat = bot && bot.loadAdminChatId && bot.loadAdminChatId();
    if (bot && chat && bot.tokenConfigured && bot.tokenConfigured()) bot.sendMessage(chat, text).catch((x) => log('AMOUNT_LINKS_TG_FAIL ' + x.message)); } catch { /* best effort */ }
}
async function audit(actor, action, rec, detail) {
  const a = { at: new Date().toISOString(), actor, action, linkId: rec.id, method: rec.method, amountCents: rec.amountCents, detail: detail || null };
  S.audit.unshift(a); if (S.audit.length > 300) S.audit.length = 300;
  const p = await tables().catch(() => null);
  if (p) await p.query(`INSERT INTO pay_amount_links_audit (actor, action, link_id, method, amount_cents, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [actor, action, rec.id, rec.method, rec.amountCents, detail ? JSON.stringify(detail) : null]).catch((x) => log('AMOUNT_LINKS_AUDIT_FAIL ' + x.message));
  persistLocal();
}
async function dbOrFail() {
  const p = await tables().catch((x) => { log('AMOUNT_LINKS_DB_FAIL ' + x.message); return null; });
  if (pool() && !p) throw new Error('Databáza je dočasne nedostupná – zmena sa neuložila.');
  return p;
}
async function upsert(rec, actor, action, old) {
  const p = await dbOrFail();
  if (p) await p.query(`INSERT INTO pay_amount_links (id, method, amount_cents, url, label, enabled, created_at, updated_at, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET method=EXCLUDED.method, amount_cents=EXCLUDED.amount_cents, url=EXCLUDED.url,
    label=EXCLUDED.label, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
  [rec.id, rec.method, rec.amountCents, rec.url, rec.label, rec.enabled, rec.createdAt, rec.updatedAt, rec.createdBy, rec.updatedBy]);
  S.rows.set(rec.id, pub(rec)); persistLocal();
  const d = { host: hostOf(rec.url), enabled: rec.enabled };
  if (old) Object.assign(d, { oldAmountCents: old.amountCents, oldHost: hostOf(old.url), oldEnabled: old.enabled, urlChanged: old.url !== rec.url });
  await audit(actor, action, rec, d);
  log(`AMOUNT_LINK_${action.toUpperCase()} ${rec.id} ${rec.method} ${rec.amountCents} host=${hostOf(rec.url)} enabled=${rec.enabled} by=${actor}`);
  const verb = action === 'create' ? 'pridaný' : action === 'toggle' ? (rec.enabled ? 'zapnutý' : 'vypnutý') : 'upravený';
  notify(`🔗 Odkaz podľa sumy ${verb}\nSpôsob: ${methodLabel(rec.method)}\nSuma: ${old && old.amountCents !== rec.amountCents ? fmt(old.amountCents) + ' → ' : ''}${fmt(rec.amountCents)}\nDoména: ${hostOf(rec.url)}${old && old.url !== rec.url ? ' (odkaz zmenený)' : ''}\nKto: ${actor}`);
  return pub(rec);
}
async function create(fields, actor) {
  const f = parseFields(fields, null); const now = new Date().toISOString();
  return upsert({ id: 'al_' + crypto.randomBytes(6).toString('hex'), ...f, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor }, actor, 'create', null);
}
async function update(id, fields, actor) {
  const prev = S.rows.get(id); if (!prev) throw new Error('Odkaz sa nenašiel.');
  return upsert({ ...prev, ...parseFields(fields, prev), updatedAt: new Date().toISOString(), updatedBy: actor }, actor, 'update', prev);
}
async function setEnabled(id, enabled, actor) {
  const prev = S.rows.get(id); if (!prev) throw new Error('Odkaz sa nenašiel.');
  if (prev.enabled === enabled) return prev;
  return upsert({ ...prev, enabled, updatedAt: new Date().toISOString(), updatedBy: actor }, actor, 'toggle', prev);
}
async function remove(id, actor) {
  const prev = S.rows.get(id); if (!prev) throw new Error('Odkaz sa nenašiel.');
  const p = await dbOrFail();
  if (p) await p.query('DELETE FROM pay_amount_links WHERE id=$1', [id]);
  S.rows.delete(id); persistLocal();
  await audit(actor, 'delete', prev, { host: hostOf(prev.url) });
  log(`AMOUNT_LINK_DELETE ${id} ${prev.method} ${prev.amountCents} by=${actor}`);
  notify(`🗑️ Odkaz podľa sumy zmazaný\nSpôsob: ${methodLabel(prev.method)}\nSuma: ${fmt(prev.amountCents)}\nKto: ${actor}`);
  return { ok: true };
}
function state() {
  return { ok: true, methods: methods(), rows: list(), audit: S.audit.slice(0, 50) };
}

/* ---------- checkout: order + „Zaplatiť“ page ---------- */
async function createOrder({ link, orderId, amountEur, countryCode, providerAlias, provider, loadOrders, saveOrders, appendLog }) {
  const order = {
    orderId, amountEur, amount: amountEur, currency: 'EUR', country: countryCode, provider: 'amount_link', providerAlias, gateway: 'amount_link',
    originalProvider: provider, paymentMethod: providerAlias, resolution: 'amount_link', amountLinkId: link.id, amountLinkUrl: link.url,
    status: 'awaiting_payment', createdAt: new Date().toISOString(),
  };
  order.checkoutUrl = order.localPayUrl = `/link-pay?orderId=${encodeURIComponent(orderId)}`;
  const orders = loadOrders(); orders[orderId] = order; saveOrders(orders);
  appendLog(`ORDER_CREATED ${orderId} eur=${amountEur} provider=amount_link method=${providerAlias} link=${link.id}`);
  notify(`🧾 Nová objednávka – odkaz podľa sumy\nObjednávka: ${orderId}\nSpôsob: ${methodLabel(providerAlias)}\nSuma: ${fmt(link.amountCents)}`);
  return order;
}
const ID_RE = /^ord_[a-f0-9]{16}$/;
function mount(app, { loadOrders, saveOrders, appendLog }) {
  if (appendLog) log = appendLog;
  const find = (id) => { const o = ID_RE.test(String(id || '')) ? loadOrders()[id] : null; return o && o.provider === 'amount_link' ? o : null; };
  app.get('/link-pay', (req, res) => {
    const o = find(req.query.orderId);
    if (!o) return res.status(404).type('html').send('<p>Objednávka sa nenašla. <a href="/platby">Späť</a></p>');
    res.set('Cache-Control', 'no-store');
    const amt = Number(o.amountEur).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    res.type('html').send(`<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Zaplatiť</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;color:#111}
.box{border:1px solid #ddd;border-radius:12px;padding:20px;margin:12px 0;text-align:center}.amt{font-size:2rem;font-weight:800;margin:.3rem 0 1rem}
.btn{background:#0666eb;color:#fff;border:0;border-radius:12px;padding:18px;font-size:19px;font-weight:700;cursor:pointer;text-decoration:none;display:block;width:100%}
small{color:#666}</style><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body>
<div class="box"><div>Suma na zaplatenie</div><div class="amt">${e(amt)} €</div>
<form method="post" action="/link-pay/go/${e(o.orderId)}" target="_blank" rel="noopener"><button class="btn" type="submit">Zaplatiť</button></form></div>
<p><small>Objednávka ${e(o.orderId)}</small></p><script src="/chat-widget.js" defer></script></body></html>`);
  });
  const go = (req, res) => {
    const o = find(req.params.id);
    if (!o || !/^https:\/\//.test(String(o.amountLinkUrl || ''))) return res.status(404).send('Objednávka sa nenašla');
    res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer');
    if (!o.linkOpenedAt) { const orders = loadOrders(); if (orders[o.orderId]) { orders[o.orderId].linkOpenedAt = new Date().toISOString(); saveOrders(orders); } log(`AMOUNT_LINK_OPENED ${o.orderId}`); }
    res.redirect(303, o.amountLinkUrl);
  };
  app.post('/link-pay/go/:id', go);
  app.get('/link-pay/go/:id', go);
}

/* ---------- admin UI ---------- */
function mountAdmin(app) {
  const { sameOrigin, nostore } = require('./payMethods');
  const css = `<style>
.al-m{margin:0 0 .6rem;border:1px solid var(--line);border-radius:12px;padding:.2rem .8rem}.al-m>summary{cursor:pointer;padding:.55rem 0;font-weight:600;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.pill{font-size:.75rem;border-radius:99px;padding:.1rem .5rem;background:#1e293b;color:var(--muted)}.pill.on{background:#14532d;color:#bbf7d0}.pill.off{background:#3f1d1d;color:#fecaca}
table.al tr.off td{opacity:.55}.al-actions{display:flex;gap:.35rem;flex-wrap:wrap}.al-actions form{margin:0}.al-actions button,.al-actions .btn{padding:.4rem .65rem;font-size:.85rem}
.url{font-family:ui-monospace,monospace;word-break:break-all;font-size:.82rem;color:var(--muted)}.amt{font-weight:700;white-space:nowrap}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.chk{display:flex;align-items:center;gap:.5rem}.chk input{width:auto}.hint{color:var(--muted);font-size:.85rem}
@media(max-width:640px){table.al thead{display:none}table.al tr{display:block;border-bottom:1px solid var(--line);padding:.5rem 0}table.al td{display:block;border:0;padding:.2rem 0}.grid2{grid-template-columns:1fr}}
</style>`;
  const page = (req, title, body, msg = '', err = '') => layout({ title, userEmail: req.adminSession && req.adminSession.email,
    body: `${css}${msg ? `<div class="ok">${e(msg)}</div>` : ''}${err ? `<div class="err">${e(err)}</div>` : ''}${body}` });
  const MSG = { added: 'Odkaz pridaný.', saved: 'Odkaz uložený.', toggled: 'Stav odkazu zmenený.', deleted: 'Odkaz zmazaný.' };
  const actorOf = (req) => (req.adminSession && req.adminSession.email) || 'admin';
  const guard = (req, res) => { if (!sameOrigin(req)) { res.status(403).send('Zakázané'); return false; } return true; };
  const form = (r, err) => {
    const isNew = !r.id; const ms = methods();
    const opts = (sel) => `<optgroup label="Platby cez odkaz">${ms.filter((m) => m.linkBased).map((m) => `<option value="${e(m.id)}"${m.id === sel ? ' selected' : ''}>${e(m.label)}</option>`).join('')}</optgroup><optgroup label="Ostatné spôsoby">${ms.filter((m) => !m.linkBased).map((m) => `<option value="${e(m.id)}"${m.id === sel ? ' selected' : ''}>${e(m.label)}</option>`).join('')}</optgroup>`;
    const amount = r.amount != null ? r.amount : r.amountCents != null ? String(r.amountCents / 100).replace('.', ',') : '';
    return `<form method="post" action="/admin/platby/amount-links/save" class="card" id="${isNew ? 'pridat' : 'upravit'}"><h2>${isNew ? '➕ Pridať odkaz' : '✏️ Upraviť odkaz'}</h2>
${err ? `<div class="err">${e(err)}</div>` : ''}<input type="hidden" name="id" value="${e(r.id || '')}">
<div class="grid2"><div><label>Spôsob platby *</label><select name="method" required>${opts(r.method || (ms.find((m) => m.id === 'revolut_manual') || ms.find((m) => m.linkBased) || {}).id)}</select></div>
<div><label>Suma (EUR) *</label><input type="text" name="amount" inputmode="decimal" required maxlength="12" value="${e(amount)}" placeholder="napr. 25 alebo 19,99"></div></div>
<label>Platobný odkaz (https) *</label><input type="url" name="url" required maxlength="2000" autocomplete="off" spellcheck="false" value="${e(r.url || '')}" placeholder="https://…">
<p class="hint">Zákazník odkaz neuvidí – zobrazí sa mu len tlačidlo „Zaplatiť“, keď sa suma objednávky presne zhoduje.</p>
<div class="grid2"><div><label>Poznámka (pre vás, voliteľné)</label><input type="text" name="label" maxlength="60" value="${e(r.label || '')}"></div>
<div><label class="chk" style="margin-top:1.6rem"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnutý</label></div></div>
<p><button>💾 Uložiť</button> ${isNew ? '' : '<a class="btn" style="background:#334155" href="/admin/platby/amount-links">Späť</a>'}</p></form>`;
  };
  const listPage = (req, msg = '', err = '') => {
    const byM = new Map(); for (const r of list()) { if (!byM.has(r.method)) byM.set(r.method, []); byM.get(r.method).push(r); }
    const blocks = [...byM.entries()].map(([m, rows]) => {
      const on = rows.filter((r) => r.enabled).length;
      return `<details class="al-m" open><summary>${e(methodLabel(m))} <span class="pill on">${on} zap.</span>${rows.length - on ? `<span class="pill off">${rows.length - on} vyp.</span>` : ''}</summary>
<table class="al"><thead><tr><th>Suma</th><th>Odkaz</th><th>Stav</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.enabled ? '' : 'off'}"><td class="amt">${e(fmt(r.amountCents))}${r.label ? `<br><span class="hint">${e(r.label)}</span>` : ''}</td>
<td><span class="url">${e(r.url)}</span></td><td><span class="pill ${r.enabled ? 'on' : 'off'}">${r.enabled ? 'zapnutý' : 'vypnutý'}</span></td>
<td><div class="al-actions"><a class="btn" href="/admin/platby/amount-links/edit/${e(r.id)}">Upraviť</a>
<form method="post" action="/admin/platby/amount-links/toggle/${e(r.id)}"><input type="hidden" name="state" value="${r.enabled ? 'off' : 'on'}"><button class="${r.enabled ? 'secondary' : ''}">${r.enabled ? 'Vypnúť' : 'Zapnúť'}</button></form>
<form method="post" action="/admin/platby/amount-links/delete/${e(r.id)}" data-confirm="Naozaj zmazať odkaz na ${e(fmt(r.amountCents))}?"><button class="danger" style="background:#7f1d1d">Zmazať</button></form></div></td></tr>`).join('')}</tbody></table></details>`;
    }).join('');
    const audit = S.audit.slice(0, 15).map((a) => `<tr><td>${e(new Date(a.at).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }))}</td><td>${e(a.actor)}</td><td>${e(a.action)}</td><td>${e(methodLabel(a.method))} · ${e(a.detail && a.detail.oldAmountCents != null && a.detail.oldAmountCents !== a.amountCents ? fmt(a.detail.oldAmountCents) + ' → ' : '')}${e(fmt(a.amountCents))}${a.detail && a.detail.urlChanged ? ' · odkaz zmenený' : ''}</td></tr>`).join('');
    return page(req, 'Odkazy podľa sumy', `<div class="card"><h1>🔗 Platobné odkazy podľa sumy</h1>
<p class="hint">Pre Revolut, Skrill a iné platby cez odkaz: zadajte sumu v EUR a platobný odkaz. Keď zákazník zadá presne túto sumu, na checkoute uvidí len tlačidlo „Zaplatiť“ (odkaz sa nezobrazuje). Pri inej sume ostáva pôvodný postup a návody bez zmeny.</p>
<p><a class="btn" href="#pridat">➕ Pridať odkaz</a></p></div>
${blocks || '<div class="card"><p class="hint">Zatiaľ žiadne odkazy.</p></div>'}${form({})}
<div class="card"><h2>🧾 História zmien</h2><table class="al"><thead><tr><th>Kedy</th><th>Kto</th><th>Akcia</th><th>Zmena</th></tr></thead><tbody>${audit || '<tr><td colspan="4" class="hint">Zatiaľ žiadne zmeny.</td></tr>'}</tbody></table></div>
<script>document.addEventListener('submit',function(ev){var f=ev.target;if(f&&f.getAttribute('data-confirm')&&!window.confirm(f.getAttribute('data-confirm')))ev.preventDefault()});</script>`, msg, err);
  };
  app.get('/admin/platby/amount-links', (req, res) => { nostore(res); res.type('html').send(listPage(req, MSG[req.query.m] || '')); });
  app.get('/admin/platby/amount-links/edit/:id', (req, res) => {
    nostore(res); const r = S.rows.get(String(req.params.id));
    if (!r) return res.status(404).type('html').send(listPage(req, '', 'Odkaz sa nenašiel.'));
    res.type('html').send(page(req, 'Upraviť odkaz', form(r)));
  });
  app.post('/admin/platby/amount-links/save', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const b = req.body || {};
    try { if (b.id) await update(String(b.id), b, actorOf(req)); else await create(b, actorOf(req)); res.redirect(303, '/admin/platby/amount-links?m=' + (b.id ? 'saved' : 'added')); }
    catch (x) { const prev = b.id ? S.rows.get(String(b.id)) : null; res.status(400).type('html').send(page(req, prev ? 'Upraviť odkaz' : 'Pridať odkaz', form({ ...(prev || {}), method: b.method, amount: b.amount, url: b.url, label: b.label, enabled: b.enabled === '1' }, x.message))); }
  });
  app.post('/admin/platby/amount-links/toggle/:id', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    try { await setEnabled(String(req.params.id), req.body && req.body.state === 'on', actorOf(req)); res.redirect(303, '/admin/platby/amount-links?m=toggled'); }
    catch (x) { res.status(400).type('html').send(listPage(req, '', x.message)); }
  });
  app.post('/admin/platby/amount-links/delete/:id', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    try { await remove(String(req.params.id), actorOf(req)); res.redirect(303, '/admin/platby/amount-links?m=deleted'); }
    catch (x) { res.status(400).type('html').send(listPage(req, '', x.message)); }
  });
  require('./adminSepa').addDashboardPanel(() => {
    const on = list().filter((r) => r.enabled).length;
    return `<div class="card"><h2>🔗 Odkazy podľa sumy</h2><p class="muted">${on} zapnutých odkazov (Revolut, Skrill, …).</p><a class="btn" href="/admin/platby/amount-links">Spravovať odkazy</a></div>`;
  });
  const bridgeActor = (b) => 'lnkbio-admin' + (b.actor ? ':' + String(b.actor).replace(/[^\w.@+-]/g, '').slice(0, 40) : '');
  require('./payMethods').serveSigned(app, BRIDGE_PATH, {
    state: async () => state(),
    get: async (b) => { const r = S.rows.get(String(b.id || '')); return r ? { ok: true, row: r, methods: methods() } : { ok: false, status: 404, error: 'Odkaz sa nenašiel.' }; },
    create: async (b) => ({ ok: true, row: await create(b.fields || {}, bridgeActor(b)) }),
    update: async (b) => ({ ok: true, row: await update(String(b.id || ''), b.fields || {}, bridgeActor(b)) }),
    toggle: async (b) => ({ ok: true, row: await setEnabled(String(b.id || ''), b.state === 'on', bridgeActor(b)) }),
    delete: async (b) => remove(String(b.id || ''), bridgeActor(b)),
  }, 'AMOUNT_LINKS');
}

module.exports = { BRIDGE_PATH, init, mount, mountAdmin, match, amountsByMethod, list, create, update, setEnabled, remove, state, methods, createOrder, _parse: parseFields };
