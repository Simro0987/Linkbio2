'use strict';
// TV program (EPG) per channel + homepage "Dnes v TV".
// Source: epgshare01.online free XMLTV files (schedule metadata only: channel id/name, time, title, category, short description).
// Never stores or shows stream URLs, playlists (M3U) or Xtream data.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tx } = require('./uitext');
const C = require('./epgcore');
const POSTER = require('./wdposter');
const FETCH = require('./epgfetch');
const OFFICIAL = require('./epgoff');
const EXTERNAL = require('./epgext');

const TZ = 'Europe/Bratislava';
const FEED_URL = (f) => `https://epgshare01.online/epgshare01/epg_ripper_${f}.xml.gz`;
// built-in free alternative XMLTV files (fill channels epgshare lacks or has stale): iptv-epg.org per-country files, epg.pw Russia
const ALT_URL = { IEPGRU1: 'https://iptv-epg.org/files/epg-ru.xml.gz', IEPGUA1: 'https://iptv-epg.org/files/epg-ua.xml.gz', IEPGCZ1: 'https://iptv-epg.org/files/epg-cz.xml.gz', IEPGPL1: 'https://iptv-epg.org/files/epg-pl.xml.gz', IEPGDE1: 'https://iptv-epg.org/files/epg-de.xml.gz', IEPGHU1: 'https://iptv-epg.org/files/epg-hu.xml.gz', IEPGGB1: 'https://iptv-epg.org/files/epg-gb.xml.gz', PWRU1: 'https://epg.pw/xmltv/epg_RU.xml.gz' };
const FEEDS_ALL = ['SK1', 'CZ1', 'HU1', 'PL1', 'DE1', 'AT1', 'CH1', 'UK1', 'NL1', 'UA1', 'IT1', 'FR1', 'ES1', 'BE2', 'LU1', 'HR1', 'LT1', 'TR1', 'CA2', 'MX1', 'RAKUTEN1', 'RO1', 'RS1', 'GR1', 'BG1', 'LV1', 'IE1', 'MUSICBOX1', 'DELUXEMUSIC1', 'SPORTKLUB1', ...Object.keys(ALT_URL)];
const isAltFeed = (f) => Object.prototype.hasOwnProperty.call(ALT_URL, f);
const FEEDS_V3 = ['MUSICBOX1', 'DELUXEMUSIC1', 'SPORTKLUB1', 'IEPGRU1', 'IEPGUA1', 'IEPGCZ1', 'IEPGPL1', 'IEPGDE1', 'PWRU1']; // added 2026-11: music/KHL/Russian/Ukrainian channels with stale or no epgshare data
const FEEDS_V2 = ['BE2', 'LU1', 'HR1', 'LT1', 'TR1', 'CA2', 'MX1', 'RAKUTEN1']; // added 2026-10: Deluxe/ANIXE+/Red Bull, MDR, Arena Sport 3, My Hits, Россия 24, TSN, Fox Sports; RAKUTEN1: Red Bull TV
const D = { epg_on: '1', epg_feeds: 'SK1,CZ1,HU1,PL1,DE1,AT1,CH1,UK1,NL1,UA1,IT1,FR1,ES1,BE2,LU1,HR1,LT1,TR1,CA2,MX1,RAKUTEN1,MUSICBOX1,DELUXEMUSIC1,SPORTKLUB1,IEPGRU1,IEPGUA1,IEPGCZ1,IEPGPL1,IEPGDE1,PWRU1', epg_hours: '6', epg_ahead: '36', epg_skip: 'VOD\nRádi\nWebkam\n18+\nzápasy', dnes_on: '1', dnes_max: '14', dnes_kinds: 'film,sport,show', dnes_scope: 'skcz', dnes_top: '3', dnes_speed: '3', top_move: '1', sport_on: '1', dnes_title: 'Dnes v TV', dnes_title_en: 'Today on TV', top_n: '4', top_title: 'Top dnes', top_title_en: 'Top today', week_on: '1', week_n: '4', week_title: 'Top týždňa', week_title_en: 'Top this week', guide_on: '1', guide_genres: 'sport,film,series,show,doc,kids,news,music', guide_def: 'sport', guide_days: '7', guide_scope: 'skcz' };
// custom XMLTV sources added in admin: feed key "src:<id>", their channel ids are prefixed "src<id>:" (no collisions with epgshare ids)
const SRC_RE = /^(?:src\d+|IEPG[A-Z]{2}\d|PW[A-Z]{2}\d):/; // custom sources + built-in alternative feeds (prefixed ids)
const isSrcFeed = (f) => /^src:\d+$/.test(String(f || ''));
// IPTV playlists / Xtream panels are never accepted (only schedule files)
const SRC_MAX = 10;
const UA = { 'user-agent': 'lnkbio-epg/1.0 (+https://lnkbio.onrender.com)' };
const ASSET_V = (() => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'static/epg.js')) + fs.readFileSync(path.join(__dirname, 'static/epg.css')) + fs.readFileSync(path.join(__dirname, 'static/tev.js')) + fs.readFileSync(path.join(__dirname, 'static/evh.js'))).digest('hex').slice(0, 8); } catch { return '1'; } })();
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
  const feedsOf = (c) => [...new Set(String(c.epg_feeds || '').toUpperCase().split(/[\s,;]+/).filter((f) => /^[A-Z]{2,12}\d{1,2}$/.test(f)))].slice(0, 40);
  const skipOf = (c) => String(c.epg_skip || '').split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter((x) => x && x !== '-');
  const skipped = (cat, sk) => { const c = String(cat || '').toLowerCase(); return sk.some((x) => c.includes(x)); };
  const kv = { get: async (k) => ((await pool.query('SELECT v FROM epg_kv WHERE k=$1', [k])).rows[0] || {}).v, set: (k, v) => pool.query('INSERT INTO epg_kv (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, String(v)]) };
  const OFF = OFFICIAL.install({ pool, kv, getSettings, C, ADULT, JUNK, onChange: () => dropCaches() }); // official broadcaster schedules (STVR, JOJ, Prima) → days 4–7
  const DATA_V = '6'; // bump when stored EPG data needs a rebuild after deploy (refresh runs on the first tick)
  let mapCache = null, nowCache = null, dnesCache = null, srcCache = null; const dayCache = new Map();
  const sources = async () => srcCache || (srcCache = (await pool.query('SELECT * FROM epg_src ORDER BY id')).rows);
  let sportCache = null;
  const dropCaches = () => { mapCache = null; nowCache = null; dnesCache = null; sportCache = null; dayCache.clear(); if (G) G.drop(); if (E) E.drop(); };
  let G = null, E = null; // genre guide (epgguide.js), top events (epgevents.js)
  const channels = async () => (ctx.tvchAll ? ctx.tvchAll() : (await pool.query('SELECT id,name,category,logo,ord,visible FROM tv_channels ORDER BY ord,id')).rows);
  const loadMap = async () => mapCache || (mapCache = new Map((await pool.query('SELECT channel_id,epg_id,manual,score,shift FROM epg_map')).rows.map((r) => [r.channel_id, r])));
  // external sport schedules (oneplay.cz, nikeliga.sk, chanceliga.cz, hokej.cz) → 'ext:<channel_id>' rows for channels without EPG (epgext.js)
  const EXT = EXTERNAL.install({ pool, kv, channels, loadMap, onChange: () => dropCaches(), imp: (x) => (E && E.bigPts ? E.bigPts(x) : 0) });
  ctx.epgExt = EXT;

  ctx.epgInit = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')`);
    await EXT.init();
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_chan (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', names TEXT NOT NULL DEFAULT '', feed TEXT NOT NULL DEFAULT '', n INT NOT NULL DEFAULT -1, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_map (channel_id INT PRIMARY KEY, epg_id TEXT NOT NULL DEFAULT '', manual BOOLEAN NOT NULL DEFAULT false, score REAL NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_prog (epg_id TEXT NOT NULL, s TIMESTAMPTZ NOT NULL, e TIMESTAMPTZ NOT NULL, title TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', descr TEXT NOT NULL DEFAULT '', yr TEXT NOT NULL DEFAULT '', fl TEXT NOT NULL DEFAULT '', PRIMARY KEY (epg_id, s))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS epg_prog_s ON epg_prog (s)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dnes_pin (id SERIAL PRIMARY KEY, channel_id INT NOT NULL, s TIMESTAMPTZ NOT NULL, e TIMESTAMPTZ NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dnes_hide (k TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    if (E) await E.init();
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_poster (k TEXT PRIMARY KEY, url TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`ALTER TABLE epg_map ADD COLUMN IF NOT EXISTS shift INT NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE epg_poster ADD COLUMN IF NOT EXISTS pop INT NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE epg_poster ADD COLUMN IF NOT EXISTS rt INT NOT NULL DEFAULT 0`);
    await pool.query(`CREATE TABLE IF NOT EXISTS epg_src (id SERIAL PRIMARY KEY, name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, pref BOOLEAN NOT NULL DEFAULT false, nch INT NOT NULL DEFAULT -1, nprog INT NOT NULL DEFAULT -1, ncover INT NOT NULL DEFAULT -1, cover TEXT NOT NULL DEFAULT '', days REAL NOT NULL DEFAULT 0, err TEXT NOT NULL DEFAULT '', checked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await OFF.init();
    if (await kv.get('guide_v7') !== '1') { const st = await getSettings(); if (String(st.guide_days || '') === '4') await setSettings({ guide_days: '7' }); await kv.set('guide_v7', '1'); } // old default 4 → 7 days
    if (await kv.get('poster_v2') !== '1') { await pool.query(`DELETE FROM epg_poster`); await kv.set('poster_v2', '1'); }
    if (await kv.get('feeds_v2') !== '1') { // one-time: add the new feeds to a stored feed list
      const st = await getSettings(); if (st.epg_feeds) { const cur = feedsOf(st); await setSettings({ epg_feeds: [...new Set([...cur, ...FEEDS_V2])].slice(0, 30).join(',') }); }
      await kv.set('feeds_v2', '1');
    }
    if (await kv.get('feeds_v3') !== '1') {
      const st = await getSettings(); if (st.epg_feeds) { const cur = feedsOf(st); await setSettings({ epg_feeds: [...new Set([...cur, ...FEEDS_V3])].slice(0, 40).join(',') }); }
      await kv.set('feeds_v3', '1');
    }
    schedule();
  };

  // ---------- fetching ----------
  const status = { running: false, phase: '', feed: '', started: 0 };
  async function open(feed, signal) {
    if (isSrcFeed(feed)) { // admin-supplied URL → SSRF-safe fetcher (public IPs only, size limit)
      const src = (await sources()).find((x) => 'src:' + x.id === feed); if (!src) throw new Error('zdroj neexistuje');
      const r = await FETCH.open(src.url, { signal }); return { body: r.stream, gz: r.gz, pre: 'src' + src.id + ':', max: 300 * 1024 * 1024 };
    }
    const r = await fetch(isAltFeed(feed) ? ALT_URL[feed] : FEED_URL(feed), { headers: UA, signal, redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
    return { body: r.body, gz: true, pre: isAltFeed(feed) ? feed + ':' : '', max: 400 * 1024 * 1024 };
  }
  async function readChannels(feed) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 120e3);
    const out = [];
    try { const o = await open(feed, ac.signal); await C.parseStream(o.body, { gz: o.gz, maxBytes: o.max, channelsOnly: true, onChannel: (c) => { if (c.id && out.length < 5000) out.push({ id: o.pre + C.clip(c.id, 120), names: c.names.slice(0, 4).map((n) => C.clip(n, 120)), feed }); } }); }
    finally { clearTimeout(t); ac.abort(); }
    return out;
  }
  // full detail from..to; to..far only highlight candidates (films, live sport, big shows) for "Top týždňa"
  async function readProgs(feed, want, from, to, far, gEnd) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 300e3);
    const counts = new Map(); let rows = [], kept = 0, hl = 0, slim = 0;
    try {
      const o = await open(feed, ac.signal);
      await C.parseStream(o.body, {
        gz: o.gz, maxBytes: o.max,
        onProg: (p) => {
          if (!p.ch || !(p.stop > from) || !(p.start < far) || !(p.stop > p.start)) return;
          const id = o.pre ? o.pre + C.clip(p.ch, 120) : p.ch, near = p.start < to;
          if (near) counts.set(id, (counts.get(id) || 0) + 1);
          if (!want.has(id)) return;
          const dur = (p.stop - p.start) / 60e3, guide = !near && p.start < gEnd && dur >= 10 && slim < 150000;
          if (!near && !guide && hl >= 40000) return;
          const d = C.progDetails(p); if (!d.title) return;
          let kind = ADULT.test(d.cat) ? 'adult' : C.classify(d.cat, d.title);
          if (kind === 'film' && dur < 65) kind = dur < 20 ? '' : 'series';
          const fl = (d.live ? 'l' : '') + (d.rerun ? 'r' : '') + (d.premiere ? 'p' : '');
          // days 3+: slim rows (no description) for the genre guide; beyond the guide window only "Top týždňa" candidates
          if (!near) { if (guide) { if (kind === 'adult' || JUNK.test(d.title)) return; slim++; } else { if (scoreOf({ s: p.start, e: p.stop, title: d.title, kind, cat: d.cat, yr: d.year, fl }, FARCH, 0) < 22) return; hl++; } }
          rows.push([id, new Date(p.start), new Date(p.stop), d.title, near ? d.sub : C.clip(d.sub, 80), near ? d.cat : d.cat.slice(0, 60), kind, near ? d.desc : '', d.year, fl]); kept++;
          if (kept > 400000) return 'stop';
        },
      });
    } finally { clearTimeout(t); ac.abort(); }
    return { rows, counts, hl, slim };
  }
  const FARCH = { name: '', category: '' };
  async function insertProgs(c, rows) {
    // dedupe by (epg_id, s)
    const seen = new Set(); rows = rows.filter((r) => { const k = r[0] + '|' + +r[1]; if (seen.has(k)) return false; seen.add(k); return true; });
    for (let i = 0; i < rows.length; i += 1000) {
      const b = rows.slice(i, i + 1000); const cols = Array.from({ length: 10 }, (_, j) => b.map((r) => r[j]));
      await c.query(`INSERT INTO epg_prog (epg_id,s,e,title,sub,cat,kind,descr,yr,fl) SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::timestamptz[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[],$10::text[]) ON CONFLICT (epg_id,s) DO NOTHING`, cols);
    }
  }
  const idxOf = (rows) => (rows.length ? C.buildIndex(rows.map((r) => ({ id: r.id, names: r.names ? r.names.split('\n') : [r.name], feed: r.feed, n: r.n }))) : null);
  // country guard; ids from custom sources often have no country suffix → allowed
  const okCat = (cat, id) => { const raw = String(id).replace(SRC_RE, ''); return raw === id ? C.allowed(cat, id) : !C.idCountry(raw) || C.allowed(cat, raw); };
  // fuzzy name match in one index (+ "+1" timeshift fallback: base channel shifted by 60 min); adds the top candidates to `want`
  function fuzzy(ix, ch, w, want) {
    if (!ix) return { best: null, top: null, shift: 0 };
    const cands = (name) => C.candidates(ix, name, ch.category, 6).filter((x) => x.sim >= C.MATCH_MIN && okCat(ch.category, x.id));
    const cand = cands(ch.name); cand.slice(0, w).forEach((x) => want.add(x.id));
    let best = cand.find((x) => C.isMatch(x)) || null, shift = 0;
    if (!best && /\+\s*1\b/.test(ch.name)) { const c2 = cands(ch.name.replace(/\+\s*1\b/, ' ')); c2.slice(0, 2).forEach((x) => want.add(x.id)); const b2 = c2.find((x) => C.isMatch(x)); if (b2) { best = b2; shift = 60; } }
    return { best, top: cand[0] || null, shift };
  }
  // priority: manual → preferred custom sources → built-in mapping → epgshare (fuzzy, +1) → other custom sources (fill gaps)
  async function computeMap(c, chans, epgRows) {
    const pref = new Set((await sources()).filter((x) => x.enabled && x.pref).map((x) => 'src:' + x.id));
    const T = { p: [], m: [], l: [] }; for (const r of epgRows) (isSrcFeed(r.feed) ? (pref.has(r.feed) ? T.p : T.l) : isAltFeed(r.feed) ? T.l : T.m).push(r);
    const ixP = idxOf(T.p), ixM = idxOf(T.m), ixL = idxOf(T.l);
    const sk = skipOf(c), cur = await loadMap(), res = new Map(), want = new Set(), byId = new Map(epgRows.map((r) => [r.id, r]));
    const put = (ch, b, shift) => res.set(ch.id, { epg_id: b.id, score: b.sim, shift });
    let i = 0;
    for (const ch of chans) {
      if (++i % 10 === 0) await new Promise((r) => setImmediate(r)); // fuzzy matching is CPU heavy: yield so health checks / requests are served (a blocked loop got the instance restarted mid-refresh)
      const m = cur.get(ch.id);
      if (m && m.manual) { if (m.epg_id) want.add(m.epg_id); continue; }
      if (skipped(ch.category, sk)) { res.set(ch.id, { epg_id: '', score: 0, shift: 0 }); continue; }
      const p = fuzzy(ixP, ch, 2, want); if (p.best) { put(ch, p.best, p.shift); continue; }
      // 1) built-in verified mapping
      const kn = C.known(ch.name), kr = kn && byId.get(kn.id);
      if (kr) want.add(kn.id);
      // 2) fuzzy name match in the epgshare feeds, 3) custom/alternative sources for what is still missing
      const a = fuzzy(ixM, ch, 3, want), l = fuzzy(ixL, ch, 2, want);
      // coverage-aware: a stale id (few programmes in the window) loses to a fresh alternative
      const opts = []; if (kr && kr.n !== 0) opts.push({ epg_id: kn.id, score: 1, shift: kn.shift, n: kr.n }); if (a.best && a.best.n > 0) opts.push({ epg_id: a.best.id, score: a.best.sim, shift: a.shift, n: a.best.n }); if (l.best && l.best.n > 0) opts.push({ epg_id: l.best.id, score: l.best.sim, shift: l.shift, n: l.best.n });
      const pick = C.pickCovered(opts); if (pick) { res.set(ch.id, { epg_id: pick.epg_id, score: pick.score, shift: pick.shift || 0 }); continue; }
      const b = a.best && !(a.best.n < 0 && l.best && l.best.n > 0) ? a : l.best ? l : a;
      const top = a.top || p.top || l.top;
      res.set(ch.id, b.best ? { epg_id: b.best.id, score: b.best.sim, shift: b.shift } : { epg_id: '', score: top ? top.sim : 0, shift: 0 });
    }
    return { res, want };
  }
  async function saveMap(res) {
    const ids = [...res.keys()]; if (!ids.length) return;
    await pool.query(`INSERT INTO epg_map (channel_id,epg_id,manual,score,shift,updated_at) SELECT a,b,false,c,d,now() FROM unnest($1::int[],$2::text[],$3::real[],$4::int[]) AS t(a,b,c,d)
      ON CONFLICT (channel_id) DO UPDATE SET epg_id=EXCLUDED.epg_id, score=EXCLUDED.score, shift=EXCLUDED.shift, updated_at=now() WHERE NOT epg_map.manual`, [ids, ids.map((i) => res.get(i).epg_id), ids.map((i) => res.get(i).score), ids.map((i) => res.get(i).shift || 0)]);
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
    // mark the attempt first: a crash/restart mid-refresh must not cause a refresh loop on every boot
    if (!opt.feeds) await kv.set('try_at', new Date(t0).toISOString());
    const mlog = (w) => console.log(`EPG refresh ${w} ${Math.round((Date.now() - t0) / 1000)}s rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
    mlog('start');
    const allFeeds = [...feedsOf(c), ...(await sources()).filter((x) => x.enabled).map((x) => 'src:' + x.id)];
    let feeds = allFeeds; if (opt.feeds) feeds = feeds.filter((f) => opt.feeds.includes(f));
    const report = {}; if (opt.feeds) { try { const o = JSON.parse((await kv.get('report')) || '{}'); for (const f of allFeeds) if (o[f] && !opt.feeds.includes(f)) report[f] = o[f]; } catch {} }
    // phase 1: channel lists (download aborts at the first <programme>, only a few kB per feed)
    if (!opt.feeds) for (const f of feeds) {
      status.feed = f;
      try {
        const seenId = new Set(), list = (await readChannels(f)).filter((x) => x.id && !seenId.has(x.id) && seenId.add(x.id)); report[f] = { ch: list.length };
        if (list.length) await pool.query(`INSERT INTO epg_chan (id,name,names,feed,seen_at) SELECT a,b,c,d,now() FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) AS t(a,b,c,d) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,names=EXCLUDED.names,feed=EXCLUDED.feed,seen_at=now()`, [list.map((x) => x.id), list.map((x) => x.names[0] || x.id), list.map((x) => x.names.join('\n')), list.map((x) => f)]);
      } catch (e) { report[f] = { err: String(e.message).slice(0, 120) }; }
    }
    await pool.query(`DELETE FROM epg_chan WHERE NOT (feed = ANY($1)) OR seen_at < now() - interval '14 days'`, [allFeeds]);
    const chans = await channels();
    let epgRows = (await pool.query('SELECT id,name,names,feed,n FROM epg_chan')).rows;
    // phase 2: provisional auto-mapping + candidate set
    status.phase = 'párovanie';
    let { want } = await computeMap(c, chans, epgRows);
    // phase 3: programmes, one feed at a time (streamed, only wanted channels within the window)
    const now = Date.now(), from = Math.min(dayStart(now), now - 3 * 3600e3) - 3600e3, to = now + Math.max(12, Math.min(72, +c.epg_ahead || 36)) * 3600e3, far = dayStart(now) + 8 * 86400e3 + 6 * 3600e3, gEnd = c.guide_on === '1' ? dayStart(dayStart(now) + Math.max(1, Math.min(7, +c.guide_days || 4)) * 86400e3 + 6 * 3600e3) + 3 * 3600e3 : 0;
    const byFeed = new Map(); for (const r of epgRows) { if (!byFeed.has(r.feed)) byFeed.set(r.feed, []); byFeed.get(r.feed).push(r.id); }
    status.phase = 'program';
    for (const f of feeds) {
      const ids = (byFeed.get(f) || []).filter((i) => want.has(i)); if (!ids.length) { (report[f] = report[f] || {}).progs = 0; continue; }
      status.feed = f; mlog('feed ' + String(f).slice(0, 40));
      try {
        const { rows, counts, hl, slim } = await readProgs(f, new Set(ids), from, to, far, gEnd);
        const cl = await pool.connect();
        try {
          await cl.query('BEGIN');
          await cl.query('DELETE FROM epg_prog WHERE epg_id = ANY($1)', [ids]);
          await insertProgs(cl, rows);
          const all = byFeed.get(f); await cl.query('UPDATE epg_chan SET n = COALESCE(x.n, 0) FROM (SELECT a, b AS n FROM unnest($1::text[],$2::int[]) AS t(a,b)) x WHERE epg_chan.id = x.a', [all, all.map((i) => counts.get(i) || 0)]);
          await cl.query('COMMIT');
        } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
        let last = 0; for (const r of rows) if (+r[2] > last) last = +r[2];
        Object.assign(report[f] = report[f] || {}, { progs: rows.length, hl, slim, withData: [...counts.keys()].length, days: last ? +((last - now) / 86400e3).toFixed(1) : 0 });
      } catch (e) { (report[f] = report[f] || {}).err = String(e.message).slice(0, 120); }
    }
    // phase 4: final mapping now that we know which EPG channels really have data
    status.phase = 'ukladanie'; mlog('save');
    epgRows = (await pool.query('SELECT id,name,names,feed,n FROM epg_chan')).rows;
    const fin = await computeMap(c, chans, epgRows); await saveMap(fin.res);
    await pool.query(`DELETE FROM epg_map WHERE channel_id NOT IN (SELECT id FROM tv_channels)`);
    await pool.query(`DELETE FROM epg_prog WHERE e < $1 OR (epg_id NOT LIKE 'ext:%' AND epg_id NOT IN (SELECT epg_id FROM epg_map WHERE epg_id <> ''))`, [new Date(from)]);
    await pool.query(`DELETE FROM dnes_hide WHERE k LIKE 'p:%' AND created_at < now() - interval '3 days'`);
    await pool.query(`DELETE FROM dnes_pin WHERE e < now() - interval '1 day'`);
    status.phase = 'oficiálne programy'; status.feed = ''; mlog('official');
    try { const r = await OFF.merge(far, !!opt.offForce); mlog('official merged ' + (r && r.n)); } catch (e) { console.error('EPG official merge', e.message); }
    await kv.set('last_run', new Date().toISOString()); await kv.set('last_ms', Date.now() - t0); await kv.set('report', JSON.stringify(report));
    if (!opt.feeds) { await kv.set('last_full', new Date().toISOString()); await kv.set('data_v', DATA_V); }
    await kv.set('last_err', ''); mlog('done');
    dropCaches(); postersSoon();
    EXT.apply().catch((e) => console.error('EXT apply', e.message)); // a channel that now has real EPG drops its external rows
  }
  let timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    const tick = async () => {
      try {
        const c = cfg(await getSettings()); if (c.epg_on !== '1' && c.dnes_on !== '1') return;
        if (!running && !offRun && (await EXT.due())) EXT.run(); // light: ~11 small page reads every 6 h
        const last = Date.parse(await kv.get('last_full') || 0) || 0, h = Math.max(2, Math.min(24, +c.epg_hours || 6));
        // official SK/CZ schedules (light: a few small HTTP requests + SQL) run on their own, independent of the heavy XMLTV refresh
        if (!running && !offRun && ((await kv.get('off_v')) !== DATA_V || Date.now() - (Date.parse(await kv.get('off_at') || 0) || 0) > 12 * 3600e3)) {
          const far = dayStart(Date.now()) + 8 * 86400e3 + 6 * 3600e3;
          offRun = OFF.merge(far, false).then(async (r) => { await kv.set('off_v', DATA_V); console.log(`EPG official merged ${r && r.n} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`); })
            .catch((e) => console.error('EPG official', e.message)).finally(() => { offRun = null; dropCaches(); });
          return;
        }
        // no refresh loop on boot: last attempt never finished (crash/restart/deploy) → back off 3 h, otherwise 20 min
        const tried = Date.parse(await kv.get('try_at') || 0) || 0; if (Date.now() - tried < (tried > last + 60e3 ? 3 * 3600e3 : 20 * 60e3)) return;
        if (Date.now() - last > h * 3600e3 - 60e3 || (await kv.get('data_v')) !== DATA_V) refresh();
      } catch (e) { console.error('EPG tick', e.message); }
    };
    setTimeout(tick, 45e3).unref(); timer = setInterval(tick, 10 * 60e3); timer.unref();
    setTimeout(() => OFF.ctStart(), 90e3).unref(); // ČT XML queue (1 request / 70 s)
  }

  // ---------- read side ----------
  async function visibleMapped() {
    const c = cfg(await getSettings()), sk = skipOf(c), m = await loadMap();
    const ext = await EXT.extIds(); // channels filled from an external schedule (no real EPG) – shown even in skipped categories
    return (await channels()).filter((r) => r.visible && (ext.has(r.id) || (!skipped(r.category, sk) && m.get(r.id) && m.get(r.id).epg_id))).map((r) => (ext.has(r.id) ? { ...r, epg: 'ext:' + r.id, sh: 0, ext: true } : { ...r, epg: m.get(r.id).epg_id, sh: (m.get(r.id).shift || 0) * 60e3 }));
  }
  async function nowData() {
    if (nowCache && Date.now() - nowCache.t < 60e3) return nowCache.d;
    const vm = await visibleMapped(); const byEpg = new Map(); let maxSh = 0; for (const r of vm) { if (!byEpg.has(r.epg)) byEpg.set(r.epg, []); byEpg.get(r.epg).push(r); maxSh = Math.max(maxSh, r.sh); }
    const out = {}, nowS = Date.now() / 1000;
    if (byEpg.size) {
      const shOf = new Map(); for (const r of vm) shOf.set(r.epg, Math.max(shOf.get(r.epg) || 0, r.sh)); const ks = [...byEpg.keys()];
      const q = await pool.query(`SELECT epg_id, s, e, title, kind, fl FROM (SELECT p.epg_id,p.s,p.e,p.title,p.kind,p.fl, row_number() OVER (PARTITION BY p.epg_id ORDER BY p.s) AS rn FROM epg_prog p JOIN unnest($1::text[],$2::int[]) AS u(id,sh) ON p.epg_id = u.id WHERE p.e > now() - make_interval(secs => u.sh / 1000) AND p.s < now() + CASE WHEN u.id LIKE 'ext:%' THEN interval '8 days' ELSE interval '12 hours' END) x WHERE rn <= 6 ORDER BY epg_id, s`, [ks, ks.map((k) => shOf.get(k))]);
      for (const r of q.rows) for (const ch of byEpg.get(r.epg_id)) { const e = Math.round((+r.e + ch.sh) / 1000); if (e <= nowS) continue; const l = (out[ch.id] = out[ch.id] || []); if (l.length < 4) l.push([Math.round((+r.s + ch.sh) / 1000), e, r.title, r.kind === 'adult' ? '' : r.kind, xfl(r.fl)]); }
    }
    const d = { t: Math.round(Date.now() / 1000), c: out };
    nowCache = { t: Date.now(), d }; return d;
  }
  async function dayData(id) {
    const hit = dayCache.get(id); if (hit && Date.now() - hit.t < 300e3) return hit.d;
    const vm = (await visibleMapped()).find((r) => r.id === id); if (!vm) return null;
    const ds = dayStart(Date.now());
    const q = await pool.query(`SELECT s,e,title,sub,cat,kind,descr,lnk,fl FROM epg_prog WHERE epg_id=$1 AND e > $2 AND s < $3 ORDER BY s LIMIT 200`, [vm.epg, new Date(ds - vm.sh), new Date(ds + (vm.ext ? 8 * 86400e3 : 27 * 3600e3) - vm.sh)]); // external-schedule channels: whole next week (a few matches)
    const d = { id, name: vm.name, p: q.rows.map((r) => [Math.round((+r.s + vm.sh) / 1000), Math.round((+r.e + vm.sh) / 1000), r.title, r.kind === 'adult' ? '' : r.kind, r.sub, r.cat, r.descr, ctLink(r.lnk), xfl(r.fl)]) };
    if (dayCache.size > 1000) dayCache.clear(); dayCache.set(id, { t: Date.now(), d }); return d;
  }
  const xfl = (f) => (/q/.test(f || '') ? 'q' : /x/.test(f || '') ? 'x' : ''); // external schedule: 'x', predicted channel: 'q'
  const ctLink = (u) => (/^https:\/\/www\.ceskatelevize\.cz\//.test(u || '') ? u : ''); // ČT terms: every ČT programme links back to ČT
  const jsonOut = (res, d, age = 60) => { res.set({ 'Cache-Control': `public, max-age=${age}`, 'X-Content-Type-Options': 'nosniff' }); res.json(d); };
  app.get('/api/epg/now', wrap(async (req, res) => { const c = cfg(await getSettings()); if (c.epg_on !== '1') return jsonOut(res, { t: Math.round(Date.now() / 1000), c: {} }); jsonOut(res, await nowData()); }));
  app.get('/api/epg/day/:id(\\d+)', wrap(async (req, res) => { const c = cfg(await getSettings()); const d = c.epg_on === '1' ? await dayData(+req.params.id) : null; if (!d) return res.status(404).json({ p: [] }); jsonOut(res, d, 300); }));
  // assets for the Kanály page (tiles get filled by /static/epg.js)
  // ---------- reminders (.ics) and today's sport ----------
  const icsEsc = (t) => String(t || '').replace(/[\\;,]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n');
  const icsT = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (l) => { const out = []; let cur = '', n = 0; for (const ch of l) { const b = Buffer.byteLength(ch); if (n + b > 73) { out.push(cur); cur = ' '; n = 1; } cur += ch; n += b; } out.push(cur); return out.join('\r\n'); };
  function icsOut(res, x) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lnkbio//TV program//SK', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', 'UID:' + x.uid + '@lnkbio.onrender.com', 'DTSTAMP:' + icsT(Date.now()), 'DTSTART:' + icsT(x.s), 'DTEND:' + icsT(x.e),
      'SUMMARY:' + icsEsc(x.title + ' – ' + x.ch), 'DESCRIPTION:' + icsEsc(`${x.title}\nKanál: ${x.ch}${x.sub ? '\n' + x.sub : ''}${x.lnk ? '\nProgram: Česká televize – ' + x.lnk : '\nTV program: epgshare01.online (orientačný)'}`), 'LOCATION:' + icsEsc(x.ch),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(x.title + ' – ' + x.ch), 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
    const fn = 'tv-' + (tnorm(x.title).replace(/ /g, '-').slice(0, 40) || 'program') + '.ics';
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${fn}"`, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' });
    res.send(lines.map(fold).join('\r\n') + '\r\n');
  }
  app.get('/api/epg/ics/:id(\\d+)/:s(\\d{9,11})', wrap(async (req, res) => {
    const vm = (await visibleMapped()).find((r) => r.id === +req.params.id); if (!vm) return res.status(404).type('text').send('Not found');
    const r = (await pool.query('SELECT s,e,title,sub,lnk FROM epg_prog WHERE epg_id=$1 AND s=$2 LIMIT 1', [vm.epg, new Date(+req.params.s * 1000 - vm.sh)])).rows[0];
    if (!r) return res.status(404).type('text').send('Not found');
    icsOut(res, { uid: 'tv-' + vm.id + '-' + req.params.s, s: +r.s + vm.sh, e: +r.e + vm.sh, title: r.title, sub: r.sub, lnk: ctLink(r.lnk), ch: vm.name });
  }));
  app.get('/api/epg/ics/pin/:id(\\d+)', wrap(async (req, res) => {
    const p = (await pool.query('SELECT id,channel_id,s,e,title FROM dnes_pin WHERE id=$1', [+req.params.id])).rows[0]; const ch = p && (await channels()).find((r) => r.id === p.channel_id && r.visible);
    if (!ch) return res.status(404).type('text').send('Not found');
    icsOut(res, { uid: 'pin-' + p.id, s: +p.s, e: +p.e, title: p.title, ch: ch.name });
  }));
  app.get('/api/epg/sport', wrap(async (req, res) => {
    const c = cfg(await getSettings()); if (c.epg_on !== '1' || c.sport_on !== '1') return jsonOut(res, { l: [], ch: {} });
    if (!sportCache || Date.now() - sportCache.t > 120e3) {
      const now = Date.now(), de = dayStart(now) + 26 * 3600e3;
      const vm = (await visibleMapped()).filter((r) => !r.sh && !ADULT.test(r.category)); const byEpg = new Map(); for (const r of vm) { if (!byEpg.has(r.epg)) byEpg.set(r.epg, []); byEpg.get(r.epg).push(r); }
      const l = [], chs = {}, seen = new Set();
      if (byEpg.size) {
        const q = await pool.query(`SELECT epg_id,s,e,title,fl FROM epg_prog WHERE epg_id = ANY($1) AND kind='sport' AND e > now() AND s < $2 AND e - s >= interval '30 minutes' ORDER BY s LIMIT 1500`, [[...byEpg.keys()], new Date(de)]);
        for (const p of q.rows) {
          if (C.NOTLIVE.test(p.title) || JUNK.test(p.title)) continue;
          for (const ch of byEpg.get(p.epg_id).slice(0, 1)) {
            const k = tnorm(p.title) + '|' + +p.s + '|' + (skcz(ch) ? 1 : 0); if (seen.has(k)) continue; seen.add(k);
            const live = C.LIVE.test(p.title) || (p.fl || '').includes('l'), big = BIGSPORT.test(p.title) || NATTEAM.test(p.title);
            l.push([ch.id, Math.round(+p.s / 1000), Math.round(+p.e / 1000), p.title, live ? 1 : 0, big ? 1 : 0]);
            if (!chs[ch.id]) chs[ch.id] = [ch.name, ctx.tvchLogoSrc ? ctx.tvchLogoSrc(ch) : '/tvlogo/' + ch.id, skcz(ch) ? 1 : 0];
          }
          if (l.length >= 300) break;
        }
      }
      sportCache = { t: Date.now(), d: { t: Math.round(Date.now() / 1000), l, ch: chs } };
    }
    jsonOut(res, sportCache.d, 120);
  }));
  ctx.epgAssets = async (req) => { const c = cfg(await getSettings()); const shortOn = ctx.shortEpgReady ? await ctx.shortEpgReady().catch(() => false) : false; if (c.epg_on !== '1' && !shortOn) return ''; const en = req.lang === 'en'; return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><div id="epgcfg" hidden data-short="${shortOn ? "1" : "0"}" data-l="${en ? 'en' : 'sk'}" data-now="${esc(tx(en, 'Teraz', 'Now'))}" data-next="${esc(tx(en, 'Potom', 'Next'))}" data-day="${esc(tx(en, 'Celý program dnes', 'Full schedule today'))}" data-min="${esc(tx(en, 'min', 'min'))}"${G ? G.attrs(en, c) : ''} data-fav="${esc(tx(en, 'Obľúbené', 'Favourites'))}" data-favadd="${esc(tx(en, 'Pridať do obľúbených', 'Add to favourites'))}" data-favdel="${esc(tx(en, 'Odobrať z obľúbených', 'Remove from favourites'))}" data-rem="${esc(tx(en, 'Pripomenúť', 'Remind me'))}" data-load="${esc(tx(en, 'Načítavam…', 'Loading…'))}" data-left="${esc(tx(en, 'ešte', 'left'))}" data-dayx="${esc(tx(en, 'Rozpis zápasov na 7 dní', 'Match schedule, next 7 days'))}" data-pred="${esc(tx(en, 'predpokladaný kanál', 'expected channel'))}" data-predh="${esc(tx(en, 'Zdroj uvádza len platformu – číslo kanála je odhad', 'The source names only the platform – the channel number is an estimate'))}" data-ext="${esc(tx(en, 'podľa rozpisu', 'per fixture list'))}" data-exth="${esc(tx(en, 'Z verejného rozpisu súťaže / platformy', 'From the public competition / platform schedule'))}"></div><script src="/static/epg.js?v=${ASSET_V}" defer></script><p class="hint epgsrc">${esc(tx(en, 'TV program: epgshare01.online (orientačný, môže sa líšiť); oficiálne programy STVR, JOJ, Prima a Česká televize (odkaz „ČT“ vedie na ceskatelevize.cz).', 'TV schedule: epgshare01.online (indicative, may differ); official schedules from STVR, JOJ, Prima and Česká televize (the “ČT” link leads to ceskatelevize.cz).'))}</p>`; };

  // ---------- Dnes v TV ----------
  const CATW = [[/sloven/i, 12], [/česk|cesk/i, 9], [/filmy a seri/i, 7], [/^šport$|^sport$/i, 6], [/dokument/i, 2]];
  const DOCCH = /doku|docu|nature|history|histor|discovery|planete|national geographic|nat ?geo|animal|explore|travel|crime\b|investigation|viasat (explore|history|nature)|spektrum|da vinci/i;
  // SK/CZ scene: Slovak/Czech categories, plus thematic channels (sport, film, kids, docs, music…) whose schedule id is .sk/.cz
  const FOREIGN = /maďar|madar|poľs|pols|nemec|rusk|ukrajin|švajč|svajc|zahrani|khl|dospel|18\+/i;
  const SKCZCAT = /sloven|česk|cesk|lokáln|lokaln/i;
  const skcz = (r) => !FOREIGN.test(r.category) && (SKCZCAT.test(r.category) || /\.(sk|cz)$/i.test(r.epg));
  const BIGSPORT = /liga majstrov|liga mistr|champions league|europa league|konferen[čc]n|conference league|premier league|bundesliga|la ?liga|serie a|ligue 1|nik[eé] lig|chance lig|fortuna lig|tipsport|tipos|extralig|\bnhl\b|\bnba\b|\bnfl\b|majstrovstv|mistrovstv|world cup|\beuro 20|olymp|\bf1\b|formul[ae] 1|grand prix|wimbledon|roland garros|us open|australian open|el cl[aá]sico|fin[aá]le|\bfinal\b|semifin|play-?off|derby|super bowl|\bufc\b|\boktagon|ballon d.?or|zlat[aá] lopt|zlat[yý] m[ií][čc]/i;
  const NATTEAM = /\b(slovensk[oa]|česk[oa]|cesk[oa]|slovakia|czechia|czech republic|reprezent)/i;
  const BIGCLUB = /slovan|sparta|slavia|plze[nň]|real madrid|barcelona|bayern|liverpool|manchester|arsenal|chelsea|juventus|\binter\b|\bmilan\b|\bpsg\b|dortmund|kometa|t[řr]inec|pardubice|ko[šs]ice|\bnitra|zvolen|bystrica|trnava|žilina|zilina/i;
  // extra points for the day's TOP: big sport, national team, popular/high-rated film (Wikidata), premiere
  function topBoost(x, info) {
    let b = 0; const t = x.title + ' ' + (x.cat || '');
    if (x.kind === 'sport') { if (BIGSPORT.test(t)) b += 20; if (NATTEAM.test(x.title)) b += 28; else if (BIGCLUB.test(x.title)) b += 8; }
    else if (x.kind === 'film' && info) { b += info.pop >= 30 ? 14 : info.pop >= 15 ? 8 : info.pop >= 8 ? 4 : 0; if (info.rt >= 80) b += 6; }
    else if (x.kind === 'show' && C.BIGSHOW.test(x.title)) b += 10;
    if (x.fl && x.fl.includes('p') && !x.fl.includes('r')) b += 6;
    return b;
  }
  // pick the public list with variety: each further item of the same kind costs 10 points
  // pick n by score with variety by kind; dy = { cap, pre } → at most `cap` items per calendar day (pre = already chosen), fewer same-day picks preferred
  function diverse(list, n, dy) {
    const left = list.slice(), out = [], cnt = {}, dc = new Map(), dk = (x) => dayStart(x.s);
    if (dy) for (const x of dy.pre || []) dc.set(dk(x), (dc.get(dk(x)) || 0) + 1);
    while (out.length < n && left.length) {
      let bi = -1, bv = -1e9;
      left.forEach((x, i) => { const d = dy ? dc.get(dk(x)) || 0 : 0; if (dy && d >= dy.cap) return; const v = x.score - 10 * (cnt[x.kind] || 0) - 30 * d; if (v > bv) { bv = v; bi = i; } });
      if (bi < 0) break;
      const x = left.splice(bi, 1)[0]; cnt[x.kind] = (cnt[x.kind] || 0) + 1; out.push(x); if (dy) dc.set(dk(x), (dc.get(dk(x)) || 0) + 1);
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
  // ---------- Top dnes / Top týždňa ----------
  // two compact sections: today (now → 02:00) and the next 7 days; 3–5 items each, exactly one "best"; <3 good items → section hidden
  const clampN = (v) => Math.max(3, Math.min(5, parseInt(v, 10) || 4));
  const MIN_N = 3;
  async function topItems(opt = {}) {
    if (!opt.all && dnesCache && Date.now() - dnesCache.t < 120e3) return dnesCache.d;
    const c = cfg(await getSettings()), now = Date.now(), ds = dayStart(now), de = ds + 26 * 3600e3;
    const wEnd = dayStart(ds + 8 * 86400e3 + 6 * 3600e3) + 2 * 3600e3; // tomorrow … +7 days
    const kinds = String(c.dnes_kinds).split(',').map((x) => x.trim()).filter(Boolean);
    const vm = (await visibleMapped()).filter((r) => !ADULT.test(r.category) && !r.sh && (c.dnes_scope === 'all' || skcz(r))); const byEpg = new Map(); for (const r of vm) { if (!byEpg.has(r.epg)) byEpg.set(r.epg, []); byEpg.get(r.epg).push(r); }
    const hidden = new Map((await pool.query('SELECT k,title FROM dnes_hide')).rows.map((r) => [r.k, r.title]));
    const cand = [];
    if (byEpg.size && kinds.length) {
      const q = await pool.query(`SELECT epg_id,s,e,title,cat,kind,yr,fl,lnk FROM epg_prog WHERE epg_id = ANY($1) AND kind = ANY($2) AND e > $3 AND s < $4 AND s > $5`, [[...byEpg.keys()], kinds, new Date(now + 10 * 60e3), new Date(c.week_on === '1' ? wEnd : de), new Date(now - 40 * 60e3)]);
      for (const p of q.rows) {
        const ch = byEpg.get(p.epg_id)[0]; const sc = scoreOf(p, ch, now); if (sc < 34) continue;
        const k = 'p:' + p.epg_id + '|' + +p.s, tk = 't:' + tnorm(p.title);
        cand.push({ k, tk, sec: +p.s < de ? 'd' : 'w', s: +p.s, e: +p.e, title: p.title, kind: p.kind, cat: p.cat, yr: p.yr, fl: p.fl || '', lnk: ctLink(p.lnk), ch, score: sc, hidden: hidden.has(k) || hidden.has(tk) });
      }
    }
    const info = await posterInfo(cand);
    for (const x of cand) { x.boost = topBoost(x, info.get(posterKey(x))); x.score += x.boost; }
    cand.sort((a, b) => b.score - a.score || a.s - b.s);
    const all = await channels();
    const pins = (await pool.query('SELECT id,channel_id,s,e,title,kind FROM dnes_pin WHERE e > now() AND s < $1 ORDER BY s', [new Date(wEnd)])).rows
      .map((p) => { const ch = all.find((r) => r.id === p.channel_id && r.visible); return ch ? { k: 'pin:' + p.id, pin: p.id, sec: +p.s < de ? 'd' : 'w', s: +p.s, e: +p.e, title: p.title, kind: p.kind, cat: '', ch, score: 999 } : null; }).filter(Boolean);
    // one section: dedupe titles (reruns, +1/HD variants – keep the best airing), skip hidden/used titles, 1 per channel (2 if needed), variety by kind
    function section(sec, n, used) {
      const list = cand.filter((x) => x.sec === sec), ps = pins.filter((x) => x.sec === sec).slice(0, n);
      const seen = new Set(used), perCh = new Map(), first = [], second = [];
      for (const x of ps) seen.add('t:' + tnorm(x.title));
      for (const x of list) {
        if (seen.has(x.tk)) { x.dupe = true; continue; } if (x.hidden) continue; seen.add(x.tk);
        const k = perCh.get(x.ch.id) || 0; perCh.set(x.ch.id, k + 1); if (k === 0) first.push(x); else if (k === 1) second.push(x);
      }
      let picked;
      if (sec === 'w') { // Top týždňa: spread over the days (prefer one per day, max 2 per day; 3 only if the EPG has too few days)
        const pool2 = first.concat(second); picked = [];
        for (const cap of [1, 2, 3]) { if (picked.length >= n - ps.length) break; picked = picked.concat(diverse(pool2.filter((x) => !picked.includes(x) && (cap > 1 || first.includes(x))), n - ps.length - picked.length, { cap, pre: ps.concat(picked) })); }
      } else { picked = diverse(first, n - ps.length); if (picked.length < n - ps.length) picked = picked.concat(diverse(second, n - ps.length - picked.length)); }
      const items = ps.concat(picked);
      if (items.length < MIN_N) return { items: [], list, pins: ps };
      const best = items.slice().sort((a, b) => b.score - a.score || a.s - b.s)[0];
      const rank = items.slice().sort((a, b) => b.score - a.score || a.s - b.s); rank.forEach((x, i) => { x.rank = i + 1; });
      const out = [best, ...items.filter((x) => x !== best).sort((a, b) => a.s - b.s)].map((x) => ({ ...x, best: x === best }));
      return { items: out, list, pins: ps };
    }
    const d = section('d', clampN(c.top_n), []);
    const w = c.week_on === '1' ? section('w', clampN(c.week_n), d.items.map((x) => 't:' + tnorm(x.title))) : { items: [], list: [], pins: [] };
    const out = opt.all ? { day: d, week: w } : { day: d.items, week: w.items };
    if (!opt.all) dnesCache = { t: Date.now(), d: out };
    return out;
  }
  const posterKey = (x) => tnorm(x.title) + '|' + (x.yr || '');
  async function posterInfo(items) {
    const ks = [...new Set(items.filter((x) => x.kind === 'film').map(posterKey))]; if (!ks.length) return new Map();
    return new Map((await pool.query('SELECT k,pop,rt FROM epg_poster WHERE k = ANY($1)', [ks])).rows.map((r) => [r.k, r]));
  }
  async function posterMap(items) {
    const ks = [...new Set(items.filter((x) => x.kind === 'film').map(posterKey))]; if (!ks.length) return new Map();
    return new Map((await pool.query('SELECT k,url FROM epg_poster WHERE k = ANY($1) AND url <> \'\'', [ks])).rows.map((r) => [r.k, r.url]));
  }
  // look up one film poster on Wikidata (cached in epg_poster; misses retried after 7 days); true = a lookup was made
  async function posterOne(x) {
    const k = posterKey(x); if ((await pool.query('SELECT 1 FROM epg_poster WHERE k=$1 AND (url <> \'\' OR at > now() - interval \'7 days\')', [k])).rowCount) return false;
    let r = null; try { r = await POSTER.find(x.title, x.yr); } catch { r = null; }
    const url = r && /^https:\/\/upload\.wikimedia\.org\//.test(r.url) ? r.url : '';
    await pool.query('INSERT INTO epg_poster (k,url,label,pop,rt,at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (k) DO UPDATE SET url=$2,label=$3,pop=$4,rt=$5,at=now()', [k, url, r ? String(r.label || '').slice(0, 200) : '', r ? Math.min(999, r.pop | 0) : 0, r ? Math.min(100, r.rt | 0) : 0]);
    return true;
  }
  let posterBusy = false;
  function postersSoon() {
    if (posterBusy) return; posterBusy = true;
    setTimeout(async () => {
      try {
        const t = await topItems({ all: true }), pub = await topItems();
        const items = [...pub.day, ...pub.week, ...t.day.list.slice(0, 40), ...t.week.list.slice(0, 50)].filter((x) => x.kind === 'film');
        for (const x of items) if (await posterOne(x)) await new Promise((ok) => setTimeout(ok, 400));
        dnesCache = null; console.log(`EPG posters done (${items.length}) rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
      } catch (e) { console.error('EPG posters', e.message); } finally { posterBusy = false; }
    }, 2000).unref();
  }
  const KL = (en, k) => (en ? C.KIND_LABEL_EN : C.KIND_LABEL)[k] || tx(en, 'Program', 'Show');
  const fmtWD = { sk: new Intl.DateTimeFormat('sk-SK', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'numeric' }), en: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }) };
  const dayLbl = (ms, en) => { const d = dayStart(ms), t = dayStart(Date.now()); if (d === t) return tx(en, 'Dnes', 'Today'); if (d === dayStart(t + 30 * 3600e3)) return tx(en, 'Zajtra', 'Tomorrow'); return fmtWD[en ? 'en' : 'sk'].format(new Date(ms)); };
  const SPEED = [0, 18, 28, 40, 56, 80]; // px/s for admin speed 1–5
  ctx.dnesBlock = async (req, s) => {
    try {
      const c = cfg(await getSettings()); if (c.dnes_on !== '1') return '';
      const t = await topItems(); if (!t.day.length && !t.week.length) return '';
      const en = req.lang === 'en', pm = await posterMap([...t.day, ...t.week]), now = Date.now();
      const logo = (ch) => (ctx.tvchLogoSrc ? ctx.tvchLogoSrc(ch) : '/tvlogo/' + ch.id);
      const card = (x) => { const pu = x.kind === 'film' && pm.get(posterKey(x)); const ics = x.pin ? '/api/epg/ics/pin/' + x.pin : `/api/epg/ics/${x.ch.id}/${Math.round(x.s / 1000)}`;
        return `<li class="hli dk-${esc(x.kind || 'x')}${x.best ? ' best' : ''}${x.s <= now ? ' live' : ''}" data-s="${Math.round(x.s / 1000)}" data-e="${Math.round(x.e / 1000)}" data-r="${x.rank || 9}">${pu ? `<img class="hlp" src="${esc(pu)}" alt="" loading="lazy" decoding="async" width="96" height="136" referrerpolicy="no-referrer">` : `<img class="hlp hlo" src="${esc(logo(x.ch))}" alt="" loading="lazy" decoding="async" width="80" height="80">`}<div class="hlb"><div class="hlt"><span class="hlbest">★ ${esc(tx(en, 'Naj', 'Top pick'))}</span><span class="hld">${esc(dayLbl(x.s, en))}</span><time datetime="${new Date(x.s).toISOString()}">${esc(hm(x.s))}</time><span class="hlk">${C.KIND_ICON[x.kind] || '📺'} ${esc(KL(en, x.kind))}</span><span class="hllive">${esc(tx(en, 'práve beží', 'on now'))}</span></div><div class="hln">${esc(x.title)}</div><div class="hlc"><img src="${esc(logo(x.ch))}" alt="" width="20" height="20" loading="lazy" decoding="async"><span>${esc(x.ch.name)}</span>${x.lnk ? `<a class="ctl" href="${esc(x.lnk)}" target="_blank" rel="noopener" title="${esc(tx(en, 'Program: Česká televize', 'Schedule: Česká televize'))}">ČT</a>` : ''}</div><a class="hlr" href="${ics}" rel="nofollow" download title="${esc(tx(en, 'Pripomenúť (pridať do kalendára)', 'Remind me (add to calendar)'))}">🔔 ${esc(tx(en, 'Pripomenúť', 'Remind me'))}</a></div></li>`; };
      // moving strips (JS loops them seamlessly; without JS / with reduced motion they stay a static grid)
      const mv = c.top_move !== '0', sp = SPEED[Math.max(1, Math.min(5, +c.dnes_speed || 3))];
      const sec = (id, icon, title, items) => (items.length ? `<section class="hls" id="${id}" aria-labelledby="${id}-h"${mv ? ` data-speed="${sp}"` : ''}><div class="hlhd"><h2 class="hlh" id="${id}-h">${icon} ${esc(title)}</h2>${mv ? `<button type="button" class="dnpp" aria-pressed="false" data-pause="${esc(tx(en, '⏸ Zastaviť', '⏸ Pause'))}" data-play="${esc(tx(en, '▶ Spustiť', '▶ Play'))}" hidden>${esc(tx(en, '⏸ Zastaviť', '⏸ Pause'))}</button>` : ''}</div><div class="hlv" tabindex="0" aria-label="${esc(tx(en, 'Pás – posúvajte do strán', 'Strip – scroll sideways'))}"><ol class="hll">${items.map(card).join('')}</ol></div></section>` : '');
      return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><div class="tops">${sec('top-dnes', '<span class="dnl">●</span>', (en && c.top_title_en) || c.top_title, t.day)}${sec('top-tyzden', '📅', (en && c.week_title_en) || c.week_title, t.week)}<a class="dnm" href="/${esc(s.slug)}/kanaly${en ? '?lang=en' : ''}#katalog">${esc(tx(en, 'Celý TV program pri kanáloch →', 'Full TV schedule by channel →'))}</a></div><script src="/static/epg.js?v=${ASSET_V}" defer></script>`;
    } catch (e) { console.error('dnes', e.message); return ''; }
  };

  // ---------- admin: channel edit form hook ----------
  const mapVal = (m) => (m ? (m.manual && !m.epg_id ? '-' : m.epg_id + (m.epg_id && m.shift ? '@' + (m.shift > 0 ? '+' : '') + m.shift : '')) : '');
  ctx.epgAdminPrep = async () => { const m = await loadMap(); const n = (await pool.query('SELECT COUNT(*)::int AS n FROM epg_chan')).rows[0].n; return { m, n }; };
  ctx.epgAdminField = (prep, r) => {
    const m = prep.m.get(r.id); const v = mapVal(m);
    return `<label>EPG id (TV program) · <a href="/admin/epg/ch/${r.id}">🔎 vybrať</a> <span class="hint">${m ? (m.manual ? 'ručne' : m.epg_id ? 'automaticky ' + Math.round(m.score * 100) + ' %' : 'nenájdené') : 'zatiaľ nepárované'} · prázdne = automaticky, „-“ = bez programu, „id@+60“ = posun v minútach (+1 kanály)</span></label><input name="epg_id" maxlength="120" value="${esc(v)}" autocomplete="off"><input type="hidden" name="epg_prev" value="${esc(v)}">`;
  };
  async function setManual(id, v) {
    v = String(v == null ? '' : v).trim().slice(0, 130);
    let eid = v === '-' ? '' : v, sh = 0; const mm = /^(.*?)\s*@\s*([+-]?\d{1,3})$/.exec(eid); if (mm) { eid = mm[1]; sh = Math.max(-720, Math.min(720, +mm[2])); }
    if (v === '') await pool.query('UPDATE epg_map SET manual=false, updated_at=now() WHERE channel_id=$1', [id]);
    else {
      if (eid && !(await pool.query('SELECT 1 FROM epg_chan WHERE id=$1', [eid])).rowCount) return false;
      await pool.query(`INSERT INTO epg_map (channel_id,epg_id,manual,score,shift,updated_at) VALUES ($1,$2,true,1,$3,now()) ON CONFLICT (channel_id) DO UPDATE SET epg_id=$2, manual=true, score=1, shift=$3, updated_at=now()`, [id, eid, sh]);
    }
    dropCaches(); soonPartial(eid || null); return true;
  }
  let partialT = null; const partialFeeds = new Set();
  async function soonPartial(eid) {
    if (eid) { const r = (await pool.query('SELECT feed FROM epg_chan WHERE id=$1', [eid])).rows[0]; if (r) partialFeeds.add(r.feed); }
    if (partialT) clearTimeout(partialT);
    partialT = setTimeout(() => { partialT = null; const f = [...partialFeeds]; partialFeeds.clear(); if (running) running.then(() => refresh({ feeds: f.length ? f : ['-'] })); else refresh({ feeds: f.length ? f : ['-'] }); }, 15e3); partialT.unref();
  }
  ctx.epgOnEdit = async (id, body) => { if (body && 'epg_id' in body && String(body.epg_id).trim() !== String(body.epg_prev || '').trim()) return setManual(id, body.epg_id); return true; };

  // ---------- admin: custom EPG sources (XMLTV URL) ----------
  // On save the file is downloaded once (SSRF-safe, size + time limit, streamed), channel list stored, stats + coverage computed,
  // then a partial refresh downloads its programmes for the channels that need them. Only schedule metadata is kept.
  let probing = false;
  async function noProgChannels() { // visible, not skipped, without any upcoming programme
    const c = cfg(await getSettings()), sk = skipOf(c), nd = await nowData();
    return (await channels()).filter((r) => r.visible && !skipped(r.category, sk) && !(nd.c[r.id] && nd.c[r.id].length));
  }
  async function probe(src) {
    const key = 'src:' + src.id, pre = 'src' + src.id + ':', now = Date.now();
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 75e3);
    const chs = new Map(), cnt = new Map(); let np = 0, last = 0, err = '';
    try {
      const o = await FETCH.open(src.url, { signal: ac.signal });
      await C.parseStream(o.stream, { gz: o.gz, maxBytes: 300 * 1024 * 1024,
        onChannel: (x) => { if (x.id && chs.size < 5000) chs.set(C.clip(x.id, 120), x.names.slice(0, 4).map((n) => C.clip(n, 120))); },
        onProg: (p) => { np++; if (p.ch && p.stop > now && p.stop > p.start) { const id = C.clip(p.ch, 120); cnt.set(id, (cnt.get(id) || 0) + 1); if (p.stop > last) last = p.stop; } } });
      for (const id of cnt.keys()) if (!chs.has(id) && chs.size < 5000) chs.set(id, [id]);
      if (!chs.size) err = 'Súbor neobsahuje XMLTV kanály ani program (je to naozaj XMLTV EPG?).';
    } catch (e) { if (e && e.code === 'NOTEPG') src.notepg = true; err = ac.signal.aborted ? 'Časový limit 75 s – súbor je príliš veľký alebo server pomalý.' : 'Chyba: ' + String(e.message || e).slice(0, 160); }
    finally { clearTimeout(tm); ac.abort(); }
    let ncover = -1, cover = [];
    if (!err) {
      const list = [...chs].map(([id, names]) => ({ id: pre + id, name: names[0] || id, names: names.join('\n'), feed: key, n: cnt.get(id) || 0 }));
      const cl = await pool.connect();
      try {
        await cl.query('BEGIN'); await cl.query('DELETE FROM epg_chan WHERE feed=$1', [key]);
        for (let i = 0; i < list.length; i += 1000) { const b = list.slice(i, i + 1000); await cl.query(`INSERT INTO epg_chan (id,name,names,feed,n,seen_at) SELECT a,b,c,d,e,now() FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::int[]) AS t(a,b,c,d,e) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,names=EXCLUDED.names,feed=EXCLUDED.feed,n=EXCLUDED.n,seen_at=now()`, [b.map((x) => x.id), b.map((x) => x.name), b.map((x) => x.names), b.map((x) => x.feed), b.map((x) => x.n)]); }
        await cl.query('COMMIT');
      } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
      // how many of our channels without programme would this source cover
      const ix = idxOf(list), w = new Set(); ncover = 0;
      for (const ch of await noProgChannels()) { const r = fuzzy(ix, ch, 1, w); if (r.best && r.best.n > 0) { ncover++; if (cover.length < 40) cover.push(ch.name); } }
    }
    await pool.query('UPDATE epg_src SET nch=$2, nprog=$3, ncover=$4, cover=$5, days=$6, err=$7, checked_at=now() WHERE id=$1', [src.id, err ? -1 : chs.size, err ? -1 : np, ncover, cover.join('\n'), last ? +((last - now) / 86400e3).toFixed(1) : 0, err]);
    // a playlist/stream URL is never kept: the source is disabled and its URL cleared
    if (src.notepg) await pool.query(`UPDATE epg_src SET url='', enabled=false WHERE id=$1`, [src.id]);
    srcCache = null;
    return !err;
  }
  function refreshSoon(keys) { for (const k of keys) partialFeeds.add(k); soonPartial(null); }
  // channels may fall back to other feeds whose programmes are not stored → full refresh (in the background)
  const refreshAll = () => { const go = () => (running ? running.then(go) : refresh()); setTimeout(() => { go().catch(() => {}); }, 2000).unref(); };
  const srcClean = (b) => ({ name: String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60), url: String(b.url || '').trim().slice(0, 600) });
  function srcCheck(url) { try { FETCH.checkUrl(url); } catch (e) { return e.message; } return ''; } // any http(s) URL – the format is checked by content when testing (epgfetch.js)
  const srcBack = (res, m, id) => res.redirect(303, '/admin/epg?m=' + m + (id ? '&src=' + id : '') + '#zdroje');
  admin.post('/epg/src', needAuth, csrf, wrap(async (req, res) => {
    const b = srcClean(req.body); const bad = srcCheck(b.url); if (bad) { await kv.set('src_err', bad); return srcBack(res, 'srcbad'); }
    if ((await sources()).length >= SRC_MAX) return srcBack(res, 'srcmax');
    if ((await sources()).some((x) => x.url === b.url)) return srcBack(res, 'srcdup');
    if (probing) return srcBack(res, 'srcbusy');
    const row = (await pool.query('INSERT INTO epg_src (name,url,enabled,pref) VALUES ($1,$2,true,$3) RETURNING *', [b.name || new URL(b.url).hostname, b.url, req.body.pref === '1'])).rows[0]; srcCache = null;
    probing = true; let ok = false; try { ok = await probe(row); } finally { probing = false; }
    if (row.notepg) { const e = (await pool.query('SELECT err FROM epg_src WHERE id=$1', [row.id])).rows[0]; await pool.query('DELETE FROM epg_src WHERE id=$1', [row.id]); srcCache = null; await kv.set('src_err', String((e && e.err) || '').replace(/^Chyba: /, '')); return srcBack(res, 'srcbad'); }
    if (ok) refreshSoon(['src:' + row.id]);
    srcBack(res, ok ? 'srcok' : 'srcerr', row.id);
  }));
  admin.post('/epg/src/:id(\\d+)', needAuth, csrf, wrap(async (req, res) => {
    const id = +req.params.id, cur = (await sources()).find((x) => x.id === id); if (!cur) return srcBack(res, 'ok');
    const b = srcClean(req.body); const bad = srcCheck(b.url); if (bad) { await kv.set('src_err', bad); return srcBack(res, 'srcbad', id); }
    const on = req.body.enabled === '1', pref = req.body.pref === '1', urlCh = b.url !== cur.url;
    await pool.query('UPDATE epg_src SET name=$2, url=$3, enabled=$4, pref=$5 WHERE id=$1', [id, b.name || cur.name, b.url, on, pref]); srcCache = null;
    if (!on) { await pool.query('DELETE FROM epg_chan WHERE feed=$1', [`src:${id}`]); refreshAll(); return srcBack(res, 'ok', id); }
    if (urlCh || !cur.enabled || cur.nch < 0) {
      if (probing) return srcBack(res, 'srcbusy', id);
      probing = true; let ok = false; try { ok = await probe((await sources()).find((x) => x.id === id)); } finally { probing = false; }
      if (ok) refreshSoon([`src:${id}`]); return srcBack(res, ok ? 'srcok' : 'srcerr', id);
    }
    if (cur.pref && !pref) refreshAll(); else if (pref !== cur.pref) refreshSoon([`src:${id}`]); srcBack(res, 'ok', id);
  }));
  admin.post('/epg/src/:id(\\d+)/test', needAuth, csrf, wrap(async (req, res) => {
    const src = (await sources()).find((x) => x.id === +req.params.id); if (!src) return srcBack(res, 'ok');
    if (probing) return srcBack(res, 'srcbusy', src.id);
    probing = true; let ok = false; try { ok = await probe(src); } finally { probing = false; }
    if (ok && src.enabled) refreshSoon([`src:${src.id}`]); srcBack(res, ok ? 'srcok' : 'srcerr', src.id);
  }));
  admin.post('/epg/src/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => {
    const id = +req.params.id; if (req.body.confirm !== '1') return srcBack(res, 'ok', id);
    await pool.query('DELETE FROM epg_src WHERE id=$1', [id]); await pool.query('DELETE FROM epg_chan WHERE feed=$1', [`src:${id}`]); await pool.query('DELETE FROM epg_prog WHERE epg_id LIKE $1', [`src${id}:%`]);
    await pool.query(`UPDATE epg_map SET epg_id='', score=0 WHERE NOT manual AND epg_id LIKE $1`, [`src${id}:%`]);
    srcCache = null; dropCaches(); refreshAll(); srcBack(res, 'del');
  }));
  // official broadcaster schedules card (epgoff.js)
  let offRun = null;
  async function offCard(req) {
    const st = await getSettings(), on = OFF.on(st), want = OFF.srcOn(st), x = await OFF.status();
    const per = new Map(x.per.map((r) => [r.src, r])), ids = Object.entries((x.merge && x.merge.ids) || {});
    const rows = Object.entries(OFFICIAL.SOURCES).map(([k, src]) => { const r = (x.report || {})[k] || {}, p = per.get(k);
      return `<label class="ck"><input type="checkbox" name="src_${k}" value="1"${want.has(k) ? ' checked' : ''}> ${esc(src.name)} <span class="hint">${r.err ? '⚠ ' + esc(r.err) + ' · ' : ''}${p ? `${p.n} rel. do ${esc(dayLbl(+p.b, false))}` : 'zatiaľ bez údajov'}${r.days ? ` · ${r.days} dní` : ''}${r.queue ? ` · fronta ${esc(r.queue)}` : ''}</span></label>`; }).join('');
    return `<form method="post" action="/admin/epg/off" class="card" id="oficialne">${hid(req)}<h2>🏛 Oficiálne programy TV staníc (až 7 dní)</h2>
<p class="hint">Bezplatné XMLTV súbory majú pre SK/CZ kanály program len na ~3–4 dni. Ďalšie dni sa dopĺňajú z verejných programov priamo od staníc (iba čas, názov, epizóda, žáner; žiadne streamy). Načítava sa max. 2× denne, s pauzami medzi požiadavkami. Doplní sa iba to, čo je po konci programu z XMLTV.</p>
<label class="ck"><input type="checkbox" name="off_on" value="1"${on ? ' checked' : ''}> Dopĺňať program z oficiálnych zdrojov</label>${rows}
<p class="hint">Posledné načítanie: ${esc(ago(x.at))}${x.merge && x.merge.n != null ? ` · doplnených relácií: ${x.merge.n} pre ${ids.length} EPG kanálov` : ''}${offRun ? ' · <b>práve beží…</b>' : ''}</p>
${ids.length ? `<details><summary>Doplnené kanály</summary><p class="hint">${ids.map(([id, ch]) => esc(id) + ' ← ' + esc(ch)).join(' · ')}</p></details>` : ''}
<p class="hint"><b>ČT</b>: oficiálny XML export (registrovaný účet, meno iba v premennej prostredia CT_XML_USER). Podmienky ČT: max. 1 súbor za minútu (načítava sa postupne, 1 kanál-deň za ~70 s; dnes/zajtra každých 6 h, ostatné dni 1× denne), údaje sa nemenia, pri každej relácii je odkaz „ČT“ na ceskatelevize.cz, údaje sa ďalej nešíria (žiadny export). ČT má prednosť pred XMLTV.</p>
<p class="hint">Nedostupné: <b>Markíza</b> a <b>Nova</b> (stránky programu blokujú automatické čítanie). Tieto kanály majú program z XMLTV (~3–4 dni).</p>
<div class="row"><button>Uložiť</button><button name="now" value="1">🔄 Uložiť a načítať teraz</button></div></form>`;
  }
  async function srcCard(req, report) {
    const list = await sources(), miss = await noProgChannels(), err = await kv.get('src_err');
    const sel = +req.query.src || 0;
    const row = (x) => { const r = report['src:' + x.id] || {};
      return `<form method="post" action="/admin/epg/src/${x.id}" class="srcrow${x.id === sel ? ' sel' : ''}">${hid(req)}<div class="row"><b>${esc(x.name)}</b><span class="hint">${x.enabled ? '✅ zapnutý' : '⏸ vypnutý'}${x.pref ? ' · ⭐ prednostný' : ''} · overené ${esc(ago(x.checked_at && x.checked_at.toISOString()))}</span></div>
${x.err ? `<p class="err">${esc(x.err)}</p>` : x.nch >= 0 ? `<p>📺 <b>${x.nch}</b> kanálov · 🗓 <b>${x.nprog}</b> relácií · na <b>${esc(String(x.days))}</b> dní dopredu · pokryje <b>${x.ncover}</b> našich kanálov bez programu${r.progs != null ? ` · posledná obnova: ${r.err ? '⚠ ' + esc(r.err) : r.progs + ' rel. uložených'}` : ''}</p>${x.cover ? `<p class="hint">Pokryje napr.: ${esc(x.cover.split('\n').slice(0, 15).join(', '))}${x.ncover > 15 ? '…' : ''}</p>` : ''}` : '<p class="hint">Zatiaľ neoverené.</p>'}
<label>Názov</label><input name="name" maxlength="60" value="${esc(x.name)}"><label>URL TV programu (XMLTV)</label><input name="url" type="url" maxlength="600" value="${esc(x.url)}" required>
<label class="ck"><input type="checkbox" name="enabled" value="1"${x.enabled ? ' checked' : ''}> Zapnutý</label><label class="ck"><input type="checkbox" name="pref" value="1"${x.pref ? ' checked' : ''}> ⭐ Prednostný (použiť aj pre kanály, ktoré už program majú)</label>
<div class="row"><button>💾 Uložiť</button><button formaction="/admin/epg/src/${x.id}/test">🔍 Otestovať znova</button><label class="ck"><input type="checkbox" name="confirm" value="1"> potvrdiť</label><button class="d" formaction="/admin/epg/src/${x.id}/delete">🗑 Zmazať</button></div></form>`; };
    const byCat = new Map(); for (const r of miss) { if (!byCat.has(r.category)) byCat.set(r.category, []); byCat.get(r.category).push(r); }
    return `<div class="card" id="zdroje"><h2>📡 Vlastné EPG zdroje</h2><p class="hint">Pridajte ľubovoľný http/https odkaz na TV program vo formáte XMLTV – prípona ani parametre nerozhodujú (napr. <code>.xml</code>, <code>.gz</code>, <code>.xz</code>, <code>.zip</code>, <code>.php</code> alebo bez prípony). Formát sa rozpozná podľa obsahu pri overení. Použije sa pre kanály, ktoré program zatiaľ nemajú (prednostný zdroj aj pre ostatné). Sťahuje sa spolu s ostatnými zdrojmi (každých ${esc(cfg(await getSettings()).epg_hours)} h). Párovanie kanálov je automatické podľa názvu; ručne cez „EPG id“ pri kanáli (🔎). Ukladá sa iba program (čas, názov, kategória) – žiadne streamy ani playlisty; ak odkaz vráti IPTV playlist (M3U/M3U8) alebo stream, zdroj sa odmietne. Max. ${SRC_MAX} zdrojov, súbor do 120 MB.</p>
${err && /^src(bad)$/.test(req.query.m || '') ? `<p class="err">${esc(err)}</p>` : ''}
${list.map((x) => '<hr>' + row(x)).join('') || '<p class="hint">Zatiaľ žiadne vlastné zdroje.</p>'}
${list.length < SRC_MAX ? `<form method="post" action="/admin/epg/src" class="srcrow">${hid(req)}<h3>➕ Pridať zdroj</h3><label>Názov</label><input name="name" maxlength="60" placeholder="napr. Môj EPG"><label>URL TV programu (XMLTV)</label><input name="url" type="url" maxlength="600" required placeholder="https://…/epg.xml.gz, …/xmltv.php?…, …/guide.zip"><label class="ck"><input type="checkbox" name="pref" value="1"> ⭐ Prednostný</label><button>➕ Pridať a otestovať</button><p class="hint">Overenie stiahne celý súbor (môže trvať až ~1 min).</p></form>` : ''}
<details${miss.length ? ' open' : ''}><summary><b>Chýbajúce kanály – bez programu: ${miss.length}</b></summary><p class="hint">Viditeľné kanály, ktoré teraz nemajú žiadny program (okrem vynechaných kategórií). Kliknite 🔎 a vyberte EPG id, alebo pridajte zdroj, ktorý ich obsahuje.</p>${[...byCat].map(([cat, rs]) => `<p><b>${esc(cat)}</b> (${rs.length}): ${rs.slice(0, 60).map((r) => `<a href="/admin/epg/ch/${r.id}">${esc(r.name)}</a>`).join(', ')}${rs.length > 60 ? ' …' : ''}</p>`).join('') || '<p class="ok">Všetky kanály majú program. 🎉</p>'}</details></div>`;
  }

  // ---------- admin page ----------
  const MS = { ok: 'Uložené.', run: 'Obnova TV programu spustená na pozadí (zvyčajne 1–3 min). Obnovte stránku neskôr.', busy: 'Obnova už prebieha.', remap: 'Automatické párovanie sa prepočíta pri obnove (spustená).', badid: 'Takéto EPG id v zdroji neexistuje (najprv obnovte zdroj alebo skontrolujte id).', pin: 'Pripnuté.', hid: 'Skryté.', unhid: 'Znovu zobrazené.', del: 'Zmazané.', badpin: 'Vyplňte kanál, čas začiatku a názov.', srcok: 'Zdroj overený a uložený. Program sa stiahne o chvíľu na pozadí (1–3 min).', srcerr: 'Zdroj sa nepodarilo overiť – pozrite chybu pri zdroji.', srcbad: 'Zdroj nebol uložený – dôvod je uvedený nižšie.', srcmax: 'Dosiahnutý max. počet zdrojov.', srcdup: 'Tento zdroj už existuje.', srcbusy: 'Práve sa overuje iný zdroj, skúste o chvíľu.' };
  const msg = (q) => (MS[q.m] ? `<p class="${/^(bad|src(err|bad|max|dup|busy))/.test(q.m) ? 'err' : 'ok'}">${esc(MS[q.m])}</p>` : '');
  const back = (res, m, a = '') => res.redirect(303, '/admin/epg?m=' + m + (a ? '#' + a : ''));
  const ago = (iso) => { const t = Date.parse(iso || ''); if (!t) return 'nikdy'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `pred ${m} min` : `pred ${Math.round(m / 6) / 10} h`; };
  const KINDS = [['film', '🎬 Filmy'], ['sport', '⚽ Šport (priame prenosy)'], ['show', '🎤 Veľké relácie / zábava']];
  admin.get('/epg', needAuth, wrap(async (req, res) => {
    const s = await getSettings(), c = cfg(s), sk = skipOf(c);
    const [lastRun, lastFull, lastMs, rep, lastErr] = await Promise.all(['last_run', 'last_full', 'last_ms', 'report', 'last_err'].map((k) => kv.get(k)));
    let report = {}; try { report = JSON.parse(rep || '{}'); } catch { report = {}; }
    const chans = await channels(), m = await loadMap(), srcs = await sources();
    const st = { all: 0, skip: 0, mapped: 0, manual: 0, none: 0 };
    for (const r of chans) { st.all++; const x = m.get(r.id); if (x && x.manual) { st.manual++; if (x.epg_id) st.mapped++; continue; } if (skipped(r.category, sk)) { st.skip++; continue; } if (x && x.epg_id) st.mapped++; else st.none++; }
    const nprog = (await pool.query('SELECT COUNT(*)::int AS n, MIN(s) AS a, MAX(e) AS b FROM epg_prog')).rows[0];
    const f = ['unmapped', 'mapped', 'manual', 'skipped', 'all'].includes(req.query.f) ? req.query.f : 'unmapped';
    const cq = String(req.query.cat || '');
    const list = chans.filter((r) => { const x = m.get(r.id), isSk = skipped(r.category, sk); if (cq && r.category !== cq) return false; if (f === 'all') return true; if (f === 'skipped') return isSk && !(x && x.manual); if (f === 'manual') return x && x.manual; if (f === 'mapped') return x && x.epg_id; return !isSk && !(x && x.epg_id) && !(x && x.manual); });
    const nowD = await nowData(); const cats = [...new Set(chans.map((r) => r.category))];
    const dn = await topItems({ all: true }), pub = await topItems(); const hidden = (await pool.query('SELECT k,title,created_at FROM dnes_hide ORDER BY created_at DESC LIMIT 100')).rows;
    const vis = chans.filter((r) => r.visible);
    const item = (x) => `<div class="row"><span>${x.best ? '★ <b>NAJ</b> ' : ''}<b>${esc(dayLbl(x.s, false))} ${esc(hm(x.s))}</b> ${C.KIND_ICON[x.kind] || ''} ${esc(x.title)} · <span class="hint">${esc(x.ch.name)}${x.score < 999 ? ' · skóre ' + x.score + (x.boost ? ' (TOP +' + x.boost + ')' : '') : ''}${x.dupe ? ' · duplicita' : ''}${x.hidden ? ' · skryté' : ''}</span></span>${x.pin ? `<form method="post" action="/admin/epg/pin/${x.pin}/delete">${hid(req)}<button class="d">🗑 Odopnúť</button></form>` : `${x.hidden ? '' : `<form method="post" action="/admin/epg/hide">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť</button></form><form method="post" action="/admin/epg/hide">${hid(req)}<input type="hidden" name="k" value="${esc(x.tk)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť titul</button></form>`}<form method="post" action="/admin/epg/pin">${hid(req)}<input type="hidden" name="channel_id" value="${x.ch.id}"><input type="hidden" name="s" value="${esc(toLocal(x.s))}"><input type="hidden" name="dur" value="${Math.round((x.e - x.s) / 60e3)}"><input type="hidden" name="title" value="${esc(x.title)}"><input type="hidden" name="kind" value="${esc(x.kind)}"><button>📌 Pripnúť</button></form>`}</div>`;
    res.send(page('TV program (EPG)', `<h1>🗓 TV program (EPG) &amp; Top v TV</h1>${msg(req.query)}<p><a href="/admin">← Admin</a> · <a href="/admin/kanaly-katalog">📺 Katalóg kanálov</a> · <a href="/admin/udalosti">🔥 Top udalosti (pripnúť, kľúčové slová)</a></p>
<p class="hint">Zdroj: <b>epgshare01.online</b> – bezplatné verejné XMLTV súbory (iba programové údaje: čas, názov relácie, kategória) + <a href="#zdroje">vlastné EPG zdroje</a>. Ukladá sa celý program na ~${esc(c.epg_ahead)} h dopredu pre kanály na stránke, ďalšie dni (do 7) iba kandidáti na „Top týždňa“ (filmy, priame prenosy, veľké relácie). Žiadne streamy ani playlisty.</p>
<div class="card"><h2>📊 Stav</h2><p>Posledná obnova: <b>${esc(ago(lastRun))}</b>${lastMs ? ` (${Math.round(+lastMs / 1000)} s)` : ''} · plná: ${esc(ago(lastFull))} · interval ${esc(c.epg_hours)} h${status.running ? ` · <b>práve beží: ${esc(status.phase)} ${esc(status.feed)}</b>` : ''}</p>
<p>Kanály: <b>${st.mapped}</b> s programom · ${st.none} bez párovania · ${st.manual} ručne · ${st.skip} vynechaných (kategórie) · spolu ${st.all}. Uložených relácií: ${nprog.n}${nprog.a ? ` (${esc(hm(+nprog.a))} – ${esc(new Date(nprog.b).toISOString().slice(0, 10))} ${esc(hm(+nprog.b))})` : ''}.</p>
${lastErr ? `<p class="err">Chyba: ${esc(lastErr)}</p>` : ''}${Object.keys(report).length ? `<p class="hint">${Object.entries(report).map(([k, v]) => `${esc(isSrcFeed(k) ? ((srcs.find((x) => 'src:' + x.id === k) || {}).name || k) : k)}: ${v.err ? '⚠ ' + esc(v.err) : `${v.ch != null ? v.ch + ' kan., ' : ''}${v.progs || 0} rel.${v.days ? ' · ' + v.days + ' d' : ''}`}`).join(' · ')}</p>` : ''}
<div class="row"><form method="post" action="/admin/epg/refresh">${hid(req)}<button>🔄 Obnoviť teraz</button></form><form method="post" action="/admin/epg/remap">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> potvrdiť</label><button>🔁 Znovu automaticky spárovať (ručné ostanú)</button></form></div></div>
${await srcCard(req, report)}
${await offCard(req)}
<form method="post" action="/admin/epg/settings" class="card" id="nast">${hid(req)}<h2>⚙ Nastavenia TV programu</h2>
<label class="ck"><input type="checkbox" name="epg_on" value="1"${c.epg_on === '1' ? ' checked' : ''}> Zobraziť TV program pri kanáloch (Teraz / Potom / celý deň)</label>
<label>Zdroje (krajiny epgshare01, oddelené čiarkou) <span class="hint">dostupné: ${FEEDS_ALL.join(', ')}</span></label><input name="epg_feeds" maxlength="400" value="${esc(c.epg_feeds)}">
<label>Obnova každých (hodín)</label><select name="epg_hours">${[2, 3, 4, 6, 8, 12, 24].map((h) => `<option${+c.epg_hours === h ? ' selected' : ''}>${h}</option>`).join('')}</select>
<label>Program dopredu (hodín)</label><select name="epg_ahead">${[24, 36, 48].map((h) => `<option${+c.epg_ahead === h ? ' selected' : ''}>${h}</option>`).join('')}</select>
<label>Vynechať kategórie kanálov (časť názvu, jedna na riadok)</label><textarea name="epg_skip" rows="5" maxlength="1000">${esc(c.epg_skip)}</textarea><button>Uložiť</button></form>
<form method="post" action="/admin/epg/dnes" class="card" id="dnes">${hid(req)}<h2>⭐ Top dnes &amp; Top týždňa (hlavná stránka)</h2><p class="hint">Automaticky vyberané najdôležitejšie udalosti (filmy, priame športové prenosy, veľké relácie) – iba z viditeľných kanálov. V každej sekcii 3–5 položiek, jedna zvýraznená ako „Naj“. Ak nie sú aspoň 3 kvalitné položky, sekcia sa skryje. Pripnúť / skryť nižšie v náhľade.</p>
<label class="ck"><input type="checkbox" name="dnes_on" value="1"${c.dnes_on === '1' ? ' checked' : ''}> Zobraziť na hlavnej stránke</label>
<h3>🔥 Top dnes</h3><label>Nadpis</label><input name="top_title" maxlength="60" value="${esc(c.top_title)}"><label>Nadpis (EN)</label><input name="top_title_en" maxlength="60" value="${esc(c.top_title_en)}">
<label>Počet položiek</label><select name="top_n">${[3, 4, 5].map((n) => `<option${clampN(c.top_n) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
<h3>📅 Top týždňa</h3><label class="ck"><input type="checkbox" name="week_on" value="1"${c.week_on === '1' ? ' checked' : ''}> Zobraziť „Top týždňa“ (najbližších 7 dní, bez dneška)</label><label>Nadpis</label><input name="week_title" maxlength="60" value="${esc(c.week_title)}"><label>Nadpis (EN)</label><input name="week_title_en" maxlength="60" value="${esc(c.week_title_en)}">
<label>Počet položiek</label><select name="week_n">${[3, 4, 5].map((n) => `<option${clampN(c.week_n) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
<h3>Spoločné</h3><label class="ck"><input type="checkbox" name="top_move" value="1"${c.top_move !== '0' ? ' checked' : ''}> Pohyblivé pásy (plynulá slučka, pauza pri prejdení myšou/dotyku, tlačidlo ⏸/▶; pri „obmedziť pohyb“ v systéme statické)</label>
<label>Rýchlosť posúvania pásov</label><select name="dnes_speed">${[[1, 'veľmi pomaly'], [2, 'pomaly'], [3, 'stredne'], [4, 'rýchlo'], [5, 'veľmi rýchlo']].map(([v, l]) => `<option value="${v}"${(+c.dnes_speed || 3) === v ? ' selected' : ''}>${l}</option>`).join('')}</select><label>Kanály</label><select name="dnes_scope"><option value="skcz"${c.dnes_scope !== 'all' ? ' selected' : ''}>Iba SK/CZ kanály (aj tematické)</option><option value="all"${c.dnes_scope === 'all' ? ' selected' : ''}>Všetky viditeľné kanály</option></select>
<p>Typy:</p>${KINDS.map(([k, l]) => `<label class="ck"><input type="checkbox" name="kind_${k}" value="1"${c.dnes_kinds.split(',').includes(k) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}<button>Uložiť</button></form>
${G ? await G.card(req) : ''}
<div class="card" id="nahlad"><h2>👁 Náhľad výberu</h2>${[['🔥 Top dnes', dn.day, pub.day], ['📅 Top týždňa', dn.week, pub.week]].map(([h, d, p]) => `<h3>${h}</h3><p class="hint">Na webe: ${p.map((x) => (x.best ? '★ <b>NAJ</b> ' : '') + esc(dayLbl(x.s, false) + ' ' + hm(x.s) + ' ' + x.title)).join(' · ') || '— (menej ako 3 kvalitné položky → sekcia skrytá)'}</p>${d.pins.length ? `<p><b>📌 Pripnuté</b></p>${d.pins.map(item).join('')}` : ''}<details><summary>Kandidáti podľa skóre (${d.list.length})</summary>${d.list.slice(0, 30).map(item).join('') || '<p class="hint">Zatiaľ žiadne dáta – spustite obnovu.</p>'}</details>`).join('')}
${hidden.length ? `<h3>🙈 Skryté</h3>${hidden.map((h) => `<div class="row"><span>${esc(h.title || h.k)} <span class="hint">${h.k.startsWith('t:') ? '(celý titul)' : '(jedno vysielanie)'}</span></span><form method="post" action="/admin/epg/unhide">${hid(req)}<input type="hidden" name="k" value="${esc(h.k)}"><button>👁 Zobraziť</button></form></div>`).join('')}` : ''}</div>
<form method="post" action="/admin/epg/pin" class="card" id="pin">${hid(req)}<h2>📌 Pridať vlastnú položku</h2><p class="hint">Napr. zápas alebo film, ktorý v programe chýba, alebo udalosť, ktorá má byť určite v Top. Dnešná ide do „Top dnes“, neskoršia (do 7 dní) do „Top týždňa“; pripnutá je vždy „Naj“. Zobrazí sa do jej konca.</p>
<label>Kanál</label><select name="channel_id" required><option value="">— vyberte —</option>${vis.map((r) => `<option value="${r.id}">${esc(r.name)} (${esc(r.category)})</option>`).join('')}</select>
<label>Začiatok</label><input type="datetime-local" name="s" required><label>Dĺžka (min)</label><input type="number" name="dur" min="5" max="600" value="120"><label>Názov</label><input name="title" maxlength="160" required>
<label>Typ</label><select name="kind">${Object.entries(C.KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select><button>Pripnúť</button></form>
<div class="card" id="map"><h2>🔗 Párovanie kanálov s programom</h2><p class="hint">Automaticky podľa podobnosti názvu (a krajiny podľa kategórie). Opraviť: zadajte EPG id (alebo „-“ = bez programu, prázdne = automaticky) alebo kliknite 🔎.</p>
<p>${[['unmapped', 'Bez párovania'], ['mapped', 'Spárované'], ['manual', 'Ručne'], ['skipped', 'Vynechané'], ['all', 'Všetky']].map(([k, l]) => (k === f ? `<b>${l}</b>` : `<a href="/admin/epg?f=${k}${cq ? '&cat=' + encodeURIComponent(cq) : ''}#map">${l}</a>`)).join(' · ')}</p>
<form method="get" action="/admin/epg" class="row"><input type="hidden" name="f" value="${esc(f)}"><select name="cat"><option value="">Všetky kategórie</option>${cats.map((x) => `<option${x === cq ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select><button>Filtrovať</button></form>
<p class="hint">${list.length} kanálov</p>${list.slice(0, 300).map((r) => { const x = m.get(r.id), nw = (nowD.c[r.id] || [])[0]; const v = mapVal(x); return `<form method="post" action="/admin/epg/map/${r.id}" class="row">${hid(req)}<span><b>${esc(r.name)}</b> <span class="hint">${esc(r.category)}${r.visible ? '' : ' · skrytý'} · ${x ? (x.manual ? 'ručne' : x.epg_id ? 'auto ' + Math.round(x.score * 100) + ' %' : 'nenájdené') : '—'}${nw ? ' · teraz: ' + esc(nw[2]) : ''}</span></span><input name="epg_id" maxlength="120" value="${esc(v)}" placeholder="EPG id"><input type="hidden" name="epg_prev" value="${esc(v)}"><button>Uložiť</button><a href="/admin/epg/ch/${r.id}">🔎</a></form>`; }).join('')}${list.length > 300 ? '<p class="hint">Zobrazených prvých 300 – použite filter kategórie.</p>' : ''}</div>`, 'adm'));
  }));
  admin.get('/epg/ch/:id(\\d+)', needAuth, wrap(async (req, res) => {
    const ch = (await channels()).find((r) => r.id === +req.params.id); if (!ch) return res.redirect(303, '/admin/epg');
    const m = (await loadMap()).get(ch.id); const q = String(req.query.q || '').slice(0, 80);
    const rows = (await pool.query('SELECT id,name,names,feed,n FROM epg_chan')).rows;
    const ix = C.buildIndex(rows.map((r) => ({ id: r.id, names: r.names ? r.names.split('\n') : [r.name], feed: r.feed, n: r.n })));
    let cand = C.candidates(ix, q || ch.name, ch.category, 15);
    if (q) { const nq = tnorm(q); cand = cand.concat(rows.filter((r) => tnorm(r.id + ' ' + r.names).includes(nq)).slice(0, 30).map((r) => ({ id: r.id, name: r.name, feed: r.feed, n: r.n, sim: 0 }))).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i); }
    const prev = mapVal(m);
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
    await setSettings({ dnes_on: b.dnes_on ? '1' : '0', dnes_kinds: KINDS.map(([k]) => k).filter((k) => b['kind_' + k]).join(',') || 'film', top_title: clean(b.top_title, D.top_title), top_title_en: clean(b.top_title_en, D.top_title_en), top_n: String(clampN(b.top_n)), week_on: b.week_on ? '1' : '0', week_title: clean(b.week_title, D.week_title), week_title_en: clean(b.week_title_en, D.week_title_en), week_n: String(clampN(b.week_n)), dnes_scope: b.dnes_scope === 'all' ? 'all' : 'skcz', top_move: b.top_move ? '1' : '0', dnes_speed: String(Math.max(1, Math.min(5, parseInt(b.dnes_speed, 10) || 3))) });
    dropCaches(); back(res, 'ok', 'dnes');
  }));
  admin.post('/epg/off', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body; await setSettings({ off_on: b.off_on ? '1' : '0', off_src: Object.keys(OFFICIAL.SOURCES).filter((k) => b['src_' + k]).join(',') || '-' });
    if (!offRun && !running) { const far = dayStart(Date.now()) + 8 * 86400e3 + 6 * 3600e3; offRun = OFF.merge(far, b.now === '1').catch((e) => console.error('EPG official', e.message)).finally(() => { offRun = null; dropCaches(); }); }
    back(res, 'ok', 'oficialne');
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
  G = require('./epgguide')(ctx, { cfg, D, visibleMapped, skcz, dayStart, dayLbl, hm, localHour, jsonOut, scoreOf, topBoost, posterKey, posterInfo, posterMap, posterOne, tnorm, JUNK, ADULT, DOCCH, back, MS });
  E = require('./epgevents')(ctx, { visibleMapped, skcz, dayStart, dayLbl, hm, localHour, tnorm, JUNK, ADULT, channels, fromLocal, toLocal, ASSET_V, kv });
  ctx.eventsBlock = (req, s, where) => E.block(req, s, where);
  ctx.extAdminHtml = EXT.mountAdmin({ admin, needAuth, csrf, wrap, esc, hid });
  ctx.eventsHero = (req, s, where) => E.hero(req, s, where);
  ctx.epgRefresh = refresh;
  const SYNC_SRC = 'Panel XMLTV';
  ctx.epgUpsertSyncSource = async (url) => {
    const bad = srcCheck(url); if (bad) return { ok: false, err: bad };
    srcCache = null;
    let list = await sources();
    let src = list.find((x) => x.name === SYNC_SRC) || list.find((x) => x.url === url);
    if (!src) {
      if (list.length >= SRC_MAX) return { ok: false, err: 'Dosiahnutý max. počet vlastných EPG zdrojov.' };
      src = (await pool.query('INSERT INTO epg_src (name,url,enabled,pref) VALUES ($1,$2,true,true) RETURNING *', [SYNC_SRC, url])).rows[0];
    } else {
      await pool.query('UPDATE epg_src SET url=$2, enabled=true, pref=true, name=$3 WHERE id=$1', [src.id, url, SYNC_SRC]);
    }
    srcCache = null;
    src = (await sources()).find((x) => x.name === SYNC_SRC);
    if (!src) return { ok: false, err: 'Zdroj sa nepodarilo uložiť.' };
    if (probing) return { ok: false, err: 'Práve sa overuje iný zdroj, skúste o chvíľu.', id: src.id, busy: true };
    probing = true; let ok = false;
    try { ok = await probe(src); } finally { probing = false; }
    if (ok) refreshSoon(['src:' + src.id]);
    return { ok, id: src.id };
  };
  ctx.epgApplyTvg = async (pairs) => {
    const list = Array.isArray(pairs) ? pairs : [];
    const rows = (await pool.query('SELECT id FROM epg_chan')).rows.map((r) => r.id);
    const exact = new Map(rows.map((id) => [id.toLowerCase(), id]));
    const suff = new Map();
    for (const id of rows) {
      const low = id.toLowerCase();
      const i = low.lastIndexOf(':');
      const tail = i >= 0 ? low.slice(i + 1) : low;
      if (!suff.has(tail)) suff.set(tail, []);
      suff.get(tail).push(id);
    }
    const map = await loadMap();
    let mapped = 0;
    for (const p of list) {
      const tvg = String(p.tvgId || '').trim();
      const cid = +p.id;
      if (!tvg || !cid) continue;
      const cur = map.get(cid);
      if (cur && cur.manual) continue;
      let eid = exact.get(tvg.toLowerCase());
      if (!eid) {
        const hits = suff.get(tvg.toLowerCase()) || [];
        eid = hits.length === 1 ? hits[0] : (hits.find((x) => x.startsWith('src')) || hits[0]);
      }
      if (!eid) continue;
      await pool.query(`INSERT INTO epg_map (channel_id,epg_id,manual,score,shift,updated_at) VALUES ($1,$2,false,1,0,now()) ON CONFLICT (channel_id) DO UPDATE SET epg_id=$2, score=1, updated_at=now() WHERE NOT epg_map.manual`, [cid, eid]);
      mapped++;
    }
    if (mapped) dropCaches();
    return mapped;
  };
};
