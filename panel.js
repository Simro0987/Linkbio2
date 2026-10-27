'use strict';
// Read-only subscription-panel adapters: only account status / expiry is ever requested or returned.
// Never requests, returns, logs or proxies streams, playlists or m3u URLs. Credentials are never logged.
const MAX_BODY = 2 * 1024 * 1024, TIMEOUT = 10000;
const UNLIMITED = '2099-12-31T00:00:00.000Z';

function normBase(u) {
  let s = String(u || '').trim(); if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let x; try { x = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return null;
  return x.origin + x.pathname.replace(/\/+$/, '').replace(/\/(player_api|panel_api|get)\.php$/i, '').replace(/\/stalker_portal(\/.*)?$/i, '').replace(/\/c$/, '');
}
/** parse many date shapes -> ISO string | 'unlimited' | null */
function parseDate(v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  if (typeof v === 'string' && /^(unlimited|never|neobmedzene|0000-00-00.*)$/i.test(v.trim())) return 'unlimited';
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v).trim())) { let n = Number(v); if (n > 1e12) n /= 1000; if (n <= 0) return null; return new Date(n * 1000).toISOString(); }
  const s = String(v).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(:\d{2})?)$/, '$1T$2Z');
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s); if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 23, 59, 59)).toISOString();
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T23:59:59Z' : s);
  return isNaN(d) ? null : d.toISOString();
}
const getPath = (o, p) => String(p || '').split('.').filter(Boolean).reduce((a, k) => (a == null ? a : Array.isArray(a) && /^\d+$/.test(k) ? a[+k] : a[k]), o);
const result = (found, expiry, extra = {}) => {
  const exp = expiry === 'unlimited' ? UNLIMITED : expiry;
  return { found: !!found, expiry: exp || null, active: !!found && (!exp || new Date(exp) > new Date()) && extra.enabled !== false, ...extra };
};

