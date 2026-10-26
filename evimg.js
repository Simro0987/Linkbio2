'use strict';
// Automatic background image + short description resolver for the "Top udalosť týždňa" hero (server-side only).
// Chain per event (order per genre in evsources.js): admin upload → official og:image (whitelisted domains) →
// TheSportsDB team fanart (A vs B → split background) → TMDB backdrop (optional key) → Wikipedia lead image →
// Wikimedia Commons (free licences, credit stored) → bundled fallback background (rotating variants).
// Gemini (free tier) identifies the event (optionally with Google Search grounding), verifies every candidate
// (confidence ≥ VERIFY_MIN) and writes the Slovak teaser strictly from fetched facts. Images: ≥1000 px, landscape,
// attention crop, slight darken + blur, webp ≤150 KB in two variants (desktop 2× / mobile), one sharp job at a time.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('./evsources');

const sha = (v) => crypto.createHash('sha1').update(String(v)).digest('hex');
const strip = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const inList = (host, list) => list.some((d) => host === d || host.endsWith('.' + d));
const OFFICIAL_ALL = [...new Set(Object.values(S.OFFICIAL).flat())];
const FREE_LIC = /^(cc0|public domain|pd\b|pd-|cc by(-sa)? \d|cc-by(-sa)?-\d|attribution)/i;
const SPORT_TSDB = { football: 'Soccer', soccer: 'Soccer', 'ice hockey': 'Ice Hockey', hockey: 'Ice Hockey', basketball: 'Basketball', volleyball: 'Volleyball', handball: 'Handball', tennis: 'Tennis', mma: 'Fighting', boxing: 'Fighting', motorsport: 'Motorsport' };
const STOP = new Set(['live', 'prenos', 'priamy', 'naziv', 'nazivo', 'final', 'finale', 'zapas', 'vecer', 'show', 'liga', 'league', 'the', 'and', 'cup', 'pohar', 'sport']);

