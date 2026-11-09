'use strict';
const http = require('http');
const https = require('https');
// Read-only subscription-panel adapters: only account status / expiry is ever requested or returned.
// Never requests, returns, logs or proxies streams, playlists or m3u URLs. Credentials are never logged.
const MAX_BODY = 2 * 1024 * 1024, TIMEOUT = 10000;
const UNLIMITED = '2099-12-31T00:00:00.000Z';

function normBase(u) {
  let s = String(u || '').trim(); if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let x; try { x = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password || !x.hostname) return null;
  let path = x.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  path = path.replace(/\/(player_api|panel_api|get)\.php$/i, '').replace(/\/stalker_portal(\/.*)?$/i, '').replace(/\/c$/, '');
  return x.origin + path;
}
/** Join a panel base with a path or query. Always strips trailing slashes from the base (keeps http://),
 *  avoids a double slash, and preserves a path prefix (http://host:8080/sub/ + player_api.php). */
function joinUrl(base, path = '') {
  const raw = String(base || '').trim();
  if (!raw) return String(path || '');
  const m = /^(https?:\/\/)/i.exec(raw);
  const head = m ? m[1] : '';
  const rest = (m ? raw.slice(head.length) : raw).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const root = head + rest;
  let p = String(path || '');
  if (!p) return root;
  if (p.startsWith('?') || p.startsWith('#')) return root + '/' + p;
  return root + '/' + p.replace(/^\/+/, '');
}
function tidyFullUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  const h = s.split('#');
  const q = h[0].split('?');
  return joinUrl(q[0], '') + (q.length > 1 ? '?' + q.slice(1).join('?') : '') + (h.length > 1 ? '#' + h.slice(1).join('#') : '');
}
function tidyReqUrl(url) {
  const s = String(url || '');
  try {
    const x = new URL(s);
    x.pathname = x.pathname.replace(/\/{2,}/g, '/');
    return x.toString();
  } catch { return s; }
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

function sameSafeRedirect(from, loc) {
  let next; try { next = new URL(loc, from); } catch { return null; }
  if (!/^https?:$/.test(next.protocol)) return null;
  let src; try { src = new URL(from); } catch { return null; }
  const hostOk = next.hostname === src.hostname;
  const httpsUp = src.protocol === 'http:' && next.protocol === 'https:' && hostOk;
  const sameOrigin = next.origin === src.origin;
  if (!(httpsUp || sameOrigin)) return null;
  return next.href;
}
/** Panel HTTP(S) only – rejectUnauthorized is false so a self-signed panel cert works. Not used for the site itself. */
function panelRequest(url, opt = {}) {
  return new Promise((ok, bad) => {
    url = tidyReqUrl(url);
    let x; try { x = new URL(url); } catch { return bad(new Error('neplatná URL')); }
    const lib = x.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (lnkbio subscription check)', ...(opt.headers || {}) };
    const req = lib.request(url, {
      method: opt.method || 'GET',
      headers,
      timeout: TIMEOUT,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > (opt.maxBody || MAX_BODY) + 1) { req.destroy(new Error('response too large')); } });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const headersMap = { get: (k) => { const v = res.headers[String(k || '').toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v || null); } };
        ok({ status: res.statusCode, headers: headersMap, text: async () => buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('časový limit spojenia')));
    req.on('error', bad);
    const sig = opt.signal;
    if (sig) {
      if (sig.aborted) { req.destroy(sig.reason || new Error('aborted')); return; }
      sig.addEventListener('abort', () => req.destroy(sig.reason || new Error('aborted')), { once: true });
    }
    if (opt.body) req.write(opt.body);
    req.end();
  });
}
function create({ fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || panelRequest;
  async function getJsonOnce(url, opt = {}, hops = 0) {
    const limit = opt.maxBody || MAX_BODY;
    url = tidyReqUrl(url);
    const fetchOpt = { method: opt.method || 'GET', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (lnkbio subscription check)', ...(opt.headers || {}) }, body: opt.body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT), maxBody: limit };
    const r = await doFetch(url, fetchOpt);
    const loc = r.headers && r.headers.get && r.headers.get('location');
    if (hops < 3 && loc && [301, 302, 303, 307, 308].includes(r.status)) {
      const next = sameSafeRedirect(url, loc);
      if (next) return getJsonOnce(next, opt, hops + 1);
    }
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
    if (len > limit) throw new Error('response too large');
    const ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
    if (/mpegurl|octet-stream|video|audio/i.test(ct)) throw new Error('unexpected content');
    const t = await r.text(); if (t.length > limit) throw new Error('response too large');
    let j = null; try { j = JSON.parse(t); } catch { j = null; }
    return { status: r.status, json: j };
  }
  async function getJson(url, opt = {}) {
    return getJsonOnce(url, opt);
  }
  const q = (o) => new URLSearchParams(o).toString();
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

  function asList(json) {
    if (Array.isArray(json)) return json;
    if (!json || typeof json !== 'object') return null;
    const a = json.data || json.lines || json.users || json.results;
    if (Array.isArray(a)) return a;
    if (a && typeof a === 'object' && !Array.isArray(a)) return Object.values(a);
    if (json.users && typeof json.users === 'object') return Object.values(json.users);
    return null;
  }
  function lineExtra(row) {
    if (!row || typeof row !== 'object') return {};
    const status = String(row.status || row.line_status || '');
    const banned = Number(row.is_banned) === 1 || Number(row.banned) === 1 || /banned/i.test(status);
    const disabled = Number(row.enabled) === 0 || Number(row.admin_enabled) === 0 || /disabled/i.test(status);
    const extra = { status: banned ? 'Banned' : (disabled ? 'Disabled' : status), enabled: !banned && !disabled };
    const cons = Number(row.active_cons), maxc = Number(row.max_connections);
    if (Number.isFinite(cons) || Number.isFinite(maxc)) extra.connections = { active: Number.isFinite(cons) ? cons : 0, max: Number.isFinite(maxc) ? maxc : 0 };
    return extra;
  }
  function lineExpiry(row) {
    const v = row.exp_date != null ? row.exp_date : (row.expire != null ? row.expire : (row.expires_at != null ? row.expires_at : row.expiry));
    return v == null || v === '' ? 'unlimited' : parseDate(v);
  }
  function fromLine(row, username) {
    if (!row || typeof row !== 'object') return result(false, null);
    const un = String(row.username || row.user || row.login || '');
    if (username && un && un.toLowerCase() !== String(username).toLowerCase()) return result(false, null);
    if (username && !un) return result(false, null);
    return result(true, lineExpiry(row), lineExtra(row));
  }
  function publicView(r, extra = {}) {
    if (!r || r.error) return { found: false, error: true };
    const out = { found: !!r.found, active: !!r.active, expiry: r.expiry || null, status: r.status || '', connections: r.connections || null, ...extra };
    return out;
  }

  // ---- adapters ----
  const xtream = {
    id: 'xtream', label: 'Xtream Codes API (player_api.php – Xtream UI, XUI.one, 1-stream…)',
    /** verify a line with its own credentials (customer or public check) */
    async checkLine(base, user, pass) {
      const { status, json } = await getJson(`${joinUrl(base, "player_api.php")}?${q({ username: user, password: pass })}`);
      const ui = json && json.user_info;
      if (status >= 400 || !ui) return status === 401 || status === 403 || (json && json.user_info === undefined && Array.isArray(json)) ? result(false, null) : null;
      if (String(ui.auth) !== '1') return result(false, null, { authFailed: true });
      const cons = Number(ui.active_cons), maxc = Number(ui.max_connections);
      const extra = { status: String(ui.status || ''), enabled: !/^(banned|disabled|expired)$/i.test(String(ui.status || '')) || false };
      if (Number.isFinite(cons) || Number.isFinite(maxc)) extra.connections = { active: Number.isFinite(cons) ? cons : 0, max: Number.isFinite(maxc) ? maxc : 0 };
      return result(true, ui.exp_date == null || ui.exp_date === '' ? 'unlimited' : parseDate(ui.exp_date), extra);
    },
    async detect(c) { const r = await xtream.checkLine(c.base, c.user, c.pass).catch(() => null); return r && r.found ? { ok: true, note: 'Prihlasovacie údaje fungujú ako linka – vyhľadanie iných používateľov ide cez admin API (panel_api / Xtream UI) alebo cez uložený zoznam mien.' } : null; },
    lookup: null,
  };
  const xui = {
    id: 'xui', label: 'Xtream UI / XUI.one admin API (meno a heslo administrátora)',
    async adminGet(c, action, extra = {}) {
      if (!c.user || !c.pass) return null;
      const body = q({ username: c.user, password: c.pass, action, ...extra });
      const post = await getJson(joinUrl(c.base, "?" + q({ action, ...extra })), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      if (post.json != null) return post.json;
      if (post.status === 404 || post.status === 405 || post.status === 501) return null;
      const get = await getJson(joinUrl(c.base, "?" + q({ username: c.user, password: c.pass, action, ...extra })));
      return get.json;
    },
    async apiPhp(c, sub, data) {
      if (!c.user || !c.pass) return null;
      const body = q({ username: c.user, password: c.pass, ...(data ? { data: JSON.stringify(data) } : {}) });
      const { json } = await getJson(joinUrl(c.base, "api.php?action=user&sub=" + encodeURIComponent(sub)), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      return json;
    },
    async lines(c) {
      const json = await xui.adminGet(c, 'get_lines');
      const arr = asList(json);
      if (arr) return arr;
      const listed = await xui.apiPhp(c, 'list').catch(() => null);
      return asList(listed);
    },
    async detect(c) {
      if (!c.user || !c.pass) return null;
      const a = await xui.lines(c).catch(() => null);
      if (a) return { ok: true, note: `Admin API odpovedá (${a.length} liniek).` };
      const p = await xui.apiPhp(c, 'info', { username: '__lnkbio_probe__' }).catch(() => null);
      if (p && typeof p === 'object' && ('result' in p || p.data || p.user_info)) return { ok: true, note: 'Admin API (api.php) odpovedá.' };
      return null;
    },
    async lookup(c, username) {
      if (!c.user || !c.pass) return { error: 'nocreds' };
      // get_line uses line_username/line/search – admin auth already occupies username=
      let json = await xui.adminGet(c, 'get_line', { line_username: username }).catch(() => null);
      let row = json && (json.data || json.user_info || json);
      if (Array.isArray(row)) row = row[0];
      let r = fromLine(row, username);
      if (r.found) return r;
      json = await xui.adminGet(c, 'get_line', { line: username, search: username }).catch(() => null);
      row = json && (json.data || json.user_info || json);
      if (Array.isArray(row)) row = row[0];
      r = fromLine(row, username);
      if (r.found) return r;
      const info = await xui.apiPhp(c, 'info', { username }).catch(() => null);
      row = info && (info.data || info.user_info || (info.result && info.result !== false ? info : null));
      if (Array.isArray(row)) row = row[0];
      r = fromLine(row, username);
      if (r.found) return r;
      const a = await xui.lines(c).catch(() => null);
      row = (a || []).find((x) => String((x && (x.username || x.user || x.login)) || '').toLowerCase() === username.toLowerCase());
      if (!row) return result(false, null);
      return fromLine(row, username);
    },
  };
  const panelApi = {
    id: 'panel_api', label: 'Xtream panel_api.php (reseller zoznam používateľov)',
    async users(c) {
      const { json } = await getJson(`${joinUrl(c.base, "panel_api.php")}?${q({ username: c.user, password: c.pass })}`);
      if (!json || typeof json !== 'object') return null;
      return asList(json);
    },
    async detect(c) { const l = await panelApi.users(c).catch(() => null); return l ? { ok: true, note: `panel_api.php vracia zoznam (${l.length}).` } : null; },
    async lookup(c, username) {
      const l = await panelApi.users(c); if (!l) throw new Error('panel_api nedostupné');
      const row = l.find((x) => String((x && (x.username || x.user)) || '').toLowerCase() === username.toLowerCase());
      if (!row) return result(false, null);
      return fromLine(row, username);
    },
  };
  const stalker = {
    id: 'stalker', label: 'Stalker / Ministra portal (REST API)',
    async get(c, login) { return getJson(joinUrl(c.base, "stalker_portal/api/accounts/" + encodeURIComponent(login)), { headers: { authorization: basic(c.user, c.pass) } }); },
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
    url(c, username) { return String(c.tpl).replace(/\{username\}/g, encodeURIComponent(username)).replace(/\{base\}/g, joinUrl(c.base || '', "")); },
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
  /** Live channel catalog (names, logos, categories, tvg-id only). Never requests get.php / m3u / stream paths. */
  async function liveCatalog(c) {
    const CHS = require('./chsync');
    if (!c || !c.base || !c.user || !c.pass) return { items: [], skipped: 0, error: 'nocreds' };
    const opt = { maxBody: 8 * 1024 * 1024 };
    const cats = await getJson(`${joinUrl(c.base, "player_api.php")}?${q({ username: c.user, password: c.pass, action: 'get_live_categories' })}`, opt);
    const streams = await getJson(`${joinUrl(c.base, "player_api.php")}?${q({ username: c.user, password: c.pass, action: 'get_live_streams' })}`, opt);
    if (!Array.isArray(streams.json)) return { items: [], skipped: 0, error: 'badlist' };
    return CHS.fromXtream(Array.isArray(cats.json) ? cats.json : [], streams.json);
  }
  /** Short EPG for one stream_id. Returns raw JSON (parsed listings happen in shortepg). */
  async function shortEpg(c, streamId, { limit = 4 } = {}) {
    if (!c || !c.base || !c.user || !c.pass) return null;
    const sid = Math.round(Number(streamId));
    if (!Number.isInteger(sid) || sid <= 0) return null;
    const { status, json } = await getJson(`${joinUrl(c.base, "player_api.php")}?${q({ username: c.user, password: c.pass, action: 'get_short_epg', stream_id: String(sid), limit: String(limit) })}`);
    if (status >= 400 || json == null) return null;
    return json;
  }
  return { detect, lookup, checkOwn, liveCatalog, shortEpg, ADAPTERS, publicView, fromLine, clear: () => cache.clear() };
}
module.exports = { create, normBase, joinUrl, tidyReqUrl, tidyFullUrl, parseDate, getPath, UNLIMITED, sameSafeRedirect };
