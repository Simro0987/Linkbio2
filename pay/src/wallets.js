'use strict';
/**
 * Admin-managed crypto RECEIVE addresses (Ryan types public addresses only — no keys, no wallet creation).
 * Source of truth: Neon tables wallet_addresses + wallet_address_audit (file fallback data/wallet-addresses.json
 * for local dev without DATABASE_URL). Seeded once from data/address-pools.json (+ data/wallets.json).
 * Consumers read the in-memory cache synchronously: first(network), forChain(chain), enabledAddresses(network).
 * BTCPay is NOT involved here — BTCPay keeps generating its own addresses for the BTCPay option only.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const orderDb = require('./db');
const V = require('./addrValidate');
const { layout, escapeHtml: e } = require('./adminSepa');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'wallet-addresses.json');
const AUDIT_FILE = path.join(DATA_DIR, 'wallet-addresses-audit.json');
const BRIDGE_PATH = '/api/admin-bridge/wallets';
const NETS = V.NETWORKS;
const NET_ORDER = Object.keys(NETS);
const EVM_CHAINS = ['eth', 'base', 'arbitrum', 'polygon', 'bsc', 'optimism'];

const S = { rows: new Map(), audit: [], seeded: false };
let log = () => {};
let ready = null;
const pool = () => orderDb.pool();

async function tables() {
  const p = pool(); if (!p) return null;
  if (!ready) {
    ready = p.query(`CREATE TABLE IF NOT EXISTS wallet_addresses (
        id text PRIMARY KEY, network text NOT NULL, label text NOT NULL DEFAULT '', address text NOT NULL, memo text,
        enabled boolean NOT NULL DEFAULT true, sort integer NOT NULL DEFAULT 100,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        created_by text, updated_by text)`)
      .then(() => p.query(`CREATE INDEX IF NOT EXISTS wallet_addresses_net ON wallet_addresses (network, enabled, sort)`))
      .then(() => p.query(`CREATE TABLE IF NOT EXISTS wallet_address_audit (
        id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL,
        wallet_id text, network text, old_value jsonb, new_value jsonb)`))
      .catch((x) => { ready = null; throw x; });
  }
  await ready; return p;
}
const pub = (r) => r && ({ id: r.id, network: r.network, label: r.label || '', address: r.address, memo: r.memo || null, enabled: r.enabled !== false, sort: Number(r.sort) || 0, createdAt: r.createdAt || null, updatedAt: r.updatedAt || null, createdBy: r.createdBy || null, updatedBy: r.updatedBy || null });
const fromRow = (x) => pub({ id: x.id, network: x.network, label: x.label, address: x.address, memo: x.memo, enabled: x.enabled, sort: x.sort,
  createdAt: x.created_at && new Date(x.created_at).toISOString(), updatedAt: x.updated_at && new Date(x.updated_at).toISOString(), createdBy: x.created_by, updatedBy: x.updated_by });
function persistLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...S.rows.values()], null, 1));
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(S.audit.slice(0, 500), null, 1));
  } catch { /* read-only fs */ }
}

