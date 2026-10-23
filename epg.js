'use strict';
// TV program (EPG) per channel + homepage "Dnes v TV".
// Source: epgshare01.online free XMLTV files (schedule metadata only: channel id/name, time, title, category, short description).
// Never stores or shows stream URLs, playlists (M3U) or Xtream data.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tx } = require('./uitext');
const C = require('./epgcore');
const POSTER = require('./posters');

const TZ = 'Europe/Bratislava';
const FEED_URL = (f) => `https://epgshare01.online/epgshare01/epg_ripper_${f}.xml.gz`;
const FEEDS_ALL = ['SK1', 'CZ1', 'HU1', 'PL1', 'DE1', 'AT1', 'CH1', 'UK1', 'NL1', 'UA1', 'IT1', 'FR1', 'ES1', 'RO1', 'HR1', 'RS1'];
const D = { epg_on: '1', epg_feeds: 'SK1,CZ1,HU1,PL1,DE1,AT1,CH1,UK1,NL1,UA1,IT1,FR1,ES1', epg_hours: '6', epg_ahead: '36', epg_skip: 'VOD\nRádi\nWebkam\n18+\nzápasy', dnes_on: '1', dnes_max: '8', dnes_kinds: 'film,sport,show', dnes_title: 'Dnes v TV', dnes_title_en: 'Today on TV' };
const UA = { 'user-agent': 'lnkbio-epg/1.0 (+https://lnkbio.onrender.com)' };
const ASSET_V = (() => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static/epg.js')) + fs.readFileSync(path.join(__dirname, 'static/epg.css'))).digest('hex').slice(0, 8); } catch { return '1'; } })();
const ADULT = /pre dospelých|pro dospělé|erotic|erotik|\bxxx\b|\badult\b|18\+/i;
const JUNK = /přestávka|prestavka|nevysiela|nevysílá|nočné vysielanie|noční vysílání|teleshop|teleshopping|programme resumes|sendepause|koniec vysielania|konec vysílání|^\s*-\s*$|^\s*(n\/a|tba|tbd)\s*$/i;
const tnorm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- time helpers (Europe/Bratislava) ----------
const fmtHM = new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const hm = (ms) => fmtHM.format(new Date(ms));
function parts(ms) { const o = {}; for (const p of fmtParts.formatToParts(new Date(ms))) o[p.type] = +p.value || p.value; return o; }
function tzOff(ms) { const p = parts(ms); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000; }
function dayStart(ms) { const p = parts(ms); const g = Date.UTC(p.year, p.month - 1, p.day); return g - tzOff(g - tzOff(g)); }
const localHour = (ms) => { const p = parts(ms); return (p.hour % 24) + p.minute / 60; };
// datetime-local "2026-10-23T20:15" (Bratislava) → ms
function fromLocal(v) { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(v || '')); if (!m) return NaN; const g = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]); return g - tzOff(g - tzOff(g)); }
function toLocal(ms) { const p = parts(ms); const z = (n) => String(n).padStart(2, '0'); return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour % 24)}:${z(p.minute)}`; }

module.exports = function install(ctx) {
  const { app, admin, pool, page, esc, hid, csrf, needAuth, wrap, getSettings, setSettings } = ctx;
  const cfg = (s) => { const o = {}; for (const k of Object.keys(D)) o[k] = s[k] == null || s[k] === '' && !/^(epg_skip)$/.test(k) ? D[k] : String(s[k]); return o; };
  const feedsOf = (c) => [...new Set(String(c.epg_feeds || '').toUpperCase().split(/[\s,;]+/).filter((f) => /^[A-Z]{2,12}\d{1,2}$/.test(f)))].slice(0, 20);
  const skipOf = (c) => String(c.epg_skip || '').split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter((x) => x && x !== '-');
  const skipped = (cat, sk) => { const c = String(cat || '').toLowerCase(); return sk.some((x) => c.includes(x)); };
  const kv = { get: async (k) => ((await pool.query('SELECT v FROM epg_kv WHERE k=$1', [k])).rows[0] || {}).v, set: (k, v) => pool.query('INSERT INTO epg_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, String(v)]) };
  let mapCache = null, nowCache = null, dnesCache = null; const dayCache = new Map();
  const dropCaches = () => { mapCache = null; nowCache = null; dnesCache = null; dayCache.clear(); };
  const channels = async () => (ctx.tvchAll ? ctx.tvchAll() : (await pool.query('SELECT id,name,category,logo,ord,visible FROM tv_channels ORDER BY ord,id')).rows);
  const loadMap = async () => mapCache || (mapCache = new Map((await pool.query('SELECT channel_id,epg_id,manual,score FROM epg_map')).rows.map((r) => [r.channel_id, r])));

  ctx.epgInit = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_chan (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', names TEXT NOT NULL DEFAULT '', feed TEXT NOT NULL DEFAULT '', n INT NOT NULL DEFAULT -1, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_map (channel_id INT PRIMARY KEY, epg_id TEXT NOT NULL DEFAULT '', manual BOOLEAN NOT NULL DEFAULT false, score REAL NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_prog (epg_id TEXT NOT NULL, s TIMESTAMPTZ NOT NULL, e TIMESTAMPTZ NOT NULL, title TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL DEFAULT '', yr TEXT NOT NULL DEFAULT '', fl TEXT NOT NULL DEFAULT '', PRIMARY KEY (epg_id, s))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS epg_prog_s ON epg_prog (s)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dnes_pin (id SERIAL PRIMARY KEY, channel_id INT NOT NULL, s TIMESTAMPTZ NOT NULL, e TIMESTAMPTZ NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dnes_hide (k TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_poster (k TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    schedule();
  };

  // ---------- fetching ----------
  const status = { running: false, phase: '', feed: '', started: 0 };
  async function open(feed, signal) {
    const r = await fetch(FEED_URL(feed), { headers: UA, signal, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    return r.body;
  }
  async function readChannels(feed) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 120e3);
    const out = [];
    try { await C.parseStream(await open(feed, ac.signal), { gz: true, channelsOnly: true, onChannel: (c) => { if (c.id && out.length < 5000) out.push({ id: C.clip(c.id, 120), names: c.names.slice(0, 4).map((n) => C.clip(n, 120)), feed }); } }); }
    finally { clearTimeout(t); ac.abort(); }
    return out;
  }
  async function readProgs(feed, want, from, to, onBatch) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 300e3);
    const counts = new Map(); let rows = [], kept = 0;
    try {
      await C.parseStream(await open(feed, ac.signal), {
        gz: true,
        onProg: (p) => {
          if (!p.ch || !(p.stop > from) || !(p.start < to) || !(p.stop > p.start)) return;
          counts.set(p.ch, (counts.get(p.ch) || 0) + 1);
          if (!want.has(p.ch)) return;
          const d = C.progDetails(p); if (!d.title) return;
          const dur = (p.stop - p.start) / 60e3;
          let kind = ADULT.test(d.cat) ? 'adult' : C.classify(d.cat, d.title);
          if (kind === 'film' && dur < 65) kind = dur < 20 ? '' : 'series';
          rows.push([p.ch, new Date(p.start), new Date(p.stop), d.title, d.sub, d.cat, kind, d.desc, d.year, (d.live ? 'l' : '') + (d.rerun ? 'r' : '') + (d.premiere ? 'p' : '')]); kept++;
          if (kept > 400000) return 'stop';
        },
      });
    } finally { clearTimeout(t); ac.abort(); }
    return { rows, counts };
  }
  async function insertProgs(c, rows) {
    // dedupe by (epg_id, s)
    const seen = new Set(); rows = rows.filter((r) => { const k = r[0] + '|' + +r[1]; if (seen.has(k)) return false; seen.add(k); return true; });
    for (let i = 0; i < rows.length; i += 1000) {
      const b = rows.slice(i, i + 1000); const cols = Array.from({ length: 10 }, (_, j) => b.map((r) => r[j]));
      await c.query(`INSERT INTO epg_prog (epg_id,s,e,title,sub,cat,kind,descr,yr,fl) SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::timestamptz[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[]) ON CONFLICT (epg_id,s) DO NOTHING`, cols);
    }
  }
  async function computeMap(c, chans, epgRows) {
    const ix = C.buildIndex(epgRows.map((r) => ({ id: r.id, names: r.names ? r.names.split('\n') : [r.name], feed: r.feed, n: r.n })));
    const sk = skipOf(c), cur = await loadMap(), res = new Map(), want = new Set();
    for (const ch of chans) {
      const m = cur.get(ch.id);
      if (m && m.manual) { if (m.epg_id) want.add(m.epg_id); continue; }
      if (skipped(ch.category, sk)) { res.set(ch.id, { epg_id: '', score: 0 }); continue; }
      const cand = C.candidates(ix, ch.name, ch.category, 4).filter((x) => x.sim >= C.MATCH_MIN);
      cand.slice(0, 3).forEach((x) => want.add(x.id));
      const best = cand.find((x) => C.isMatch(x));
      res.set(ch.id, best ? { epg_id: best.id, score: best.sim } : { epg_id: '', score: cand[0] ? cand[0].sim : 0 });
    }
    return { res, want };
  }
  async function saveMap(res) {
    const ids = [...res.keys()]; if (!ids.length) return;
    await pool.query(`INSERT INTO epg_map (channel_id,epg_id,manual,score,updated_at) SELECT a,b,false,c,now() FROM unnest($1::int[],$2::text[],$3::real[]) AS t(a,b,c)
      ON CONFLICT (channel_id) DO UPDATE SET epg_id=EXCLUDED.epg_id, score=EXCLUDED.score, updated_at=now() WHERE NOT epg_map.manual`, [ids, ids.map((i) => res.get(i).epg_id), ids.map((i) => res.get(i).score)]);
    mapCache = null;
  }

  let running = null;
  function refresh(opt = {}) {
    if (running) return running;
    running = doRefresh(opt).catch((e) => { console.error('EPG refresh failed:', e.message); kv.set('last_err', new Date().toISOString() + ' ' + String(e.message).slice(0, 300)).catch(() => {}); })
      .finally(() => { running = null; status.running = false; status.phase = ''; status.feed = ''; dropCaches(); });
    return running;
  }
  async function doRefresh(opt) {
    const c = cfg(await getSettings()); const t0 = Date.now();
    Object.assign(status, { running: true, started: t0, phase: 'kanály', feed: '' });
    let feeds = feedsOf(c); if (opt.feeds) feeds = feeds.filter((f) => opt.feeds.includes(f));
    const report = {};
    // phase 1: channel lists (download aborts at the first <programme>, only a few kB per feed)
    if (!opt.feeds) for (const f of feeds) {
      status.feed = f;
      try {
        const list = await readChannels(f); report[f] = { ch: list.length };
        if (list.length) await pool.query(`INSERT INTO epg_chan (id,name,names,feed,seen_at) SELECT a,b,c,d,now() FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS t(a,b,c,d) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,names=EXCLUDED.names,feed=EXCLUDED.feed,seen_at=now()`, [list.map((x) => x.id), list.map((x) => x.names[0] || x.id), list.map((x) => x.names.join('\n')), list.map((x) => f)]);
      } catch (e) { report[f] = { err: String(e.message).slice(0, 120) }; }
    }
    await pool.query(`DELETE FROM epg_chan WHERE NOT (feed = ANY($1)) OR seen_at < now() - interval '14 days'`, [feedsOf(c)]);
    const chans = await channels();
    let epgRows = (await pool.query('SELECT id,name,names,feed,n FROM epg_chan')).rows;
    // phase 2: provisional auto-mapping + candidate set
    status.phase = 'párovanie';
    let { want } = await computeMap(c, chans, epgRows);
    // phase 3: programmes, one feed at a time (streamed, only wanted channels within the window)
    const now = Date.now(), from = Math.min(dayStart(now), now - 3 * 3600e3), to = now + Math.max(12, Math.min(72, +c.epg_ahead || 36)) * 3600e3;
    const byFeed = new Map(); for (const r of epgRows) { if (!byFeed.has(r.feed)) byFeed.set(r.feed, []); byFeed.get(r.feed).push(r.id); }
    status.phase = 'program';
    for (const f of feeds) {
      const ids = (byFeed.get(f) || []).filter((i) => want.has(i)); if (!ids.length) { (report[f] = report[f] || {}).progs = 0; continue; }
      status.feed = f;
      try {
        const { rows, counts } = await readProgs(f, new Set(ids), from, to);
        const cl = await pool.connect();
        try {
          await cl.query('BEGIN');
          await cl.query('DELETE FROM epg_prog WHERE epg_id = ANY($1)', [ids]);
          await insertProgs(cl, rows);
          const all = byFeed.get(f); await cl.query('UPDATE epg_chan SET n = COALESCE(x.n, 0) FROM (SELECT a, b AS n FROM unnest($1::text[],$2::int[]) AS t(a,b)) x WHERE epg_chan.id = x.a', [all, all.map((i) => counts.get(i) || 0)]);
          await cl.query('COMMIT');
        } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
        Object.assign(report[f] = report[f] || {}, { progs: rows.length, withData: [...counts.keys()].length });
      } catch (e) { (report[f] = report[f] || {}).err = String(e.message).slice(0, 120); }
    }
    // phase 4: final mapping now that we know which EPG channels really have data
    status.phase = 'ukladanie';
    epgRows = (await pool.query('SELECT id,name,names,feed,n FROM epg_chan')).rows;
    const fin = await computeMap(c, chans, epgRows); await saveMap(fin.res);
    await pool.query(`DELETE FROM epg_map WHERE channel_id NOT IN (SELECT id FROM tv_channels)`);
    await pool.query(`DELETE FROM epg_prog WHERE e < $1 OR epg_id NOT IN (SELECT epg_id FROM epg_map WHERE epg_id <> '')`, [new Date(from)]);
    await pool.query(`DELETE FROM dnes_hide WHERE k LIKE 'p:%' AND created_at < now() - interval '3 days'`);
    await pool.query(`DELETE FROM dnes_pin WHERE e < now() - interval '1 day'`);
    await kv.set('last_run', new Date().toISOString()); await kv.set('last_ms', Date.now() - t0); await kv.set('report', JSON.stringify(report));
    if (!opt.feeds) await kv.set('last_full', new Date().toISOString());
    await kv.set('last_err', '');
    dropCaches(); postersSoon();
  }
  let timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    const tick = async () => {
      try {
        const c = cfg(await getSettings()); if (c.epg_on !== '1' && c.dnes_on !== '1') return;
        const last = Date.parse(await kv.get('last_full') || 0) || 0, h = Math.max(2, Math.min(24, +c.epg_hours || 6));
        if (Date.now() - last > h * 3600e3 - 60e3) refresh();
      } catch (e) { console.error('EPG tick', e.message); }
    };
    setTimeout(tick, 45e3).unref(); timer = setInterval(tick, 15 * 60e3); timer.unref();
  }

  // ---------- read side ----------
  async function visibleMapped() {
    const c = cfg(await getSettings()), sk = skipOf(c), m = await loadMap();
    return (await channels()).filter((r) => r.visible && !skipped(r.category, sk) && m.get(r.id) && m.get(r.id).epg_id).map((r) => ({ ...r, epg: m.get(r.id).epg_id }));
  }
  async function nowData() {
    if (nowCache && Date.now() - nowCache.t < 60e3) return nowCache.d;
    const vm = await visibleMapped(); const byEpg = new Map(); for (const r of vm) { if (!byEpg.has(r.epg)) byEpg.set(r.epg, []); byEpg.get(r.epg).push(r.id); }
    const out = {};
    if (byEpg.size) {
      const q = await pool.query(`SELECT epg_id, s, e, title, kind FROM (SELECT epg_id,s,e,title,kind, row_number() OVER (PARTITION BY epg_id ORDER BY s) AS rn FROM epg_prog WHERE epg_id = ANY($1) AND e > now() AND s < now() + interval '12 hours') x WHERE rn <= 4 ORDER BY epg_id, s`, [[...byEpg.keys()]]);
      for (const r of q.rows) for (const id of byEpg.get(r.epg_id)) (out[id] = out[id] || []).push([Math.round(+r.s / 1000), Math.round(+r.e / 1000), r.title, r.kind === 'adult' ? '' : r.kind]);
    }
    const d = { t: Math.round(Date.now() / 1000), c: out };
    nowCache = { t: Date.now(), d }; return d;
  }
  async function dayData(id) {
    const hit = dayCache.get(id); if (hit && Date.now() - hit.t < 300e3) return hit.d;
    const vm = (await visibleMapped()).find((r) => r.id === id); if (!vm) return null;
    const ds = dayStart(Date.now());
    const q = await pool.query(`SELECT s,e,title,sub,cat,kind,descr FROM epg_prog WHERE epg_id=$1 AND e > $2 AND s < $3 ORDER BY s LIMIT 200`, [vm.epg, new Date(ds), new Date(ds + 27 * 3600e3)]);
    const d = { id, name: vm.name, p: q.rows.map((r) => [Math.round(+r.s / 1000), Math.round(+r.e / 1000), r.title, r.kind === 'adult' ? '' : r.kind, r.sub, r.cat, r.descr]) };
    if (dayCache.size > 1000) dayCache.clear(); dayCache.set(id, { t: Date.now(), d }); return d;
  }
  const jsonOut = (res, d, age = 60) => { res.set({ 'Cache-Control': `public, max-age=${age}`, 'X-Content-Type-Options': 'nosniff' }); res.json(d); };
  app.get('/api/epg/now', wrap(async (req, res) => { const c = cfg(await getSettings()); if (c.epg_on !== '1') return jsonOut(res, { t: Math.round(Date.now() / 1000), c: {} }); jsonOut(res, await nowData()); }));
  app.get('/api/epg/day/:id(\\d+)', wrap(async (req, res) => { const c = cfg(await getSettings()); const d = c.epg_on === '1' ? await dayData(+req.params.id) : null; if (!d) return res.status(404).json({ p: [] }); jsonOut(res, d, 300); }));
  // assets for the Kanály page (tiles get filled by /static/epg.js)
  ctx.epgAssets = async (req) => { const c = cfg(await getSettings()); if (c.epg_on !== '1') return ''; const en = req.lang === 'en'; return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><div id="epgcfg" hidden data-l="${en ? 'en' : 'sk'}" data-now="${esc(tx(en, 'Teraz', 'Now'))}" data-next="${esc(tx(en, 'Potom', 'Next'))}" data-day="${esc(tx(en, 'Celý program dnes', 'Full schedule today'))}" data-min="${esc(tx(en, 'min', 'min'))}" data-none="${esc(tx(en, 'Program nie je k dispozícii.', 'Schedule not available.'))}" data-load="${esc(tx(en, 'Načítavam…', 'Loading…'))}" data-left="${esc(tx(en, 'ešte', 'left'))}"></div><script src="/static/epg.js?v=${ASSET_V}" defer></script><p class="hint epgsrc">${esc(tx(en, 'TV program: epgshare01.online (orientačný, môže sa líšiť).', 'TV schedule: epgshare01.online (indicative, may differ).'))}</p>`; };

  // ---------- Dnes v TV ----------
  const CATW = [[/sloven/i, 12], [/česk|cesk/i, 9], [/filmy a seri/i, 7], [/^šport$|^sport$/i, 6], [/dokument/i, 2]];
  const DOCCH = /doku|docu|nature|history|histor|discovery|planete|national geographic|nat ?geo|animal|explore|travel|crime\b|investigation|viasat (explore|history|nature)|spektrum|da vinci/i;
  // pick the public list with variety: each further item of the same kind costs 10 points
  function diverse(list, n) {
    const left = list.slice(), out = [], cnt = {};
    while (out.length < n && left.length) {
      let bi = 0, bv = -1e9;
      left.forEach((x, i) => { const v = x.score - 10 * (cnt[x.kind] || 0); if (v > bv) { bv = v; bi = i; } });
      const x = left.splice(bi, 1)[0]; cnt[x.kind] = (cnt[x.kind] || 0) + 1; out.push(x);
    }
    return out;
  }
  function scoreOf(p, ch, now) {
    const s = +p.s, e = +p.e, dur = (e - s) / 60e3, h = localHour(s), t = p.title;
    if (JUNK.test(t) || p.kind === 'adult' || ADULT.test(p.cat)) return -1;
    let sc;
    if (p.kind === 'film') { if (dur < 70 || DOCCH.test(ch.name)) return -1; sc = 40; const y = +p.yr; if (y && y >= new Date().getFullYear() - 3) sc += 8; }
    else if (p.kind === 'sport') {
      if (dur < 40 || C.NOTLIVE.test(t)) return -1;
      const match = C.LIVE.test(t) || /\S\s[-–]\s\S.*\s[-–]\s\S/.test(t) || /\bvs\.?\s/i.test(t) || p.fl.includes('l');
      sc = match ? 48 : 10; if (p.fl.includes('l')) sc += 10;
    } else if (p.kind === 'show') { if (dur < 40) return -1; sc = C.BIGSHOW.test(t) ? 42 : 14; }
    else return -1;
    if (p.fl.includes('r')) sc -= 14;
    if (h >= 19.5 && h < 22.75) sc += 18; else if (h >= 17 && h < 19.5) sc += 8; else if (h >= 22.75) sc += 3; else if (h < 12 && h >= 4) sc -= p.kind === 'sport' ? 2 : 12;
    for (const [r, w] of CATW) if (r.test(ch.category)) { sc += w; break; }
    if (s < now) sc -= 6;
    return sc;
  }
  async function dnesItems(opt = {}) {
    if (!opt.all && dnesCache && Date.now() - dnesCache.t < 120e3) return dnesCache.d;
    const c = cfg(await getSettings()), now = Date.now(), ds = dayStart(now), de = ds + 26 * 3600e3;
    const kinds = String(c.dnes_kinds).split(',').map((x) => x.trim()).filter(Boolean);
    const vm = (await visibleMapped()).filter((r) => !ADULT.test(r.category)); const byEpg = new Map(); for (const r of vm) { if (!byEpg.has(r.epg)) byEpg.set(r.epg, []); byEpg.get(r.epg).push(r); }
    const hidden = new Map((await pool.query('SELECT k,title FROM dnes_hide')).rows.map((r) => [r.k, r.title]));
    let cand = [];
    if (byEpg.size && kinds.length) {
      const q = await pool.query(`SELECT epg_id,s,e,title,cat,kind,yr,fl FROM epg_prog WHERE epg_id = ANY($1) AND kind = ANY($2) AND e > $3 AND s < $4 AND s > $5`, [[...byEpg.keys()], kinds, new Date(now + 10 * 60e3), new Date(de), new Date(now - 40 * 60e3)]);
      for (const p of q.rows) {
        const ch = byEpg.get(p.epg_id)[0]; const sc = scoreOf(p, ch, now); if (sc < 34) continue;
        const k = 'p:' + p.epg_id + '|' + +p.s, tk = 't:' + tnorm(p.title);
        cand.push({ k, tk, s: +p.s, e: +p.e, title: p.title, kind: p.kind, cat: p.cat, yr: p.yr, ch, score: sc, hidden: hidden.has(k) || hidden.has(tk) });
      }
    }
    cand.sort((a, b) => b.score - a.score || a.s - b.s);
    // dedupe titles (same film on +1 / HD variants) and cap per channel
    const seen = new Set(), perCh = new Map(), pick = [];
    for (const x of cand) { if (x.hidden && !opt.all) continue; const tk = x.tk + '|' + Math.round(x.s / 3600e3); if (seen.has(x.tk) || seen.has(tk)) { x.dupe = true; if (!opt.all) continue; } seen.add(x.tk); const n = perCh.get(x.ch.id) || 0; if (n >= 2 && !opt.all) continue; perCh.set(x.ch.id, n + 1); pick.push(x); }
    const max = Math.max(1, Math.min(30, +c.dnes_max || 8));
    const all = await channels();
    const pins = (await pool.query('SELECT id,channel_id,s,e,title,kind FROM dnes_pin WHERE e > now() AND s < $1 ORDER BY s', [new Date(de)])).rows
      .map((p) => { const ch = all.find((r) => r.id === p.channel_id && r.visible); return ch ? { k: 'pin:' + p.id, pin: p.id, s: +p.s, e: +p.e, title: p.title, kind: p.kind, cat: '', ch, score: 999 } : null; }).filter(Boolean);
    const out = opt.all ? { pins, auto: pick } : [...pins, ...diverse(pick, Math.max(0, max - pins.length))].sort((a, b) => a.s - b.s);
    if (!opt.all) dnesCache = { t: Date.now(), d: out };
    return out;
  }
  const posterKey = (x) => tnorm(x.title) + '|' + (x.yr || '');
  async function posterMap(items) {
    const ks = [...new Set(items.filter((x) => x.kind === 'film').map(posterKey))]; if (!ks.length) return new Map();
    return new Map((await pool.query('SELECT k,url FROM epg_poster WHERE k = ANY($1) AND url <> \'\'', [ks])).rows.map((r) => [r.k, r.url]));
  }
  let posterBusy = false;
  function postersSoon() {
    if (posterBusy) return; posterBusy = true;
    setTimeout(async () => {
      try {
        const items = (await dnesItems({ all: true })).auto.filter((x) => x.kind === 'film').slice(0, 25).concat((await dnesItems()).filter((x) => x.kind === 'film'));
        for (const x of items) {
          const k = posterKey(x); if ((await pool.query('SELECT 1 FROM epg_poster WHERE k=$1 AND (url <> \'\' OR at > now() - interval \'7 days\')', [k])).rowCount) continue;
          let r = null; try { r = await POSTER.find({ name: x.title + (x.yr ? ' (' + x.yr + ')' : ''), category: 'film' }); } catch { r = null; }
          const url = r && /^https:\/\/upload\.wikimedia\.org\//.test(r.url) ? r.url : '';
          await pool.query('INSERT INTO epg_poster (k,url,label,at) VALUES ($1,$2,$3,now()) ON CONFLICT (k) DO UPDATE SET url=$2,label=$3,at=now()', [k, url, r ? String(r.label || '').slice(0, 200) : '']);
          await new Promise((ok) => setTimeout(ok, 400));
        }
        dnesCache = null;
      } catch (e) { console.error('EPG posters', e.message); } finally { posterBusy = false; }
    }, 2000).unref();
  }
  const KL = (en, k) => (en ? C.KIND_LABEL_EN : C.KIND_LABEL)[k] || tx(en, 'Program', 'Show');
  ctx.dnesBlock = async (req, s) => {
    try {
      const c = cfg(await getSettings()); if (c.dnes_on !== '1') return '';
      const items = await dnesItems(); if (!items.length) return '';
      const en = req.lang === 'en', pm = await posterMap(items), now = Date.now();
      const logo = (ch) => (ctx.tvchLogoSrc ? ctx.tvchLogoSrc(ch) : '/tvlogo/' + ch.id);
      const title = (en && c.dnes_title_en) || c.dnes_title || 'Dnes v TV';
      return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><section class="dnes" aria-label="${esc(title)}"><h2 class="dnh"><span class="dnl">●</span> ${esc(title)}</h2><ul class="dnl-list">${items.map((x) => { const pu = x.kind === 'film' && pm.get(posterKey(x)); return `<li class="dni dk-${esc(x.kind || 'x')}${x.s <= now ? ' live' : ''}" data-s="${Math.round(x.s / 1000)}" data-e="${Math.round(x.e / 1000)}">${pu ? `<img class="dnp" src="${esc(pu)}" alt="" loading="lazy" decoding="async" width="56" height="80" referrerpolicy="no-referrer">` : `<img class="dnp dnc" src="${esc(logo(x.ch))}" alt="" loading="lazy" decoding="async" width="56" height="56">`}<div class="dnb"><div class="dnt"><time datetime="${new Date(x.s).toISOString()}">${esc(hm(x.s))}</time><span class="dnk">${C.KIND_ICON[x.kind] || '📺'} ${esc(KL(en, x.kind))}</span><span class="dnlive">${esc(tx(en, 'práve beží', 'on now'))}</span></div><div class="dnn">${esc(x.title)}</div><div class="dnch"><img src="${esc(logo(x.ch))}" alt="" width="20" height="20" loading="lazy" decoding="async"><span>${esc(x.ch.name)}</span></div><div class="dpb"><i></i></div></div></li>`; }).join('')}</ul><a class="dnm" href="/${esc(s.slug)}/kanaly${en ? '?lang=en' : ''}#katalog">${esc(tx(en, 'Celý TV program pri kanáloch →', 'Full TV schedule by channel →'))}</a></section><script src="/static/epg.js?v=${ASSET_V}" defer></script>`;
    } catch (e) { console.error('dnes', e.message); return ''; }
  };

  // ---------- admin: channel edit form hook ----------
  ctx.epgAdminPrep = async () => { const m = await loadMap(); const n = (await pool.query('SELECT COUNT(*)::int AS n FROM epg_chan')).rows[0].n; return { m, n }; };
  ctx.epgAdminField = (prep, r) => {
    const m = prep.m.get(r.id); const v = m ? (m.manual && !m.epg_id ? '-' : m.epg_id) : '';
    return `<label>EPG id (TV program) · <a href="/admin/epg/ch/${r.id}">🔎 vybrať</a> <span class="hint">${m ? (m.manual ? 'ručne' : m.epg_id ? 'automaticky ' + Math.round(m.score * 100) + ' %' : 'nenájdené') : 'zatiaľ nepárované'} · prázdne = automaticky, „-“ = bez programu</span></label><input name="epg_id" maxlength="120" value="${esc(v)}" autocomplete="off"><input type="hidden" name="epg_prev" value="${esc(v)}">`;
  };
  async function setManual(id, v) {
    v = String(v == null ? '' : v).trim().slice(0, 120);
    if (v === '') await pool.query('UPDATE epg_map SET manual=false, updated_at=now() WHERE channel_id=$1', [id]);
    else {
      const eid = v === '-' ? '' : v;
      if (eid && !(await pool.query('SELECT 1 FROM epg_chan WHERE id=$1', [eid])).rowCount) return false;
      await pool.query(`INSERT INTO epg_map (channel_id,epg_id,manual,score,updated_at) VALUES ($1,$2,true,1,now()) ON CONFLICT (channel_id) DO UPDATE SET epg_id=$2, manual=true, score=1, updated_at=now()`, [id, eid]);
    }
    dropCaches(); soonPartial(v && v !== '-' ? v : null); return true;
  }
  let partialT = null; const partialFeeds = new Set();
  async function soonPartial(eid) {
    if (eid) { const r = (await pool.query('SELECT feed FROM epg_chan WHERE id=$1', [eid])).rows[0]; if (r) partialFeeds.add(r.feed); }
    if (partialT) clearTimeout(partialT);
    partialT = setTimeout(() => { partialT = null; const f = [...partialFeeds]; partialFeeds.clear(); if (running) running.then(() => refresh({ feeds: f.length ? f : ['-'] })); else refresh({ feeds: f.length ? f : ['-'] }); }, 15e3); partialT.unref();
  }
  ctx.epgOnEdit = async (id, body) => { if (body && 'epg_id' in body && String(body.epg_id).trim() !== String(body.epg_prev || '').trim()) return setManual(id, body.epg_id); return true; };

  // ---------- admin page ----------
  const MS = { ok: 'Uložené.', run: 'Obnova TV programu spustená na pozadí (zvyčajne 1–3 min). Obnovte stránku neskôr.', busy: 'Obnova už prebieha.', remap: 'Automatické párovanie sa prepočíta pri obnove (spustená).', badid: 'Takéto EPG id v zdroji neexistuje (najprv obnovte zdroj alebo skontrolujte id).', pin: 'Pripnuté.', hid: 'Skryté.', unhid: 'Znovu zobrazené.', del: 'Zmazané.', badpin: 'Vyplňte kanál, čas začiatku a názov.' };
  const msg = (q) => (MS[q.m] ? `<p class="${/^bad/.test(q.m) ? 'err' : 'ok'}">${esc(MS[q.m])}</p>` : '');
  const back = (res, m, a = '') => res.redirect(303, '/admin/epg?m=' + m + (a ? '#' + a : ''));
  const ago = (iso) => { const t = Date.parse(iso || ''); if (!t) return 'nikdy'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `pred ${m} min` : `pred ${Math.round(m / 6) / 10} h`; };
  const KINDS = [['film', '🎬 Filmy'], ['sport', '⚽ Šport (priame prenosy)'], ['show', '🎤 Veľké relácie / zábava']];
  admin.get('/epg', needAuth, wrap(async (req, res) => {
    const s = await getSettings(), c = cfg(s), sk = skipOf(c);
    const [lastRun, lastFull, lastMs, rep, lastErr] = await Promise.all(['last_run', 'last_full', 'last_ms', 'report', 'last_err'].map((k) => kv.get(k)));
    let report = {}; try { report = JSON.parse(rep || '{}'); } catch { report = {}; }
    const chans = await channels(), m = await loadMap();
    const st = { all: 0, skip: 0, mapped: 0, manual: 0, none: 0 };
    for (const r of chans) { st.all++; const x = m.get(r.id); if (x && x.manual) { st.manual++; if (x.epg_id) st.mapped++; continue; } if (skipped(r.category, sk)) { st.skip++; continue; } if (x && x.epg_id) st.mapped++; else st.none++; }
    const nprog = (await pool.query('SELECT COUNT(*)::int AS n, MIN(s) AS a, MAX(e) AS b FROM epg_prog')).rows[0];
    const f = ['unmapped', 'mapped', 'manual', 'skipped', 'all'].includes(req.query.f) ? req.query.f : 'unmapped';
    const cq = String(req.query.cat || '');
    const list = chans.filter((r) => { const x = m.get(r.id), isSk = skipped(r.category, sk); if (cq && r.category !== cq) return false; if (f === 'all') return true; if (f === 'skipped') return isSk && !(x && x.manual); if (f === 'manual') return x && x.manual; if (f === 'mapped') return x && x.epg_id; return !isSk && !(x && x.epg_id) && !(x && x.manual); });
    const nowD = await nowData(); const cats = [...new Set(chans.map((r) => r.category))];
    const dn = await dnesItems({ all: true }); const hidden = (await pool.query('SELECT k,title,created_at FROM dnes_hide ORDER BY created_at DESC LIMIT 100')).rows;
    const vis = chans.filter((r) => r.visible);
    const item = (x) => `<div class="row"><span><b>${esc(hm(x.s))}</b> ${C.KIND_ICON[x.kind] || ''} ${esc(x.title)} · <span class="hint">${esc(x.ch.name)}${x.score < 999 ? ' · skóre ' + x.score : ''}${x.dupe ? ' · duplicita' : ''}${x.hidden ? ' · skryté' : ''}</span></span>${x.pin ? `<form method="post" action="/admin/epg/pin/${x.pin}/delete">${hid(req)}<button class="d">🗑 Odopnúť</button></form>` : `${x.hidden ? '' : `<form method="post" action="/admin/epg/hide">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť</button></form><form method="post" action="/admin/epg/hide">${hid(req)}<input type="hidden" name="k" value="${esc(x.tk)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť titul</button></form>`}<form method="post" action="/admin/epg/pin">${hid(req)}<input type="hidden" name="channel_id" value="${x.ch.id}"><input type="hidden" name="s" value="${esc(toLocal(x.s))}"><input type="hidden" name="dur" value="${Math.round((x.e - x.s) / 60e3)}"><input type="hidden" name="title" value="${esc(x.title)}"><input type="hidden" name="kind" value="${esc(x.kind)}"><button>📌 Pripnúť</button></form>`}</div>`;
    res.send(page('TV program (EPG)', `<h1>🗓 TV program (EPG) &amp; Dnes v TV</h1>${msg(req.query)}<p><a href="/admin">← Admin</a> · <a href="/admin/kanaly-katalog">📺 Katalóg kanálov</a></p>
<p class="hint">Zdroj: <b>epgshare01.online</b> – bezplatné verejné XMLTV súbory (iba programové údaje: čas, názov relácie, kategória). Ukladá sa len program na ~${esc(c.epg_ahead)} h dopredu pre kanály na stránke. Žiadne streamy ani playlisty.</p>
<div class="card"><h2>📊 Stav</h2><p>Posledná obnova: <b>${esc(ago(lastRun))}</b>${lastMs ? ` (${Math.round(+lastMs / 1000)} s)` : ''} · plná: ${esc(ago(lastFull))} · interval ${esc(c.epg_hours)} h${status.running ? ` · <b>práve beží: ${esc(status.phase)} ${esc(status.feed)}</b>` : ''}</p>
<p>Kanály: <b>${st.mapped}</b> s programom · ${st.none} bez párovania · ${st.manual} ručne · ${st.skip} vynechaných (kategórie) · spolu ${st.all}. Uložených relácií: ${nprog.n}${nprog.a ? ` (${esc(hm(+nprog.a))} – ${esc(new Date(nprog.b).toISOString().slice(0, 10))} ${esc(hm(+nprog.b))})` : ''}.</p>
${lastErr ? `<p class="err">Chyba: ${esc(lastErr)}</p>` : ''}${Object.keys(report).length ? `<p class="hint">${Object.entries(report).map(([k, v]) => `${esc(k)}: ${v.err ? '⚠ ' + esc(v.err) : `${v.ch != null ? v.ch + ' kan., ' : ''}${v.progs || 0} rel.`}`).join(' · ')}</p>` : ''}
<div class="row"><form method="post" action="/admin/epg/refresh">${hid(req)}<button>🔄 Obnoviť teraz</button></form><form method="post" action="/admin/epg/remap">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> potvrdiť</label><button>🔁 Znovu automaticky spárovať (ručné ostanú)</button></form></div></div>
<form method="post" action="/admin/epg/settings" class="card" id="nast">${hid(req)}<h2>⚙ Nastavenia TV programu</h2>
<label class="ck"><input type="checkbox" name="epg_on" value="1"${c.epg_on === '1' ? ' checked' : ''}> Zobraziť TV program pri kanáloch (Teraz / Potom / celý deň)</label>
<label>Zdroje (krajiny epgshare01, oddelené čiarkou) <span class="hint">dostupné: ${FEEDS_ALL.join(', ')}</span></label><input name="epg_feeds" maxlength="200" value="${esc(c.epg_feeds)}">
<label>Obnova každých (hodín)</label><select name="epg_hours">${[2, 3, 4, 6, 8, 12, 24].map((h) => `<option${+c.epg_hours === h ? ' selected' : ''}>${h}</option>`).join('')}</select>
<label>Program dopredu (hodín)</label><select name="epg_ahead">${[24, 36, 48].map((h) => `<option${+c.epg_ahead === h ? ' selected' : ''}>${h}</option>`).join('')}</select>
<label>Vynechať kategórie kanálov (časť názvu, jedna na riadok)</label><textarea name="epg_skip" rows="5" maxlength="1000">${esc(c.epg_skip)}</textarea><button>Uložiť</button></form>
<form method="post" action="/admin/epg/dnes" class="card" id="dnes">${hid(req)}<h2>⭐ Dnes v TV (hlavná stránka)</h2><p class="hint">Najdôležitejšie dnešné relácie (filmy, priame športové prenosy, veľké relácie) – iba z viditeľných kanálov na stránke. Ak nie sú dáta, blok sa skryje.</p>
<label class="ck"><input type="checkbox" name="dnes_on" value="1"${c.dnes_on === '1' ? ' checked' : ''}> Zobraziť blok na hlavnej stránke</label>
<label>Nadpis</label><input name="dnes_title" maxlength="60" value="${esc(c.dnes_title)}"><label>Nadpis (EN)</label><input name="dnes_title_en" maxlength="60" value="${esc(c.dnes_title_en)}">
<label>Max. položiek</label><input name="dnes_max" type="number" min="1" max="30" value="${esc(c.dnes_max)}">
<p>Typy:</p>${KINDS.map(([k, l]) => `<label class="ck"><input type="checkbox" name="kind_${k}" value="1"${c.dnes_kinds.split(',').includes(k) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}<button>Uložiť</button></form>
<div class="card" id="nahlad"><h2>👁 Dnes v TV – výber</h2>${dn.pins.length ? `<h3>📌 Pripnuté</h3>${dn.pins.map(item).join('')}` : ''}<h3>Automatický výber (zoradené podľa skóre; na webe max ${esc(c.dnes_max)}, max 2 na kanál)</h3>${dn.auto.slice(0, 40).map(item).join('') || '<p class="hint">Zatiaľ žiadne dáta – spustite obnovu.</p>'}
${hidden.length ? `<h3>🙈 Skryté</h3>${hidden.map((h) => `<div class="row"><span>${esc(h.title || h.k)} <span class="hint">${h.k.startsWith('t:') ? '(celý titul)' : '(jedno vysielanie)'}</span></span><form method="post" action="/admin/epg/unhide">${hid(req)}<input type="hidden" name="k" value="${esc(h.k)}"><button>👁 Zobraziť</button></form></div>`).join('')}` : ''}</div>
<form method="post" action="/admin/epg/pin" class="card" id="pin">${hid(req)}<h2>📌 Pridať vlastnú položku</h2><p class="hint">Napr. zápas alebo film, ktorý v programe chýba. Zobrazí sa do jeho konca.</p>
<label>Kanál</label><select name="channel_id" required><option value="">— vyberte —</option>${vis.map((r) => `<option value="${r.id}">${esc(r.name)} (${esc(r.category)})</option>`).join('')}</select>
<label>Začiatok</label><input type="datetime-local" name="s" required><label>Dĺžka (min)</label><input type="number" name="dur" min="5" max="600" value="120"><label>Názov</label><input name="title" maxlength="160" required>
<label>Typ</label><select name="kind">${Object.entries(C.KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select><button>Pripnúť</button></form>
<div class="card" id="map"><h2>🔗 Párovanie kanálov s programom</h2><p class="hint">Automaticky podľa podobnosti názvu (a krajiny podľa kategórie). Opraviť: zadajte EPG id (alebo „-“ = bez programu, prázdne = automaticky) alebo kliknite 🔎.</p>
<p>${[['unmapped', 'Bez párovania'], ['mapped', 'Spárované'], ['manual', 'Ručne'], ['skipped', 'Vynechané'], ['all', 'Všetky']].map(([k, l]) => (k === f ? `<b>${l}</b>` : `<a href="/admin/epg?f=${k}${cq ? '&cat=' + encodeURIComponent(cq) : ''}#map">${l}</a>`)).join(' · ')}</p>
<form method="get" action="/admin/epg" class="row"><input type="hidden" name="f" value="${esc(f)}"><select name="cat"><option value="">Všetky kategórie</option>${cats.map((x) => `<option${x === cq ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select><button>Filtrovať</button></form>
<p class="hint">${list.length} kanálov</p>${list.slice(0, 300).map((r) => { const x = m.get(r.id), nw = (nowD.c[r.id] || [])[0]; const v = x ? (x.manual && !x.epg_id ? '-' : x.epg_id) : ''; return `<form method="post" action="/admin/epg/map/${r.id}" class="row">${hid(req)}<span><b>${esc(r.name)}</b> <span class="hint">${esc(r.category)}${r.visible ? '' : ' · skrytý'} · ${x ? (x.manual ? 'ručne' : x.epg_id ? 'auto ' + Math.round(x.score * 100) + ' %' : 'nenájdené') : '—'}${nw ? ' · teraz: ' + esc(nw[2]) : ''}</span></span><input name="epg_id" maxlength="120" value="${esc(v)}" placeholder="EPG id"><input type="hidden" name="epg_prev" value="${esc(v)}"><button>Uložiť</button><a href="/admin/epg/ch/${r.id}">🔎</a></form>`; }).join('')}${list.length > 300 ? '<p class="hint">Zobrazených prvých 300 – použite filter kategórie.</p>' : ''}</div>`, 'adm'));
  }));
  admin.get('/epg/ch/:id(\\d+)', needAuth, wrap(async (req, res) => {
    const ch = (await channels()).find((r) => r.id === +req.params.id); if (!ch) return res.redirect(303, '/admin/epg');
    const m = (await loadMap()).get(ch.id); const q = String(req.query.q || '').slice(0, 80);
    const rows = (await pool.query('SELECT id,name,names,feed,n FROM epg_chan')).rows;
    const ix = C.buildIndex(rows.map((r) => ({ id: r.id, names: r.names ? r.names.split('\n') : [r.name], feed: r.feed, n: r.n })));
    let cand = C.candidates(ix, q || ch.name, ch.category, 15);
    if (q) { const nq = tnorm(q); cand = cand.concat(rows.filter((r) => tnorm(r.id + ' ' + r.names).includes(nq)).slice(0, 30).map((r) => ({ id: r.id, name: r.name, feed: r.feed, n: r.n, sim: 0 }))).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i); }
    const prev = m ? (m.manual && !m.epg_id ? '-' : m.epg_id) : '';
    const opt = (id, label) => `<form method="post" action="/admin/epg/map/${ch.id}" class="row">${hid(req)}<input type="hidden" name="epg_id" value="${esc(id)}"><input type="hidden" name="epg_prev" value="${esc(prev + '#')}"><input type="hidden" name="ret" value="ch"><button>${esc(label)}</button></form>`;
    res.send(page('EPG – ' + ch.name, `<h1>🔎 TV program pre: ${esc(ch.name)}</h1>${msg(req.query)}<p><a href="/admin/epg#map">← TV program</a> · <a href="/admin/kanaly-katalog">📺 Katalóg</a></p>
<p>Kategória: ${esc(ch.category)} · teraz: <b>${m ? (m.manual ? 'ručne' : 'automaticky') : '—'}</b> ${m && m.epg_id ? '<code>' + esc(m.epg_id) + '</code>' : '(bez programu)'}</p>
<form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Hľadať v zdroji (napr. Markiza)"><button>Hľadať</button></form>
<div class="card"><h2>Návrhy</h2>${cand.map((x) => `<div class="row"><span><code>${esc(x.id)}</code> ${esc(x.name)} <span class="hint">${esc(x.feed)} · ${x.n > 0 ? x.n + ' relácií' : x.n === 0 ? 'bez programu' : 'neznáme'}${x.sim ? ' · zhoda ' + Math.round(x.sim * 100) + ' %' : ''}</span></span>${opt(x.id, '✔ Použiť')}</div>`).join('') || '<p class="hint">Nič sa nenašlo. Skúste iný názov alebo pridajte zdroj krajiny v nastaveniach.</p>'}</div>
<div class="row">${opt('', '↺ Automaticky')}${opt('-', '🚫 Bez programu')}</div>`, 'adm'));
  }));
  admin.post('/epg/map/:id(\\d+)', needAuth, csrf, wrap(async (req, res) => {
    const id = +req.params.id; const ok = await ctx.epgOnEdit(id, req.body);
    if (req.body.ret === 'ch') return res.redirect(303, `/admin/epg/ch/${id}?m=${ok ? 'ok' : 'badid'}`);
    back(res, ok ? 'ok' : 'badid', 'map');
  }));
  admin.post('/epg/settings', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body; const feeds = feedsOf({ epg_feeds: b.epg_feeds }).join(',') || D.epg_feeds;
    await setSettings({ epg_on: b.epg_on ? '1' : '0', epg_feeds: feeds, epg_hours: String([2, 3, 4, 6, 8, 12, 24].includes(+b.epg_hours) ? +b.epg_hours : 6), epg_ahead: String([24, 36, 48].includes(+b.epg_ahead) ? +b.epg_ahead : 36), epg_skip: String(b.epg_skip || '').split(/\r?\n/).map((x) => x.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60)).filter(Boolean).slice(0, 30).join('\n') || '-' });
    dropCaches(); back(res, 'ok', 'nast');
  }));
  admin.post('/epg/dnes', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body; const clean = (v, d) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || d;
    await setSettings({ dnes_on: b.dnes_on ? '1' : '0', dnes_max: String(Math.max(1, Math.min(30, parseInt(b.dnes_max, 10) || 8))), dnes_kinds: KINDS.map(([k]) => k).filter((k) => b['kind_' + k]).join(',') || 'film', dnes_title: clean(b.dnes_title, D.dnes_title), dnes_title_en: clean(b.dnes_title_en, D.dnes_title_en) });
    dropCaches(); back(res, 'ok', 'dnes');
  }));
  admin.post('/epg/refresh', needAuth, csrf, wrap(async (req, res) => { if (running) return back(res, 'busy'); refresh(); back(res, 'run'); }));
  admin.post('/epg/remap', needAuth, csrf, wrap(async (req, res) => { if (req.body.confirm !== '1') return back(res, 'ok'); await pool.query('DELETE FROM epg_map WHERE NOT manual'); dropCaches(); if (!running) refresh(); back(res, 'remap'); }));
  admin.post('/epg/hide', needAuth, csrf, wrap(async (req, res) => { const k = String(req.body.k || '').slice(0, 300); if (/^(p|t):/.test(k)) await pool.query('INSERT INTO dnes_hide (k,title) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING', [k, String(req.body.title || '').slice(0, 160)]); dropCaches(); back(res, 'hid', 'nahlad'); }));
  admin.post('/epg/unhide', needAuth, csrf, wrap(async (req, res) => { await pool.query('DELETE FROM dnes_hide WHERE k=$1', [String(req.body.k || '')]); dropCaches(); back(res, 'unhid', 'nahlad'); }));
  admin.post('/epg/pin', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body, id = parseInt(b.channel_id, 10), s = fromLocal(b.s), dur = Math.max(5, Math.min(600, parseInt(b.dur, 10) || 120)), title = C.clip(String(b.title || '').replace(/\b[a-z][a-z0-9+.-]{1,10}:\/\/\S+/gi, ''), 160);
    if (!id || !Number.isFinite(s) || !title || !(await channels()).some((r) => r.id === id)) return back(res, 'badpin', 'pin');
    await pool.query('INSERT INTO dnes_pin (channel_id,s,e,title,kind) VALUES ($1,$2,$3,$4,$5)', [id, new Date(s), new Date(s + dur * 60e3), title, C.KIND_LABEL[b.kind] ? b.kind : '']);
    dropCaches(); postersSoon(); back(res, 'pin', 'nahlad');
  }));
  admin.post('/epg/pin/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => { await pool.query('DELETE FROM dnes_pin WHERE id=$1', [+req.params.id]); dropCaches(); back(res, 'del', 'nahlad'); }));
  ctx.epgRefresh = refresh;
};
