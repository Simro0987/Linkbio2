'use strict';
// "Program podľa žánru" for the Kanály page: one panel with genre tabs + day tabs, lazy-loaded per genre/day via /api/epg/guide.
// Reads only stored schedule metadata (epg_prog); days 3+ are slim rows (no description) written by the EPG refresh.
const C = require('./epgcore');
const { tx } = require('./uitext');

const GENRES = [
  ['sport', '⚽', 'Šport', 'Sport'], ['film', '🎬', 'Filmy', 'Movies'], ['series', '📺', 'Seriály', 'Series'], ['show', '🎙', 'Relácie', 'Shows'],
  ['doc', '🌍', 'Dokumenty', 'Documentaries'], ['kids', '🧸', 'Deti', 'Kids'], ['news', '📰', 'Správy', 'News'], ['music', '🎵', 'Hudba', 'Music'],
];
const GL = new Map(GENRES.map((g) => [g[0], g]));
const MAXL = 400; // per genre/day and group (SK/CZ, other)
// channel type fallback (name + catalogue category) when a programme has no usable EPG category
const CHT = [
  ['news', /\bnews\b|\bta3\b|čt ?24|ct ?24|tn live|joj news|\bcnn\b|bbc world|euronews|sky news|al jazeera|france 24|\bdw\b|tagesschau|n-tv|welt\b|rossiya 24|россия 24|\b24\b/i],
  ['kids', /kids|junior|disney|nick|cartoon|jojko|duck ?tv|minimax|baby|boomerang|\brik\b|déčko|decko|ráčik|racik|smart kids|detsk|dětsk|deti|děti|gulli|kika|super ?rtl|toggo|babytv|da vinci/i],
  ['music', /music|hudb|\bmtv\b|óčko|ocko|\bvh1\b|hits\b|deluxe|šláger|slagr|rebel|retro\b|mezzo|stingray|clubbing|melody|power tv|4fun/i],
  ['sport', /sport|šport|arena|eurosport|golf|fight|nova sport|premier sport|dazn|sky sport|\bespn|motor|hunting|fishing|red bull/i],
  ['film', /filmbox|cinemax|\bhbo|cinema\b|\bkino\b/i], // film channels whose names also contain e.g. "crime"
  ['doc', /doku|docu|nature|history|histor|discovery|planete|national geographic|nat ?geo|animal|explore|travel|crime\b|investigation|viasat (explore|history|nature)|spektrum|science|\bid\b|love nature|dokument/i],
  ['film', /film|cinema|cinemax|\bhbo|\bamc\b|\bkino\b|movie|filmbox|epic drama|horor|\baxn\b|paramount|\bmax\b|nova cinema|joj cinema|prima max|cs film|kinosvet|kino barrandov|\bfx\b|star\b|warner|universal|sony/i],
];
// placeholders / shopping / station idents that are not real programmes
const GJUNK = /media ?shop|nachtprogramm|nočný program|noční program|telesklep|telenákup|infomercial|tele ?market|závěr vysílání|záver vysielania|ukončenie vysielania|zveme na|program neposkytuje|bez programu|nemá program|program nie je k dispozícii|není k dispozici|end of transmission|off ?air|sendeschluss|close ?down|^\s*(pause|loop|info|promo|trailer|reklama|upoutávky)\s*$/i;
const SPORT_S = /(?<![\p{L}\p{N}])(premier league|pro league|bundesliga|serie a|la liga|ligue 1|champions league|europa league|nfl|nba|nhl|ufc|formula 1|motogp|tipsport liga|extraliga)(?![\p{L}\p{N}])/iu; // strong: overrides a feed category
const SPORT_T = /(?<![\p{L}\p{N}])(league|liga|ligue|bundesliga|serie a|cup|pohár|championship|šampionát|mistrovství|majstrovstvá|grand prix|ufc|wrestling|boxing|zápas|play-?off|nfl|nba|nhl|mlb|atp|wta|formula 1|f1|motogp)(?![\p{L}\p{N}])/iu;
const NEWS_T = /^(správy|zprávy|udalosti|události|televízne noviny|televizní noviny|noviny|krimi|reflex(ia)?|interview|news|journal|tagesschau|híradó|wiadomości|fakty|ranné správy|události v regionech|newsroom|90 ?minút|horizont|týždeň|téma dňa)\b/i;