/* ---------- seed (one time, marker = audit row action 'seed') ---------- */
function seedRows() {
  const out = []; let pools = {}; let w = {};
  try { pools = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'address-pools.json'), 'utf8')); } catch { pools = {}; }
  try { w = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'wallets.json'), 'utf8')); } catch { w = {}; }
  const add = (network, address, label, i) => {
    const v = V.validate(network, address, null); if (!v.ok) return;
    if (out.some((r) => r.network === network && r.address === v.address)) return;
    out.push({ network, address: v.address, label, sort: (i + 1) * 10 });
  };
  const map = { btc: 'btc', ltc: 'ltc', bch: 'bch', doge: 'doge', sol: 'sol', evm: 'evm', lightning: 'lightning' };
  for (const [k, net] of Object.entries(map)) (Array.isArray(pools[k]) ? pools[k] : []).forEach((a, i) => add(net, a, i === 0 ? 'Pôvodná adresa (import)' : `Pôvodná adresa #${i + 1} (import)`, i));
  if (w.evm && w.evm.address) add('evm', w.evm.address, 'Pôvodná adresa (import)', 0);
  if (w.sol && typeof w.sol === 'string') add('sol', w.sol, 'Pôvodná adresa (import)', 0);
  if (w.sol && w.sol.address) add('sol', w.sol.address, 'Pôvodná adresa (import)', 0);
  // env overrides that used to take priority — public addresses only
  if (!out.some((r) => r.network === 'evm')) for (const k of ['MERCHANT_WALLET', 'WALLET_EVM']) if (process.env[k]) add('evm', process.env[k], `Z env ${k}`, 0);
  return out;
}
async function insert(p, r) {
  await p.query(`INSERT INTO wallet_addresses (id, network, label, address, memo, enabled, sort, created_at, updated_at, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET network=EXCLUDED.network, label=EXCLUDED.label, address=EXCLUDED.address,
    memo=EXCLUDED.memo, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
  [r.id, r.network, r.label, r.address, r.memo, r.enabled, r.sort, r.createdAt, r.updatedAt, r.createdBy, r.updatedBy]);
}
async function auditAdd(entry) {
  const a = { at: new Date().toISOString(), ...entry };
  S.audit.unshift(a); if (S.audit.length > 500) S.audit.length = 500;
  const p = await tables().catch(() => null);
  if (p) await p.query(`INSERT INTO wallet_address_audit (actor, action, wallet_id, network, old_value, new_value) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [a.actor, a.action, a.walletId || null, a.network || null, a.old ? JSON.stringify(a.old) : null, a.new ? JSON.stringify(a.new) : null]);
  persistLocal();
}

async function init(appendLog) {
  if (appendLog) log = appendLog;
  const p = await tables().catch((x) => { log('WALLETS_DB_FAIL ' + x.message); return null; });
  if (p) {
    const seeded = await p.query(`SELECT 1 FROM wallet_address_audit WHERE action='seed' LIMIT 1`);
    if (!seeded.rowCount) {
      const now = new Date().toISOString(); const rows = seedRows();
      for (const r of rows) await insert(p, { id: 'w_' + crypto.randomBytes(6).toString('hex'), memo: null, enabled: true, createdAt: now, updatedAt: now, createdBy: 'seed', updatedBy: 'seed', ...r });
      await p.query(`INSERT INTO wallet_address_audit (actor, action, new_value) VALUES ('seed','seed',$1::jsonb)`, [JSON.stringify({ count: rows.length })]);
      log(`WALLETS_SEEDED ${rows.length}`);
    }
    const { rows } = await p.query('SELECT * FROM wallet_addresses');
    S.rows.clear(); rows.forEach((x) => S.rows.set(x.id, fromRow(x)));
    const au = await p.query('SELECT * FROM wallet_address_audit ORDER BY id DESC LIMIT 300');
    S.audit = au.rows.map((x) => ({ at: new Date(x.at).toISOString(), actor: x.actor, action: x.action, walletId: x.wallet_id, network: x.network, old: x.old_value, new: x.new_value }));
  } else {
    try { JSON.parse(fs.readFileSync(FILE, 'utf8')).forEach((r) => S.rows.set(r.id, pub(r))); } catch { /* none */ }
    try { S.audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); } catch { S.audit = []; }
    if (!S.audit.some((a) => a.action === 'seed')) {
      const now = new Date().toISOString(); const rows = seedRows();
      rows.forEach((r) => { const id = 'w_' + crypto.randomBytes(6).toString('hex'); S.rows.set(id, pub({ id, memo: null, enabled: true, createdAt: now, updatedAt: now, createdBy: 'seed', updatedBy: 'seed', ...r })); });
      S.audit.unshift({ at: now, actor: 'seed', action: 'seed', new: { count: rows.length } }); persistLocal();
      log(`WALLETS_SEEDED_LOCAL ${rows.length}`);
    }
  }
  S.seeded = true;
  log(`WALLETS_READY ${S.rows.size}`);
}

