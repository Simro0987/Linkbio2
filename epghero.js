'use strict';
// "Top udalosť týždňa" – Netflix-style hero carousel (max 3 slides) at the top of the homepage.
// Fully server-side: EPG scoring for the next 7 days + official calendars (OKTAGON MMA) fetched by this server,
// optional Gemini ranking of the top candidates (deterministic score order as fallback), cached in memory + epg_kv
// and refreshed every few hours. Admin pins always fill the slots first. All genres (sport, film/series premieres, reality
// finals, galas, concerts, elections, New Year's Eve…). Images are never hotlinked: admin upload, or an automatically
// found + verified image (evimg.js: official og:image → TheSportsDB → TMDB → Wikipedia → Wikimedia Commons) stored as
// small webp variants (desktop + mobile), or a rotating bundled background (static/ev/<cat>-<n>.webp). Short Slovak
// description written only from fetched facts (admin can override). Program info only – never stream links.
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const C = require('./epgcore');
const { tx } = require('./uitext');
const S = require('./evsources');
const path = require('path');

const HD = { evh_max: '10', evh_on: '1', evh_cards_home: '0', evh_gem: '1', evh_okt: '1', evh_okt_ch: 'Premier Sport 3 Extra', evh_ch: '', evh_big: '' };
// SK/CZ only: the Kanály catalogue has no country field → category + name allowlist (evsources CHANNELS + admin lines) + EPG id country
const NOT_SKCZ_CAT = /maďar|madar|poľs|pols|nemec|rusk|ukrajin|švajč|svajc|khl|dospel|18\+|vod|rádi|radi|webkam/i; // 'zahraničný' šport: only known SK/CZ feeds (Arena Sport 1/2 …)
const SKCZ_CAT = /sloven|česk|cesk|lokáln|lokaln/i;
const FOREIGN_TAG = /(?:^|[\s(])(pl|nl|de|hu|mx|uk|esp|hr|ro|at|us|fr|it|ru|ua|4k)(?=$|[\s)])/i;
const chRules = (txt) => { const add = [], deny = []; for (let l of String(txt || '').split(/\r?\n/)) { l = l.trim().toLowerCase(); if (!l || l[0] === '#') continue; if (l[0] === '-') { if (l.slice(1).trim()) deny.push(l.slice(1).trim()); } else add.push(l.replace(/^\+/, '').trim()); } return { add: add.filter(Boolean), deny }; };
const MAX_DEF = 10, MAX_HI = 10, WEEK = 7 * 86400e3, REFRESH = 3 * 3600e3, OKT_TTL = 6 * 3600e3, OKT_DUR = 5 * 3600e3;
const OKT_URL = 'https://oktagonmma.com/cs/';
const CATS = [
  ['stadium', /volejbal|volleyball|futsal|h[aá]dzan|h[aá]zen|handball|florbal|floorball|bedminton|badminton|curling|snooker/i],
  ['mma', /oktagon|\bmma\b|\bufc\b|\bcage\b/i],
  ['boxing', /\bbox|boxing|kickbox|\bk-?1\b|\bring\b/i],
  ['awards', /ballon|zlat[aá] lopt|zlat[yý] m[ií][čc]|oscar|academy award|glob[ue]s?\b|grammy|emmy|sl[aá]vik|[čc]esk[yý] lev|slnko v sieti|award|vyhl[aá]seni|vyhl[aá]šen|korunov|kr[aá][lľ]ovsk/i],
  ['newyear', /silvest|nov[yý] rok|novoro[čc]n/i],
  ['news', /vo[lľ]by|volby|debat|inaugur/i],
  ['reality', /farma|survivor|big brother|masterchef|love island|ru[žz]e pre|v[yý]mena man[žz]eliek|prest[řr]eno|ex on the beach|bachelor/i],
  ['f1', /formul|\bf1\b|grand prix|ve[lľ]k[aá] cena|motogp|rall(y|ye)|nascar|indycar/i],
  ['hockey', /hokej|hockey|\bnhl\b|stanley|extralig|\bkhl\b/i],
  ['tennis', /tenis|tennis|wimbledon|roland|us open|australian open|davis|\batp\b|\bwta\b/i],
  ['basketball', /basket|\bnbk\b|kos[aá]rk|\bnba\b|euroleague|eurolig/i],
  ['athletics', /atlet|cyklist|tour de france|marat[oó]n|olymp|biatlon|lyžov|lyzov/i],
  ['show', /eurov|superstar|talent|koncert|concert|festival|\bshow\b|gala|let'?s dance|hlas [čc]esko|tvoja tv[aá]r|tvoje tv[aá][řr]/i],
  ['football', /futbal|fotbal|football|soccer|lig[ay] majstrov|lig[ay] mistr|champions|europa league|eur[oó]psk|evropsk|konferen|cl[aá]sico|derby|premier league|la liga|bundesliga|serie a|\bms\b|\bme\b|euro 20|world cup|uefa|fifa/i],
];
const KINDCAT = { film: 'film', series: 'series', doc: 'documentary', news: 'news', show: 'show', music: 'show' };
const OKT_KW = [{ k: 'oktagon mma', w: 55, label: 'OKTAGON MMA', short: false, cs: '' }, { k: 'oktagon', w: 50, label: 'Oktagon', short: false, cs: '' }];
const DEVNET = process.env.NODE_ENV !== 'production' && process.env.EVH_DEV_NET === '1';
// minor sports / women's / youth competitions: fine for the cards, rarely „the event of the week“
const MINOR = /\b(volejbal|volleyball|futsal|bedminton|badminton|curling|snooker|šípky|sipky|darts|stolný tenis|stolni tenis|florbal|plávanie|plavani|gymnastika|krasokorčuľovanie|krasobrusleni|cyklistika|veslovanie|ženy|žien|ženské|zeny|women|U1[6-9]|U2[01]|junior|dorast)\b/i;
// background category: films/series/docs by EPG kind, everything else by title keywords (default: generic stadium)
// number of hero slides (admin „Počet udalostí“, default 8, 1–12)
const maxOf = (hc) => Math.max(1, Math.min(MAX_HI, parseInt(hc && hc.evh_max, 10) || MAX_DEF));
// variety: ranked list → n picks with ≤ perCat of one category (football, hockey, film…) and ≤ perDay on one day;
// if that leaves gaps, the best skipped ones fill them (order kept)
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava' }).format(ms);
function diversify(list, n, opt = {}) {
  const perCat = opt.perCat || Math.max(2, Math.ceil(n * 0.375)), perDay = opt.perDay || Math.max(2, Math.ceil(n * 0.4));
  const out = [], rest = [], cc = new Map(), dc = new Map();
  for (const x of list) {
    if (out.length >= n) { rest.push(x); continue; }
    const c = x.cat || 'x', d = dayOf(x.s);
    if ((cc.get(c) || 0) >= perCat || (dc.get(d) || 0) >= perDay) { rest.push(x); continue; }
    out.push(x); cc.set(c, (cc.get(c) || 0) + 1); dc.set(d, (dc.get(d) || 0) + 1);
  }
  for (const x of rest) { if (out.length >= n) break; out.push(x); }
  return out.sort((a, b) => list.indexOf(a) - list.indexOf(b));
}
const catOf = (t, kind) => { if (/^(film|series|doc)$/.test(kind || '')) return KINDCAT[kind]; for (const [k, re] of CATS) if (re.test(t)) return k; return KINDCAT[kind] || 'stadium'; };
const gmodels = () => [...new Set((process.env.EVH_GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash').split(',').map((x) => x.trim()).filter((x) => /^[\w.-]{3,60}$/.test(x)))].slice(0, 4);
const RV = 4, ALG = 9; // ALG: bump to recompute the cached week after ranking changes
const BIG = require('./evbig');
const RK = require('./evrank'); // ranking algorithm: priority, merge, variety, Slovak date labels (documented there)
const FX_TTL = 12 * 3600e3, FX_MAX = 16; // official fixture lookups (TheSportsDB): cache per pairing, max new lookups per refresh
// league tables for „top of the table“ clashes (TheSportsDB free key; top 4 per league, cached 12 h)
const LEAGUES = [[4328, 'Premier League'], [4335, 'LaLiga'], [4331, 'Bundesliga'], [4332, 'Serie A'], [4334, 'Ligue 1'], [4672, 'Niké liga'], [4631, 'Chance liga']]; // bump to re-resolve cached images/descriptions after resolver changes
const sha = (v) => crypto.createHash('sha1').update(String(v)).digest('hex');
// a stored detector config equal to an older built-in default (saved verbatim) follows the current default → new teams/rules apply
const OLD_BIG = new Set(['210a07710e84ee4a5178f00f0dfdfee5b7145de6']);
const bigSrc = (v) => { const t = String(v || '').trim(); return !t || OLD_BIG.has(sha(t)) ? S.BIG_DEFAULT : t; };
// "OKTAGON 96: GOGOLADZE VS. KLINKHAMMER" → "OKTAGON 96: Gogoladze vs. Klinkhammer"
const prettyOkt = (t) => { const i = t.indexOf(':'); if (i < 0) return t; const tail = t.slice(i + 1).toLowerCase().replace(/(^|[\s\-–(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\bVs\./g, 'vs.'); return t.slice(0, i + 1) + tail; };
const dispTitle = (x) => (x.teams ? x.teams[0] + ' – ' + x.teams[1] : x.title);
const pick = (o, k) => (o && typeof o === 'object' ? o[k] || o.cs || o.sk || o.en || '' : String(o || ''));

module.exports = function hero(ctx, h, E) {
  const { app, admin, pool, esc, hid, csrf, needAuth, wrap, getSettings, setSettings } = ctx;
  const { dayStart, dayLbl, hm, tnorm, channels, ASSET_V, kv } = h;
  const hcfg = (s) => { const o = {}; for (const k of Object.keys(HD)) o[k] = s[k] == null || s[k] === '' ? HD[k] : String(s[k]); return o; };
  let wk = null, busy = null, loaded = false, lastGem = 0, side = null, tmdbSet = '';

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ev_imgc (k TEXT PRIMARY KEY, src TEXT NOT NULL DEFAULT '', img BYTEA NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`ALTER TABLE ev_imgc ADD COLUMN IF NOT EXISTS img_m BYTEA, ADD COLUMN IF NOT EXISTS credit TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS meta TEXT NOT NULL DEFAULT ''`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ev_desc (tk TEXT PRIMARY KEY, txt TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    try { tmdbSet = String((await getSettings()).evh_tmdb || ''); } catch {}
    // one-time, idempotent: the carousel default went 8 → 10 (max 10); a saved 8 (old default) or > 10 becomes 10, a
    // deliberately lower admin value stays; the kv flag makes it run once, so a later admin choice of 8 is kept
    try {
      if (!(await kv.get('evh_mig_max10'))) {
        const cur = parseInt((await getSettings()).evh_max, 10);
        if (cur === 8 || cur > MAX_HI) { await setSettings({ evh_max: String(MAX_DEF) }); stale(); }
        await kv.set('evh_mig_max10', String(Date.now()));
      }
    } catch (e) { console.error('evhero migrate max10', e.message); }
    setTimeout(() => { ensure().catch(() => {}); }, 15e3).unref();
    setInterval(() => { refresh().catch(() => {}); }, REFRESH).unref();
  }
  const stale = () => { if (wk) wk.dirty = true; side = null; };

  // ---------- safe server-side fetching (https only, public hosts only, size caps, manual redirects) ----------
  async function hostOk(host) {
    host = host.replace(/^\[|\]$/g, '');
    if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('blocked');
    const all = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (!all.length || (!DEVNET && all.some((a) => (ctx.privateIp ? ctx.privateIp(a.address) : /^(127\.|10\.|192\.168\.|::1$)/.test(a.address))))) throw new Error('blocked');
  }
  // extra.__head: HTML pages – keep only the first `max` bytes (meta tags live in <head>) instead of failing
  async function get(url, accept, max, extra) {
    let u = url; const head = !!(extra && extra.__head); extra = Object.assign({}, extra || {}); delete extra.__head;
    for (let i = 0; i < 4; i++) {
      const x = new URL(u); if (x.protocol !== 'https:') throw new Error('https only'); await hostOk(x.hostname);
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(12e3), headers: Object.assign({ 'user-agent': 'Mozilla/5.0 (compatible; lnkbio-tvguide/1.0; TV program guide; server-side image cache)', accept, 'accept-language': 'cs,sk;q=0.9,en;q=0.5' }, extra || {}) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!head && +(r.headers.get('content-length') || 0) > max) throw new Error('too big');
      const parts = []; let n = 0; const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > max) { try { await rd.cancel(); } catch {} if (head) { parts.push(value); break; } throw new Error('too big'); } parts.push(value); }
      return { buf: Buffer.concat(parts.map((p) => Buffer.from(p))), type: String(r.headers.get('content-type') || '').toLowerCase(), url: u };
    }
    throw new Error('too many redirects');
  }
  const toWebp = (buf) => require('sharp')(buf, { limitInputPixels: 40e6 }).rotate().resize(1280, 720, { fit: 'cover', position: 'attention' }).webp({ quality: 60, effort: 4 }).toBuffer();
  // image URL or an event page URL (→ og:image / twitter:image) → raw image buffer / small webp buffer
  async function fetchRaw(url) {
    let r = await get(url, 'image/avif,image/webp,image/*,text/html;q=0.8', 6e6);
    if (/html/.test(r.type)) {
      const html = r.buf.toString('utf8', 0, Math.min(r.buf.length, 600e3));
      const m = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(html);
      if (!m) throw new Error('no og:image');
      r = await get(new URL(m[1].replace(/&amp;/g, '&'), r.url).href, 'image/avif,image/webp,image/*', 6e6);
    }
    if (!/^image\//.test(r.type) && !/^\s*$/.test(r.type)) throw new Error('not an image');
    return r.buf;
  }
  const fetchImage = async (url) => toWebp(await fetchRaw(url));
  const TB = require('./evbadge')({ kv, get: (u, a, m, x) => get(u, a, m, x) });
  const R = require('./evimg')({ get, pool, kv, clip: C.clip, models: gmodels, staticDir: path.join(__dirname, 'static'), tmdbKey: () => String(process.env.TMDB_API_KEY || tmdbSet || '').trim() });
  // cached copy of an official calendar image (downloaded once, desktop + mobile webp in Postgres, served from /ev-img/…)
  async function cachedImg(url) {
    const k = 'u-' + sha('v2|' + url).slice(0, 24);
    const ex = (await pool.query('SELECT extract(epoch from at)::int AS v FROM ev_imgc WHERE k=$1', [k])).rows[0];
    if (ex) return { k, v: ex.v };
    const v = await R.variants(await fetchRaw(url));
    if (v.w0 < S.MIN_W || v.w0 / v.h0 < S.MIN_RATIO) throw new Error(`${v.w0}×${v.h0} – malý alebo nie na šírku`);
    const r = (await pool.query(`INSERT INTO ev_imgc (k,src,img,img_m,credit,meta) VALUES ($1,$2,$3,$4,$5,'') ON CONFLICT (k) DO UPDATE SET img=$3, img_m=$4, at=now() RETURNING extract(epoch from at)::int AS v`, [k, C.clip(url, 400), v.w, v.m, '© ' + new URL(url).hostname.replace(/^www\./, '')])).rows[0];
    return { k, v: r.v };
  }
  const ovKey = (tk) => 'o-' + sha(tk).slice(0, 24);
  async function standings() {
    try { const c = JSON.parse((await kv.get('evh_tbl')) || 'null'); if (c && c.v === 2 && Date.now() - c.t < 12 * 3600e3) return c.top || []; } catch {}
    const d = new Date(), y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, top = [];
    for (const [id, league] of LEAGUES) {
      try { const r = await get(`https://www.thesportsdb.com/api/v1/json/123/lookuptable.php?l=${id}&s=${y}-${y + 1}`, 'application/json', 1e6); const j = JSON.parse(r.buf.toString('utf8'));
        const tb = (j && j.table) || [], teams = tb.slice(0, 4).map((x) => BIG.norm(x.strTeam)).filter(Boolean);
        // rows (free key: top 5) → positions/points/form in card descriptions
        if (teams.length) top.push({ league, teams, rows: tb.slice(0, 8).map((x) => ({ name: x.strTeam || '', rank: +x.intRank || 0, pts: +x.intPoints || 0, form: x.strForm || '' })).filter((x) => x.name && x.rank) }); } catch {}
      await new Promise((r) => setTimeout(r, 1200));
    }
    await kv.set('evh_tbl', JSON.stringify({ v: 2, t: Date.now(), top })).catch(() => {});
    return top;
  }
  // SK/CZ channels of the Kanály catalogue (read live from tv_channels each refresh → channels added in admin are included automatically)
  async function skczChannels(hc) {
    const rows = (await pool.query(`SELECT c.id, c.name, c.category, COALESCE(m.epg_id,'') AS epg, COALESCE(m.shift,0) AS sh, p.last FROM tv_channels c
      LEFT JOIN epg_map m ON m.channel_id = c.id LEFT JOIN (SELECT epg_id, max(e) AS last FROM epg_prog GROUP BY epg_id) p ON p.epg_id = m.epg_id WHERE c.visible ORDER BY c.ord, c.id`)).rows;
    const rl = chRules(hc.evh_ch), now = Date.now(), ok = [], no = [];
    for (const r of rows) {
      const n = r.name.toLowerCase(), known = S.chanOf(r.name), tld = (/\.([a-z]{2})\d?$/i.exec(r.epg) || [])[1] || '', epgForeign = !!tld && !/^(sk|cz)$/i.test(tld);
      let why = '';
      if (rl.deny.some((t) => n.includes(t))) why = 'admin vylúčil';
      else if (S.CHANNEL_DENY.some((re) => re.test(r.name))) why = 'zahraničný kanál';
      else if (rl.add.some((t) => n.includes(t))) why = '';
      else if (NOT_SKCZ_CAT.test(r.category)) why = 'kategória ' + r.category;
      else if (FOREIGN_TAG.test(r.name)) why = 'zahraničný feed (názov)';
      else if (!SKCZ_CAT.test(r.category) && !known) why = 'nie je v zozname SK/CZ kanálov';
      else if (epgForeign) why = 'zahraničný program (EPG .' + tld + ')';
      const x = { id: r.id, name: r.name, category: r.category, epg: r.epg, shifted: +r.sh !== 0, has: !!(r.last && +r.last > now), sites: known ? known[2] : [] };
      (why ? no : ok).push(Object.assign(x, { why }));
    }
    return { ok, no };
  }

  // ---------- OKTAGON MMA official calendar (Next.js __NEXT_DATA__ on the public homepage) ----------
  async function fetchOkt() {
    const r = await get(OKT_URL, 'text/html', 3e6);
    let html = r.buf.toString('utf8'); const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html); html = null;
    if (!m) throw new Error('kalendár nenájdený');
    const j = JSON.parse(m[1]), out = [], seen = new Set();
    const walk = (q) => { for (const x of (q && q.state && Array.isArray(q.state.data) ? q.state.data : [])) {
      if (!x || !x.startDate || !x.title || x.state === 'CANCELLED' || seen.has(x.id)) continue;
      if (x.organizationId && !/OKTAGON/i.test(x.organizationId)) continue;
      const s = Date.parse(x.startDate); if (!Number.isFinite(s)) continue; seen.add(x.id);
      const loc = x.location || {}, title = C.clip(pick(x.title, 'cs'), 140);
      out.push({ id: String(x.id).slice(0, 60), slug: String(x.slug || '').replace(/[^\w-]/g, '').slice(0, 120), title, short: C.clip(pick(x.shortTitle, 'cs') || title.split(':')[0], 40), s, place: C.clip([pick(loc.city || {}, 'cs'), pick(loc.name || {}, 'cs')].filter(Boolean).join(' · '), 80), img: (() => { const u = x.coverImage && x.coverImage.url ? pick(x.coverImage.url, 'cs') : ''; return /^https:\/\//.test(u) ? u.slice(0, 400) : ''; })() });
    } };
    for (const q of (((j.props || {}).pageProps || {}).dehydratedState || {}).queries || []) walk(q);
    out.sort((a, b) => a.s - b.s);
    return { t: Date.now(), ok: true, err: '', events: out.filter((x) => x.s > Date.now() - 86400e3).slice(0, 12) };
  }
  const oktNum = (t) => { const m = /\boktagon\s*(\d{1,3})\b/i.exec(t); return m ? +m[1] : null; };

  // ---------- Gemini ranking (optional, free tier) ----------
  const rankPrompt = (n) => S.PROMPTS.rank.replace('choose the 3 BIGGEST events', `choose the ${n} BIGGEST events, ordered from the biggest`).replace('{"top":["id1","id2","id3"]', '{"top":["id1","id2","…"]') +
    ` Keep the selection varied: if there are enough real top events, mix sports and genres and different days of the week (at most ${Math.max(2, Math.ceil(n * 0.375))} events of the same sport or genre).`;
  async function gemini(list, n, now) {
    const key = String(process.env.GEMINI_API_KEY || '').trim(); if (!key) throw new Error('bez GEMINI_API_KEY');
    const models = gmodels();
    // the model does not know today's date: give it the local time; all candidate times are Europe/Bratislava wall time
    const prompt = rankPrompt(n) + `\nNow is ${RK.whenLbl(now || Date.now(), 0)} (Europe/Bratislava). All candidates air in the coming 7 days (in_days = calendar days from today); they were already filtered (no recordings, no ended events).` + '\n\nCandidates:\n' + JSON.stringify(list);
    let last = '';
    for (const m of models) {
      try {
        const gc = { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 400 + 120 * n }; if (/2\.5/.test(m)) gc.thinkingConfig = { thinkingBudget: 0 };
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(20e3), body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc }) });
        if (!r.ok) { last += (last ? '; ' : '') + m + ' HTTP ' + r.status; continue; }
        const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
        const ids = new Set(list.map((x) => x.id)), top = [...new Set((Array.isArray(o.top) ? o.top : []).map(String))].filter((x) => ids.has(x)).slice(0, n);
        if (!top.length) { last += (last ? '; ' : '') + m + ' prázdna odpoveď'; continue; }
        const why = {}; for (const id of top) { const w = o.why && o.why[id]; if (w) why[id] = C.clip(String(w).replace(/[<>]/g, ''), 120); }
        return { top, why, model: m };
      } catch (e) { last += (last ? '; ' : '') + m + ' ' + (e.name === 'TimeoutError' ? 'timeout' : (e.message || e.name).slice(0, 60)); }
    }
    throw new Error(C.clip(last || 'chyba', 200));
  }

  // ---------- official fixtures (TheSportsDB free API): kick-off, status and team badges of a match pairing ----------
  // cached per pairing in epg_kv (12 h), max FX_MAX new lookups per refresh, ~2 s apart (free-tier rate limit)
  async function fixtures(list, now) {
    let c = {}; try { c = JSON.parse((await kv.get('evh_fx')) || '{}') || {}; } catch {}
    const out = new Map(); let n = 0; out.err = 0;
    for (const x of list) {
      const pk = RK.pairKey(x.teams); let hit = c[pk]; if (hit && hit.v !== 2) hit = null; // v2: + venue/city
      if (!hit || now - hit.t > FX_TTL) {
        if (n >= FX_MAX) continue;
        const evs = []; let fail = false;
        const y = new Date(x.s).getUTCMonth() >= 6 ? new Date(x.s).getUTCFullYear() : new Date(x.s).getUTCFullYear() - 1;
        const q = RK.qName(x.teams[0]).replace(/ /g, '_') + '_vs_' + RK.qName(x.teams[1]).replace(/ /g, '_');
        for (const url of [`https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=${encodeURIComponent(q)}&s=${y}-${y + 1}`, `https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=${encodeURIComponent(q)}`]) {
          if (n) await new Promise((r) => setTimeout(r, 2600)); n++;
          try { const r = await get(url, 'application/json', 1e6); const j = JSON.parse(r.buf.toString('utf8')); for (const e of (j && j.event) || []) evs.push(RK.tsdbEvent(e)); } catch (e) { fail = true; if (/429/.test(e.message)) n = FX_MAX; break; } // rate limit → stop, retry next refresh
          if (evs.length) break;
        }
        if (fail && !evs.length) { out.err++; if (c[pk]) out.set(x.k, RK.classify(x.s, x.teams, c[pk].ev)); continue; } // keep the old cache entry, never cache an error
        hit = c[pk] = { v: 2, t: now, ev: evs.slice(0, 6) };
      }
      out.set(x.k, RK.classify(x.s, x.teams, hit.ev));
    }
    for (const k of Object.keys(c)) if (now - c[k].t > 3 * 86400e3) delete c[k];
    await kv.set('evh_fx', JSON.stringify(c)).catch(() => {});
    return out;
  }
  // team badge → small transparent webp in ev_imgc (never hotlinked), served from /ev-img/c/b-…
  async function badgeImg(url) {
    if (!/^https:\/\/((r2|www)\.thesportsdb\.com|commons\.wikimedia\.org|upload\.wikimedia\.org|a\.espncdn\.com)\//.test(url || '')) return '';
    const tsdb = /thesportsdb/.test(url);
    const k = 'b-' + sha('b1|' + url).slice(0, 24);
    try {
      const ex = (await pool.query('SELECT extract(epoch from at)::int AS v FROM ev_imgc WHERE k=$1', [k])).rows[0]; if (ex) return '/ev-img/c/' + k + '?v=' + ex.v;
      let r; try { r = await get(tsdb ? url + '/small' : url, 'image/*', 2e6, tsdb ? {} : { 'user-agent': 'lnkbio-tvguide/1.0 (https://lnkbio.onrender.com/tv; TV guide team logos)' }); } catch { r = await get(url, 'image/*', 3e6); }
      const w = await require('sharp')(r.buf, { limitInputPixels: 20e6 }).resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80, alphaQuality: 90 }).toBuffer();
      const v = (await pool.query(`INSERT INTO ev_imgc (k,src,img,img_m,credit,meta) VALUES ($1,$2,$3,$3,$4,'') ON CONFLICT (k) DO UPDATE SET img=$3, img_m=$3, at=now() RETURNING extract(epoch from at)::int AS v`, [k, C.clip(url, 400), w, tsdb ? '© TheSportsDB' : /espncdn/.test(url) ? 'ESPN' : 'Wikimedia Commons / Wikipedia'])).rows[0].v;
      return '/ev-img/c/' + k + '?v=' + v;
    } catch (e) { console.error('evhero badge', e.message); return ''; }
  }

  // ---------- weekly computation ----------
  async function compute() {
    const st = await getSettings(), c = E.cfg(st), hc = hcfg(st), kws0 = E.kwOf(c), now = Date.now(), min = Math.max(1, Math.min(200, parseInt(c.ev_min, 10) || 55));
    // 1) official OKTAGON calendar (re-fetched every 6 h; the last good copy is kept on errors)
    let okt = wk && wk.okt;
    if (hc.evh_okt === '1' && (!okt || !okt.ok || now - okt.t > OKT_TTL || (wk && wk.dirty === 'force'))) {
      try { okt = await fetchOkt(); } catch (e) { okt = { t: now, ok: false, err: C.clip(e.message, 100), events: (okt && okt.events) || [] }; }
    }
    if (hc.evh_okt !== '1') okt = null;
    E.setOkt(new Set(((okt && okt.events) || []).map((x) => oktNum(x.title)).filter((x) => x != null)));
    // Oktagon keywords always count for the hero (even when the admin's keyword list predates them)
    // + non-sport event keywords (reality/show finals, galas, Eurovision, elections, Silvester – evsources.js)
    const EXTRA = require('./epgevents').parseKw(S.EXTRA_KW), kw1 = [...kws0, ...EXTRA.filter((x) => !kws0.some((y) => y.k === x.k))];
    const kws = (hc.evh_okt === '1' ? [...kw1, ...OKT_KW.filter((x) => !kw1.some((y) => y.k === x.k))] : kw1).sort((a, b) => b.w - a.w);
    // 2) EPG – everything running now or starting within 7 days
    const hidden = new Set((await pool.query('SELECT k FROM ev_hide')).rows.map((r) => r.k));
    const chs = await skczChannels(hc), allow = new Set(chs.ok.map((r) => r.id));
    const bigCfg = BIG.parse(bigSrc(hc.evh_big)), bigTop = (await standings()).map((L) => Object.assign({}, L, { tids: L.teams.map((n) => BIG.teamsIn(bigCfg, n)) }));
    E.setBig({ cfg: bigCfg, top: bigTop });
    const cand = await E.scan(c, kws, now + 60e3, now + WEEK, true, allow);
    // a minor sport/competition is penalised – unless the big-match detector recognised a specific match/athlete (Vlhová slalom, SK/CZ team, rivalry…)
    for (const x of cand) if (!x.bigStrong && MINOR.test(x.title + ' ' + (x.sub || ''))) { x.score -= 15; x.why.push('menší šport/súťaž −15'); }
    // 3) OKTAGON events this week → EPG airing if the guide has it, else the calendar time on Premier Sport 3 Extra
    const all = await channels(), oktCh = all.find((r) => r.name.toLowerCase() === hc.evh_okt_ch.toLowerCase()) || all.find((r) => /premier sport 3 extra/i.test(r.name));
    for (const ev of (okt && okt.events) || []) {
      if (ev.s + OKT_DUR < now || ev.s > now + WEEK) continue;
      const n = oktNum(ev.title), re = n != null ? new RegExp('\\boktagon\\s*' + n + '\\b', 'i') : null;
      const m = re && cand.find((x) => !x.rerun && re.test(x.title) && Math.abs(x.s - ev.s) < 18 * 3600e3);
      if (m) { Object.assign(m, { src: 'epg+okt', score: m.score + 5, img0: ev.img, place: ev.place, title: prettyOkt(ev.title) }); m.why.push('oficiálny kalendár +5'); continue; }
      const ch = oktCh ? { id: oktCh.id, name: oktCh.name, category: oktCh.category } : { id: 0, name: hc.evh_okt_ch, category: 'Šport' };
      const r = E.score({ s: ev.s, e: ev.s + OKT_DUR, title: ev.title, sub: '', cat: 'MMA', kind: 'sport', fl: 'l', descr: '' }, ch, c, kws, true);
      if (!r) continue;
      r.why.push('oficiálny kalendár +5');
      cand.push({ k: 'o:' + ev.id, tk: 't:' + tnorm(ev.title), title: prettyOkt(ev.title), sub: '', s: ev.s, e: ev.s + OKT_DUR, kind: 'sport', ch, chName: ch.name, score: r.score + 5, kw: r.kw, why: r.why, live: true, rerun: false, src: 'okt', img0: ev.img, place: ev.place, startOnly: true });
    }
    // 4) hard filters + match details (see evrank.js): valid times, still ahead/on air, no recordings („Záznam“ also in the
    //    EPG description), team pairing + competition for matches; one entry per airing key before the cross-channel merge
    const hiddenOf = (x) => hidden.has(x.k) || hidden.has(x.tk) || hidden.has('t:' + tnorm(x.title));
    const pool0 = [];
    for (const x of cand) {
      if (!Number.isFinite(x.s) || !Number.isFinite(x.e) || x.e <= x.s || x.e <= now) continue;
      x.cat = catOf(x.title + ' ' + x.kw.join(' ') + ' ' + (x.sub || ''), x.kind);
      if (x.src !== 'okt' && RK.isRecording(x)) { x.rerun = true; continue; }
      x.teams = /okt/.test(x.src || '') ? null : RK.teamsOf(x, x.cat);
      if (x.teams) x.teams = x.teams.map(RK.sk); // Czech EPG names → Slovak (Švýcarsko → Švajčiarsko)
      x.comp = x.teams ? RK.sk(RK.compOf(x, x.teams)) : '';
      if (x.teams) x.tk = 't:' + tnorm(x.teams.join(' ') + ' ' + RK.dayKey(x.s));
      const floor = RK.isSport(x) ? min : min - 25; // non-sport TV (films, premieres, shows, galas) may enter 25 points lower – TMDB/channel/format decide later
      if (x.score < floor || x.rerun || hiddenOf(x)) continue;
      x.title = RK.sk(x.title); x.sub = RK.sk(x.sub || ''); // Czech programme names → Slovak (Velká cena → Veľká cena …)
      pool0.push(x);
    }
    pool0.sort((a, b) => b.score - a.score || a.s - b.s);
    const N = maxOf(hc);
    // 5) official fixture check for matches (TheSportsDB): confirmed kick-off (+6, badges) or delayed re-broadcast (dropped)
    const fx = await fixtures(pool0.filter((x) => x.teams).slice(0, 4 * N), now);
    const pool1 = pool0.filter((x) => {
      if (!x.teams) return true; const r = fx.get(x.k); if (!r) return true;
      if (r.st === 'replay') { x.why.push('záznam – zápas sa hral ' + fmt(r.ev.ts)); return false; }
      if (r.st === 'ok') { x.official = 'ok'; x.ko = r.ev.ts; x.hb = r.ev.hb; x.ab = r.ev.ab; x.league = r.ev.league; x.venue = r.ev.venue; x.round = r.ev.round; x.why.push('oficiálny rozpis +6'); }
      return true;
    });
    // 6a) non-sport quality: TMDB popularity + rating (official API, key on the server only; cached 7 days)
    try { await tmdbScores(pool1.filter((x) => !RK.isSport(x)).sort((a, b) => b.score - a.score).slice(0, 24), now); } catch (e) { console.error('evhero tmdb', e.message); }
    // 6) priority (score + sooner + official + SK/CZ/players/strength + non-sport quality), merge across channels, optional Gemini
    let ranked = RK.merge(RK.firstAirings(pool1).map((x) => { x.why.push(...RK.bonusWhy(x)); return Object.assign(x, { prio: RK.priority(x, now) }); }).sort((a, b) => b.prio - a.prio || a.s - b.s));
    // Gemini sees the top max(12, 2N) plus enough non-sport items for the ≥ 40 % share
    const top0 = ranked.slice(0, Math.max(12, 2 * N)), nsN = top0.filter((x) => !RK.isSport(x)).length;
    const top = top0.concat(ranked.slice(top0.length).filter((x) => !RK.isSport(x)).slice(0, Math.max(0, N - nsN))).map((x, i) => Object.assign(x, { id: 'c' + (i + 1) }));
    let rank = { by: 'score', model: '', err: '', why: {} }, order = [];
    if (hc.evh_gem === '1' && top.length > 1) {
      const list = top.map((x) => ({ id: x.id, title: dispTitle(x), competition: x.comp || '', channel: [x.chName, ...(x.alt || [])].join(' / ') + (x.pred ? ' (predpokladaný kanál)' : ''), when: RK.whenLbl(x.s, 0) + ' (Europe/Bratislava)', in_days: RK.dayDiff(now, x.s), genre: x.kind || '', score: x.prio, keywords: x.kw.join(', '), big_match: x.big ? x.big.join(', ') : '', official_fixture: x.official === 'ok' }));
      const hsh = sha(rankPrompt(N) + RK.dayKey(now) + JSON.stringify(list.map((x) => [x.title, x.channel, x.when, x.big_match]))).slice(0, 16);
      let memo = null; try { memo = JSON.parse((await kv.get('evh_gem')) || 'null'); } catch {}
      if (memo && memo.h === hsh && now - memo.t < 12 * 3600e3) rank = { by: 'gemini', model: memo.model, err: '', why: memo.why || {}, cached: true }, order = memo.top;
      else if (now - lastGem < 5 * 60e3) rank.err = 'Gemini – pauza medzi volaniami';
      else {
        lastGem = now;
        try { const g = await gemini(list, N, now); rank = { by: 'gemini', model: g.model, err: '', why: g.why }; order = g.top; await kv.set('evh_gem', JSON.stringify({ h: hsh, t: now, top: g.top, why: g.why, model: g.model })); } catch (e) { rank.err = 'Gemini: ' + e.message; }
      }
      for (const x of top) { const gi = order.indexOf(x.id); if (gi >= 0) { x.prio = RK.priority(x, now, gi); x.why.push('Gemini #' + (gi + 1)); } }
      ranked.sort((a, b) => b.prio - a.prio || a.s - b.s); // Gemini bonus only moves the top candidates; the rest stays for variety
    }
    // 7) variety: ≤ 3 per sport/genre and per day (8 slides), sport ≤ 60 % → ≥ 40 % best non-sport (evrank.js select),
    //    then 2 spares (best remaining non-sport + sport) for when a card ends; every card gets a visible reason chip
    const picks = RK.select(ranked, N, { spare: 2 });
    // team logos: official fixture badge → persistent logo cache (evbadge.js chain: flags, Wikidata/Commons, TheSportsDB, Wikipedia)
    const tOf = (x) => { const sp = TB.sportOf(x.cat, x.comp), w = /žien|žen|ženy|women/i.test((x.comp || '') + ' ' + (x.sub || '')); return x.teams.map((name) => ({ name, sport: sp, women: w })); };
    try { await TB.ensure(picks.filter((x) => x.teams).flatMap(tOf), 12, now); } catch (e) { console.error('evhero logos', e.message); }
    for (const x of picks) if (x.teams) {
      const [th, ta] = tOf(x), lh = TB.get(th.name, th.sport, th.women), la = TB.get(ta.name, ta.sport, ta.women);
      if (!x.hb && lh) x.hb = lh.b; if (!x.ab && la) x.ab = la.b;
      x.hbI = await badgeImg(x.hb); x.abI = await badgeImg(x.ab);
      if (!x.hbI && lh && lh.b !== x.hb) x.hbI = await badgeImg(lh.b); if (!x.abI && la && la.b !== x.ab) x.abI = await badgeImg(la.b);
      x.logoSrc = [lh && lh.src, la && la.src].filter(Boolean).join(' / ') || (x.hb ? 'TheSportsDB (zápas)' : '');
    }
    // slow background prefetch for the rest of the candidates (next refresh has their logos without waiting)
    const later = pool0.filter((x) => x.teams && !picks.includes(x)).slice(0, 12).flatMap(tOf);
    setTimeout(() => TB.ensure(later, 8).catch(() => {}), 5e3).unref();
    // 6) background images + facts: official calendar cover, else the automatic resolver (evimg.js; cached 24 h per title)
    if (st.evh_tmdb != null) tmdbSet = String(st.evh_tmdb || '');
    R.beginRefresh();
    const jget = async (k) => { try { return JSON.parse((await kv.get(k)) || '{}') || {}; } catch { return {}; } };
    const rc = await jget('evh_res'), skips = await jget('evh_skip'), force = wk && wk.dirty === 'force';
    for (const x of picks) {
      x.cat = x.cat || catOf(x.title + ' ' + x.kw.join(' ') + ' ' + (x.sub || ''), x.kind); x.reason = rank.why[x.id] || '';
      x.img = ''; x.imgM = ''; x.credit = ''; x.imgPage = ''; x.imgLog = []; x.facts = [];
      let sk = skips[x.tk] || 0;
      if (x.img0 && !sk) {
        try { const c0 = await cachedImg(x.img0); x.img = '/ev-img/c/' + c0.k + '?v=' + c0.v; x.imgM = '/ev-img/m/' + c0.k + '?v=' + c0.v; x.imgSrc = 'official (oficiálny kalendár)'; x.credit = '© ' + new URL(x.img0).hostname.replace(/^www\./, ''); x.imgPage = x.img0; x.imgLog.push('✅ obrázok: oficiálny kalendár (cover)'); }
        catch (e) { x.imgLog.push('oficiálny kalendár: ' + C.clip(e.message, 60)); }
      }
      if (x.img0) sk = Math.max(0, sk - 1);
      let r = rc[x.tk];
      if (!r || r.v !== RV || r.skip !== sk || now - r.t > 24 * 3600e3 || (force && now - r.t > 10 * 60e3)) {
        try { r = await R.resolve(x, x.cat, sk); r.v = RV; rc[x.tk] = r; console.log('evhero:', C.clip(x.title, 60), '→', r.img ? r.img.src : 'záloha ' + x.cat, '|', r.log.join(' | ')); }
        catch (e) { console.error('evhero resolve', C.clip(x.title, 60), e.message); }
      }
      if (r) {
        if (r.genre && r.genre !== 'sport' && x.cat === (KINDCAT[x.kind] || 'stadium') && S.GENRES[r.genre]) x.cat = S.GENRES[r.genre].cat;
        x.genre = r.genre; x.facts = r.facts || []; x.fbOff = r.fbOff || 0;
        if (!x.img) {
          x.imgLog.push(...(r.log || []));
          if (r.img) { x.img = '/ev-img/c/' + r.img.k + '?v=' + r.img.v; x.imgM = '/ev-img/m/' + r.img.k + '?v=' + r.img.v; x.imgSrc = r.img.src; x.credit = r.img.credit; x.imgPage = r.img.page; }
        } else x.imgLog.push('(resolver našiel: ' + (r.img ? r.img.src : 'nič') + ' – oficiálny kalendár má prednosť)');
      }
      if (!x.img) x.imgSrc = '';
    }
    for (const k of Object.keys(rc)) if (!picks.some((x) => x.tk === k) && now - rc[k].t > 7 * 86400e3) delete rc[k];
    for (const k of Object.keys(rc).sort((a, b) => rc[b].t - rc[a].t).slice(40)) delete rc[k];
    await kv.set('evh_res', JSON.stringify(rc)).catch(() => {});
    // 7) short Slovak description per card (see evrank.js „card descriptions“): matches → facts from the official fixture,
    //    table and big-match tiers, written by a rotating template; other events → cleaned EPG text. Gemini may rewrite the
    //    same facts into a teaser (cached per event by a hash of its facts); rejected/failed → the template stays.
    const dctx = { rivals: new Set(bigCfg.rival.map((r) => r.name)), tables: bigTop };
    let mi = 0, ci = 0;
    const dlog = [], items = picks.map((x, i) => {
      const f = []; let tpl = '', mf = null, tsrc = '', cdesc = '';
      if (x.teams) {
        mf = RK.matchFacts(x, dctx); tpl = RK.matchDesc(mf, mi++); tsrc = 'šablóna z faktov (' + (x.official === 'ok' ? 'TheSportsDB + ' : '') + 'EPG + veľké zápasy)';
        f.push({ src: x.official === 'ok' ? 'thesportsdb' : 'epg', lang: 'sk', text: [`Zápas: ${mf.h} (domáci) – ${mf.a}`, mf.comp && 'Súťaž: ' + mf.comp, mf.round && 'Kolo: ' + mf.round, mf.venue && 'Dejisko: ' + mf.venue, mf.rival && 'Rivalita: ' + mf.rival, mf.stake && 'Fáza: ' + mf.stake, mf.clubs && 'Súboj veľkých klubov',
          mf.ph && `Tabuľka: ${mf.h} ${mf.ph.rank}. miesto, ${mf.ph.pts} bodov${RK.formSk(mf.ph.form) ? ', forma ' + RK.formSk(mf.ph.form) : ''}`, mf.pa && `Tabuľka: ${mf.a} ${mf.pa.rank}. miesto, ${mf.pa.pts} bodov${RK.formSk(mf.pa.form) ? ', forma ' + RK.formSk(mf.pa.form) : ''}`].filter(Boolean).join('. ') });
      } else {
        // Slovak EPG text first; a Czech one (ČT, Nova Sport) is only a fact for Gemini, never shown verbatim
        tpl = RK.isCzech(x.descr) ? '' : RK.cleanEpg(x.descr, x.title); if (tpl) tsrc = 'EPG popis (vyčistený)';
        cdesc = RK.catDesc(x, ci++);
        f.push({ src: 'epg', lang: 'sk', text: 'Program: ' + RK.sk(x.title) + (x.sub ? ' – ' + RK.sk(x.sub) : '') + '. ' + cdesc });
        if (x.descr && x.descr.length > 25) f.push({ src: 'epg', lang: RK.isCzech(x.descr) ? 'cs' : 'sk', text: C.clip(x.descr, 400) });
        if (!tpl && RK.isSport(x)) { tpl = cdesc; tsrc = 'šablóna kategórie (' + (x.cat || 'šport') + ')'; }
      }
      if (/okt/.test(x.src || '')) { const m = /^(oktagon\s*\d+)\s*:\s*(.+)$/i.exec(x.title); if (m) { f.push({ src: 'oktagon', lang: 'sk', text: `${m[1]} – hlavný zápas večera: ${m[2]}${x.place ? '; miesto: ' + x.place : ''} (oficiálny kalendár OKTAGON MMA)` }); if (!tpl) { tpl = `${m[2].replace(/\s+vs\.?\s+/i, ' proti ')} v hlavnom zápase večera${x.place ? ' – ' + x.place : ''}.`; tsrc = 'OKTAGON kalendár'; } } }
      const ord = S.DESC_ORDER[x.genre] || S.DESC_ORDER._, ix = (z) => { const n = ord.indexOf(String(z.src).split(' ')[0]); return n < 0 ? 99 : n; };
      if (!x.teams) f.push(...[...x.facts].sort((a, b) => ix(a) - ix(b)));
      if (!tpl && !x.teams) for (const z of f) { if (z.src === 'epg') continue; const c = z.lang === 'sk' && !RK.isCzech(z.text) && RK.cleanEpg(z.text.replace(/^[^:]{0,80}:\s/, ''), x.title); if (c) { tpl = c; tsrc = z.src + ' (zhrnutie)'; break; } }
      if (!tpl && !x.teams) { tpl = cdesc; tsrc = 'šablóna kategórie (' + (x.cat || x.kind || 'program') + ')'; }
      const it = { id: 'e' + (i + 1), tk: x.tk, title: dispTitle(x) + (x.comp ? ' (' + x.comp + ')' : ''), genre: x.genre || x.kind, facts: f.slice(0, 5), tpl, tsrc, alt: x.teams ? [1, 2, 3].map((k) => RK.matchDesc(mf, mi + 3 + k)) : [1, 2].map((k) => RK.catDesc(x, ci + k)), teams: x.teams };
      it.h = sha('d3|' + it.title + '|' + JSON.stringify(it.facts.map((z) => z.text))).slice(0, 16);
      return it;
    });
    const dc = await jget('evh_desc3'), need = items.filter((it) => it.facts.length && !(dc[it.tk] && dc[it.tk].h === it.h));
    if (need.length) {
      const o = await R.describe(need, dlog);
      for (const it of need) { const g = o[it.id]; if (g && g.d && /Gemini/.test(g.src || '')) dc[it.tk] = { h: it.h, t: now, d: RK.okTeaser(g.d, it.facts.map((z) => z.text).concat(it.title), it.teams) ? g.d : '', src: g.src }; }
    }
    for (const k of Object.keys(dc)) if (now - dc[k].t > 7 * 86400e3) delete dc[k];
    kv.set('evh_desc2', '{}').catch(() => {}); // the old teaser cache (bad OKTAGON/curling teasers) is dropped
    await kv.set('evh_desc3', JSON.stringify(dc)).catch(() => {});
    const used = new Set();
    for (const x of picks) {
      const it = items.find((z) => z.tk === x.tk), g = dc[x.tk] && dc[x.tk].h === it.h ? dc[x.tk] : null, k0 = (d) => RK.fold(d).slice(0, 40);
      // Gemini teaser (re-checked on every use) → fact template → its other variants; a card is never left empty
      // a women's match whose teaser never says so (Gemini wrote „Pražské derby … Fortuna liga“) falls back to the template
      const okG = g && g.d && RK.okTeaser(g.d, it.facts.map((z) => z.text).concat(it.title), it.teams) && !(RK.women(x) && !/žien|žen|ženy|žensk/i.test(g.d));
      let d = okG && !used.has(k0(g.d)) ? g.d : '', src = d ? g.src : '';
      if (!d) for (const t of [it.tpl, ...it.alt]) if (t && !used.has(k0(t))) { d = t; src = t === it.tpl ? it.tsrc : 'šablóna (variant)'; break; }
      if (!d) { d = it.tpl || RK.catDesc(x, 0); src = it.tsrc || 'šablóna kategórie'; }
      const pl = RK.legionLine(RK.legion(x)), pls = RK.legion(x).map((o) => o.who.split(' ').slice(-1)[0]);
      if (pl && !pls.every((n) => d.includes(n))) { d = d.replace(/\s*$/, '') + ' ' + pl; src += ' + hráči SK/CZ'; }
      used.add(k0(d));
      x.desc = d; x.descSrc = src + (g && g.d && !okG ? ' · Gemini zamietnutý kontrolou' : !g && it.facts.length ? ' · Gemini nedostupný' : '');
    }
    if (dlog.length) console.log('evhero desc:', dlog.join(' | '));
    try { await pool.query(`DELETE FROM ev_imgc WHERE (k LIKE 'u-%' OR k LIKE 'r-%' OR k LIKE 'b-%') AND at < now() - interval '45 days'`); } catch {}
    // reason chip last: after fixtures (teams/stage), category (catOf) and descriptions are final – a TV special the EPG
    // marks as „film“ but catOf files as a show must not get „Filmová premiéra“
    for (const x of picks) x.rs = RK.reason(x);
    const slim = (x) => ({ k: x.k, tk: x.tk, title: x.title, sub: C.clip(x.sub, 90), s: x.s, e: x.e, kind: x.kind, ch: { id: x.ch.id, name: x.ch.name, category: x.ch.category }, chName: x.chName, pred: x.pred ? 1 : 0, score: x.score, kw: x.kw, why: x.why, src: x.src || 'epg', img: x.img || '', imgM: x.imgM || '', img0: x.img0 || '', imgSrc: x.imgSrc || '', credit: x.credit || '', imgPage: x.imgPage || '', imgLog: x.imgLog || [], fbOff: x.fbOff || 0, genre: x.genre || '', desc: x.desc || '', descSrc: x.descSrc || '', cat: x.cat || catOf(x.title, x.kind), place: x.place || '', reason: x.reason || '', rs: x.rs || '', tmdb: x.tmdb || null, startOnly: !!x.startOnly, live: x.live, teams: x.teams || null, comp: x.comp || '', ko: x.ko || 0, hbI: x.hbI || '', abI: x.abI || '', alt: x.alt || [], official: x.official || '', prio: x.prio == null ? x.score : x.prio });
    const chInfo = { ok: chs.ok.length, epg: chs.ok.filter((r) => r.has).length, noEpg: chs.ok.filter((r) => !r.has && !r.shifted).map((r) => ({ id: r.id, name: r.name, category: r.category, mapped: !!r.epg })),
      okNames: chs.ok.filter((r) => r.has && !r.shifted).map((r) => r.name), excl: chs.no.length, exclFeeds: chs.no.filter((r) => /feed|EPG|zozname|admin/.test(r.why) && !/vod|rádi|radi/i.test(r.category)).map((r) => r.name + ' – ' + r.why).slice(0, 200) };
    wk = { t: now, rv: RV, alg: ALG, n: N, fxErr: fx.err || 0, chans: chInfo, rank, picks: picks.map(slim), top: top.map((x) => Object.assign(slim(x), { imgLog: [] })), okt, ground: Object.assign({}, R.groundStatus(), { at: now }) };
    await kv.set('evh_week', JSON.stringify(wk)).catch(() => {});
    side = null;
    return wk;
  }
  function refresh(force) {
    if (busy) return busy;
    if (force && wk) wk.dirty = force;
    busy = compute().catch((e) => { console.error('evhero', e.message, process.env.EVH_DEBUG ? e.stack : ''); return wk; }).finally(() => { busy = null; });
    return busy;
  }
  async function ensure() {
    if (!loaded) { loaded = true; try { const v = await kv.get('evh_week'); if (v && !wk) { wk = JSON.parse(v); E.setOkt(new Set(((wk.okt && wk.okt.events) || []).map((x) => oktNum(x.title)).filter((x) => x != null))); } } catch {} }
    const now = Date.now();
    if (!wk) { await Promise.race([refresh(), new Promise((r) => setTimeout(r, 9e3).unref())]); return wk; }
    const live = wk.picks.filter((x) => x.e > now).length;
    let N = MAX_DEF; try { N = maxOf(hcfg(await getSettings())); } catch {}
    if (wk.dirty || wk.rv !== RV || wk.alg !== ALG || now - wk.t > REFRESH || (live < N && now - wk.t > 20 * 60e3) || (wk.fxErr && now - wk.t > 30 * 60e3) || (wk.n || 3) !== N) refresh();
    return wk;
  }
  // pins + admin image overrides change rarely – 60 s cache
  async function sideData() {
    if (side && Date.now() - side.t < 60e3) return side;
    const pins = await E.pinsList(Date.now() + WEEK);
    const ov = new Map((await pool.query(`SELECT k, extract(epoch from at)::int AS v FROM ev_imgc WHERE k LIKE 'o-%'`)).rows.map((r) => [r.k, r.v]));
    const dov = new Map((await pool.query('SELECT tk, txt FROM ev_desc')).rows.map((r) => [r.tk, r.txt]));
    return (side = { t: Date.now(), pins, ov, dov });
  }
  // TMDB (official API, https://developer.themoviedb.org): popularity + vote for non-sport candidates. Key only from env
  // (TMDB_API_KEY, v3 key or v4 bearer token), never sent to the browser; results cached in evh_tmdb for 7 days.
  async function tmdbScores(list, now) {
    const key = String(process.env.TMDB_API_KEY || tmdbSet || '').trim(); if (!key || !list.length) return;
    let c = {}; try { c = JSON.parse((await kv.get('evh_tmdb')) || '{}') || {}; } catch {}
    let calls = 0;
    for (const x of list) {
      const q = RK.tmdbQuery(x.title); if (!q) continue;
      const ck = RK.fold(q).slice(0, 60) + '|' + (x.kind === 'film' ? 'm' : 't');
      let hit = c[ck] && now - c[ck].t < 7 * 86400e3 ? c[ck] : null;
      if (!hit && calls < 30) {
        hit = { t: now, r: null };
        for (const lang of ['sk-SK', 'cs-CZ']) {
          if (calls >= 30) break; calls++;
          const v4 = key.length > 60, path = x.kind === 'film' ? 'movie' : x.kind === 'series' ? 'tv' : 'multi';
          const u = `https://api.themoviedb.org/3/search/${path}?query=${encodeURIComponent(q)}&language=${lang}&include_adult=false` + (v4 ? '' : '&api_key=' + encodeURIComponent(key));
          try {
            const r = await get(u, 'application/json', 400e3, v4 ? { authorization: 'Bearer ' + key } : {});
            const j = JSON.parse(r.buf.toString('utf8')), m = (j.results || []).find((z) => RK.tmdbMatch(q, z));
            if (m) { hit.r = { pop: +m.popularity || 0, vote: +m.vote_average || 0, n: +m.vote_count || 0, id: m.id }; break; }
          } catch (e) { hit.err = String(e.message).replace(key, '***').slice(0, 60); break; }
        }
        if (!hit.err) c[ck] = hit;
      }
      if (hit && hit.r) { x.tmdb = hit.r; x.why.push(`TMDB popularita ${Math.round(hit.r.pop)}, hodnotenie ${hit.r.vote.toFixed(1)} (${hit.r.n})`); }
    }
    for (const k of Object.keys(c)) if (now - c[k].t > 7 * 86400e3) delete c[k];
    await kv.set('evh_tmdb', JSON.stringify(c)).catch(() => {});
  }
  async function slides() {
    const w = await ensure(), sd = await sideData(), now = Date.now(), all = await channels(), N = maxOf(hcfg(await getSettings()));
    const out = [], ovImg = (tk) => { const o = sd.ov.get(ovKey(tk)); return o ? { img: '/ev-img/c/' + ovKey(tk) + '?v=' + o, imgM: '/ev-img/m/' + ovKey(tk) + '?v=' + o, imgSrc: 'admin (vlastný obrázok)', credit: '', imgPage: '' } : null; };
    for (const p of sd.pins.filter((x) => x.e > now).slice(0, N)) {
      const tk = 't:' + tnorm(p.title), pk = ((w && w.picks) || []).find((y) => y.tk === tk), cat = (pk && pk.cat) || catOf(p.title + ' ' + (p.note || ''), 'sport'), dv = sd.dov.get(tk);
      out.push(Object.assign({ pin: p.id, rs: (pk && pk.rs) || '📌 Tip redakcie', tk, title: p.title, s: p.s, e: p.e, ch: p.ch, chName: p.chName, sub: '', desc: dv || p.note || '', descSrc: dv ? 'admin' : p.note ? 'admin (pin)' : '', img: p.img || '', imgM: '', cat, src: 'pin', imgSrc: p.img ? 'admin (pin)' : '' }, ovImg(tk) || {}));
    }
    for (const x of (w && w.picks) || []) {
      if (out.length >= N) break;
      if (x.e <= now || out.some((y) => y.tk === x.tk)) continue;
      const ch = x.ch && x.ch.id ? all.find((r) => r.id === x.ch.id) || null : null, dv = sd.dov.get(x.tk);
      out.push(Object.assign({}, x, { ch, desc: dv || x.desc || '', descSrc: dv ? 'admin (prepísaný)' : x.descSrc || '' }, ovImg(x.tk) || {}));
    }
    // bundled fallback backgrounds: variant by title hash, consecutive slides never share the same file
    let prev = '';
    for (const x of out) {
      if (x.img) { prev = ''; continue; }
      const c0 = x.cat || catOf(x.title + ' ' + (x.sub || ''), x.kind), cat = S.FALLBACK[c0] ? c0 : 'stadium', n = S.FALLBACK[cat];
      let i = (parseInt(sha(x.tk || x.title).slice(0, 6), 16) + (x.fbOff || 0)) % n + 1; if (`${cat}-${i}` === prev && n > 1) i = i % n + 1;
      prev = `${cat}-${i}`; x.fb = prev; x.imgSrc = 'záloha: ' + prev;
    }
    return out;
  }

  // ---------- public hero ----------
  const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1);
  const bgOf = (x) => x.img || `/static/ev/${x.fb || 'stadium-1'}.webp?v=${ASSET_V}`;
  const bgM = (x) => (x.img ? x.imgM || x.img : `/static/ev/${x.fb || 'stadium-1'}-m.webp?v=${ASSET_V}`);
  // relative badge from Bratislava calendar days (evrank.badge; static/evh.js recomputes it in the browser every 30 s)
  const badge = (x, en) => RK.badge(x.s, Date.now(), en);
  // card headline: a match is „Home – Away“, everything else its EPG title
  const teamH = (x) => `<span class="evh-tm">${x.hbI ? `<img src="${esc(x.hbI)}" alt="" width="48" height="48" decoding="async">` : ''}<span>${esc(x.teams[0])}</span></span><span class="evh-x" aria-hidden="true">–</span><span class="evh-tm">${x.abI ? `<img src="${esc(x.abI)}" alt="" width="48" height="48" decoding="async">` : ''}<span>${esc(x.teams[1])}</span></span>`;
  async function render(req, s, where) {
    try {
      const st = await getSettings(), hc = hcfg(st); if (hc.evh_on !== '1') return '';
      const list = await slides(); if (!list.length) return '';
      const en = req.lang === 'en', n = list.length, logo = (ch) => (ctx.tvchLogoSrc ? ctx.tvchLogoSrc(ch) : '/tvlogo/' + ch.id);
      const sl = list.map((x, i) => {
        const on = x.s <= Date.now(), when = RK.whenLbl(x.s, x.startOnly ? 0 : x.e, en), ko = x.ko && Math.abs(x.ko - x.s) >= 5 * 60e3 ? x.ko : 0;
        return `<article class="evh-s${i ? '' : ' on'}${on ? ' live' : ''}" role="group" aria-roledescription="${esc(tx(en, 'snímka', 'slide'))}" aria-label="${i + 1} / ${n}"${i ? ' aria-hidden="true" inert' : ''} data-s="${Math.round(x.s / 1000)}" data-e="${Math.round(x.e / 1000)}">
<picture><source media="(max-width:699px)" srcset="${esc(bgM(x))}" width="800" height="800"><img class="evh-bg" src="${esc(bgOf(x))}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async" width="1600" height="1000"></picture><div class="evh-g"></div>${x.img && x.credit ? `<p class="evh-cr">${esc(/^foto:/i.test(x.credit) ? x.credit : 'Foto: ' + x.credit)}</p>` : ''}
<div class="evh-c"><p class="evh-k"><span class="evh-b" data-l="${esc(tx(en, 'NAŽIVO', 'LIVE'))}" data-o="${esc(tx(en, 'o ', 'in '))}" data-d="${esc(en ? 'day|days|days' : 'deň|dni|dní')}" data-t="${esc(en ? 'today, in |tomorrow' : 'dnes o |zajtra')}">${esc(badge(x, en))}</span><span>${x.pin ? '📌 ' + esc(tx(en, 'Odporúčame', 'Featured')) : '🔥 ' + esc(tx(en, 'Top udalosť týždňa', 'Top event of the week'))}</span></p>
${(() => { const rs = x.rs || (() => { try { return RK.reason(x); } catch { return ''; } })(); return rs ? `<p class="evh-rs">${esc(rs)}</p>` : ''; })()}${x.comp ? `<p class="evh-cp">${esc(x.comp)}</p>` : ''}<h2 class="evh-t${x.teams ? ' evh-vs' : ''}"${x.teams ? ` aria-label="${esc(dispTitle(x))}"` : ''}>${x.teams ? teamH(x) : esc(x.title)}</h2>
<p class="evh-m"><time datetime="${new Date(x.s).toISOString()}">${esc(when)}</time>${ko ? `<span class="evh-ko">${esc(tx(en, 'výkop ', 'kick-off '))}${esc(RK.hmL(ko))}</span>` : ''}${x.chName ? `<span class="evh-ch">${x.ch ? `<img src="${esc(logo(x.ch))}" alt="" width="30" height="30" loading="lazy" decoding="async">` : ''}${esc(x.chName)}${x.pred ? `<small class="evh-pq">${esc(tx(en, 'predpokladaný kanál', 'expected channel'))}</small>` : ''}</span>${x.alt && x.alt.length ? `<span class="evh-alt">${esc(tx(en, 'aj ', 'also '))}${esc(x.alt.join(', '))}</span>` : ''}` : ''}${x.place ? `<span class="evh-pl">📍 ${esc(x.place)}</span>` : ''}</p>
${x.desc || (x.sub && !x.teams && x.sub.length >= 20) ? `<p class="evh-d">${esc(x.desc || x.sub)}</p>` : ''}<div class="evh-pr"${on ? '' : ' hidden'}><i></i></div></div></article>`;
      }).join('');
      const nav = n > 1 ? `<button type="button" class="evh-nav evh-prev" aria-label="${esc(tx(en, 'Predchádzajúca udalosť', 'Previous event'))}">‹</button><button type="button" class="evh-nav evh-next" aria-label="${esc(tx(en, 'Ďalšia udalosť', 'Next event'))}">›</button><div class="evh-dots">${list.map((x, i) => `<button type="button" data-i="${i}" aria-label="${esc(dispTitle(x))}" aria-current="${i ? 'false' : 'true'}"></button>`).join('')}</div>` : '';
      return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><section class="evh" aria-roledescription="${esc(tx(en, 'karusel', 'carousel'))}" aria-label="${esc(tx(en, 'Top udalosti týždňa v TV', 'Top TV events of the week'))}" data-n="${n}" data-rank="${esc((wk && wk.rank && wk.rank.by) || 'score')}">${sl}${nav}</section><script src="/static/evh.js?v=${ASSET_V}" defer></script>`;
    } catch (e) { console.error('evhero', e.message, process.env.EVH_DEBUG ? e.stack : ''); return ''; }
  }
  const cardsOffHome = (st) => hcfg(st).evh_on === '1' && hcfg(st).evh_cards_home !== '1';

  // ---------- public: cached / admin images ----------
  app.get('/ev-img/:v(c|m)/:k([uorb]-[0-9a-f]{24})', wrap(async (req, res) => {
    const r = (await pool.query(`SELECT ${req.params.v === 'm' ? 'COALESCE(img_m,img)' : 'img'} AS img FROM ev_imgc WHERE k=$1`, [req.params.k])).rows[0]; if (!r) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }); res.send(r.img);
  }));

  // ---------- admin ----------
  const fmt = (ms) => `${cap(dayLbl(ms, false))} ${hm(ms)}`;
  async function adminHtml(req) {
    const st = await getSettings(), hc = hcfg(st); await ensure(); const w = wk || { picks: [], top: [], rank: {}, t: 0 }, list = await slides(), now = Date.now();
    const srcL = { pin: '📌 pin', epg: 'EPG', okt: 'OKTAGON kalendár', 'epg+okt': 'EPG + OKTAGON kalendár' };
    const k2 = (x) => esc(x.tk || '');
    const slide = (x, i) => `<div class="row evadm"><img src="${esc(bgOf(x))}" alt="" width="160" height="90" loading="lazy"><span><b>${i + 1}. ${esc(dispTitle(x))}</b>${x.comp ? ' <span class="hint">(' + esc(x.comp) + ')</span>' : ''}<br><span class="hint">${esc(fmt(x.s))}${x.startOnly ? '' : '–' + esc(hm(x.e))} CET · ${esc(x.chName || '—')}${x.pred ? ' <i>(predpokladaný kanál)</i>' : ''} · zdroj: ${srcL[x.src] || x.src}${x.alt && x.alt.length ? ' + ' + esc(x.alt.join(', ')) : ''}${x.pin ? '' : ' · skóre ' + x.score + (x.prio != null && x.prio !== x.score ? ' → priorita ' + x.prio : '')}${x.why ? ' (' + esc(x.why.join(', ')) + ')' : ''}${x.reason ? ' · Gemini: „' + esc(x.reason) + '“' : ''} </span>
<span class="hint evx">🖼 obrázok: <b>${esc(x.imgSrc || '')}</b>${x.credit ? ' · ' + esc(x.credit) : ''}${x.imgPage ? ' · ' + esc(C.clip(x.imgPage, 90)) : ''}<br>📝 popis: <b>${esc(x.descSrc || '—')}</b></span>
${x.imgLog && x.imgLog.length ? `<details class="evlog"><summary>Log zdrojov (${x.imgLog.length})</summary><ol>${x.imgLog.map((l) => '<li>' + esc(l) + '</li>').join('')}</ol></details>` : ''}
<form method="post" action="/admin/udalosti/hero/desc" class="evdesc">${hid(req)}<input type="hidden" name="tk" value="${k2(x)}"><textarea name="txt" maxlength="220" rows="2" placeholder="Krátky popis (1–2 vety, max 200 znakov). Prázdne = automatický.">${esc(x.desc || '')}</textarea><button>💬 Uložiť popis</button></form></span>
<span class="evbtns">${x.pin ? '' : `<form method="post" action="/admin/udalosti/hero/pin">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><button>📌 Pripnúť</button></form><form method="post" action="/admin/udalosti/hero/hide">${hid(req)}<input type="hidden" name="k" value="${k2(x)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť</button></form>`}
${x.pin || /^admin/.test(x.imgSrc || '') ? '' : `<form method="post" action="/admin/udalosti/hero/nextimg">${hid(req)}<input type="hidden" name="tk" value="${k2(x)}"><button>🔁 Nájsť iný obrázok</button></form>`}
<form method="post" action="/admin/udalosti/hero/img" enctype="multipart/form-data">${hid(req)}<input type="hidden" name="tk" value="${k2(x)}"><input type="file" name="image" accept="image/jpeg,image/png,image/webp"><input name="url" maxlength="400" placeholder="https:// obrázok alebo stránka udalosti"><button>🖼 Zmeniť obrázok</button>${x.imgSrc && /^admin \(vlastný/.test(x.imgSrc) ? '<label class="ck"><input type="checkbox" name="del" value="1"> zrušiť vlastný obrázok</label>' : ''}</form></span></div>`;
    const okt = w.okt;
    return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><div class="card" id="hero"><h2>🏆 Top udalosť týždňa – hero navrchu webu (${list.length}/${maxOf(hc)})</h2>
<p class="hint">Karusel (max ${maxOf(hc)}, nastaviteľné nižšie: 1–${MAX_HI}) navrchu domovskej stránky. Poradie: 📌 pripnuté → automatický výber z TV programu na 7 dní (kľúčové slová + šport + naživo + večer, bez záznamov) + oficiálny kalendár OKTAGON MMA${hc.evh_gem === '1' ? ' → Gemini zoradí top ' + Math.max(12, 2 * maxOf(hc)) + ' (pri chybe ostáva poradie podľa skóre)' : ''} · priorita = skóre + skôr (dnes +6 … o 7 dní −3) + oficiálny rozpis +6 (+ Gemini max +10) · záznamy a odložené prenosy (zápas sa už hral podľa oficiálneho rozpisu) sa vyraďujú · rovnaká udalosť na viacerých kanáloch = 1 karta · pestrosť: max ${Math.max(2, Math.ceil(maxOf(hc) * 0.3))} z jedného športu/žánru, ${Math.max(2, Math.ceil(maxOf(hc) * 0.35))} z jedného dňa, šport max ${Math.ceil(maxOf(hc) * 0.75)}. Prepočet každé ${REFRESH / 3600e3} h.</p>
<p>Vypočítané: <b>${w.t ? esc(fmt(w.t)) + ' CET' : '—'}</b> · poradie: <b>${w.rank && w.rank.by === 'gemini' ? 'Gemini (' + esc(w.rank.model || '') + (w.rank.cached ? ', z cache' : '') + ')' : 'skóre (deterministicky)'}</b>${w.rank && w.rank.err ? ' · <span class="hint">' + esc(w.rank.err) + '</span>' : ''}</p>
${w.chans ? `<details class="evlog"><summary>📺 Kanály pre výber: <b>${w.chans.ok}</b> SK/CZ kanálov z Kanály (${w.chans.epg} s programom, ${w.chans.noEpg.length} bez programu) · ${w.chans.excl} vylúčených (zahraničné / rádiá / VOD / 18+)</summary>
<p><b>Bez programu (EPG):</b> ${w.chans.noEpg.map((r) => esc(r.name) + (/premier sport 3 extra/i.test(r.name) ? ' <i>(OKTAGON kalendár)</i>' : r.mapped ? ' <i>(spárovaný, zdroj neposiela dáta)</i>' : '')).join(', ') || '—'}</p>
<p><b>S programom:</b> ${w.chans.okNames.map(esc).join(', ')}</p>
<p><b>Vylúčené (výber):</b> ${w.chans.exclFeeds.map(esc).join(', ') || '—'}</p></details>` : ''}
<p class="hint">🔎 Gemini Google Search grounding: ${(() => { const g = w.ground || R.groundStatus(); return g.lastOk ? '✅ funguje (posledné ' + esc(fmt(g.lastOk)) + ' CET)' : g.err ? '⚠ nedostupné – ' + esc(g.err) + ' → identifikácia bez groundingu; URL len z whitelistu + overenie zhody (≥' + S.VERIFY_MIN + ')' : 'zatiaľ nepoužité'; })()} · TMDB: ${process.env.TMDB_API_KEY ? '✅ kľúč z env' : tmdbSet ? '✅ kľúč v nastaveniach' : 'nenastavené (nepovinné – filmy/seriály berú Wikipédiu / stránku TV)'}</p>
<form method="post" action="/admin/udalosti/hero/refresh">${hid(req)}<button>🔄 Prepočítať teraz</button></form>
${list.map(slide).join('') || '<p class="hint">Tento týždeň nie je žiadna udalosť nad hranicou skóre – pripnite ju ručne nižšie.</p>'}
<h3>Ďalší kandidáti týždňa</h3>${(w.top || []).filter((x) => !list.some((y) => y.tk === x.tk)).slice(0, 9).map((x) => `<div class="row"><span><b>${esc(fmt(x.s))}</b> ${esc(dispTitle(x))} · <span class="hint">${esc(x.chName)} · skóre ${x.score}${x.prio != null ? ' → ' + x.prio : ''} · ${esc((x.why || []).join(', '))}</span></span><form method="post" action="/admin/udalosti/hero/pin">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><button>📌</button></form></div>`).join('') || '<p class="hint">—</p>'}
<h3>🥊 OKTAGON MMA (oficiálny kalendár)</h3><p class="hint">${okt ? (okt.ok ? '✅ načítané ' : '⚠ chyba ' + esc(okt.err) + ' · posledné ') + esc(fmt(okt.t)) + ' CET' : 'vypnuté'} · kanál: <b>${esc(hc.evh_okt_ch)}</b> (v EPG zdrojoch nie je – čas sa berie z kalendára; ak EPG nájde „OKTAGON N“ naživo, použije sa EPG)</p>
${((okt && okt.events) || []).slice(0, 6).map((x) => `<div class="row"><span><b>${esc(fmt(x.s))} CET</b> ${esc(prettyOkt(x.title))} · <span class="hint">${esc(x.place)}</span></span></div>`).join('')}
<form method="post" action="/admin/udalosti/hero/settings">${hid(req)}<h3>⚙ Nastavenia hero</h3>
<label class="ck"><input type="checkbox" name="evh_on" value="1"${hc.evh_on === '1' ? ' checked' : ''}> Zobraziť hero „Top udalosť týždňa“ navrchu domovskej stránky</label>
<label>Počet udalostí v karuseli (1–${MAX_HI}, predvolene ${MAX_DEF})</label><input type="number" name="evh_max" min="1" max="${MAX_HI}" step="1" value="${maxOf(hc)}" inputmode="numeric">
<label class="ck"><input type="checkbox" name="evh_cards_home" value="1"${hc.evh_cards_home === '1' ? ' checked' : ''}> Pod hero zobraziť aj kartičky „Dnes v TV · Top udalosti“ (na stránke Kanály ostávajú)</label>
<label class="ck"><input type="checkbox" name="evh_gem" value="1"${hc.evh_gem === '1' ? ' checked' : ''}> Zoradiť kandidátov cez Gemini (${process.env.GEMINI_API_KEY ? 'kľúč nastavený' : 'GEMINI_API_KEY chýba'})</label>
<label class="ck"><input type="checkbox" name="evh_okt" value="1"${hc.evh_okt === '1' ? ' checked' : ''}> Načítavať kalendár OKTAGON MMA</label>
<label>Kanál pre OKTAGON</label><input name="evh_okt_ch" maxlength="60" value="${esc(hc.evh_okt_ch)}">
<label>Kanály pre Top udalosti – iba SK/CZ (doplnky k vstavanému zoznamu; jeden názov / časť názvu na riadok, <code>-názov</code> = vylúčiť)</label><textarea name="evh_ch" rows="3" maxlength="2000" placeholder="napr.&#10;Nova Sport 5 CZ&#10;-Story 4">${esc(hc.evh_ch)}</textarea>
<label>⚽🏒🎾 Detektor veľkých zápasov – všetky športy (tímy, rivality, skupiny, mená, pravidlá; prázdne = predvolené)${(() => { const e = BIG.parse(bigSrc(hc.evh_big)).errors; return e.length ? ' – ⚠ neplatné riadky: ' + esc(e.slice(0, 3).join(' | ')) : ''; })()}</label><textarea name="evh_big" rows="12" maxlength="20000" class="evbig">${esc(bigSrc(hc.evh_big))}</textarea><label class="ck"><input type="checkbox" name="evh_big_reset" value="1"> obnoviť predvolený detektor (najnovšie tímy, ligy a pravidlá)</label>
<label>TMDB API kľúč (nepovinné – lepšie obrázky a popisy filmov/seriálov; v3 kľúč alebo v4 token)</label><input type="password" name="evh_tmdb" maxlength="400" autocomplete="off" placeholder="${process.env.TMDB_API_KEY ? 'nastavené cez env TMDB_API_KEY' : tmdbSet ? '•••••• uložený (prázdne = ponechať)' : 'nenastavené'}">${tmdbSet ? '<label class="ck"><input type="checkbox" name="evh_tmdb_del" value="1"> vymazať uložený TMDB kľúč</label>' : ''}<button>Uložiť</button></form></div>${ctx.extAdminHtml ? await ctx.extAdminHtml(req) : ''}`;
  }
  const back = (res, m) => E.back(res, m, 'hero');
  admin.post('/udalosti/hero/refresh', needAuth, csrf, wrap(async (req, res) => { side = null; await refresh('force'); back(res, 'ok'); }));
  admin.post('/udalosti/hero/settings', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body, ch = String(b.evh_okt_ch || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || HD.evh_okt_ch;
    const chTxt = String(b.evh_ch || '').replace(/[\u0000-\u0009\u000b-\u001f<>]/g, '').split(/\r?\n/).map((x) => x.trim().slice(0, 60)).filter(Boolean).slice(0, 60).join('\n');
    let bigTxt = String(b.evh_big || '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').slice(0, 20000).trim();
    if (bigTxt === S.BIG_DEFAULT.trim() || OLD_BIG.has(sha(bigTxt)) || b.evh_big_reset) bigTxt = ''; // unchanged → keep following the built-in defaults
    const upd = { evh_big: bigTxt, evh_ch: chTxt, evh_on: b.evh_on ? '1' : '0', evh_cards_home: b.evh_cards_home ? '1' : '0', evh_gem: b.evh_gem ? '1' : '0', evh_okt: b.evh_okt ? '1' : '0', evh_okt_ch: ch, evh_max: String(maxOf({ evh_max: b.evh_max })) };
    const tm = String(b.evh_tmdb || '').trim(); if (b.evh_tmdb_del) upd.evh_tmdb = ''; else if (tm) { if (!/^[\w.\-]{16,400}$/.test(tm)) return back(res, 'bad'); upd.evh_tmdb = tm; }
    await setSettings(upd); if (upd.evh_tmdb != null) tmdbSet = upd.evh_tmdb;
    await refresh('force'); back(res, 'ok');
  }));
  admin.post('/udalosti/hero/hide', needAuth, csrf, wrap(async (req, res) => {
    const k = String(req.body.k || '').slice(0, 300); if (/^t:/.test(k)) await pool.query('INSERT INTO ev_hide (k,title) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING', [k, E.noUrl(req.body.title, 160)]);
    await refresh(true); back(res, 'hid');
  }));
  admin.post('/udalosti/hero/pin', needAuth, csrf, wrap(async (req, res) => {
    await ensure(); const k = String(req.body.k || ''), x = wk && [...wk.picks, ...wk.top].find((y) => y.k === k); if (!x) return back(res, 'bad');
    let img = null; const ok = x.img && /^\/ev-img\/c\/([ur]-[0-9a-f]{24})/.exec(x.img);
    if (ok) img = ((await pool.query('SELECT img FROM ev_imgc WHERE k=$1', [ok[1]])).rows[0] || {}).img || null;
    await pool.query('INSERT INTO ev_pin (title,channel_id,channel_txt,s,e,img_url,img,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [C.clip(x.title, 160), x.ch && x.ch.id ? x.ch.id : null, x.ch && x.ch.id ? '' : C.clip(x.chName, 60), new Date(x.s), new Date(x.e), '', img, C.clip(x.place || '', 140)]);
    if (ctx.audit) await ctx.audit(req, 'ev_pin', x.title);
    side = null; E.back(res, 'pin', 'hero');
  }));
  admin.post('/udalosti/hero/img', needAuth, (req, res, next) => E.up(req, res, (e) => (e ? back(res, 'badimg') : next())), csrf, wrap(async (req, res) => {
    const tk = String(req.body.tk || '').slice(0, 300); if (!/^t:/.test(tk)) return back(res, 'bad');
    if (req.body.del === '1') { await pool.query('DELETE FROM ev_imgc WHERE k=$1', [ovKey(tk)]); side = null; return back(res, 'del'); }
    let v = null;
    if (req.file && req.file.size) { try { v = await R.variants(req.file.buffer); } catch { return back(res, 'badimg'); } }
    else if (req.body.url) { try { v = await R.variants(await fetchRaw(String(req.body.url).trim().slice(0, 400))); } catch { return back(res, 'badurl'); } }
    else return back(res, 'badimg');
    await pool.query(`INSERT INTO ev_imgc (k,src,img,img_m,credit,meta) VALUES ($1,'admin',$2,$3,'','') ON CONFLICT (k) DO UPDATE SET img=$2, img_m=$3, src='admin', at=now()`, [ovKey(tk), v.w, v.m]);
    if (ctx.audit) await ctx.audit(req, 'ev_img', tk.slice(0, 100));
    side = null; back(res, 'ok');
  }));

  // "Nájsť iný obrázok": skip the current automatic candidate and resolve the next one (synchronously)
  admin.post('/udalosti/hero/nextimg', needAuth, csrf, wrap(async (req, res) => {
    const tk = String(req.body.tk || '').slice(0, 300); if (!/^t:/.test(tk)) return back(res, 'bad');
    let sk = {}; try { sk = JSON.parse((await kv.get('evh_skip')) || '{}') || {}; } catch {}
    sk[tk] = Math.min(20, (sk[tk] || 0) + 1); const keys = Object.keys(sk); for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete sk[k];
    await kv.set('evh_skip', JSON.stringify(sk));
    if (ctx.audit) await ctx.audit(req, 'ev_nextimg', tk.slice(0, 100));
    side = null; await refresh(true); back(res, 'ok');
  }));
  // per-event description override (empty = automatic)
  admin.post('/udalosti/hero/desc', needAuth, csrf, wrap(async (req, res) => {
    const tk = String(req.body.tk || '').slice(0, 300); if (!/^t:/.test(tk)) return back(res, 'bad');
    const t = E.noUrl(String(req.body.txt || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(), 220);
    const cur = (wk && wk.picks.find((x) => x.tk === tk)) || null;
    if (!t || (cur && t === cur.desc)) await pool.query('DELETE FROM ev_desc WHERE tk=$1', [tk]);
    else await pool.query('INSERT INTO ev_desc (tk,txt) VALUES ($1,$2) ON CONFLICT (tk) DO UPDATE SET txt=$2, at=now()', [tk, t]);
    if (ctx.audit) await ctx.audit(req, 'ev_desc', tk.slice(0, 100));
    side = null; back(res, 'ok');
  }));

  return { init, stale, render, cardsOffHome, adminHtml, refresh, fetchImage, toWebp, _catOf: catOf, _fetchOkt: fetchOkt, _prettyOkt: prettyOkt };
};
module.exports.catOf = catOf; module.exports.diversify = diversify; module.exports.maxOf = maxOf; module.exports.prettyOkt = prettyOkt;
