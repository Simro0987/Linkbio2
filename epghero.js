'use strict';
// "Top udalosť týždňa" – Netflix-style hero carousel (max 3 slides) at the top of the homepage.
// Fully server-side: EPG scoring for the next 7 days + official calendars (OKTAGON MMA) fetched by this server,
// optional Gemini ranking of the top candidates (deterministic score order as fallback), cached in memory + epg_kv
// and refreshed every few hours. Admin pins always fill the slots first. Images are never hotlinked: admin upload,
// or the official event image (og:image / calendar cover) downloaded once and stored as a small webp, or a bundled
// category background (static/ev/*.webp). Program info only – never stream links.
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const C = require('./epgcore');
const { tx } = require('./uitext');

const HD = { evh_on: '1', evh_cards_home: '0', evh_gem: '1', evh_okt: '1', evh_okt_ch: 'Premier Sport 3 Extra' };
const MAXS = 3, WEEK = 7 * 86400e3, REFRESH = 3 * 3600e3, OKT_TTL = 6 * 3600e3, OKT_DUR = 5 * 3600e3;
const OKT_URL = 'https://oktagonmma.com/cs/';
const CATS = [
  ['sport', /volejbal|volleyball|futsal|h[aá]dzan|h[aá]zen|handball|florbal|floorball|bedminton|badminton|curling|snooker/i],
  ['mma', /oktagon|\bmma\b|\bufc\b|\bcage\b|\bbox|boxing|kickbox|\bk-?1\b|\bring\b/i],
  ['awards', /ballon|zlat[aá] lopt|zlat[yý] m[ií][čc]|oscar|academy award|glob[ue]s?\b|grammy|sl[aá]vik|award|vyhl[aá]seni|vyhl[aá]šen/i],
  ['f1', /formul|\bf1\b|grand prix|ve[lľ]k[aá] cena|motogp|rall(y|ye)|nascar|indycar/i],
  ['hockey', /hokej|hockey|\bnhl\b|stanley|extralig|\bkhl\b/i],
  ['tennis', /tenis|tennis|wimbledon|roland|us open|australian open|davis|\batp\b|\bwta\b/i],
  ['basketball', /basket|\bnbk\b|kos[aá]rk|\bnba\b|euroleague|eurolig/i],
  ['show', /eurov|superstar|talent|koncert|concert|festival|\bshow\b|gala/i],
  ['football', /futbal|fotbal|football|soccer|lig[ay] majstrov|lig[ay] mistr|champions|europa league|eur[oó]psk|evropsk|konferen|cl[aá]sico|derby|premier league|la liga|bundesliga|serie a|\bms\b|\bme\b|euro 20|world cup|uefa|fifa/i],
];
const OKT_KW = [{ k: 'oktagon mma', w: 55, label: 'OKTAGON MMA', short: false, cs: '' }, { k: 'oktagon', w: 50, label: 'Oktagon', short: false, cs: '' }];
const DEVNET = process.env.NODE_ENV !== 'production' && process.env.EVH_DEV_NET === '1';
// minor sports / women's / youth competitions: fine for the cards, rarely „the event of the week“
const MINOR = /\b(volejbal|volleyball|futsal|bedminton|badminton|curling|snooker|šípky|sipky|darts|stolný tenis|stolni tenis|florbal|plávanie|plavani|gymnastika|krasokorčuľovanie|krasobrusleni|cyklistika|veslovanie|ženy|žien|ženské|zeny|women|U1[6-9]|U2[01]|junior|dorast)\b/i;
const catOf = (t, kind) => { for (const [k, re] of CATS) if (re.test(t)) return k; return kind === 'show' || kind === 'music' ? 'show' : 'sport'; };
const sha = (v) => crypto.createHash('sha1').update(String(v)).digest('hex');
// "OKTAGON 96: GOGOLADZE VS. KLINKHAMMER" → "OKTAGON 96: Gogoladze vs. Klinkhammer"
const prettyOkt = (t) => { const i = t.indexOf(':'); if (i < 0) return t; const tail = t.slice(i + 1).toLowerCase().replace(/(^|[\s\-–(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\bVs\./g, 'vs.'); return t.slice(0, i + 1) + tail; };
const pick = (o, k) => (o && typeof o === 'object' ? o[k] || o.cs || o.sk || o.en || '' : String(o || ''));

module.exports = function hero(ctx, h, E) {
  const { app, admin, pool, esc, hid, csrf, needAuth, wrap, getSettings, setSettings } = ctx;
  const { dayStart, dayLbl, hm, tnorm, channels, ASSET_V, kv } = h;
  const hcfg = (s) => { const o = {}; for (const k of Object.keys(HD)) o[k] = s[k] == null || s[k] === '' ? HD[k] : String(s[k]); return o; };
  let wk = null, busy = null, loaded = false, lastGem = 0, side = null;

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ev_imgc (k TEXT PRIMARY KEY, src TEXT NOT NULL DEFAULT '', img BYTEA NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
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
  async function get(url, accept, max) {
    let u = url;
    for (let i = 0; i < 4; i++) {
      const x = new URL(u); if (x.protocol !== 'https:') throw new Error('https only'); await hostOk(x.hostname);
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(12e3), headers: { 'user-agent': 'Mozilla/5.0 (compatible; lnkbio-tvguide/1.0)', accept, 'accept-language': 'cs,sk;q=0.9,en;q=0.5' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (+(r.headers.get('content-length') || 0) > max) throw new Error('too big');
      const parts = []; let n = 0; const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > max) { try { await rd.cancel(); } catch {} throw new Error('too big'); } parts.push(value); }
      return { buf: Buffer.concat(parts.map((p) => Buffer.from(p))), type: String(r.headers.get('content-type') || '').toLowerCase(), url: u };
    }
    throw new Error('too many redirects');
  }
  const toWebp = (buf) => require('sharp')(buf, { limitInputPixels: 40e6 }).rotate().resize(1280, 720, { fit: 'cover', position: 'attention' }).webp({ quality: 60, effort: 4 }).toBuffer();
  // image URL or an event page URL (→ og:image / twitter:image) → small webp buffer
  async function fetchImage(url) {
    let r = await get(url, 'image/avif,image/webp,image/*,text/html;q=0.8', 6e6);
    if (/html/.test(r.type)) {
      const html = r.buf.toString('utf8', 0, Math.min(r.buf.length, 600e3));
      const m = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(html);
      if (!m) throw new Error('no og:image');
      r = await get(new URL(m[1].replace(/&amp;/g, '&'), r.url).href, 'image/avif,image/webp,image/*', 6e6);
    }
    if (!/^image\//.test(r.type) && !/^\s*$/.test(r.type)) throw new Error('not an image');
    return toWebp(r.buf);
  }
  // cached copy of an official image (downloaded once, stored in Postgres, served from /ev-img/c/…)
  async function cachedImg(url) {
    const k = 'u-' + sha(url).slice(0, 24);
    const ex = (await pool.query('SELECT extract(epoch from at)::int AS v FROM ev_imgc WHERE k=$1', [k])).rows[0];
    if (ex) return '/ev-img/c/' + k + '?v=' + ex.v;
    const img = await fetchImage(url);
    const v = (await pool.query(`INSERT INTO ev_imgc (k,src,img) VALUES ($1,$2,$3) ON CONFLICT (k) DO UPDATE SET img=$3, at=now() RETURNING extract(epoch from at)::int AS v`, [k, C.clip(url, 400), img])).rows[0].v;
    return '/ev-img/c/' + k + '?v=' + v;
  }
  const ovKey = (tk) => 'o-' + sha(tk).slice(0, 24);

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
  async function gemini(list) {
    const key = String(process.env.GEMINI_API_KEY || '').trim(); if (!key) throw new Error('bez GEMINI_API_KEY');
    const models = [...new Set((process.env.EVH_GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.8-flash').split(',').map((x) => x.trim()).filter((x) => /^[\w.-]{3,60}$/.test(x)))].slice(0, 4);
    const prompt = 'You are the editor of a Slovak/Czech TV guide homepage. From the candidate TV broadcasts of the next 7 days below, choose the 3 BIGGEST events (fewer only if there are fewer real top events) that the most viewers in Slovakia and Czechia will want to watch live (e.g. big finals, national-team games, Champions League top matches, galas like the Ballon d\'Or, big MMA cards like numbered OKTAGON events, Olympics, F1 decisive races). Prefer live first-run broadcasts; avoid reruns, studio shows, magazines and minor matches. Use ONLY ids from the list. Answer with JSON only: {"top":["id1","id2","id3"],"why":{"id1":"short reason in Slovak, max 12 words"}}\n\nCandidates:\n' + JSON.stringify(list);
    let last = '';
    for (const m of models) {
      try {
        const gc = { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 600 }; if (/2\.5/.test(m)) gc.thinkingConfig = { thinkingBudget: 0 };
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(20e3), body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc }) });
        if (!r.ok) { last += (last ? '; ' : '') + m + ' HTTP ' + r.status; continue; }
        const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
        const ids = new Set(list.map((x) => x.id)), top = [...new Set((Array.isArray(o.top) ? o.top : []).map(String))].filter((x) => ids.has(x)).slice(0, MAXS);
        if (!top.length) { last += (last ? '; ' : '') + m + ' prázdna odpoveď'; continue; }
        const why = {}; for (const id of top) { const w = o.why && o.why[id]; if (w) why[id] = C.clip(String(w).replace(/[<>]/g, ''), 120); }
        return { top, why, model: m };
      } catch (e) { last += (last ? '; ' : '') + m + ' ' + (e.name === 'TimeoutError' ? 'timeout' : (e.message || e.name).slice(0, 60)); }
    }
    throw new Error(C.clip(last || 'chyba', 200));
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
    const kws = hc.evh_okt === '1' ? [...kws0, ...OKT_KW.filter((x) => !kws0.some((y) => y.k === x.k))].sort((a, b) => b.w - a.w) : kws0;
    // 2) EPG – everything running now or starting within 7 days
    const hidden = new Set((await pool.query('SELECT k FROM ev_hide')).rows.map((r) => r.k));
    const cand = await E.scan(c, kws, now + 60e3, now + WEEK);
    for (const x of cand) if (MINOR.test(x.title + ' ' + (x.sub || ''))) { x.score -= 15; x.why.push('menší šport/súťaž −15'); }
    // 3) OKTAGON events this week → EPG airing if the guide has it, else the calendar time on Premier Sport 3 Extra
    const all = await channels(), oktCh = all.find((r) => r.name.toLowerCase() === hc.evh_okt_ch.toLowerCase()) || all.find((r) => /premier sport 3 extra/i.test(r.name));
    for (const ev of (okt && okt.events) || []) {
      if (ev.s + OKT_DUR < now || ev.s > now + WEEK) continue;
      const n = oktNum(ev.title), re = n != null ? new RegExp('\\boktagon\\s*' + n + '\\b', 'i') : null;
      const m = re && cand.find((x) => !x.rerun && re.test(x.title) && Math.abs(x.s - ev.s) < 18 * 3600e3);
      if (m) { Object.assign(m, { src: 'epg+okt', score: m.score + 5, img0: ev.img, place: ev.place, title: prettyOkt(ev.title) }); m.why.push('oficiálny kalendár +5'); continue; }
      const ch = oktCh ? { id: oktCh.id, name: oktCh.name, category: oktCh.category } : { id: 0, name: hc.evh_okt_ch, category: 'Šport' };
      const r = E.score({ s: ev.s, e: ev.s + OKT_DUR, title: ev.title, sub: '', cat: 'MMA', kind: 'sport', fl: 'l', descr: '' }, ch, c, kws);
      if (!r) continue;
      r.why.push('oficiálny kalendár +5');
      cand.push({ k: 'o:' + ev.id, tk: 't:' + tnorm(ev.title), title: prettyOkt(ev.title), sub: '', s: ev.s, e: ev.s + OKT_DUR, kind: 'sport', ch, chName: ch.name, score: r.score + 5, kw: r.kw, why: r.why, live: true, rerun: false, src: 'okt', img0: ev.img, place: ev.place, startOnly: true });
    }
    // 4) eligible: above the threshold, not hidden, first-run only; one airing per title (highest score, then earliest)
    cand.sort((a, b) => b.score - a.score || a.s - b.s);
    const seen = new Set(), elig = [];
    for (const x of cand) { if (x.score < min || x.rerun || hidden.has(x.k) || hidden.has(x.tk) || seen.has(x.tk)) continue; seen.add(x.tk); elig.push(x); }
    const top = elig.slice(0, 12).map((x, i) => Object.assign(x, { id: 'c' + (i + 1) }));
    // 5) optional Gemini re-ranking of the top 12 (memoized per candidate set; deterministic score order on any failure)
    let rank = { by: 'score', model: '', err: '', why: {} }, order = top.map((x) => x.id);
    if (hc.evh_gem === '1' && top.length > 1) {
      const list = top.map((x) => ({ id: x.id, title: x.title, channel: x.chName, when: new Date(x.s).toISOString(), score: x.score, keywords: x.kw.join(', ') }));
      const hsh = sha(JSON.stringify(list.map((x) => [x.title, x.channel, x.when]))).slice(0, 16);
      let memo = null; try { memo = JSON.parse((await kv.get('evh_gem')) || 'null'); } catch {}
      if (memo && memo.h === hsh && now - memo.t < 12 * 3600e3) rank = { by: 'gemini', model: memo.model, err: '', why: memo.why || {}, cached: true }, order = memo.top;
      else if (now - lastGem < 5 * 60e3) rank.err = 'Gemini – pauza medzi volaniami';
      else {
        lastGem = now;
        try { const g = await gemini(list); rank = { by: 'gemini', model: g.model, err: '', why: g.why }; order = g.top; await kv.set('evh_gem', JSON.stringify({ h: hsh, t: now, top: g.top, why: g.why, model: g.model })); } catch (e) { rank.err = 'Gemini: ' + e.message; }
      }
      order = [...order.filter((id) => top.some((x) => x.id === id)), ...top.map((x) => x.id).filter((id) => !order.includes(id))];
    }
    const picks = order.map((id) => top.find((x) => x.id === id)).filter(Boolean).slice(0, MAXS + 2);
    // 6) background images: official image (downloaded + cached) or category background
    for (const x of picks) {
      x.cat = catOf(x.title + ' ' + x.kw.join(' ') + ' ' + (x.sub || ''), x.kind); x.imgSrc = 'kategória: ' + x.cat; x.img = '';
      if (x.img0) { try { x.img = await cachedImg(x.img0); x.imgSrc = 'oficiálny obrázok (og:image)'; } catch (e) { x.imgSrc += ' (oficiálny obrázok zlyhal: ' + C.clip(e.message, 40) + ')'; } }
      x.reason = rank.why[x.id] || '';
    }
    try { await pool.query(`DELETE FROM ev_imgc WHERE k LIKE 'u-%' AND at < now() - interval '45 days'`); } catch {}
    const slim = (x) => ({ k: x.k, tk: x.tk, title: x.title, sub: C.clip(x.sub, 90), s: x.s, e: x.e, kind: x.kind, ch: { id: x.ch.id, name: x.ch.name, category: x.ch.category }, chName: x.chName, score: x.score, kw: x.kw, why: x.why, src: x.src || 'epg', img: x.img || '', img0: x.img0 || '', imgSrc: x.imgSrc || '', cat: x.cat || catOf(x.title, x.kind), place: x.place || '', reason: x.reason || '', startOnly: !!x.startOnly, live: x.live });
    wk = { t: now, rank, picks: picks.map(slim), top: top.map(slim), okt };
    await kv.set('evh_week', JSON.stringify(wk)).catch(() => {});
    side = null;
    return wk;
  }
  function refresh(force) {
    if (busy) return busy;
    if (force && wk) wk.dirty = force;
    busy = compute().catch((e) => { console.error('evhero', e.message); return wk; }).finally(() => { busy = null; });
    return busy;
  }
  async function ensure() {
    if (!loaded) { loaded = true; try { const v = await kv.get('evh_week'); if (v && !wk) { wk = JSON.parse(v); E.setOkt(new Set(((wk.okt && wk.okt.events) || []).map((x) => oktNum(x.title)).filter((x) => x != null))); } } catch {} }
    const now = Date.now();
    if (!wk) { await Promise.race([refresh(), new Promise((r) => setTimeout(r, 9e3).unref())]); return wk; }
    const live = wk.picks.filter((x) => x.e > now).length;
    if (wk.dirty || now - wk.t > REFRESH || (live < MAXS && now - wk.t > 20 * 60e3)) refresh();
    return wk;
  }
  // pins + admin image overrides change rarely – 60 s cache
  async function sideData() {
    if (side && Date.now() - side.t < 60e3) return side;
    const pins = await E.pinsList(Date.now() + WEEK);
    const ov = new Map((await pool.query(`SELECT k, extract(epoch from at)::int AS v FROM ev_imgc WHERE k LIKE 'o-%'`)).rows.map((r) => [r.k, r.v]));
    return (side = { t: Date.now(), pins, ov });
  }
  async function slides() {
    const w = await ensure(), sd = await sideData(), now = Date.now(), all = await channels();
    const out = [];
    for (const p of sd.pins.filter((x) => x.e > now).slice(0, MAXS)) {
      const tk = 't:' + tnorm(p.title), o = sd.ov.get(ovKey(tk)), cat = catOf(p.title + ' ' + (p.note || ''), 'sport');
      out.push({ pin: p.id, tk, title: p.title, s: p.s, e: p.e, ch: p.ch, chName: p.chName, sub: p.note || '', img: o ? '/ev-img/c/' + ovKey(tk) + '?v=' + o : p.img || '', cat, src: 'pin', imgSrc: o ? 'admin (prepísaný)' : p.img ? 'admin (pin)' : 'kategória: ' + cat });
    }
    for (const x of (w && w.picks) || []) {
      if (out.length >= MAXS) break;
      if (x.e <= now || out.some((y) => y.tk === x.tk)) continue;
      const ch = x.ch && x.ch.id ? all.find((r) => r.id === x.ch.id) || null : null, o = sd.ov.get(ovKey(x.tk));
      out.push(Object.assign({}, x, { ch, sub: x.place || x.sub || '', img: o ? '/ev-img/c/' + ovKey(x.tk) + '?v=' + o : x.img, imgSrc: o ? 'admin (prepísaný)' : x.imgSrc }));
    }
    return out;
  }

  // ---------- public hero ----------
  const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1);
  const bgOf = (x) => x.img || `/static/ev/${x.cat || 'sport'}.webp?v=${ASSET_V}`;
  function badge(x, en) {
    const now = Date.now(); if (x.s <= now) return '● ' + tx(en, 'NAŽIVO', 'LIVE');
    const m = Math.max(1, Math.round((x.s - now) / 60e3)); const o = tx(en, 'o ', 'in ');
    if (m < 60) return o + m + ' min'; if (m < 24 * 60) return o + Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    const d = Math.round(m / 1440); return o + d + ' ' + (en ? (d === 1 ? 'day' : 'days') : d === 1 ? 'deň' : d < 5 ? 'dni' : 'dní');
  }
  async function render(req, s, where) {
    try {
      const st = await getSettings(), hc = hcfg(st); if (hc.evh_on !== '1') return '';
      const list = await slides(); if (!list.length) return '';
      const en = req.lang === 'en', n = list.length, logo = (ch) => (ctx.tvchLogoSrc ? ctx.tvchLogoSrc(ch) : '/tvlogo/' + ch.id);
      const sl = list.map((x, i) => {
        const on = x.s <= Date.now(), when = `${cap(dayLbl(x.s, en))} · ${hm(x.s)}${x.startOnly ? '' : '–' + hm(x.e)}`;
        return `<article class="evh-s${i ? '' : ' on'}${on ? ' live' : ''}" role="group" aria-roledescription="${esc(tx(en, 'snímka', 'slide'))}" aria-label="${i + 1} / ${n}"${i ? ' aria-hidden="true" inert' : ''} data-s="${Math.round(x.s / 1000)}" data-e="${Math.round(x.e / 1000)}">
<img class="evh-bg" src="${esc(bgOf(x))}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async" width="1280" height="720"><div class="evh-g"></div>
<div class="evh-c"><p class="evh-k"><span class="evh-b" data-l="${esc(tx(en, 'NAŽIVO', 'LIVE'))}" data-o="${esc(tx(en, 'o ', 'in '))}" data-d="${esc(en ? 'day|days|days' : 'deň|dni|dní')}">${esc(badge(x, en))}</span><span>${x.pin ? '📌 ' + esc(tx(en, 'Odporúčame', 'Featured')) : '🔥 ' + esc(tx(en, 'Top udalosť týždňa', 'Top event of the week'))}</span></p>
<h2 class="evh-t">${esc(x.title)}</h2>
<p class="evh-m"><time datetime="${new Date(x.s).toISOString()}">${esc(when)}</time>${x.chName ? `<span class="evh-ch">${x.ch ? `<img src="${esc(logo(x.ch))}" alt="" width="30" height="30" loading="lazy" decoding="async">` : ''}${esc(x.chName)}</span>` : ''}</p>
${x.sub ? `<p class="evh-d">${esc(x.sub)}</p>` : ''}<div class="evh-pr"${on ? '' : ' hidden'}><i></i></div></div></article>`;
      }).join('');
      const nav = n > 1 ? `<button type="button" class="evh-nav evh-prev" aria-label="${esc(tx(en, 'Predchádzajúca udalosť', 'Previous event'))}">‹</button><button type="button" class="evh-nav evh-next" aria-label="${esc(tx(en, 'Ďalšia udalosť', 'Next event'))}">›</button><div class="evh-dots">${list.map((x, i) => `<button type="button" data-i="${i}" aria-label="${esc(x.title)}" aria-current="${i ? 'false' : 'true'}"></button>`).join('')}</div>` : '';
      return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><section class="evh" aria-roledescription="${esc(tx(en, 'karusel', 'carousel'))}" aria-label="${esc(tx(en, 'Top udalosti týždňa v TV', 'Top TV events of the week'))}" data-n="${n}" data-rank="${esc((wk && wk.rank && wk.rank.by) || 'score')}">${sl}${nav}</section><script src="/static/evh.js?v=${ASSET_V}" defer></script>`;
    } catch (e) { console.error('evhero', e.message); return ''; }
  }
  const cardsOffHome = (st) => hcfg(st).evh_on === '1' && hcfg(st).evh_cards_home !== '1';

  // ---------- public: cached / admin images ----------
  app.get('/ev-img/c/:k([uo]-[0-9a-f]{24})', wrap(async (req, res) => {
    const r = (await pool.query('SELECT img FROM ev_imgc WHERE k=$1', [req.params.k])).rows[0]; if (!r) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }); res.send(r.img);
  }));

  // ---------- admin ----------
  const fmt = (ms) => `${cap(dayLbl(ms, false))} ${hm(ms)}`;
  async function adminHtml(req) {
    const st = await getSettings(), hc = hcfg(st); await ensure(); const w = wk || { picks: [], top: [], rank: {}, t: 0 }, list = await slides(), now = Date.now();
    const srcL = { pin: '📌 pin', epg: 'EPG', okt: 'OKTAGON kalendár', 'epg+okt': 'EPG + OKTAGON kalendár' };
    const k2 = (x) => esc(x.tk || '');
    const slide = (x, i) => `<div class="row evadm"><img src="${esc(bgOf(x))}" alt="" width="160" height="90" loading="lazy"><span><b>${i + 1}. ${esc(x.title)}</b><br><span class="hint">${esc(fmt(x.s))}${x.startOnly ? '' : '–' + esc(hm(x.e))} CET · ${esc(x.chName || '—')} · zdroj: ${srcL[x.src] || x.src}${x.pin ? '' : ' · skóre ' + x.score}${x.why ? ' (' + esc(x.why.join(', ')) + ')' : ''}${x.reason ? ' · Gemini: „' + esc(x.reason) + '“' : ''} · obrázok: ${esc(x.imgSrc || '')}</span></span>
<span class="evbtns">${x.pin ? '' : `<form method="post" action="/admin/udalosti/hero/pin">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><button>📌 Pripnúť</button></form><form method="post" action="/admin/udalosti/hero/hide">${hid(req)}<input type="hidden" name="k" value="${k2(x)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť</button></form>`}
<form method="post" action="/admin/udalosti/hero/img" enctype="multipart/form-data">${hid(req)}<input type="hidden" name="tk" value="${k2(x)}"><input type="file" name="image" accept="image/jpeg,image/png,image/webp"><input name="url" maxlength="400" placeholder="https:// obrázok alebo stránka udalosti"><button>🖼 Zmeniť obrázok</button>${x.imgSrc && /prepísaný/.test(x.imgSrc) ? '<label class="ck"><input type="checkbox" name="del" value="1"> zrušiť vlastný obrázok</label>' : ''}</form></span></div>`;
    const okt = w.okt;
    return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><div class="card" id="hero"><h2>🏆 Top udalosť týždňa – hero navrchu webu (${list.length}/${MAXS})</h2>
<p class="hint">Karusel (max ${MAXS}) navrchu domovskej stránky. Poradie: 📌 pripnuté → automatický výber z TV programu na 7 dní (kľúčové slová + šport + naživo + večer, bez záznamov) + oficiálny kalendár OKTAGON MMA${hc.evh_gem === '1' ? ' → Gemini zoradí top 12 (pri chybe ostáva poradie podľa skóre)' : ''}. Prepočet každé ${REFRESH / 3600e3} h.</p>
<p>Vypočítané: <b>${w.t ? esc(fmt(w.t)) + ' CET' : '—'}</b> · poradie: <b>${w.rank && w.rank.by === 'gemini' ? 'Gemini (' + esc(w.rank.model || '') + (w.rank.cached ? ', z cache' : '') + ')' : 'skóre (deterministicky)'}</b>${w.rank && w.rank.err ? ' · <span class="hint">' + esc(w.rank.err) + '</span>' : ''}</p>
<form method="post" action="/admin/udalosti/hero/refresh">${hid(req)}<button>🔄 Prepočítať teraz</button></form>
${list.map(slide).join('') || '<p class="hint">Tento týždeň nie je žiadna udalosť nad hranicou skóre – pripnite ju ručne nižšie.</p>'}
<h3>Ďalší kandidáti týždňa</h3>${(w.top || []).filter((x) => !list.some((y) => y.tk === x.tk)).slice(0, 9).map((x) => `<div class="row"><span><b>${esc(fmt(x.s))}</b> ${esc(x.title)} · <span class="hint">${esc(x.chName)} · skóre ${x.score} · ${esc((x.why || []).join(', '))}</span></span><form method="post" action="/admin/udalosti/hero/pin">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><button>📌</button></form></div>`).join('') || '<p class="hint">—</p>'}
<h3>🥊 OKTAGON MMA (oficiálny kalendár)</h3><p class="hint">${okt ? (okt.ok ? '✅ načítané ' : '⚠ chyba ' + esc(okt.err) + ' · posledné ') + esc(fmt(okt.t)) + ' CET' : 'vypnuté'} · kanál: <b>${esc(hc.evh_okt_ch)}</b> (v EPG zdrojoch nie je – čas sa berie z kalendára; ak EPG nájde „OKTAGON N“ naživo, použije sa EPG)</p>
${((okt && okt.events) || []).slice(0, 6).map((x) => `<div class="row"><span><b>${esc(fmt(x.s))} CET</b> ${esc(prettyOkt(x.title))} · <span class="hint">${esc(x.place)}</span></span></div>`).join('')}
<form method="post" action="/admin/udalosti/hero/settings">${hid(req)}<h3>⚙ Nastavenia hero</h3>
<label class="ck"><input type="checkbox" name="evh_on" value="1"${hc.evh_on === '1' ? ' checked' : ''}> Zobraziť hero „Top udalosť týždňa“ navrchu domovskej stránky</label>
<label class="ck"><input type="checkbox" name="evh_cards_home" value="1"${hc.evh_cards_home === '1' ? ' checked' : ''}> Pod hero zobraziť aj kartičky „Dnes v TV · Top udalosti“ (na stránke Kanály ostávajú)</label>
<label class="ck"><input type="checkbox" name="evh_gem" value="1"${hc.evh_gem === '1' ? ' checked' : ''}> Zoradiť kandidátov cez Gemini (${process.env.GEMINI_API_KEY ? 'kľúč nastavený' : 'GEMINI_API_KEY chýba'})</label>
<label class="ck"><input type="checkbox" name="evh_okt" value="1"${hc.evh_okt === '1' ? ' checked' : ''}> Načítavať kalendár OKTAGON MMA</label>
<label>Kanál pre OKTAGON</label><input name="evh_okt_ch" maxlength="60" value="${esc(hc.evh_okt_ch)}"><button>Uložiť</button></form></div>`;
  }
  const back = (res, m) => E.back(res, m, 'hero');
  admin.post('/udalosti/hero/refresh', needAuth, csrf, wrap(async (req, res) => { side = null; await refresh('force'); back(res, 'ok'); }));
  admin.post('/udalosti/hero/settings', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body, ch = String(b.evh_okt_ch || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || HD.evh_okt_ch;
    await setSettings({ evh_on: b.evh_on ? '1' : '0', evh_cards_home: b.evh_cards_home ? '1' : '0', evh_gem: b.evh_gem ? '1' : '0', evh_okt: b.evh_okt ? '1' : '0', evh_okt_ch: ch });
    await refresh('force'); back(res, 'ok');
  }));
  admin.post('/udalosti/hero/hide', needAuth, csrf, wrap(async (req, res) => {
    const k = String(req.body.k || '').slice(0, 300); if (/^t:/.test(k)) await pool.query('INSERT INTO ev_hide (k,title) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING', [k, E.noUrl(req.body.title, 160)]);
    await refresh(true); back(res, 'hid');
  }));
  admin.post('/udalosti/hero/pin', needAuth, csrf, wrap(async (req, res) => {
    await ensure(); const k = String(req.body.k || ''), x = wk && [...wk.picks, ...wk.top].find((y) => y.k === k); if (!x) return back(res, 'bad');
    let img = null; const ok = x.img && /^\/ev-img\/c\/(u-[0-9a-f]{24})/.exec(x.img);
    if (ok) img = ((await pool.query('SELECT img FROM ev_imgc WHERE k=$1', [ok[1]])).rows[0] || {}).img || null;
    await pool.query('INSERT INTO ev_pin (title,channel_id,channel_txt,s,e,img_url,img,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [C.clip(x.title, 160), x.ch && x.ch.id ? x.ch.id : null, x.ch && x.ch.id ? '' : C.clip(x.chName, 60), new Date(x.s), new Date(x.e), '', img, C.clip(x.place || '', 140)]);
    if (ctx.audit) await ctx.audit(req, 'ev_pin', x.title);
    side = null; E.back(res, 'pin', 'hero');
  }));
  admin.post('/udalosti/hero/img', needAuth, (req, res, next) => E.up(req, res, (e) => (e ? back(res, 'badimg') : next())), csrf, wrap(async (req, res) => {
    const tk = String(req.body.tk || '').slice(0, 300); if (!/^t:/.test(tk)) return back(res, 'bad');
    if (req.body.del === '1') { await pool.query('DELETE FROM ev_imgc WHERE k=$1', [ovKey(tk)]); side = null; return back(res, 'del'); }
    let img = null;
    if (req.file && req.file.size) { try { img = await toWebp(req.file.buffer); } catch { return back(res, 'badimg'); } }
    else if (req.body.url) { try { img = await fetchImage(String(req.body.url).trim().slice(0, 400)); } catch { return back(res, 'badurl'); } }
    else return back(res, 'badimg');
    await pool.query('INSERT INTO ev_imgc (k,src,img) VALUES ($1,$2,$3) ON CONFLICT (k) DO UPDATE SET img=$3, src=$2, at=now()', [ovKey(tk), 'admin', img]);
    if (ctx.audit) await ctx.audit(req, 'ev_img', tk.slice(0, 100));
    side = null; back(res, 'ok');
  }));

  return { init, stale, render, cardsOffHome, adminHtml, refresh, fetchImage, toWebp, _catOf: catOf, _fetchOkt: fetchOkt, _prettyOkt: prettyOkt };
};
module.exports.catOf = catOf; module.exports.prettyOkt = prettyOkt;