/* ---------- sync accessors ---------- */
const sorted = (arr) => arr.sort((a, b) => a.sort - b.sort || String(a.createdAt).localeCompare(String(b.createdAt)));
function list(network) { return sorted([...S.rows.values()].filter((r) => !network || r.network === network)); }
function enabledAddresses(network) { return list(network).filter((r) => r.enabled); }
function first(network) { return enabledAddresses(network)[0] || null; }
/** EVM chain: a chain-specific address wins, else the shared 'evm' address. */
function forChain(chain) { return (EVM_CHAINS.includes(chain) && first(chain)) || (EVM_CHAINS.includes(chain) ? first('evm') : first(chain)); }
function counts() { const c = {}; for (const r of S.rows.values()) { c[r.network] = c[r.network] || { on: 0, off: 0 }; c[r.network][r.enabled ? 'on' : 'off']++; } return c; }
const isReady = () => S.seeded;

/* ---------- mutations (shared by admin UI + bridge) ---------- */
function parseFields(f, prev) {
  const network = String(f.network || (prev && prev.network) || '').toLowerCase();
  if (!NETS[network]) throw new Error('Vyberte sieť / menu.');
  const v = V.validate(network, f.address, f.memo);
  if (!v.ok) throw new Error(v.error);
  const label = String(f.label || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  const sortRaw = String(f.sort == null ? '' : f.sort).trim();
  const sort = sortRaw === '' ? (prev ? prev.sort : (Math.max(0, ...list(network).map((r) => r.sort)) + 10)) : Number(sortRaw);
  if (!Number.isInteger(sort) || sort < 0 || sort > 100000) throw new Error('Poradie musí byť celé číslo 0 – 100000.');
  const enabled = f.enabled === true || f.enabled === '1' || f.enabled === 'on' || f.enabled === 'true';
  const dup = list(network).find((r) => r.address === v.address && (r.memo || null) === (v.memo || null) && (!prev || r.id !== prev.id));
  if (dup) throw new Error(`Táto adresa už v zozname je („${dup.label || dup.id}“).`);
  return { network, address: v.address, memo: v.memo, label, sort, enabled };
}
const short = (a) => (a && a.length > 18 ? a.slice(0, 10) + '…' + a.slice(-6) : a || '');
function notify(text) {
  try {
    const bot = global.__telegramBot; const chat = bot && bot.loadAdminChatId && bot.loadAdminChatId();
    if (bot && chat && bot.tokenConfigured && bot.tokenConfigured()) bot.sendMessage(chat, text).catch((x) => log('WALLETS_TG_FAIL ' + x.message));
  } catch (x) { log('WALLETS_TG_FAIL ' + x.message); }
}
async function save(rec, actor, action, old) {
  const p = await tables().catch((x) => { log('WALLETS_DB_FAIL ' + x.message); return null; });
  if (pool() && !p) throw new Error('Databáza je dočasne nedostupná – zmena sa neuložila.');
  if (p) await insert(p, rec);
  S.rows.set(rec.id, pub(rec)); persistLocal();
  const snap = (r) => r && { network: r.network, label: r.label, address: r.address, memo: r.memo, enabled: r.enabled, sort: r.sort };
  await auditAdd({ actor, action, walletId: rec.id, network: rec.network, old: snap(old), new: snap(rec) }).catch((x) => log('WALLETS_AUDIT_FAIL ' + x.message));
  log(`WALLET_${action.toUpperCase()} ${rec.id} ${rec.network} ${short(rec.address)} enabled=${rec.enabled} by=${actor}`);
  const net = NETS[rec.network].short;
  const lines = [`👛 Zmena adresy peňaženky (${action === 'create' ? 'pridaná' : action === 'toggle' ? (rec.enabled ? 'zapnutá' : 'vypnutá') : 'upravená'})`,
    `Sieť: ${net}${rec.label ? ' · ' + rec.label : ''}`, `Kto: ${actor}`];
  if (old && old.address !== rec.address) lines.push(`Stará: ${old.address}${old.memo ? ' (memo ' + old.memo + ')' : ''}`);
  lines.push(`${old && old.address !== rec.address ? 'Nová' : 'Adresa'}: ${rec.address}${rec.memo ? ' (memo ' + rec.memo + ')' : ''}`);
  if (old && old.enabled !== rec.enabled) lines.push(`Stav: ${old.enabled ? 'zapnutá' : 'vypnutá'} → ${rec.enabled ? 'zapnutá' : 'vypnutá'}`);
  const f = first(rec.network); lines.push(`Checkout teraz použije: ${f ? short(f.address) : '— (žiadna zapnutá – mena sa skryje)'}`);
  notify(lines.join('\n'));
  return pub(rec);
}
async function create(fields, actor) {
  const f = parseFields(fields, null); const now = new Date().toISOString();
  return save({ id: 'w_' + crypto.randomBytes(6).toString('hex'), ...f, createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor }, actor, 'create', null);
}
async function update(id, fields, actor) {
  const prev = S.rows.get(id); if (!prev) throw new Error('Adresa sa nenašla.');
  const f = parseFields({ ...fields, network: prev.network }, prev);
  return save({ ...prev, ...f, updatedAt: new Date().toISOString(), updatedBy: actor }, actor, 'update', prev);
}
async function setEnabled(id, enabled, actor) {
  const prev = S.rows.get(id); if (!prev) throw new Error('Adresa sa nenašla.');
  if (prev.enabled === enabled) return prev;
  return save({ ...prev, enabled, updatedAt: new Date().toISOString(), updatedBy: actor }, actor, 'toggle', prev);
}
function preview(fields, prevId) {
  const prev = prevId ? S.rows.get(prevId) : null;
  if (prevId && !prev) throw new Error('Adresa sa nenašla.');
  const f = parseFields(prev ? { ...fields, network: prev.network } : fields, prev);
  return { ...f, networkLabel: NETS[f.network].label, old: prev ? pub(prev) : null, willBeFirst: (() => { const others = enabledAddresses(f.network).filter((r) => !prev || r.id !== prev.id); return f.enabled && (!others.length || f.sort < others[0].sort); })() };
}
function state() {
  return { ok: true, networks: NET_ORDER.map((k) => ({ key: k, label: NETS[k].label, short: NETS[k].short, memo: NETS[k].memo, example: NETS[k].example, active: first(k) ? first(k).address : null })),
    rows: NET_ORDER.flatMap((k) => list(k)), counts: counts(), audit: S.audit.slice(0, 50) };
}

/* ---------- admin UI (checkout) ---------- */
const chunk = (a) => e(a).replace(/(.{4})/g, '$1\u200a');
function mount(app, { appendLog } = {}) {
  if (appendLog) log = appendLog;
  const { sameOrigin, nostore } = require('./payMethods');
  const css = `<style>
.wl-net{margin:0 0 .6rem;border:1px solid var(--line);border-radius:12px;padding:.2rem .8rem}.wl-net>summary{cursor:pointer;padding:.55rem 0;font-weight:600;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.pill{font-size:.75rem;border-radius:99px;padding:.1rem .5rem;background:#1e293b;color:var(--muted)}.pill.on{background:#14532d;color:#bbf7d0}.pill.off{background:#3f1d1d;color:#fecaca}
.addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;font-size:.86rem}.addr.big{font-size:1.05rem;line-height:1.6;background:#0d1524;border:1px solid var(--line);border-radius:10px;padding:.7rem;display:block}
table.wl td{vertical-align:middle}table.wl tr.off td{opacity:.55}.wl-actions{display:flex;gap:.35rem;flex-wrap:wrap}.wl-actions form{margin:0}.wl-actions button,.wl-actions .btn{padding:.4rem .65rem;font-size:.85rem}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}.chk{display:flex;align-items:center;gap:.5rem;color:var(--text)}.chk input{width:auto}
.first{color:#bbf7d0;font-size:.78rem}.hint{color:var(--muted);font-size:.85rem}dl.cf{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .9rem}dl.cf dt{color:var(--muted)}dl.cf dd{margin:0}
@media(max-width:640px){table.wl thead{display:none}table.wl tr{display:block;border-bottom:1px solid var(--line);padding:.5rem 0}table.wl td{display:block;border:0;padding:.2rem 0}.grid2{grid-template-columns:1fr}dl.cf{grid-template-columns:1fr}}
</style>`;
  const page = (req, title, body, msg = '', err = '') => layout({ title, userEmail: req.adminSession && req.adminSession.email,
    body: `${css}${msg ? `<div class="ok">${e(msg)}</div>` : ''}${err ? `<div class="err">${e(err)}</div>` : ''}${body}` });
  const MSG = { added: 'Adresa pridaná.', saved: 'Adresa uložená.', toggled: 'Stav adresy zmenený.' };
  const actorOf = (req) => (req.adminSession && req.adminSession.email) || 'admin';
  const guard = (req, res) => { if (!sameOrigin(req)) { res.status(403).send('Zakázané'); return false; } return true; };
  const netOpts = (sel) => NET_ORDER.map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${e(NETS[k].label)}</option>`).join('');

  function form(r, err) {
    const isNew = !r.id;
    return `<form method="post" action="/admin/platby/wallets/preview" class="card" id="${isNew ? 'pridat' : 'upravit'}"><h2>${isNew ? '➕ Pridať adresu' : '✏️ Upraviť adresu'}</h2>
${err ? `<div class="err">${e(err)}</div>` : ''}<input type="hidden" name="id" value="${e(r.id || '')}">
<div class="grid2"><div><label>Sieť / mena *</label>${isNew ? `<select name="network" required>${netOpts(r.network || 'btc')}</select>` : `<input type="hidden" name="network" value="${e(r.network)}"><div class="addr">${e(NETS[r.network].label)}</div>`}</div>
<div><label>Názov (pre vás, voliteľné)</label><input type="text" name="label" maxlength="60" value="${e(r.label || '')}" placeholder="napr. Trezor, Exodus…"></div></div>
<label>Verejná adresa na prijímanie *</label><input type="text" name="address" required maxlength="200" autocomplete="off" spellcheck="false" autocapitalize="off" value="${e(r.address || '')}" placeholder="Vložte adresu skopírovanú z peňaženky">
<p class="hint">Zadávajte iba verejnú adresu na prijímanie. Nikdy sem nevkladajte seed / súkromný kľúč.</p>
<div class="grid2"><div><label>Memo / Destination tag (len TON, XRP)</label><input type="text" name="memo" maxlength="120" value="${e(r.memo || '')}"></div>
<div><label>Poradie (nižšie = skôr; checkout berie prvú zapnutú)</label><input type="number" name="sort" min="0" max="100000" step="1" value="${r.sort != null ? e(r.sort) : ''}"></div></div>
<label class="chk"><input type="checkbox" name="enabled" value="1"${r.enabled !== false ? ' checked' : ''}> Zapnutá</label>
<p><button>Skontrolovať a pokračovať →</button> ${isNew ? '' : '<a class="btn" style="background:#334155" href="/admin/platby/wallets">Späť</a>'}</p></form>`;
  }
  function listPage(req, msg = '', err = '') {
    const st = state();
    const nets = st.networks.map((n) => {
      const rows = list(n.key); if (!rows.length) return '';
      const c = st.counts[n.key] || { on: 0, off: 0 }; const f = first(n.key);
      const trs = rows.map((r) => `<tr class="${r.enabled ? '' : 'off'}"><td><strong>${e(r.label || '—')}</strong>${f && f.id === r.id ? '<br><span class="first">✓ používa checkout</span>' : ''}</td>
<td><span class="addr">${e(r.address)}</span>${r.memo ? `<br><span class="hint">memo/tag: ${e(r.memo)}</span>` : ''}</td><td>${r.sort}</td>
<td><span class="pill ${r.enabled ? 'on' : 'off'}">${r.enabled ? 'zapnutá' : 'vypnutá'}</span></td>
<td><div class="wl-actions"><a class="btn" href="/admin/platby/wallets/edit/${e(r.id)}">Upraviť</a>
<form method="post" action="/admin/platby/wallets/toggle/${e(r.id)}"><input type="hidden" name="state" value="${r.enabled ? 'off' : 'on'}"><button class="${r.enabled ? 'secondary' : ''}">${r.enabled ? 'Vypnúť' : 'Zapnúť'}</button></form></div></td></tr>`).join('');
      return `<details class="wl-net"${n.key === 'evm' || rows.length < 4 ? ' open' : ''}><summary>${e(n.label)} <span class="pill on">${c.on} zap.</span>${c.off ? `<span class="pill off">${c.off} vyp.</span>` : ''}${f ? `<span class="addr hint">→ ${e(short(f.address))}</span>` : '<span class="pill off">mena sa na checkoute nezobrazí</span>'}</summary>
<table class="wl"><thead><tr><th>Názov</th><th>Adresa</th><th>Poradie</th><th>Stav</th><th></th></tr></thead><tbody>${trs}</tbody></table></details>`;
    }).join('');
    const missing = st.networks.filter((n) => !first(n.key)).map((n) => n.short).join(', ');
    const audit = st.audit.slice(0, 15).map((a) => `<tr><td>${e(new Date(a.at).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }))}</td><td>${e(a.actor)}</td><td>${e(a.action)}${a.network ? ' · ' + e(a.network) : ''}</td>