module.exports = function guide(ctx, h) {
  const { app, admin, pool, esc, hid, csrf, needAuth, wrap, getSettings, setSettings } = ctx;
  const { cfg, visibleMapped, skcz, dayStart, dayLbl, jsonOut, scoreOf, topBoost, posterKey, posterInfo, posterMap, posterOne, tnorm, JUNK, ADULT, back, MS } = h;
  Object.assign(MS, { gok: 'Uložené. Zmena počtu dní sa prejaví po najbližšej obnove programu.' });
  const on = (c) => c.epg_on === '1' && c.guide_on === '1';
  const enabled = (c) => { const s = new Set(String(c.guide_genres || '').split(',')); return GENRES.map((g) => g[0]).filter((g) => s.has(g)); };
  const ndays = (c) => Math.max(1, Math.min(7, parseInt(c.guide_days, 10) || 7));
  let cache = new Map(), avail = null; const drop = () => { cache = new Map(); avail = null; };

  const chType = (ch) => { const t = ch.name + ' ' + ch.category; for (const [g, r] of CHT) if (r.test(t)) return g; return /filmy a seri/i.test(ch.category) ? 'film' : ''; };
  // genre from EPG category (already classified at import, re-checked with the current rules) + title keywords, fallback by channel type
  function genreOf(p, ch, ct, dur) {
    if (p.kind === 'adult' || ADULT.test(p.cat)) return '';
    const cg = C.classify(p.cat, p.title);
    let g = cg || p.kind || '';
    if (g !== 'news' && g !== 'sport' && (cg ? SPORT_S : SPORT_T).test(p.title)) g = 'sport'; // feeds mislabel sport ("Saudi Pro League" as Komédie)
    if (g === 'film' && (dur < 65 || /\s[IVXL]+\.$/.test(p.title) || /\b(epiz[óo]da|díl|diel|časť|část|ep\.)\s*\d|\(\d+\/\d+\)/i.test(p.sub || ''))) g = 'series'; // "Horná Dolná VI." = season
    if (!g && NEWS_T.test(p.title)) g = 'news';
    if (!g && SPORT_T.test(p.title)) g = 'sport';
    if (ct === 'kids' && g !== 'news') return 'kids';
    if (ct === 'doc' && (g === 'film' || g === '' || g === 'series')) return 'doc';
    if (ct === 'music' && (g === '' || g === 'show')) return 'music';
    if (ct === 'news' && (g === '' || g === 'show')) return 'news';
    if (!g) g = ct === 'film' ? (dur >= 70 ? 'film' : 'series') : ct === 'sport' ? 'sport' : '';
    return g;
  }
  const generic = (x, now) => { const hr = h.localHour(x.s); let sc = 0; if (hr >= 19.5 && hr < 22.75) sc += 18; else if (hr >= 17 && hr < 19.5) sc += 6; if (x.fl.includes('p') && !x.fl.includes('r')) sc += 12; if (x.fl.includes('r')) sc -= 14; if (x.sk) sc += 8; if (x.s < now) sc -= 6; return sc; };
  const bounds = (d) => { const now = Date.now(), ds0 = dayStart(now), a = d ? dayStart(ds0 + d * 86400e3 + 6 * 3600e3) : ds0; return { now, a, b: dayStart(a + 30 * 3600e3) }; };

  async function days(c) {
    if (avail && Date.now() - avail.t < 300e3) return avail.d;
    const vm = (await visibleMapped()).filter((r) => !r.sh); const ids = [...new Set(vm.map((r) => r.epg))], n = ndays(c), out = [];
    if (ids.length) {
      const edges = []; for (let d = 0; d <= n; d++) edges.push(new Date(d === n ? bounds(d - 1).b : bounds(d).a));
      const q = await pool.query(`SELECT width_bucket(s, $2::timestamptz[]) AS k, count(*)::int AS n FROM epg_prog WHERE epg_id = ANY($1) AND s >= $3 AND s < $4 GROUP BY 1`, [ids, edges, edges[0], edges[n]]);
      const cnt = new Map(q.rows.map((r) => [r.k, r.n])); const base = cnt.get(1) || 0;
      for (let d = 0; d < n; d++) if ((cnt.get(d + 1) || 0) >= Math.max(150, base * 0.05)) out.push(d); // days 4–7 come mostly from the official SK/CZ schedules (fewer channels)
    }
    if (!out.includes(0)) out.unshift(0);
    avail = { t: Date.now(), d: out }; return out;
  }
  let pBusy = false;
  function postersLater(items) {
    if (pBusy || !items.length) return; pBusy = true;
    setTimeout(async () => { try { for (const x of items.slice(0, 40)) if (await posterOne(x)) await new Promise((ok) => setTimeout(ok, 400)); cache = new Map(); } catch (e) { console.error('EPG guide posters', e.message); } finally { pBusy = false; } }, 3000).unref();
  }
  async function dayData(c, d) {
    const hit = cache.get(d); if (hit && Date.now() - hit.t < 300e3) return hit.d;
    const { now, a, b } = bounds(d), gs = new Set(enabled(c));
    const vm = (await visibleMapped()).filter((r) => !r.sh && !ADULT.test(r.category)); const byEpg = new Map();
    for (const r of vm) { const l = byEpg.get(r.epg); if (!l) byEpg.set(r.epg, [r]); else if (!skcz(l[0]) && skcz(r)) l.unshift(r); }
    const ct = new Map(vm.map((r) => [r.id, chType(r)])), items = new Map(GENRES.map((g) => [g[0], []])), seen = new Set(), perT = new Map();
    if (byEpg.size && gs.size) {
      const q = await pool.query(`SELECT epg_id,s,e,title,sub,cat,kind,yr,fl,lnk FROM epg_prog WHERE epg_id = ANY($1) AND s < $3 AND ${d ? 's >= $2' : 'e > $2'} AND e - s >= interval '10 minutes' ORDER BY s`, [[...byEpg.keys()], new Date(d ? a : now), new Date(b)]);
      for (const p of q.rows) {
        if (JUNK.test(p.title) || GJUNK.test(p.title)) continue;
        const ch = byEpg.get(p.epg_id)[0], dur = (p.e - p.s) / 60e3, g = genreOf(p, ch, ct.get(ch.id), dur);
        if (!g || !gs.has(g)) continue;
        if (g === 'sport' && (dur < 30 || C.NOTLIVE.test(p.title))) continue;
        if (g === 'film' && dur < 60) continue;
        const sk = skcz(ch) ? 1 : 0, tn = tnorm(p.title);
        // reruns: one airing per title (films, docs), per title+episode (series, shows…), news once per channel and 3 h
        const k = g + '|' + sk + '|' + tn + '|' + (g === 'film' || g === 'doc' ? '' : g === 'news' ? ch.id + '|' + Math.floor(+p.s / 108e5) : tnorm(p.sub));
        if (seen.has(k)) continue; seen.add(k);
        const kt = g + '|' + ch.id + '|' + tn, nt = perT.get(kt) || 0; if (nt >= 2) continue; perT.set(kt, nt + 1);
        items.get(g).push({ ch, sk, g, s: +p.s, e: +p.e, title: p.title, sub: C.clip(p.sub, 80), kind: g === 'film' ? 'film' : p.kind, cat: p.cat, yr: p.yr, fl: p.fl || '', lnk: /^https:\/\/www\.ceskatelevize\.cz\//.test(p.lnk || '') ? p.lnk : '' });
      }
    }
    const films = items.get('film'), info = await posterInfo(films), pm = await posterMap(films), out = {}, chs = {}, cnt = {};
    for (const [g, list] of items) {
      if (!gs.has(g)) continue;
      for (const x of list) {
        if (g === 'film' || g === 'sport' || g === 'show') { const sc = scoreOf({ ...x, kind: g }, x.ch, now); x.score = sc < 0 ? -1 : sc + topBoost({ ...x, kind: g }, info.get(posterKey(x))); } else x.score = generic(x, now);
      }
      const min = g === 'film' || g === 'sport' || g === 'show' ? 40 : 18, top = new Set();
      for (const grp of [1, 0]) list.filter((x) => x.sk === grp && x.score >= min && x.e > now).sort((p, q) => q.score - p.score || p.s - q.s).slice(0, g === 'film' || g === 'sport' ? 5 : 3).forEach((x) => top.add(x));
      const keep = [...list.filter((x) => x.sk).slice(0, MAXL), ...list.filter((x) => !x.sk).slice(0, MAXL)].sort((p, q) => p.s - q.s || q.sk - p.sk);
      out[g] = keep.map((x) => { if (!chs[x.ch.id]) chs[x.ch.id] = [x.ch.name, ctx.tvchLogoSrc ? ctx.tvchLogoSrc(x.ch) : '/tvlogo/' + x.ch.id, x.sk];
        const live = g === 'sport' && (C.LIVE.test(x.title) || x.fl.includes('l'));
        return [x.ch.id, Math.round(x.s / 1000), Math.round(x.e / 1000), x.title, x.sub, (top.has(x) ? 'h' : '') + (live ? 'l' : '') + (x.fl.includes('p') && !x.fl.includes('r') ? 'p' : '') + (x.fl.includes('q') ? 'q' : ''), g === 'film' ? pm.get(posterKey(x)) || '' : '', x.lnk]; // [7] = link back to ČT (ČT terms)
      });
      cnt[g] = [list.filter((x) => x.sk).length, list.length];
    }
    postersLater(films.filter((x) => !pm.has(posterKey(x))).sort((p, q) => q.sk - p.sk || q.score - p.score));
    const res = { l: out, ch: chs, n: cnt };
    if (cache.size > 20) cache = new Map(); cache.set(d, { t: Date.now(), d: res }); return res;
  }

  app.get('/api/epg/guide', wrap(async (req, res) => {
    const c = cfg(await getSettings()); if (!on(c)) return res.status(404).json({ l: [] });
    const gs = enabled(c), g = gs.includes(req.query.g) ? req.query.g : gs.includes(c.guide_def) ? c.guide_def : gs[0], en = req.query.l === 'en';
    const ds = await days(c), d = ds.includes(+req.query.d) ? +req.query.d : 0;
    const x = await dayData(c, d), ch = {}; const l = (x.l[g] || []);
    for (const r of l) ch[r[0]] = x.ch[r[0]];
    jsonOut(res, { t: Math.round(Date.now() / 1000), g, d, days: ds.map((k) => [k, dayLbl(bounds(k).a + 12 * 3600e3, en)]), n: x.n, l, ch }, 120);
  }));

  const attrs = (en, c) => {
    if (!on(c)) return '';
    const gs = enabled(c); if (!gs.length) return '';
    const list = gs.map((g) => { const x = GL.get(g); return [g, x[1] + ' ' + (en ? x[3] : x[2])]; });
    return ` data-guide="${esc(JSON.stringify(list))}" data-gdef="${esc(gs.includes(c.guide_def) ? c.guide_def : gs[0])}" data-gscope="${c.guide_scope === 'all' ? 'all' : 'skcz'}" data-gtitle="${esc(tx(en, 'Čo dávajú – program podľa žánru', 'What\'s on – by genre'))}" data-gnone="${esc(tx(en, 'V tento deň tu nič nie je.', 'Nothing here for this day.'))}" data-gmore="${esc(tx(en, 'Zobraziť ďalšie', 'Show more'))}" data-gall="${esc(tx(en, 'Všetky', 'All'))}" data-gtop="${esc(tx(en, 'Tip', 'Pick'))}" data-glive="${esc(tx(en, 'Naživo', 'Live'))}"`;
  };

  async function card(req) {
    const c = cfg(await getSettings()), gs = enabled(c); let ds = [], rows = '';
    try { ds = on(c) ? await days(c) : []; for (const d of ds) { const x = await dayData(c, d); rows += `<tr><td>${esc(dayLbl(bounds(d).a + 12 * 3600e3, false))}</td>${gs.map((g) => `<td>${x.n[g] ? x.n[g][0] + ' / ' + x.n[g][1] : '–'}</td>`).join('')}</tr>`; } } catch (e) { rows = `<tr><td class="err">${esc(e.message)}</td></tr>`; }
    return `<form method="post" action="/admin/epg/guide" class="card" id="zanre">${hid(req)}<h2>🗂 Program podľa žánru (sekcia Kanály)</h2>
<p class="hint">Jeden panel nad zoznamom kanálov: záložky žánrov + dni (Dnes, Zajtra, ďalšie dni), filter SK/CZ / Všetky / Obľúbené. Načítava sa až po kliknutí (každý žáner a deň zvlášť). Žáner podľa kategórie v EPG a kľúčových slov, inak podľa typu kanála (filmový, športový, detský…). Opakovania sa zlučujú; najlepšie položky sú označené „Tip“.</p>
<label class="ck"><input type="checkbox" name="guide_on" value="1"${c.guide_on === '1' ? ' checked' : ''}> Zobraziť panel v sekcii Kanály</label>
<p>Žánre:</p>${GENRES.map(([g, i, l]) => `<label class="ck"><input type="checkbox" name="g_${g}" value="1"${gs.includes(g) ? ' checked' : ''}> ${i} ${esc(l)}</label>`).join('')}
<label>Predvolený žáner</label><select name="guide_def">${GENRES.map(([g, i, l]) => `<option value="${g}"${c.guide_def === g ? ' selected' : ''}>${i} ${esc(l)}</option>`).join('')}</select>
<label>Počet dní (podľa dostupnosti v EPG)</label><select name="guide_days">${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option${ndays(c) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
<label>Predvolený filter</label><select name="guide_scope"><option value="skcz"${c.guide_scope !== 'all' ? ' selected' : ''}>SK/CZ kanály</option><option value="all"${c.guide_scope === 'all' ? ' selected' : ''}>Všetky viditeľné kanály</option></select>
<button>Uložiť</button>
${rows ? `<h3>Počty položiek (SK/CZ / všetky)</h3><div class="tblw"><table class="cmp"><tr><th>Deň</th>${gs.map((g) => `<th>${GL.get(g)[1]} ${esc(GL.get(g)[2])}</th>`).join('')}</tr>${rows}</table></div><p class="hint">Dni s údajmi: ${ds.length} (EPG zdroje dávajú ~3–4 dni dopredu).</p>` : ''}</form>`;
  }
  admin.post('/epg/guide', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body, gs = GENRES.map((g) => g[0]).filter((g) => b['g_' + g]);
    await setSettings({ guide_on: b.guide_on ? '1' : '0', guide_genres: gs.join(',') || 'sport', guide_def: GL.has(b.guide_def) ? b.guide_def : 'sport', guide_days: String(Math.max(1, Math.min(7, parseInt(b.guide_days, 10) || 7))), guide_scope: b.guide_scope === 'all' ? 'all' : 'skcz' });
    drop(); back(res, 'gok', 'zanre');
  }));
  return { drop, attrs, card, genreOf, dayData, days };
};
