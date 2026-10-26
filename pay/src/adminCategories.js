'use strict';
/**
 * Admin „Kategórie“ (Ryan): the admin organised by payment-method category. Each category page gathers what is already
 * configured elsewhere — methods (on/off, order, settings → /admin/platby/methods), per-amount checkout links (/admin/platby/amount-links
 * store, same rows, no copy), guides (/admin/platby/guides) and category tools (SEPA orders, Azteco, wallets) — plus Ryan's own
 * links (label + URL + optional amount).
 *  - „Len pre mňa“ links live in Neon pay_admin_links (file fallback data/admin-links.json) and are never shown to customers.
 *  - „Zobraziť zákazníkom“ links ARE amount links (pay_amount_links) → checkout shows only „Zaplatiť“ for that exact amount,
 *    URL stays server-side (identical to /admin/platby/amount-links). Nothing else changes for customers.
 * /admin/platby/sumy = everything grouped by amount (plan packages, gift-card face values, link amounts).
 * Auth: mounted under the existing /admin auth middleware (adminSepa) — unchanged.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const orderDb = require('./db');
const { layout, escapeHtml: e } = require('./adminSepa');
const amountLinks = require('./amountLinks');
const payMethods = require('./payMethods');
const guideStore = require('./guideStore');

const FILE = path.join(__dirname, '..', 'data', 'admin-links.json');
let log = () => {};

/* ---------- categories (built from the real METHOD_GROUPS keys / method ids) ---------- */
const CATS = [
  { key: 'revolut', icon: '🟣', label: 'Revolut (Revtag)', ids: ['revolut_manual'], groups: ['revolut'], guides: ['revolut_manual'] },
  { key: 'revolut_ramp', icon: '🟪', label: 'Revolut Ramp', ids: ['revolut_ramp'], guides: ['revolut_ramp'] },
  { key: 'karta', icon: '💳', label: 'Karta / Apple Pay / Google Pay (Changelly, Switchere)', ids: ['changelly_card'], groups: ['cards', 'wallets'], guides: ['changelly_card'] },
  { key: 'sepa', icon: '🏦', label: 'SEPA (bankový prevod)', ids: ['changelly_sepa'], groups: ['sepa'], guides: ['changelly_sepa'],
    tools: [['/admin/platby/sepa', '📋 SEPA objednávky'], ['/admin/platby/sepa-chain', '⛓️ Reťaz SEPA botov']] },
  { key: 'darcekove', icon: '🎁', label: 'Darčekové karty (Amazon, Azteco)', groups: ['g2a_amazon', 'g2a_azteco', 'vouchers'], guides: ['g2a_amazon', 'g2a_azteco'],
    tools: [['/admin/platby/azteco', '₿ Azteco (ručne)']] },
  { key: 'paysafecard', icon: '🟦', label: 'Paysafecard', groups: ['paysafecard'], guides: ['paysafecard'] },
  { key: 'skrill', icon: '🟥', label: 'Skrill', groups: ['skrill'], guides: ['switchere_skrill'] },
  { key: 'mtpelerin', icon: '🏔️', label: 'Mt Pelerin (karta / banka)', groups: ['mtpelerin'], guides: ['mtpelerin'] },
  { key: 'krypto', icon: '₿', label: 'Krypto (BTCPay, priamo na peňaženku)', groups: ['crypto_btcpay', 'crypto_direct', 'crypto', 'onramp_btcpay'], guides: ['btcpay', 'crypto_direct'],
    tools: [['/admin/platby/wallets', '👛 Adresy peňaženiek']] },
  { key: 'ostatne', icon: '🧩', label: 'Ostatné brány', groups: [], guides: [] },
];
const CAT = Object.fromEntries(CATS.map((c) => [c.key, c]));
function catOf(id, group) {
  const s = String(id || '').toLowerCase();
  for (const c of CATS) if ((c.ids || []).includes(s)) return c.key;
  for (const c of CATS) if ((c.groups || []).includes(group)) return c.key;
  return 'ostatne';
}
/** All methods (built-in + custom), by category, in admin order, with on/off. */
function methodsByCat() {
  const A = payMethods.ADMIN; const out = Object.fromEntries(CATS.map((c) => [c.key, []]));
  if (!A.rows) return out;
  for (const [g, list] of Object.entries(A.rows())) for (const x of list) {
    out[catOf(x.id, g)].push({ id: x.id, name: x.name, group: g, groupLabel: A.groupLabel(g), kind: x.kind, soon: !!x.soon, on: A.isOn(x), logos: A.logos(x), siblings: list.map((y) => y.id) });
  }
  return out;
}
const alMethods = () => new Set(amountLinks.methods().filter((m) => !/už nie je/.test(m.label)).map((m) => m.id));