<td class="addr">${a.old && a.new && a.old.address !== a.new.address ? `${e(short(a.old.address))} → ${e(short(a.new.address))}` : a.new && a.new.address ? e(short(a.new.address)) : a.new && a.new.count != null ? e(a.new.count + ' adries') : ''}${a.old && a.new && a.old.enabled !== a.new.enabled ? ` (${a.new.enabled ? 'zapnutá' : 'vypnutá'})` : ''}</td></tr>`).join('');
    return page(req, 'Adresy peňaženiek', `<div class="card"><h1>👛 Adresy peňaženiek (priame krypto platby)</h1>
<p class="hint">Z týchto adries berie checkout adresu pre priamu platbu kryptom (QR kód, sledovanie platby, Telegram). Použije sa <strong>prvá zapnutá</strong> adresa danej siete. Mena bez zapnutej adresy sa zákazníkom nezobrazí. BTCPay si adresy generuje sám a používa sa len pri platbe „BTCPay“ – tento zoznam ho neovplyvňuje.</p>
${missing ? `<p class="hint">Bez adresy (skryté): ${e(missing)}</p>` : ''}<p><a class="btn" href="#pridat">➕ Pridať adresu</a></p></div>
${nets}${form({})}<div class="card"><h2>🧾 História zmien</h2><table class="wl"><thead><tr><th>Kedy</th><th>Kto</th><th>Akcia</th><th>Zmena</th></tr></thead><tbody>${audit || '<tr><td colspan="4" class="hint">Zatiaľ žiadne zmeny.</td></tr>'}</tbody></table></div>`, msg, err);
  }
  function confirmPage(req, p, id) {
    const hidden = ['network', 'label', 'address', 'memo', 'sort'].map((k) => `<input type="hidden" name="${k}" value="${e(p[k] == null ? '' : p[k])}">`).join('') +
      (p.enabled ? '<input type="hidden" name="enabled" value="1">' : '') + `<input type="hidden" name="id" value="${e(id || '')}"><input type="hidden" name="confirm" value="1">`;
    return page(req, 'Potvrdiť adresu', `<div class="card"><h1>Skontrolujte adresu pred uložením</h1>