module.exports = function evimg(o) {
  const { get, pool, kv, clip, tmdbKey, staticDir, models } = o;
  let q = Promise.resolve();
  const job = (fn) => { const p = q.then(fn, fn); q = p.catch(() => {}); return p; };
  const sharp = () => { const s = require('sharp'); s.concurrency(1); s.cache(false); return s; };
  const G = { off: 0, err: '', lastOk: 0, budget: 0, used: 0, model: '' };

  // ---------------- Gemini (models from EVH_GEMINI_MODELS; optional google_search grounding with back-off) ----------------
  async function gem(prompt, opt = {}) {
    const key = String(process.env.GEMINI_API_KEY || '').trim(); if (!key) throw new Error('bez GEMINI_API_KEY');
    const tryG = !!opt.ground && Date.now() > G.off && G.budget > 0;
    let last = '';
    for (const m of models()) {
      for (const g of tryG ? [true, false] : [false]) {
        const gc = { temperature: 0, maxOutputTokens: opt.max || 900 }; if (!g) gc.responseMimeType = 'application/json'; if (/2\.5/.test(m)) gc.thinkingConfig = { thinkingBudget: 0 };
        const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: gc }; if (g) { body.tools = [{ google_search: {} }]; G.budget--; G.used++; }
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(g ? 30e3 : 20e3), body: JSON.stringify(body) });
          if (!r.ok) {
            if (g) { G.off = Date.now() + S.GROUND.offAfterError; G.err = m + ' HTTP ' + r.status + (r.status === 429 ? ' (free tier – grounding kvóta nedostupná/vyčerpaná)' : ''); continue; }
            last += (last ? '; ' : '') + m + ' HTTP ' + r.status; break;
          }
          const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('bez JSON');
          const out = JSON.parse(t.slice(a, b + 1));
          if (g) { G.lastOk = Date.now(); G.err = ''; G.model = m; }
          return { o: out, model: m, grounded: g, web: g ? ((j.candidates?.[0]?.groundingMetadata?.groundingChunks) || []).map((c) => c.web && c.web.title).filter(Boolean).slice(0, 6) : [] };
        } catch (e) {
          const msg = e.name === 'TimeoutError' ? 'timeout' : (e.message || e.name).slice(0, 60);
          if (g) { G.err = m + ' ' + msg; continue; }
          last += (last ? '; ' : '') + m + ' ' + msg; break;
        }
      }
    }
    throw new Error(clip(last || 'chyba', 200));
  }
  const beginRefresh = () => { G.budget = S.GROUND.maxPerRefresh; };
  const groundStatus = () => ({ on: Date.now() > G.off, err: G.err, lastOk: G.lastOk, used: G.used, model: G.model });

  // ---------------- helpers ----------------
  const okUrl = (u, list) => { try { const x = new URL(u); return x.protocol === 'https:' && !inList(x.hostname, S.BLOCKED) && (!list || inList(x.hostname, list)); } catch { return false; } };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const yearOf = (ms) => new Date(ms).getFullYear();
  const dateTxt = (ms) => new Date(ms).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  async function json(url, extra) { const r = await get(url, 'application/json', 3e6, extra); return JSON.parse(r.buf.toString('utf8')); }
  // official / broadcaster page → og:image + title + description
  async function page(url) {
    const r = await get(url, 'text/html', 1.5e6, { __head: 1 });
    const h = r.buf.toString('utf8', 0, Math.min(r.buf.length, 1.5e6));
    const meta = (names) => { for (const n of names) { const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i'), re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i'); const m = re1.exec(h) || re2.exec(h); if (m && m[1]) return strip(m[1]); } return ''; };
    let img = meta(['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']); if (img) { try { img = new URL(img.replace(/&amp;/g, '&'), r.url).href; } catch { img = ''; } }
    const t = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(h);
    return { url: r.url, img: /^https:\/\//.test(img) ? img : '', w: +meta(['og:image:width']) || 0, h: +meta(['og:image:height']) || 0, title: clip(meta(['og:title', 'twitter:title']) || strip(t ? t[1] : ''), 200), desc: clip(meta(['og:description', 'description', 'twitter:description']), 400) };
  }
  async function commonsInfo(titles) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiextmetadatafilter=LicenseShortName|Artist|ImageDescription|Credit|Categories&iiurlwidth=1920&titles=' + encodeURIComponent(titles.join('|'));
    const j = await json(u); return Object.values((j.query && j.query.pages) || {});
  }
  function commonsCand(p, srcName, extraText) {
    const i = p.imageinfo && p.imageinfo[0]; if (!i) return null; const m = i.extmetadata || {}, lic = strip(m.LicenseShortName && m.LicenseShortName.value);
    if (!FREE_LIC.test(lic) || !/jpeg|png|webp/.test(i.mime || '') || i.width < S.MIN_W || i.width / i.height < S.MIN_RATIO) return null;
    const artist = clip(strip(m.Artist && m.Artist.value), 60) || 'neznámy autor';
    return { src: srcName, img: i.thumburl || i.url, w: i.width, h: i.height, page: i.descriptionurl || '', credit: `Foto: ${artist} · ${lic} · Wikimedia Commons`,
      text: clip(`${extraText ? extraText + ' · ' : ''}file "${p.title.replace(/^File:/, '')}" – ${strip(m.ImageDescription && m.ImageDescription.value)} [categories: ${strip(m.Categories && m.Categories.value)}]`, 420) };
  }

  // ---------------- 1) research: identify the event (Gemini, optionally grounded) ----------------
  function guessGenre(x, cat) {
    if (/^(film)$/.test(cat) || x.kind === 'film') return 'film'; if (cat === 'series' || x.kind === 'series') return 'series';
    if (cat === 'reality') return 'reality'; if (cat === 'news') return 'news'; if (cat === 'documentary' || x.kind === 'doc') return 'documentary'; if (cat === 'newyear') return 'newyear';
    if (cat === 'awards') return 'awards'; if (cat === 'show') return /koncert|concert/i.test(x.title) ? 'concert' : 'show'; return 'sport';
  }
  async function research(x, cat, log) {
    const g0 = guessGenre(x, cat);
    const ev = { title: x.title, subtitle: x.sub || '', channel: x.chName, date: dateTxt(x.s), epg_text: clip(x.descr || '', 220), place: x.place || '', likely_genre: g0, channel_sites: S.chanSites(x.chName) };
    const prompt = S.PROMPTS.research + '\n\nSource guide for this genre: ' + (S.GUIDE[g0] || '') + '\nOther genres: ' + Object.entries(S.GUIDE).filter(([k]) => k !== g0).map(([k, v]) => k + ': ' + v.split(':').slice(1).join(':').trim().slice(0, 140)).join(' | ') + '\n\nEvent: ' + JSON.stringify(ev);
    let r = null;
    try {
      const g = await gem(prompt, { ground: true, max: 700 }); r = g.o;
      log.push(`identifikácia: Gemini ${g.model}${g.grounded ? ' + Google Search grounding' + (g.web.length ? ' (' + g.web.slice(0, 3).join(', ') + ')' : '') : ' (bez groundingu' + (G.err ? ': ' + G.err : '') + ')'}`);
    } catch (e) { log.push('identifikácia: Gemini nedostupné (' + clip(e.message, 80) + ') – len heuristika'); }
    r = r && typeof r === 'object' ? r : {};
    const arr = (v, n, l) => (Array.isArray(v) ? v : []).map((s) => clip(strip(s), l)).filter(Boolean).slice(0, n);
    const out = {
      genre: S.GENRES[r.genre] ? r.genre : g0, sport: clip(norm(r.sport), 30), teams: arr(r.teams_en, 2, 60), people: arr(r.people, 3, 60), event_en: clip(strip(r.event_en), 120),
      urls: arr(r.official_urls, 4, 400).filter((u) => okUrl(u, [...OFFICIAL_ALL, ...S.BROADCASTER])),
      wiki: {}, commons: clip(strip(r.commons_query), 80), tmdb: r.tmdb && typeof r.tmdb === 'object' ? { type: /^(movie|tv)$/.test(r.tmdb.type) ? r.tmdb.type : '', query: clip(strip(r.tmdb.query), 100), year: String(r.tmdb.year || '').replace(/\D/g, '').slice(0, 4) } : { type: '', query: '', year: '' },
    };
    for (const l of ['sk', 'cs', 'en']) { const t = clip(strip(r.wiki && r.wiki[l]).replace(/^https?:\/\/[^/]+\/wiki\//, '').replace(/_/g, ' '), 120); if (t) out.wiki[l] = decodeURIComponent(t); }
    const dropped = arr(r.official_urls, 4, 400).length - out.urls.length; if (dropped > 0) log.push(`${dropped}× URL mimo whitelistu zahodená`);
    // heuristics when Gemini is silent: "A – B" / "A vs. B" → teams
    if (!out.teams.length && out.genre === 'sport') { const m = /^(.{3,40}?)\s+(?:[-–]|vs\.?|v\.)\s+(.{3,40}?)(?:\s*[,(:|]|$)/i.exec(x.title.replace(/^.*?:\s*/, '')); if (m) out.teams = [m[1].trim(), m[2].trim()]; }
    return out;
  }

  // ---------------- 2) candidates per source ----------------
  async function srcOfficial(R, list, name, log) {
    const out = [], facts = [];
    for (const u of R.urls.filter((u) => okUrl(u, list)).slice(0, 2)) {
      try { const p = await page(u); const ctxt = `${host(p.url)} page "${p.title}" – ${p.desc}`;
        if (p.desc) facts.push({ src: name, lang: '', text: clip(p.title + ': ' + p.desc, 400), ctx: ctxt });
        if (p.img && okUrl(p.img)) out.push({ src: name, img: p.img, w: p.w, h: p.h, page: p.url, credit: '© ' + host(p.url), text: clip('og:image of ' + ctxt, 420) }); else log.push(`${name} ${host(u)}: bez og:image`);
      } catch (e) { log.push(`${name} ${host(u)}: ${clip(e.message, 50)}`); }
    }
    return { out, facts };
  }
  async function tsdbTeam(name, sport) {
    const j = await json('https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=' + encodeURIComponent(name));
    const want = SPORT_TSDB[sport] || '', n = norm(name).replace(/[^a-z0-9]+/g, ' ').trim();
    const l = (j.teams || []).filter((t) => !want || t.strSport === want);
    return l.find((t) => norm(t.strTeam).replace(/[^a-z0-9]+/g, ' ').trim() === n) || l.find((t) => norm(t.strTeam + ' ' + (t.strTeamAlternate || '')).includes(n)) || l[0] || null;
  }
  async function srcTsdb(R, log) {
    if (R.genre !== 'sport' || !R.teams.length) return { out: [], facts: [] };
    const teams = [];
    for (const t of R.teams) { try { const x = await tsdbTeam(t, R.sport); teams.push(x); log.push(`TheSportsDB „${t}“: ${x ? x.strTeam + ' (' + x.strSport + ', ' + (x.strLeague || '') + ')' + (x.strFanart1 ? ' fanart' : ' bez fanart') : 'nenájdené'}`); } catch (e) { teams.push(null); log.push(`TheSportsDB „${t}“: ${clip(e.message, 40)}`); } }
    const ok = teams.filter(Boolean), fa = (t) => t && [t.strFanart1, t.strFanart2, t.strFanart3, t.strFanart4].filter((u) => u && okUrl(u))[0], bd = (t) => t && t.strBadge && okUrl(t.strBadge) ? t.strBadge : '';
    const out = [], facts = ok.map((t) => ({ src: 'thesportsdb', lang: 'en', text: clip(`${t.strTeam} (${t.strSport}, ${t.strLeague || ''}${t.strCountry ? ', ' + t.strCountry : ''}${t.strStadium ? ', štadión/hala ' + t.strStadium : ''}${t.intFormedYear ? ', založený ' + t.intFormedYear : ''})`, 300), ctx: 'TheSportsDB team ' + t.strTeam }));
    const names = ok.map((t) => t.strTeam).join(' & '), lg = ok.map((t) => t.strLeague).filter(Boolean)[0] || '';
    if (teams.length === 2 && fa(teams[0]) && fa(teams[1])) out.push({ src: 'thesportsdb', kind: 'split', parts: [fa(teams[0]), fa(teams[1])], img: fa(teams[0]) + '|' + fa(teams[1]), credit: 'TheSportsDB', page: 'https://www.thesportsdb.com', text: `TheSportsDB team fan-art of both playing teams: ${names} (${lg})` });
    if (teams.length === 2 && bd(teams[0]) && bd(teams[1])) out.push({ src: 'thesportsdb', kind: 'badges', parts: [bd(teams[0]), bd(teams[1])], bg: fa(teams[0]) || fa(teams[1]) || '', img: bd(teams[0]) + '|' + bd(teams[1]), credit: 'TheSportsDB', page: 'https://www.thesportsdb.com', text: `TheSportsDB club badges of both playing teams: ${names} (${lg})` });
    for (const t of ok) if (fa(t)) out.push({ src: 'thesportsdb', img: fa(t), credit: 'TheSportsDB', page: 'https://www.thesportsdb.com', text: `TheSportsDB team fan-art of ${t.strTeam} (${t.strSport}, ${t.strLeague || ''})` });
    return { out, facts };
  }
  async function srcWiki(x, R, log) {
    const out = [], facts = [], titles = Object.assign({}, R.wiki);
    if (!Object.keys(titles).length) {
      for (const [l, qq] of [['sk', x.title], ['en', R.event_en]]) { if (!qq) continue; try { const j = await json(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(qq)}`); const h = j.query && j.query.search && j.query.search[0]; if (h) titles[l] = h.title; } catch {} }
    }
    const files = [];
    for (const l of ['sk', 'cs', 'en']) {
      const t = titles[l]; if (!t) continue;
      try {
        const j = await json(`https://${l}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`);
        if (j.type === 'disambiguation' || !j.extract) { log.push(`Wikipedia ${l} „${t}“: rozcestník/prázdne`); continue; }
        const ctxt = `Wikipedia ${l} article "${j.title}" (${strip(j.description)}): ${clip(j.extract, 300)}`;
        facts.push({ src: 'wikipedia ' + l, lang: l, text: clip(j.extract, 500), ctx: ctxt });
        const im = j.originalimage && j.originalimage.source; const m = im && /upload\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/.exec(im);
        if (m) files.push({ f: 'File:' + decodeURIComponent(m[1]), ctx: `lead image of Wikipedia ${l} article "${j.title}"` }); else if (im) log.push(`Wikipedia ${l}: hlavný obrázok nie je voľná licencia (lokálny súbor)`);
      } catch (e) { log.push(`Wikipedia ${l} „${t}“: ${clip(e.message, 40)}`); }
    }
    const uniq = [...new Map(files.map((f) => [f.f, f])).values()].slice(0, 3);
    if (uniq.length) { try { for (const p of await commonsInfo(uniq.map((f) => f.f))) { const f = uniq.find((z) => norm(z.f.replace(/_/g, ' ')) === norm(p.title)); const c = commonsCand(p, 'wikipedia', f ? f.ctx : 'Wikipedia lead image'); if (c) out.push(c); else log.push(`Wikipedia obrázok ${p.title}: licencia/rozmer nevyhovuje`); } } catch (e) { log.push('Commons info: ' + clip(e.message, 40)); } }
    return { out, facts };
  }
  async function srcCommons(x, R, log) {
    const qq = R.commons || R.event_en; if (!qq) return { out: [], facts: [] };
    try {
      const j = await json('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=' + encodeURIComponent(qq + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiextmetadatafilter=LicenseShortName|Artist|ImageDescription|Categories&iiurlwidth=1920');
      const l = Object.values((j.query && j.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).map((p) => commonsCand(p, 'commons', 'Commons search "' + qq + '"')).filter(Boolean).slice(0, 4);
      log.push(`Commons „${qq}“: ${l.length} vyhovujúcich (voľná licencia, ≥${S.MIN_W}px, na šírku)`);
      return { out: l, facts: [] };
    } catch (e) { log.push('Commons: ' + clip(e.message, 40)); return { out: [], facts: [] }; }
  }
  async function srcTmdb(x, R, log) {
    const key = tmdbKey(); if (!key) return { out: [], facts: [] };
    if (!['film', 'series', 'documentary', 'reality', 'show'].includes(R.genre)) return { out: [], facts: [] };
    const bearer = /^eyJ/.test(key), auth = (u) => (bearer ? u : u + (u.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key)), hd = bearer ? { authorization: 'Bearer ' + key } : null;
    try {
      const type = R.tmdb.type || (R.genre === 'film' ? 'movie' : R.genre === 'series' ? 'tv' : 'multi'), qq = R.tmdb.query || R.event_en || x.title;
      const j = await json(auth(`https://api.themoviedb.org/3/search/${type}?language=sk-SK&query=${encodeURIComponent(qq)}${R.tmdb.year ? (type === 'tv' ? '&first_air_date_year=' : '&year=') + R.tmdb.year : ''}`), hd);
      const it = (j.results || []).find((r) => r.media_type !== 'person') || null; if (!it) { log.push('TMDB: nenájdené'); return { out: [], facts: [] }; }
      const mt = it.media_type || (type === 'multi' ? 'movie' : type), nm = it.title || it.name || '', yr = String(it.release_date || it.first_air_date || '').slice(0, 4);
      const facts = [];
      let ov = it.overview, lang = 'sk';
      if (!ov) for (const l of ['cs-CZ', 'en-US']) { try { const d = await json(auth(`https://api.themoviedb.org/3/${mt}/${it.id}?language=${l}`), hd); if (d.overview) { ov = d.overview; lang = l.slice(0, 2); break; } } catch {} }
      if (ov) facts.push({ src: 'tmdb ' + lang, lang, text: clip(`${nm} (${yr}): ${ov}`, 500), ctx: `TMDB ${mt} "${nm}" (${yr}): ${clip(ov, 200)}` });
      const out = it.backdrop_path ? [{ src: 'tmdb', img: 'https://image.tmdb.org/t/p/w1280' + it.backdrop_path, w: 1280, h: 720, credit: 'TMDB', page: `https://www.themoviedb.org/${mt}/${it.id}`, text: `TMDB backdrop of ${mt} "${nm}" (${yr})` }] : [];
      log.push(`TMDB: „${nm}“ (${yr})${out.length ? ' backdrop' : ''}${ov ? ' + popis ' + lang : ''}`);
      return { out, facts };
    } catch (e) { log.push('TMDB: ' + clip(e.message, 40)); return { out: [], facts: [] }; }
  }

  // ---------------- 3) verification (Gemini confidence; token heuristic when Gemini is unavailable) ----------------
  function heur(x, R, c) {
    const toks = [...new Set(norm(x.title + ' ' + R.teams.join(' ') + ' ' + R.people.join(' ')).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t)))];
    const tx = norm(c.text); if (!toks.length) return 0.3;
    const hit = toks.filter((t) => tx.includes(t)).length / toks.length, yrs = (tx.match(/\b20\d\d\b/g) || []).map(Number), y = yearOf(x.s);
    if (yrs.length && !yrs.some((v) => Math.abs(v - y) <= 1)) return Math.min(0.3, hit);
    return c.src === 'thesportsdb' ? (hit > 0 ? 0.8 : 0.2) : Math.min(0.95, hit * 1.1);
  }
  async function verify(x, R, cands, log) {
    if (!cands.length) return;
    const ev = { title: x.title, subtitle: x.sub || '', channel: x.chName, date: dateTxt(x.s), genre: R.genre, teams: R.teams, people: R.people, event_en: R.event_en };
    try {
      const g = await gem(S.PROMPTS.verify + '\n\nEvent: ' + JSON.stringify(ev) + '\n\nCandidates:\n' + JSON.stringify(cands.map((c) => ({ id: c.id, source: c.src, about: c.text }))), { max: 900 });
      const miss = cands.filter((c) => g.o[c.id] == null).length; if (miss) log.push(`overenie: Gemini nevrátilo ${miss}/${cands.length} hodnotení`);
      for (const c of cands) { const v = Number(g.o[c.id]); c.conf = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; c.by = 'gemini'; }
    } catch (e) { log.push('overenie: Gemini nedostupné – heuristika (' + clip(e.message, 50) + ')'); for (const c of cands) { c.conf = heur(x, R, c); c.by = 'heur'; } }
  }

  // ---------------- 4) image processing (queue of 1) ----------------
  async function dl(u, max) { const r = await get(u, 'image/avif,image/webp,image/*', max || 8e6); if (!/^image\//.test(r.type) && r.type.trim()) throw new Error('nie je obrázok'); return r.buf; }
  async function enc(buf) { let qq = 72, out; do { out = await sharp()(buf).webp({ quality: qq, effort: 4 }).toBuffer(); qq -= 8; } while (out.length > S.MAX_BYTES && qq >= 32); return out; }
  const look = (img) => img.modulate({ brightness: 0.9 }).blur(0.5);
  async function variants(buf) {
    return job(async () => {
      const meta = await sharp()(buf, { limitInputPixels: 40e6 }).metadata();
      const out = { w0: meta.width, h0: meta.height };
      for (const [k, [w, h]] of Object.entries(S.VARIANTS)) out[k] = await enc(await look(sharp()(buf, { limitInputPixels: 40e6 }).rotate().resize(w, h, { fit: 'cover', position: 'attention' })).png().toBuffer());
      return out;
    });
  }
  async function composite(c) {
    const bufs = []; for (const u of c.parts) bufs.push(await dl(u, 4e6));
    let bg = null; if (c.kind === 'badges') { try { bg = c.bg ? await dl(c.bg, 6e6) : null; } catch {} if (!bg) bg = fs.readFileSync(path.join(staticDir, 'ev', (c.cat || 'stadium') + '-1.webp')); }
    return job(async () => {
      const sh = sharp(), out = {};
      if (c.kind === 'split') for (const b of bufs) { const m = await sh(b).metadata(); if (m.width < 600) throw new Error('fan-art príliš malý'); }
      for (const [k, [W, H]] of Object.entries(S.VARIANTS)) {
        let base;
        if (c.kind === 'split') {
          const hw = Math.round(W / 2), L = await sh(bufs[0]).rotate().resize(hw, H, { fit: 'cover', position: 'attention' }).toBuffer(), Rr = await sh(bufs[1]).rotate().resize(W - hw, H, { fit: 'cover', position: 'attention' }).toBuffer();
          const seam = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0.40" stop-color="#07070a" stop-opacity="0"/><stop offset="0.5" stop-color="#07070a" stop-opacity="0.9"/><stop offset="0.60" stop-color="#07070a" stop-opacity="0"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`);
          base = await sh({ create: { width: W, height: H, channels: 3, background: '#07070a' } }).composite([{ input: L, left: 0, top: 0 }, { input: Rr, left: hw, top: 0 }, { input: seam, left: 0, top: 0 }]).png().toBuffer();
        } else {
          const bs = k === 'm' ? 220 : 300, top = k === 'm' ? 70 : 150, xs = k === 'm' ? [130, W - 130 - bs] : [W - 2 * bs - 220, W - bs - 110];
          const bgb = await sh(bg).rotate().resize(W, H, { fit: 'cover', position: 'attention' }).modulate({ brightness: 0.5 }).blur(10).toBuffer();
          const bd = []; for (const b of bufs) bd.push(await sh(b).resize(bs, bs, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
          base = await sh(bgb).composite([{ input: bd[0], left: xs[0], top }, { input: bd[1], left: xs[1], top }]).png().toBuffer();
        }
        out[k] = await enc(await look(sh(base)).png().toBuffer());
      }
      return out;
    });
  }
  async function store(tk, c, v) {
    const k = 'r-' + sha(tk + '|' + c.img).slice(0, 24);
    const r = (await pool.query(`INSERT INTO ev_imgc (k,src,img,img_m,credit,meta) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (k) DO UPDATE SET img=$3, img_m=$4, credit=$5, meta=$6, src=$2, at=now() RETURNING extract(epoch from at)::int AS v`,
      [k, clip(c.img, 400), v.w, v.m, clip(c.credit || '', 160), JSON.stringify({ src: c.src, page: clip(c.page || '', 300), conf: c.conf })])).rows[0];
    return { k, v: r.v };
  }

  // ---------------- resolve one event: research → candidates → verify → best image + verified facts ----------------
  async function resolve(x, cat, skip) {
    const log = [], t0 = Date.now();
    const R = await research(x, cat, log);
    const order = S.IMG_ORDER[R.genre] || S.IMG_ORDER.sport;
    const res = {};
    for (const s of new Set([...order, 'wikipedia'])) {
      try {
        if (s === 'official') res[s] = await srcOfficial(R, OFFICIAL_ALL, 'official', log);
        else if (s === 'broadcaster') res[s] = await srcOfficial(R, S.BROADCASTER, 'broadcaster', log);
        else if (s === 'thesportsdb') res[s] = await srcTsdb(R, log);
        else if (s === 'wikipedia') res[s] = await srcWiki(x, R, log);
        else if (s === 'commons') res[s] = await srcCommons(x, R, log);
        else if (s === 'tmdb') res[s] = await srcTmdb(x, R, log);
      } catch (e) { log.push(s + ': ' + clip(e.message, 50)); }
      if (Date.now() - t0 > 60e3) { log.push('časový limit zdrojov'); break; }
    }
    const imgs = [], facts = [];
    for (const s of order) for (const c of (res[s] && res[s].out) || []) if (!imgs.some((z) => z.img === c.img)) imgs.push(Object.assign(c, { cat }));
    for (const s of Object.keys(res)) for (const f of res[s].facts || []) facts.push(f);
    imgs.splice(8); facts.splice(6);
    const cands = [...imgs.map((c, i) => Object.assign(c, { id: 'i' + (i + 1) })), ...facts.map((f, i) => ({ id: 't' + (i + 1), src: f.src, text: f.ctx, f }))];
    await verify(x, R, cands, log);
    const okF = cands.filter((c) => c.f && c.conf >= S.VERIFY_MIN).map((c) => Object.assign({}, c.f, { conf: c.conf }));
    for (const c of cands.filter((c) => c.f && c.conf < S.VERIFY_MIN)) log.push(`text ${c.src}: zamietnutý (istota ${c.conf.toFixed(2)})`);
    const okI = imgs.filter((c) => c.conf >= S.VERIFY_MIN);
    for (const c of imgs.filter((c) => c.conf < S.VERIFY_MIN)) log.push(`obrázok ${c.src}${c.kind ? '/' + c.kind : ''}: zamietnutý (istota ${c.conf.toFixed(2)})`);
    let pick = null, n = 0;
    for (const c of okI) {
      if (n < skip) { n++; log.push(`obrázok ${c.src}: preskočený („Nájsť iný obrázok“)`); continue; }
      try {
        if (!c.kind && c.w && c.w < S.MIN_W) throw new Error(`malý (${c.w}px)`);
        const v = c.kind ? await composite(c) : await (async () => { const b = await dl(c.img); return variants(b); })();
        if (!c.kind && (v.w0 < S.MIN_W || v.w0 / v.h0 < S.MIN_RATIO)) throw new Error(`${v.w0}×${v.h0} – malý alebo nie na šírku`);
        const st = await store(x.tk, c, v);
        pick = { k: st.k, v: st.v, src: c.src + (c.kind ? '/' + c.kind : ''), credit: c.credit || '', page: c.page || '', conf: c.conf, by: c.by, kb: [Math.round(v.w.length / 1024), Math.round(v.m.length / 1024)] };
        log.push(`✅ obrázok: ${pick.src} (istota ${c.conf.toFixed(2)}, ${c.by}; webp ${pick.kb[0]} KB / mobil ${pick.kb[1]} KB)`);
        break;
      } catch (e) { log.push(`obrázok ${c.src}: ${clip(e.message, 60)}`); n++; }
    }
    if (!pick) log.push(`➡ záložné pozadie (kategória ${cat})`);
    return { t: Date.now(), skip, genre: R.genre, img: pick, facts: okF, log: log.map((l) => clip(l, 220)).slice(0, 40), fbOff: pick ? 0 : Math.max(0, skip - okI.length) };
  }

  // ---------------- descriptions: Slovak teaser from verified facts only ----------------
  async function describe(items, log) {
    const withF = items.filter((it) => it.facts.length);
    const out = {};
    if (!withF.length) return out;
    const list = withF.map((it) => ({ id: it.id, event: it.title, genre: it.genre, facts: it.facts.map((f) => f.text) }));
    try {
      const g = await gem(S.PROMPTS.teaser + '\n\n' + JSON.stringify(list), { max: 900 });
      for (const it of withF) { const v = clip(strip(g.o[it.id] || '').replace(/https?:\/\/\S+/g, ''), 210); out[it.id] = { d: v, src: it.facts.map((f) => f.src).filter((v2, i, a) => a.indexOf(v2) === i).join(' + ') + ' → Gemini ' + g.model }; }
    } catch (e) {
      log.push('popisy: Gemini nedostupné (' + clip(e.message, 60) + ') – použitý text zo zdroja');
      for (const it of withF) { const f = it.facts.find((z) => z.src === 'epg' || /^(sk|cs)$/.test(z.lang)); if (!f) continue; let t = f.text.replace(/^[^:]{0,80}:\s/, ''); if (t.length > 200) { const cut = t.slice(0, 200); t = cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, 120)).trim(); if (!/[.!?]$/.test(t)) t += '…'; } out[it.id] = { d: t, src: f.src }; }
    }
    return out;
  }

  return { resolve, describe, gem, beginRefresh, groundStatus, variants, sha };
};