function create({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  async function getJson(url, opt = {}) {
    const r = await fetchImpl(url, { method: opt.method || 'GET', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (lnkbio subscription check)', ...(opt.headers || {}) }, body: opt.body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
    if (len > MAX_BODY) throw new Error('response too large');
    const ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
    if (/mpegurl|octet-stream|video|audio/i.test(ct)) throw new Error('unexpected content');
    const t = await r.text(); if (t.length > MAX_BODY) throw new Error('response too large');
    let j = null; try { j = JSON.parse(t); } catch { j = null; }
    return { status: r.status, json: j };
  }
  const q = (o) => new URLSearchParams(o).toString();
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

  // ---- adapters ----
  const xtream = {
    id: 'xtream', label: 'Xtream Codes API (player_api.php – Xtream UI, XUI.one, 1-stream…)',
    /** verify a line with its own credentials (customer or public check) */
    async checkLine(base, user, pass) {
      const { status, json } = await getJson(`${base}/player_api.php?${q({ username: user, password: pass })}`);
      const ui = json && json.user_info;
      if (status >= 400 || !ui) return status === 401 || status === 403 || (json && json.user_info === undefined && Array.isArray(json)) ? result(false, null) : null;
      if (String(ui.auth) !== '1') return result(false, null, { authFailed: true });
      return result(true, ui.exp_date == null || ui.exp_date === '' ? 'unlimited' : parseDate(ui.exp_date), { status: String(ui.status || ''), enabled: !/^(banned|disabled|expired)$/i.test(String(ui.status || '')) || false });
    },
    async detect(c) { const r = await xtream.checkLine(c.base, c.user, c.pass).catch(() => null); return r && r.found ? { ok: true, note: 'Prihlasovacie údaje fungujú ako linka – vyhľadanie iných používateľov vyžaduje ich heslo (alebo API kľúč XUI.one).' } : null; },
    lookup: null,
  };
  const xui = {
    id: 'xui', label: 'XUI.one admin/reseller API (api_key)',
    async lines(c) {
      const { json } = await getJson(`${c.base}/?${q({ api_key: c.key, action: 'get_lines' })}`);
      const arr = Array.isArray(json) ? json : json && (Array.isArray(json.data) ? json.data : Array.isArray(json.lines) ? json.lines : null);
      return arr;
    },
    async detect(c) { if (!c.key) return null; const a = await xui.lines(c).catch(() => null); return a ? { ok: true, note: `API odpovedá (${a.length} liniek).` } : null; },
    async lookup(c, username) {
      const { json } = await getJson(`${c.base}/?${q({ api_key: c.key, action: 'get_line', username })}`).catch(() => ({ json: null }));
      let row = json && (json.data || json); if (Array.isArray(row)) row = row[0];
      if (!row || String(row.username || '').toLowerCase() !== username.toLowerCase()) { const a = await xui.lines(c); row = (a || []).find((x) => String(x.username || '').toLowerCase() === username.toLowerCase()); }
      if (!row) return result(false, null);
      return result(true, row.exp_date == null || row.exp_date === '' ? 'unlimited' : parseDate(row.exp_date), { enabled: !(Number(row.enabled) === 0 || Number(row.admin_enabled) === 0) });
    },
  };
  const panelApi = {
    id: 'panel_api', label: 'Xtream panel_api.php (reseller zoznam používateľov)',
    async users(c) {
      const { json } = await getJson(`${c.base}/panel_api.php?${q({ username: c.user, password: c.pass })}`);
      if (!json || typeof json !== 'object') return null;
      const list = Array.isArray(json.users) ? json.users : Array.isArray(json.lines) ? json.lines : json.users && typeof json.users === 'object' ? Object.values(json.users) : null;
      return list;
    },
    async detect(c) { const l = await panelApi.users(c).catch(() => null); return l ? { ok: true, note: `panel_api.php vracia zoznam (${l.length}).` } : null; },
    async lookup(c, username) {
      const l = await panelApi.users(c); if (!l) throw new Error('panel_api nedostupné');
      const row = l.find((x) => String(x.username || '').toLowerCase() === username.toLowerCase());
      if (!row) return result(false, null);
      return result(true, row.exp_date == null || row.exp_date === '' ? 'unlimited' : parseDate(row.exp_date), { enabled: !(Number(row.enabled) === 0 || Number(row.admin_enabled) === 0) });
    },
  };
  const stalker = {
    id: 'stalker', label: 'Stalker / Ministra portal (REST API)',
    async get(c, login) { return getJson(`${c.base}/stalker_portal/api/accounts/${encodeURIComponent(login)}`, { headers: { authorization: basic(c.user, c.pass) } }); },
    async detect(c) { const r = await stalker.get(c, '__lnkbio_probe__').catch(() => null); return r && r.json && typeof r.json.status === 'string' && ('results' in r.json || 'error' in r.json) ? { ok: true, note: 'Ministra REST API odpovedá.' } : null; },
    async lookup(c, username) {
      const { json } = await stalker.get(c, username);
      if (!json || json.status !== 'OK') return result(false, null);
      let row = json.results; if (Array.isArray(row)) row = row[0]; if (!row) return result(false, null);
      const exp = parseDate(row.tariff_expired_date || row.end_date || row.expire_billing_date || null);
      return result(true, exp || 'unlimited', { enabled: !(Number(row.status) === 0 && row.status !== undefined) });
    },
  };
  const custom = {
    id: 'custom', label: 'Vlastné API (URL šablóna + JSON pole s dátumom)',
    url(c, username) { return String(c.tpl).replace(/\{username\}/g, encodeURIComponent(username)).replace(/\{base\}/g, c.base || ''); },
    async detect(c) { if (!c.tpl || !c.datePath) return null; if (!/^https?:\/\//i.test(custom.url(c, 'test'))) return null; return { ok: true, note: 'Použije sa vaša šablóna.' }; },
    async lookup(c, username) {
      const { status, json } = await getJson(custom.url(c, username), c.user ? { headers: { authorization: basic(c.user, c.pass) } } : {});
      if (status === 404 || !json) return result(false, null);
      const raw = getPath(json, c.datePath); if (raw === undefined) return result(false, null);
      return result(true, parseDate(raw) || (raw === null ? 'unlimited' : null));
    },
  };
  const ADAPTERS = { custom, xui, stalker, panel_api: panelApi, xtream };

  async function detect(c) {
    const order = c.tpl ? ['custom', 'xui', 'stalker', 'panel_api', 'xtream'] : ['xui', 'stalker', 'panel_api', 'xtream'];
    const tried = [];
    for (const id of order) { try { const r = await ADAPTERS[id].detect(c); tried.push(id); if (r) return { type: id, label: ADAPTERS[id].label, canLookup: !!ADAPTERS[id].lookup, note: r.note, tried }; } catch { tried.push(id); } }
    return { type: null, tried };
  }
  // cache 15 min
  const cache = new Map(); const TTL = 15 * 60e3;
  const cached = async (k, fn) => { const c = cache.get(k); if (c && now() - c.at < TTL) return c.v; const v = await fn(); if (v && !v.error) cache.set(k, { at: now(), v }); if (cache.size > 5000) cache.delete(cache.keys().next().value); return v; };
  /** admin-side lookup of a panel username (no customer password) */
  async function lookup(c, username) {
    const a = ADAPTERS[c.type]; if (!a || !a.lookup) return { error: 'nolookup' };
    return cached(`L:${c.type}:${username.toLowerCase()}`, () => a.lookup(c, username));
  }
  /** customer-side check with their own panel username + password (Xtream player_api) – password never stored */
  async function checkOwn(c, username, password, cacheKey) {
    if (c.type === 'stalker' || c.type === 'custom') { return { error: 'unsupported' }; }
    const go = () => xtream.checkLine(c.base, username, password);
    return cacheKey ? cached('O:' + cacheKey, go) : go();
  }
  return { detect, lookup, checkOwn, ADAPTERS, clear: () => cache.clear() };
}
module.exports = { create, normBase, parseDate, getPath, UNLIMITED };