<p class="hint">Porovnajte celú adresu znak po znaku s adresou vo vašej peňaženke (najmä začiatok a koniec).</p>
<dl class="cf"><dt>Sieť</dt><dd>${e(p.networkLabel)}</dd><dt>Názov</dt><dd>${e(p.label || '—')}</dd>
${p.old && p.old.address !== p.address ? `<dt>Doterajšia adresa</dt><dd><span class="addr">${e(p.old.address)}</span></dd>` : ''}
<dt>${p.old ? 'Nová adresa' : 'Adresa'}</dt><dd><code class="addr big">${chunk(p.address)}</code></dd>${p.memo ? `<dt>Memo / tag</dt><dd class="addr">${e(p.memo)}</dd>` : ''}
<dt>Poradie</dt><dd>${p.sort}</dd><dt>Stav</dt><dd>${p.enabled ? 'zapnutá' : 'vypnutá'}${p.willBeFirst ? ' – <strong>checkout ju začne hneď používať</strong>' : ''}</dd></dl>
<p class="hint">✓ Formát aj kontrolný súčet adresy sú v poriadku.</p>
<form method="post" action="/admin/platby/wallets/save">${hidden}<p><button>✅ Áno, adresa je správna – uložiť</button></p></form>
<form method="post" action="/admin/platby/wallets/back">${hidden.replace('name="confirm" value="1"', 'name="confirm" value="0"')}<button class="secondary">← Opraviť</button></form></div>`);
  }

  app.get('/admin/platby/wallets', (req, res) => { nostore(res); res.type('html').send(listPage(req, MSG[req.query.m] || '')); });
  app.get('/admin/platby/wallets/edit/:id', (req, res) => {
    nostore(res); const r = S.rows.get(String(req.params.id));
    if (!r) return res.status(404).type('html').send(listPage(req, '', 'Adresa sa nenašla.'));
    res.type('html').send(page(req, 'Upraviť adresu', form(r)));
  });
  const formBack = (req, res, err) => {
    const b = req.body || {}; const id = String(b.id || ''); const prev = id ? S.rows.get(id) : null;
    const r = { ...(prev || {}), network: prev ? prev.network : b.network, label: b.label, address: b.address, memo: b.memo, sort: b.sort, enabled: b.enabled === '1' };
    res.status(err ? 400 : 200).type('html').send(page(req, prev ? 'Upraviť adresu' : 'Pridať adresu', form(r, err)));
  };
  app.post('/admin/platby/wallets/preview', (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const b = req.body || {};
    try { res.type('html').send(confirmPage(req, preview(b, b.id ? String(b.id) : null), b.id ? String(b.id) : null)); } catch (x) { formBack(req, res, x.message); }
  });
  app.post('/admin/platby/wallets/back', (req, res) => { nostore(res); if (!guard(req, res)) return; formBack(req, res, ''); });
  app.post('/admin/platby/wallets/save', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    const b = req.body || {};
    if (b.confirm !== '1') return formBack(req, res, 'Najprv adresu skontrolujte a potvrďte.');
    try {
      if (b.id) await update(String(b.id), b, actorOf(req)); else await create(b, actorOf(req));
      res.redirect(303, '/admin/platby/wallets?m=' + (b.id ? 'saved' : 'added'));
    } catch (x) { formBack(req, res, x.message); }
  });
  app.post('/admin/platby/wallets/toggle/:id', async (req, res) => {
    nostore(res); if (!guard(req, res)) return;
    try { await setEnabled(String(req.params.id), req.body && req.body.state === 'on', actorOf(req)); res.redirect(303, '/admin/platby/wallets?m=toggled'); }
    catch (x) { res.status(400).type('html').send(listPage(req, '', x.message)); }
  });

  require('./adminSepa').addDashboardPanel(() => {
    const c = counts(); const nets = NET_ORDER.filter((k) => first(k));
    return `<div class="card"><h2>👛 Adresy peňaženiek</h2><p class="muted">Priame krypto platby: ${nets.length ? e(nets.map((k) => NETS[k].short).join(', ')) : 'žiadna zapnutá adresa'} · ${Object.values(c).reduce((s, x) => s + x.on, 0)} zapnutých adries.</p><a class="btn" href="/admin/platby/wallets">Spravovať adresy</a></div>`;
  });

  // signed bridge for the lnkbio admin (same secret / replay / rate limit as pay-methods)
  const bridgeActor = (b) => 'lnkbio-admin' + (b.actor ? ':' + String(b.actor).replace(/[^\w.@+-]/g, '').slice(0, 40) : '');
  require('./payMethods').serveSigned(app, BRIDGE_PATH, {
    state: async () => state(),
    get: async (b) => { const r = S.rows.get(String(b.id || '')); return r ? { ok: true, row: r, networkLabel: NETS[r.network].label } : { ok: false, status: 404, error: 'Adresa sa nenašla.' }; },
    preview: async (b) => ({ ok: true, preview: preview(b.fields || {}, b.id ? String(b.id) : null) }),
    create: async (b) => { if (b.confirm !== true) return { ok: false, status: 400, error: 'Chýba potvrdenie adresy.' }; return { ok: true, row: await create(b.fields || {}, bridgeActor(b)) }; },
    update: async (b) => { if (b.confirm !== true) return { ok: false, status: 400, error: 'Chýba potvrdenie adresy.' }; return { ok: true, row: await update(String(b.id || ''), b.fields || {}, bridgeActor(b)) }; },
    toggle: async (b) => ({ ok: true, row: await setEnabled(String(b.id || ''), b.state === 'on', bridgeActor(b)) }),
  }, 'WALLETS');
}

module.exports = { BRIDGE_PATH, NETWORKS: NETS, EVM_CHAINS, init, mount, list, first, forChain, enabledAddresses, counts, isReady, create, update, setEnabled, preview, state, short, _seedRows: seedRows };