/* ---------- own (admin-only) links ---------- */
const OWN = new Map(); let ready = null;
const pool = () => { try { return orderDb.pool(); } catch { return null; } };
async function tables() {
  const p = pool(); if (!p) return null;
  if (!ready) ready = p.query(`CREATE TABLE IF NOT EXISTS pay_admin_links (id text PRIMARY KEY, category text NOT NULL, method text, label text NOT NULL,
      url text NOT NULL, amount_cents integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by text, updated_by text)`)
    .catch((x) => { ready = null; throw x; });
  await ready; return p;
}
const fromRow = (x) => ({ id: x.id, category: x.category, method: x.method || '', label: x.label, url: x.url, amountCents: x.amount_cents == null ? null : Number(x.amount_cents),
  updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : null, updatedBy: x.updated_by || null });
function persistLocal() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify([...OWN.values()], null, 1)); } catch { /* ro */ } }
async function init(appendLog) {
  if (appendLog) log = appendLog;
  const p = await tables().catch((x) => { log('ADMIN_LINKS_DB_FAIL ' + x.message); return null; });
  if (p) { const { rows } = await p.query('SELECT * FROM pay_admin_links'); OWN.clear(); rows.forEach((x) => OWN.set(x.id, fromRow(x))); }
  else { try { JSON.parse(fs.readFileSync(FILE, 'utf8')).forEach((r) => OWN.set(r.id, r)); } catch { /* none */ } }
  log(`ADMIN_LINKS_READY ${OWN.size}`);
}
async function dbOrFail() {
  const p = await tables().catch((x) => { log('ADMIN_LINKS_DB_FAIL ' + x.message); return null; });
  if (pool() && !p) throw new Error('Databáza je dočasne nedostupná – zmena sa neuložila.');
  return p;
}
async function ownSave(r) {
  const p = await dbOrFail();
  if (p) await p.query(`INSERT INTO pay_admin_links (id, category, method, label, url, amount_cents, updated_at, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$7)
    ON CONFLICT (id) DO UPDATE SET category=EXCLUDED.category, method=EXCLUDED.method, label=EXCLUDED.label, url=EXCLUDED.url, amount_cents=EXCLUDED.amount_cents, updated_at=now(), updated_by=EXCLUDED.updated_by`,
  [r.id, r.category, r.method || null, r.label, r.url, r.amountCents, r.updatedBy]);
  OWN.set(r.id, r); persistLocal();
  log(`ADMIN_LINK_SAVE ${r.id} cat=${r.category} amount=${r.amountCents} by=${r.updatedBy}`);
}
async function ownDelete(id, actor) {
  const p = await dbOrFail();
  if (p) await p.query('DELETE FROM pay_admin_links WHERE id=$1', [id]);
  OWN.delete(id); persistLocal(); log(`ADMIN_LINK_DELETE ${id} by=${actor}`);
}

/* ---------- helpers ---------- */
const fmt = (c) => (Number(c) / 100).toLocaleString('sk-SK', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
function parseAmount(v) {
  const a = String(v == null ? '' : v).trim().replace(/\s|€/g, '').replace(',', '.');
  if (!a) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(a)) throw new Error('Suma musí byť číslo v EUR (napr. 25 alebo 19,99) alebo prázdna.');
  const c = Math.round(Number(a) * 100); if (c < 1) throw new Error('Suma musí byť aspoň 0,01 €.'); return c;
}
function parseUrl(v) {
  const url = String(v || '').trim(); let u;
  try { u = new URL(url); } catch { throw new Error('Odkaz nie je platná adresa URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Povolené sú len odkazy http(s)://');
  if (u.username || u.password) throw new Error('Odkaz nesmie obsahovať meno ani heslo.');
  if (url.length > 2000) throw new Error('Odkaz je príliš dlhý (max. 2000 znakov).');
  return u.toString();
}
const cleanLabel = (v) => String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
/** Links of a category: amount links (checkout) of its methods + own links. */
function linksOf(cat) {
  const mb = methodsByCat(); const ids = new Set((mb[cat] || []).map((m) => m.id));
  const known = new Set(Object.values(mb).flat().map((m) => m.id));
  const al = amountLinks.list().filter((r) => ids.has(r.method) || (cat === 'ostatne' && !known.has(r.method)))
    .map((r) => ({ kind: 'al', id: r.id, method: r.method, label: r.label, url: r.url, amountCents: r.amountCents, customer: r.enabled }));
  const own = [...OWN.values()].filter((r) => r.category === cat).map((r) => ({ kind: 'own', ...r, customer: false }));
  return [...al, ...own].sort((a, b) => (a.amountCents == null) - (b.amountCents == null) || (a.amountCents || 0) - (b.amountCents || 0) || a.label.localeCompare(b.label, 'sk'));
}

/* plan packages from lnkbio (cached, never blocks long) */
const PLAN = { at: 0, list: [], busy: false };
let fetchPlan = null;
function refreshPlans() {
  if (!fetchPlan || PLAN.busy || Date.now() - PLAN.at < 10 * 60e3) return;
  PLAN.busy = true;
  const one = (id) => Promise.race([fetchPlan(id).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
  Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((id) => one(id).then((p) => (p && Number(p.amount) > 0 ? { id, amount: Number(p.amount), name: p.name || p.title || '' } : null))))
    .then((l) => { const got = l.filter(Boolean); if (got.length) { PLAN.list = got; PLAN.at = Date.now(); } }).finally(() => { PLAN.busy = false; });
}
const giftAmount = (id) => { const m = /^g2a_[a-z]+_[a-z]+_(\d+)$/.exec(id); return m ? Number(m[1]) * 100 : null; };
function allAmounts() {
  const s = new Map();
  for (const p of PLAN.list) s.set(Math.round(p.amount * 100), (s.get(Math.round(p.amount * 100)) || []).concat(`balík #${p.id}`));
  for (const r of amountLinks.list()) if (!s.has(r.amountCents)) s.set(r.amountCents, []);
  for (const r of OWN.values()) if (r.amountCents != null && !s.has(r.amountCents)) s.set(r.amountCents, []);
  for (const list of Object.values(methodsByCat())) for (const m of list) { const c = giftAmount(m.id); if (c && !s.has(c)) s.set(c, []); }
  return [...s.entries()].sort((a, b) => a[0] - b[0]).map(([c, tags]) => ({ c, tags }));
}
async function checkoutOrder() {
  try {
    const A = payMethods.ADMIN; if (!A.preview) return {};
    const res = await Promise.race([A.preview(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    const order = (res && res.rank && res.rank.methodOrder) || (res && res.providers || []).map((p) => p.id) || [];
    return Object.fromEntries(order.map((id, i) => [String(id).toLowerCase(), i + 1]));
  } catch { return {}; }
}

/* ---------- UI ---------- */
const CSS = `<style>
.kt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.75rem}.kt-card{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem;color:var(--text)}
.kt-card:hover{border-color:var(--accent);text-decoration:none}.kt-card h2{margin:0 0 .4rem;font-size:1.05rem}.kt-stats{display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}.kt-stats .badge,.kt-row .badge{white-space:nowrap}
.kt-tabs{display:flex;gap:.4rem;overflow-x:auto;padding:.2rem 0 .6rem;margin-bottom:.4rem;-webkit-overflow-scrolling:touch}.kt-tabs a{white-space:nowrap;padding:.45rem .75rem;border:1px solid var(--line);border-radius:999px;color:var(--text);font-size:.88rem}
.kt-tabs a.on{background:var(--accent);border-color:var(--accent);color:#fff}.kt-tabs a:hover{text-decoration:none}
.kt-row{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;justify-content:space-between;padding:.6rem 0;border-bottom:1px solid var(--line)}.kt-row:last-child{border-bottom:0}
.kt-row .nm{flex:1 1 220px;min-width:0}.kt-row.off .nm{opacity:.55}.kt-act{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center}.kt-act form{margin:0}
.kt-act button,.kt-act .btn{padding:.4rem .7rem;font-size:.85rem}.lg{height:22px;max-width:60px;object-fit:contain;background:#fff;border-radius:5px;padding:2px 3px;vertical-align:middle;margin-right:.25rem}
.url{font-family:ui-monospace,monospace;font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}.amt{font-weight:700;white-space:nowrap}.chk{display:flex;align-items:center;gap:.5rem;color:var(--text)}.chk input{width:auto;min-width:20px;min-height:20px}
.hint{color:var(--muted);font-size:.85rem}button.danger{background:#7f1d1d}.kt-chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:.3rem 0 .6rem}.kt-chips a{padding:.3rem .65rem;border-radius:999px;border:1px solid var(--line);font-size:.85rem;color:var(--text)}
.kt-chips a.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff}.kt-sec{margin-top:.2rem}.kt-tools{display:flex;flex-wrap:wrap;gap:.5rem}
.kt-amt h2{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
@media(max-width:768px){.kt-act{width:100%}.kt-act button,.kt-act .btn{min-height:44px;flex:1 1 auto;text-align:center}.kt-chips a,.kt-tabs a{min-height:40px;display:inline-flex;align-items:center}}
</style>`;
function mountAdmin(app, opts = {}) {
  if (opts.appendLog) log = opts.appendLog;
  if (opts.fetchPlan) fetchPlan = opts.fetchPlan;
  const { sameOrigin, nostore } = payMethods;
  const routeExists = (p) => { try { return (app._router && app._router.stack || []).some((l) => l.route && l.route.path === p); } catch { return false; } };
  const actorOf = (req) => (req.adminSession && req.adminSession.email) || 'admin';
  const guard = (req, res) => { if (!sameOrigin(req)) { res.status(403).send('Zakázané'); return false; } return true; };
  const MSG = { toggled: 'Stav spôsobu platby zmenený.', moved: 'Poradie zmenené.', added: 'Odkaz pridaný.', saved: 'Odkaz uložený.', deleted: 'Odkaz zmazaný.', ltoggled: 'Zobrazenie odkazu zákazníkom zmenené.' };
  const page = (req, title, body, msg = '', err = '') => layout({ title, userEmail: req.adminSession && req.adminSession.email,
    body: `${CSS}${msg ? `<div class="ok">${e(msg)}</div>` : ''}${err ? `<div class="err">${e(err)}</div>` : ''}${body}
<script>document.addEventListener('submit',function(ev){var f=ev.target;if(f&&f.getAttribute('data-confirm')&&!window.confirm(f.getAttribute('data-confirm')))ev.preventDefault()});</script>` });
  const tabs = (cur) => `<nav class="kt-tabs" aria-label="Kategórie"><a href="/admin/platby/kategorie" class="${cur === '' ? 'on' : ''}">Všetky</a>${CATS.map((c) => `<a href="/admin/platby/kategorie/${c.key}" class="${cur === c.key ? 'on' : ''}">${c.icon} ${e(c.label.replace(/ \(.*\)$/, ''))}</a>`).join('')}<a href="/admin/platby/sumy" class="${cur === 'sumy' ? 'on' : ''}">💶 Podľa sumy</a></nav>`;

  app.get('/admin/platby/kategorie', (req, res) => {
    nostore(res); refreshPlans();
    const mb = methodsByCat();
    const cards = CATS.map((c) => {
      const ms = mb[c.key]; const on = ms.filter((m) => m.on && !m.soon).length; const ln = linksOf(c.key);
      const miss = (c.guides || []).reduce((n, k) => n + guideStore.missing(guideStore.get(k)), 0);
      if (!ms.length && !ln.length && c.key === 'ostatne') return '';
      return `<a class="kt-card" href="/admin/platby/kategorie/${c.key}"><h2>${c.icon} ${e(c.label)}</h2><div class="kt-stats">
<span class="badge ${on ? 'ok' : ''}">${on}/${ms.length} zapnuté</span><span class="badge">🔗 ${ln.filter((l) => l.customer).length} na pokladni</span>${ln.some((l) => l.kind === 'al' && !l.customer) ? `<span class="badge">${ln.filter((l) => l.kind === 'al' && !l.customer).length} vypnuté</span>` : ''}<span class="badge">${ln.filter((l) => l.kind === 'own').length} len pre mňa</span>
${(c.guides || []).length ? `<span class="badge ${miss ? 'warn' : 'ok'}">📖 ${miss ? miss + ' obr. chýba' : 'návody OK'}</span>` : ''}</div></a>`;
    }).join('');
    res.type('html').send(page(req, 'Kategórie platieb', `${tabs('')}<div class="card"><h1>🗂️ Kategórie platieb</h1>
<p class="hint">Všetko k jednému spôsobu platby na jednom mieste: zapnutie/vypnutie, poradie, odkazy podľa sumy, vlastné odkazy a návody. Pôvodné stránky (Spôsoby platby, Odkazy podľa sumy, Návody…) ostávajú – tu sa zobrazujú tie isté údaje.</p></div>
<div class="kt-grid">${cards}</div>`, MSG[req.query.m] || ''));
  });

  const linkForm = (cat, r = {}, err = '') => {
    const elig = alMethods(); const ms = (methodsByCat()[cat] || []).filter((m) => elig.has(m.id));
    const isNew = !r.id; const amount = r.amount != null ? r.amount : r.amountCents != null ? String(r.amountCents / 100).replace('.', ',') : '';
    const sel = r.method || (ms.find((m) => m.on) || ms[0] || {}).id || '';
    return `<form method="post" action="/admin/platby/kategorie/${cat}/link" class="card" id="${isNew ? 'pridat' : 'upravit'}"><h2>${isNew ? '➕ Pridať vlastný odkaz' : '✏️ Upraviť odkaz'}</h2>
${err ? `<div class="err">${e(err)}</div>` : ''}<input type="hidden" name="id" value="${e(r.id || '')}"><input type="hidden" name="kind" value="${e(r.kind || 'own')}">
<div class="grid"><div><label>Názov odkazu *</label><input type="text" name="label" required maxlength="60" value="${e(r.label || '')}" placeholder="napr. Revolut 25 € – môj odkaz"></div>
<div><label>Suma v EUR (voliteľné)</label><input type="text" name="amount" inputmode="decimal" maxlength="12" value="${e(amount)}" placeholder="napr. 25"></div></div>
<label>Odkaz (URL) *</label><input type="url" name="url" required maxlength="2000" autocomplete="off" spellcheck="false" value="${e(r.url || '')}" placeholder="https://…">
${ms.length ? `<div class="grid"><div><label>Spôsob platby (pre zobrazenie zákazníkom)</label><select name="method">${ms.map((m) => `<option value="${e(m.id)}"${m.id === sel ? ' selected' : ''}>${e(m.name)}${m.on ? '' : ' (vypnutý)'}</option>`).join('')}</select></div>
<div><label class="chk" style="margin-top:1.7rem"><input type="checkbox" name="customer" value="1"${r.customer ? ' checked' : ''}> Zobraziť zákazníkom ako tlačidlo „Zaplatiť“</label></div></div>
<p class="hint">Bez zaškrtnutia je odkaz len pre vás (zákazník ho nikdy neuvidí). So zaškrtnutím (vyžaduje sumu a https): keď zákazník pri tomto spôsobe platí presne túto sumu, uvidí len tlačidlo „Zaplatiť“ – samotný odkaz sa mu nezobrazí (ako pri Odkazoch podľa sumy).</p>`
    : '<p class="hint">Odkazy v tejto kategórii sú len pre vás (tieto spôsoby platby nepoužívajú tlačidlo „Zaplatiť“ s odkazom).</p>'}
<p><button>💾 Uložiť</button> ${isNew ? '' : `<a class="btn" style="background:#334155" href="/admin/platby/kategorie/${cat}">Späť</a>`}</p></form>`;
  };

  async function catPage(req, cat, msg = '', err = '', formHtml = '') {
    const c = CAT[cat]; refreshPlans(); const pos = await checkoutOrder();
    const self = `/admin/platby/kategorie/${cat}`;
    const ms = methodsByCat()[cat] || [];
    const fA = req.query.suma ? Math.round(Number(String(req.query.suma).replace(',', '.')) * 100) : null;
    const rowsM = ms.map((m) => {
      const i = m.siblings.indexOf(m.id);
      const mv = (dir, lbl, dis) => `<form method="post" action="/admin/platby/methods/move/${e(m.id)}"><input type="hidden" name="dir" value="${dir}"><input type="hidden" name="group" value="${e(m.group)}"><input type="hidden" name="back" value="${self}"><button class="secondary" ${dis ? 'disabled' : ''} title="${dir === 'up' ? 'Vyššie' : 'Nižšie'}" aria-label="${dir === 'up' ? 'Posunúť vyššie' : 'Posunúť nižšie'}">${lbl}</button></form>`;
      const ga = giftAmount(m.id);
      return `<div class="kt-row ${m.on ? '' : 'off'}"><div class="nm">${m.logos.slice(0, 2).map((l) => `<img class="lg" src="${e(l)}" alt="">`).join('')}<b>${e(m.name)}</b>${ga ? ` <span class="badge">${e(fmt(ga))}</span>` : ''}
<br><span class="hint">${e(m.groupLabel)} · ${e(m.id)}${m.on && pos[m.id] ? ` · na pokladni #${pos[m.id]}` : ''}${m.soon ? ' · čoskoro' : ''}</span></div>
<div class="kt-act"><span class="badge ${m.on ? 'ok' : 'bad'}">${m.on ? 'zapnutý' : 'vypnutý'}</span>
<form method="post" action="/admin/platby/methods/toggle/${e(m.id)}"><input type="hidden" name="state" value="${m.on ? 'off' : 'on'}"><input type="hidden" name="back" value="${self}"><button class="${m.on ? 'secondary' : ''}">${m.on ? 'Vypnúť' : 'Zapnúť'}</button></form>
${mv('up', '↑', i <= 0)}${mv('down', '↓', i < 0 || i >= m.siblings.length - 1)}<a class="btn" style="background:#334155" href="/admin/platby/methods/edit/${e(m.id)}">Nastavenia</a></div></div>`;
    }).join('');
    const links = linksOf(cat); const amts = [...new Set(links.filter((l) => l.amountCents != null).map((l) => l.amountCents))].sort((a, b) => a - b);
    const shown = fA ? links.filter((l) => l.amountCents === fA) : links;
    const rowsL = shown.map((l) => `<div class="kt-row ${l.kind === 'al' && !l.customer ? 'off' : ''}"><div class="nm"><span class="amt">${l.amountCents != null ? e(fmt(l.amountCents)) : 'bez sumy'}</span> · <b>${e(l.label || '(bez názvu)')}</b>
${l.kind === 'al' ? ` <span class="badge">${e((ms.find((m) => m.id === l.method) || { name: l.method }).name)}</span>` : ''}<br><a class="url" href="${e(l.url)}" target="_blank" rel="noopener noreferrer">${e(l.url)}</a></div>
<div class="kt-act">${l.kind === 'al' ? `<span class="badge ${l.customer ? 'ok' : ''}">${l.customer ? 'zákazník: „Zaplatiť“' : 'vypnutý na pokladni'}</span>
<form method="post" action="/admin/platby/kategorie/${cat}/link/toggle/${e(l.id)}"><input type="hidden" name="state" value="${l.customer ? 'off' : 'on'}"><button class="secondary">${l.customer ? 'Skryť zákazníkom' : 'Zobraziť zákazníkom'}</button></form>`
    : '<span class="badge">len pre mňa</span>'}
<a class="btn" style="background:#334155" href="/admin/platby/kategorie/${cat}/link/${l.kind}/${e(l.id)}">Upraviť</a>
<form method="post" action="/admin/platby/kategorie/${cat}/link/delete/${l.kind}/${e(l.id)}" data-confirm="Naozaj zmazať odkaz ${e(l.label || '')}?"><button class="danger">Zmazať</button></form></div></div>`).join('');
    const guides = (c.guides || []).map((k) => { const g = guideStore.get(k); const n = guideStore.missing(g);
      return `<div class="kt-row"><div class="nm"><b>${e(g.title)}</b><br><span class="hint">${g.steps.length} krokov · SK + EN</span></div><div class="kt-act"><span class="badge ${n ? 'warn' : 'ok'}">${n ? '📷 ' + n + ' obrázok chýba' : 'obrázky OK'}</span>
<a class="btn" href="/admin/platby/guides/${e(k)}">Upraviť návod</a><a class="btn" style="background:#334155" href="/admin/platby/guides/${e(k)}/preview" target="_blank" rel="noopener">Náhľad</a></div></div>`; }).join('');
    const tools = (c.tools || []).filter(([p]) => p !== '/admin/platby/sepa-chain' || routeExists(p)).map(([p, l]) => `<a class="btn" style="background:#334155" href="${p}">${e(l)}</a>`).join('');
    const chips = amts.length ? `<div class="kt-chips"><a href="${self}" class="${fA ? '' : 'on'}">Všetky sumy</a>${amts.map((a) => `<a href="${self}?suma=${a / 100}" class="${fA === a ? 'on' : ''}">${e(fmt(a))}</a>`).join('')}</div>` : '';
    return page(req, c.label, `${tabs(cat)}<div class="card"><h1>${c.icon} ${e(c.label)}</h1>${tools ? `<div class="kt-tools">${tools}</div>` : ''}</div>
<div class="card kt-sec"><h2>💳 Spôsoby platby (${ms.filter((m) => m.on).length}/${ms.length} zapnuté)</h2><p class="hint">Poradie ↑↓ platí v rámci skupiny; celkové poradie na pokladni (automaticky podľa používania) je v <a href="/admin/platby/methods#poradie">Spôsoby platby → Poradie</a>.</p>${rowsM || '<p class="hint">Žiadne spôsoby platby.</p>'}</div>
<div class="card kt-sec" id="odkazy"><h2>🔗 Odkazy</h2><p class="hint">Odkazy podľa sumy na pokladni (tie isté ako v <a href="/admin/platby/amount-links">Odkazy podľa sumy</a>) a vaše vlastné odkazy. <a href="#pridat">➕ Pridať odkaz</a></p>${chips}${rowsL || '<p class="hint">Zatiaľ žiadne odkazy.</p>'}</div>
${formHtml || linkForm(cat)}
${guides ? `<div class="card kt-sec"><h2>📖 Návody</h2>${guides}</div>` : ''}`, msg, err);
  }
  const validCat = (req, res) => { const c = String(req.params.cat || ''); if (!CAT[c]) { res.status(404).type('html').send(page(req, 'Nenájdené', `${tabs('')}<div class="err">Kategória neexistuje.</div>`)); return null; } return c; };
  app.get('/admin/platby/kategorie/:cat', async (req, res) => { nostore(res); const c = validCat(req, res); if (!c) return; res.type('html').send(await catPage(req, c, MSG[req.query.m] || '')); });
  app.get('/admin/platby/kategorie/:cat/link/:kind/:id', async (req, res) => {
    nostore(res); const c = validCat(req, res); if (!c) return;
    const l = linksOf(c).find((x) => x.kind === req.params.kind && x.id === req.params.id);
    if (!l) return res.status(404).type('html').send(await catPage(req, c, '', 'Odkaz sa nenašiel.'));
    res.type('html').send(page(req, 'Upraviť odkaz', `${tabs(c)}${linkForm(c, l)}`));
  });
  app.post('/admin/platby/kategorie/:cat/link', async (req, res) => {
    nostore(res); if (!guard(req, res)) return; const c = validCat(req, res); if (!c) return;
    const b = req.body || {}; const actor = actorOf(req);
    try {
      const label = cleanLabel(b.label); if (!label) throw new Error('Zadajte názov odkazu.');
      const amountCents = parseAmount(b.amount); const url = parseUrl(b.url);
      const customer = b.customer === '1'; const method = String(b.method || '').toLowerCase();
      const catMethods = new Set((methodsByCat()[c] || []).map((m) => m.id));
      const id = String(b.id || ''); const kind = b.kind === 'al' ? 'al' : 'own';
      if (customer) {
        if (amountCents == null) throw new Error('Na zobrazenie zákazníkom zadajte sumu – tlačidlo „Zaplatiť“ sa ukáže len pri presne tejto sume.');
        if (!alMethods().has(method) || !catMethods.has(method)) throw new Error('Vyberte spôsob platby z tejto kategórie.');
      }
      const fields = { method, amount: amountCents == null ? '' : String(amountCents / 100), url, label, enabled: customer ? '1' : '' };
      if (kind === 'al' && id) {
        if (amountCents == null) throw new Error('Odkaz na pokladni musí mať sumu. Ak ho nechcete, skryte ho zákazníkom alebo ho zmažte.');
        const prev = amountLinks.list().find((r) => r.id === id); if (!prev) throw new Error('Odkaz sa nenašiel.');
        await amountLinks.update(id, { ...fields, method: catMethods.has(method) && alMethods().has(method) ? method : prev.method }, actor);
      } else if (customer) {
        await amountLinks.create(fields, actor); // amountLinks validates https + public host + duplicates
        if (id && OWN.has(id)) await ownDelete(id, actor); // moved from „len pre mňa“ to the checkout
      } else {
        const prev = id ? OWN.get(id) : null; if (id && !prev) throw new Error('Odkaz sa nenašiel.');
        await ownSave({ id: prev ? prev.id : 'ol_' + crypto.randomBytes(6).toString('hex'), category: c, method: catMethods.has(method) ? method : '', label, url, amountCents, updatedBy: actor, updatedAt: new Date().toISOString() });
      }
      res.redirect(303, `/admin/platby/kategorie/${c}?m=${id ? 'saved' : 'added'}#odkazy`);
    } catch (x) {
      res.status(400).type('html').send(await catPage(req, c, '', '', linkForm(c, { id: b.id, kind: b.kind, label: b.label, amount: b.amount, url: b.url, method: b.method, customer: b.customer === '1' }, x.message)));
    }
  });
  app.post('/admin/platby/kategorie/:cat/link/toggle/:id', async (req, res) => {
    nostore(res); if (!guard(req, res)) return; const c = validCat(req, res); if (!c) return;
    try { await amountLinks.setEnabled(String(req.params.id), (req.body || {}).state === 'on', actorOf(req)); res.redirect(303, `/admin/platby/kategorie/${c}?m=ltoggled#odkazy`); }
    catch (x) { res.status(400).type('html').send(await catPage(req, c, '', x.message)); }
  });
  app.post('/admin/platby/kategorie/:cat/link/delete/:kind/:id', async (req, res) => {
    nostore(res); if (!guard(req, res)) return; const c = validCat(req, res); if (!c) return;
    try {
      const id = String(req.params.id);
      if (req.params.kind === 'al') await amountLinks.remove(id, actorOf(req));
      else { if (!OWN.has(id)) throw new Error('Odkaz sa nenašiel.'); await ownDelete(id, actorOf(req)); }
      res.redirect(303, `/admin/platby/kategorie/${c}?m=deleted#odkazy`);
    } catch (x) { res.status(400).type('html').send(await catPage(req, c, '', x.message)); }
  });

  /* ---------- by amount ---------- */
  app.get('/admin/platby/sumy', (req, res) => {
    nostore(res); refreshPlans();
    const mb = methodsByCat(); const amounts = allAmounts();
    const fA = req.query.suma ? Math.round(Number(String(req.query.suma).replace(',', '.')) * 100) : null;
    const fC = CAT[String(req.query.kat || '')] ? String(req.query.kat) : '';
    const q = (a, k) => '/admin/platby/sumy?' + [a ? 'suma=' + a / 100 : '', k ? 'kat=' + k : ''].filter(Boolean).join('&');
    const chipsA = `<div class="kt-chips"><a href="${q(null, fC)}" class="${fA ? '' : 'on'}">Všetky sumy</a>${amounts.map((a) => `<a href="${q(a.c, fC)}" class="${fA === a.c ? 'on' : ''}">${e(fmt(a.c))}</a>`).join('')}</div>`;
    const chipsC = `<div class="kt-chips"><a href="${q(fA, '')}" class="${fC ? '' : 'on'}">Všetky kategórie</a>${CATS.map((c) => `<a href="${q(fA, c.key)}" class="${fC === c.key ? 'on' : ''}">${c.icon} ${e(c.label.replace(/ \(.*\)$/, ''))}</a>`).join('')}</div>`;
    const blocks = amounts.filter((a) => !fA || a.c === fA).map((a) => {
      const per = CATS.filter((c) => !fC || c.key === fC).map((c) => {
        const ln = linksOf(c.key).filter((l) => l.amountCents === a.c);
        const gifts = mb[c.key].filter((m) => giftAmount(m.id) === a.c);
        if (!ln.length && !gifts.length) return '';
        return `<div class="kt-row"><div class="nm"><a href="/admin/platby/kategorie/${c.key}?suma=${a.c / 100}"><b>${c.icon} ${e(c.label)}</b></a>
${gifts.map((m) => `<br><span class="badge ${m.on ? 'ok' : 'bad'}">${m.on ? 'zap.' : 'vyp.'}</span> ${e(m.name)}`).join('')}
${ln.map((l) => `<br><span class="badge ${l.customer ? 'ok' : ''}">${l.customer ? 'zákazník: „Zaplatiť“' : l.kind === 'al' ? 'vypnutý na pokladni' : 'len pre mňa'}</span> ${e(l.label || '(bez názvu)')} <span class="url">${e(hostOf(l.url))}</span>`).join('')}</div></div>`;
      }).join('');
      return `<div class="card kt-amt"><h2><span class="amt">${e(fmt(a.c))}</span>${a.tags.map((t) => `<span class="badge ok">${e(t)}</span>`).join('')}</h2>${per || '<p class="hint">Pre túto sumu nie sú nastavené žiadne odkazy ani darčekové karty – platí bežný postup všetkých zapnutých spôsobov platby.</p>'}</div>`;
    }).join('');
    res.type('html').send(page(req, 'Podľa sumy', `${tabs('sumy')}<div class="card"><h1>💶 Podľa sumy</h1><p class="hint">Balíky z cenníka${PLAN.list.length ? '' : ' (načítavajú sa – obnovte o chvíľu)'}, hodnoty darčekových kariet a sumy z odkazov. Pri každej sume vidíte, čo je pre ňu nastavené v jednotlivých kategóriách.</p>${chipsA}${chipsC}</div>${blocks || '<div class="card"><p class="hint">Nič nenájdené.</p></div>'}`));
  });

  require('./adminSepa').addDashboardPanel(() => `<div class="card"><h2>🗂️ Kategórie platieb</h2><p class="muted">Revolut, karta, SEPA, darčekové karty, Paysafecard, Skrill, krypto… – všetko k jednému spôsobu platby na jednom mieste.</p><a class="btn" href="/admin/platby/kategorie">Otvoriť kategórie</a> <a class="btn" style="background:#334155" href="/admin/platby/sumy">Podľa sumy</a></div>`);
}

module.exports = { CATS, catOf, init, mountAdmin, _parseAmount: parseAmount };

// Prominent dashboard entry for the SEPA bot chain (nav link can be off-screen on mobile)
try {
  require('./adminSepa').addDashboardPanel(() => `<div class="card"><h2>🤖 Reťaz SEPA botov</h2><p class="muted">Tu vložíš API token SEPA kanálového bota, ID kanála, @meno overovacieho bota a e-mail na upozornenia.</p><a class="btn" href="/admin/platby/sepa-chain">Otvoriť Reťaz SEPA botov</a></div>`);
} catch (_) {}
