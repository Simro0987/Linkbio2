'use strict';
// Official broadcaster TV schedules (public program pages/APIs) to extend the free XMLTV feeds to ~7 days for SK/CZ channels.
// Schedule metadata only (channel, time, title, episode, genre). No stream/player/video URLs are read into storage.
// Respectful: fixed hosts, sequential requests with a pause, fetched at most every 12 h (cached in epg_off).
const UA = 'lnkbio-tvprogram/1.0 (+https://lnkbio.onrender.com; schedule only, 2x/day)';
const MAX = 3 * 1024 * 1024;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function get(url, signal, json) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30e3), on = () => ac.abort();
  if (signal) signal.addEventListener('abort', on, { once: true });
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rd = r.body.getReader(), parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > MAX) { ac.abort(); throw new Error('príliš veľké'); } parts.push(value); }
    const s = Buffer.concat(parts).toString('utf8');
    return json ? JSON.parse(s) : s;
  } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', on); }
}
const ent = (s) => String(s || '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(aacute|eacute|iacute|oacute|uacute|yacute|Aacute|Eacute|Iacute|Oacute|Uacute|Yacute|auml|ouml|uuml|Auml|Ouml|Uuml|ocirc|Ocirc|amp|quot|apos|lt|gt|nbsp|ndash|mdash);/g, (_, n) => ({ aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Yacute: 'Ý', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', ocirc: 'ô', Ocirc: 'Ô', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—' }[n]))
  .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const ymd = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
// local wall time (Europe/Bratislava) → epoch ms
function local(dateStr, hm) {
  const [y, m, d] = dateStr.split('-').map(Number), [H, M] = hm.split(':').map(Number);
  let g = Date.UTC(y, m - 1, d, H, M);
  for (let i = 0; i < 2; i++) { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(g).reduce((o, x) => ((o[x.type] = x.value), o), {}); const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); g += Date.UTC(y, m - 1, d, H, M) - shown; }
  return g;
}
const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// target = regex over the mapped EPG ids (from the XMLTV feeds) that this official channel extends
const SOURCES = {
  stvr: {
    name: 'STVR (stvr.sk/televizia/program)',
    chans: { jednotka: [/^(STVR\.)?Jednotka(\.HD)?\.(sk|cz)$/i], dvojka: [/^(STVR\.)?Dvojka(\.HD)?\.(sk|cz)$/i], 24: [/^(:24|STVR\.24|RTVS\.24)(\.HD)?\.(sk|cz)$/i], sport: [/^(:ŠPORT|STVR\.Šport|RTVS\.Šport)(\.HD)?\.(sk|cz)$/i] },
    async day(date, signal) {
      const h = await get(`https://www.stvr.sk/televizia/program?date=${date}`, signal), out = [];
      for (const b of h.split('<div data-content-list="list" class="tv item tv--').slice(1)) {
        const ch = b.split(/[\s"]/)[0]; if (!this.chans[ch]) continue;
        let off = 0, prev = -1; const its = [];
        for (const it of b.split('<div data-list-item').slice(1)) {
          const t = it.match(/time--start">\s*(\d\d:\d\d)/), ti = it.match(/class="title">\s*<a[^>]*>([^<]*)<\/a>/); if (!t || !ti) continue;
          const g = it.match(/<span class="genre">([^<]*)<\/span>/), ep = it.match(/<p class="episode_name">([\s\S]*?)<\/p>/);
          its.push([t[1], ti[1], g ? g[1] : '', ep ? ep[1] : '', /priamy prenos|naživo/i.test(it) ? 'l' : '']);
        }
        its.forEach((m, i) => {
          const mins = +m[0].slice(0, 2) * 60 + +m[0].slice(3);
          if (i === 0 && its[1]) { const n = +its[1][0].slice(0, 2) * 60 + +its[1][0].slice(3); if (mins > n && mins >= 17 * 60) off = -1; }
          else if (prev >= 0 && mins < prev) off++;
          prev = mins;
          out.push({ ch: 'stvr:' + ch, s: local(addDays(date, off), m[0]), title: ent(m[1]), cat: ent(m[2]), sub: ent(m[3]).slice(0, 120), fl: m[4] });
        });
      }
      return out;
    },
  },
  joj: {
    name: 'JOJ Group (joj.sk/program)',
    chans: { 1: [/^JOJ(\.HD)?\.(sk|cz)$/i], 2: [/^JOJ\.Plus(\.HD)?\.(sk|cz)$/i], 3: [/^JOJ\.KRIMI(\.HD)?\.(sk|cz)$/i], 16: [/^JOJ\.24(\.HD)?\.(sk|cz)$/i], 15: [/^JOJ\.ŠPORT(\.HD)?\.(sk|cz)$/i], 180: [/^JOJ\.Šport\.2(\.HD)?\.(sk|cz)$/i], 5: [/^Jojko(\.HD)?\.(sk|cz)$/i], 114: [/^JOJ\.Svet(\.HD)?\.(sk|cz)$/i], 6: [/^JOJ\.Cinema(\.HD)?\.(sk|cz)$/i], 10: [/^CS\.Film(\.HD)?\.(sk|cz)$/i], 11: [/^CS\.History(\.HD)?\.(sk|cz)$/i], 12: [/^CS\.Mystery(\.HD)?\.(sk|cz)$/i] },
    dflt: { 5: 'deti', 11: 'dokument', 12: 'dokument', 15: 'šport', 180: 'šport', 16: 'spravodajstvo' },
    async day(date, signal) {
      const j = await get(`https://www.joj.sk/api/v1/program/details?date=${date}`, signal, true), out = [];
      for (const [id, list] of Object.entries(j || {})) {
        if (!this.chans[id] || !Array.isArray(list)) continue;
        for (const x of list) {
          const s = Date.parse(x.start_at), e = Date.parse(x.end_at); if (!s || !e || !x.title) continue;
          const ty = (x.show && x.show.type) || '';
          out.push({ ch: 'joj:' + id, s, e, title: String(x.title).slice(0, 200), sub: String(x.episode_title || '').slice(0, 120), cat: { movie: 'film', series: 'seriál', news: 'spravodajstvo', show: 'zábava' }[ty] || this.dflt[id] || '', fl: (x.is_live ? 'l' : '') + (x.is_premiere ? 'p' : '') });
        }
      }
      return out;
    },
  },
  prima: {
    name: 'TV Prima (iprima.cz/tv-program)',
    chans: { prima: [/^Prima(\.HD)?\.cz$/i], cool: [/^Prima\.COOL(\.HD)?\.cz$/i], max: [/^Prima\.MAX(\.HD)?\.cz$/i], krimi: [/^Prima\.Krimi(\.HD)?\.cz$/i], love: [/^Prima\.LOVE(\.HD)?\.cz$/i], zoom: [/^Prima\.ZOOM(\.HD)?\.cz$/i], show: [/^Prima\.Show(\.HD)?\.cz$/i], star: [/^Prima\.Star(\.HD)?\.cz$/i], cnn: [/^CNN\.Prima\.News(\.HD)?\.(cz|sk)$/i], sport: [/^Prima\.Sport(\.HD)?\.cz$/i] },
    key: (t) => ({ 'prima': 'prima', 'prima cool': 'cool', 'prima max': 'max', 'prima krimi': 'krimi', 'prima love': 'love', 'prima zoom': 'zoom', 'prima show': 'show', 'prima star': 'star', 'cnn prima news': 'cnn', 'prima sport': 'sport' }[String(t || '').toLowerCase()]),
    async day(date, signal) {
      const h = await get(`https://www.iprima.cz/tv-program/${date}`, signal), out = [];
      const m = h.match(/<script type="application\/json" id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); if (!m) throw new Error('formát stránky sa zmenil');
      const a = JSON.parse(m[1]), memo = new Map(), WRAP = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef']);
      const R = (i, depth = 0) => { // Nuxt "devalue" payload: values reference other indexes
        if (typeof i !== 'number' || depth > 40) return i; if (memo.has(i)) return memo.get(i);
        const v = a[i]; let o;
        if (Array.isArray(v)) { if (typeof v[0] === 'string' && WRAP.has(v[0])) o = R(v[1], depth + 1); else if (typeof v[0] === 'string' && /^(Set|Map|Date|RegExp|BigInt|null)$/.test(v[0])) o = null; else { o = []; memo.set(i, o); for (const x of v) o.push(R(x, depth + 1)); return o; } }
        else if (v && typeof v === 'object') { o = {}; memo.set(i, o); for (const k of Object.keys(v)) o[k] = R(v[k], depth + 1); return o; } else o = v;
        memo.set(i, o); return o;
      };
      const data = (R(0) || {}).data || {}; const hit = Object.values(data).find((x) => x && Array.isArray(x.channelsData)); if (!hit) throw new Error('formát stránky sa zmenil');
      for (const c of hit.channelsData) {
        const k = this.key(c.title); if (!k || !Array.isArray(c.items)) continue;
        for (const x of c.items) {
          const s = Date.parse(x.programStartTime), e = Date.parse(x.programEndTime); if (!s || !e || !x.title) continue;
          const g = Array.isArray(x.genres) ? x.genres.map((y) => (y && (y.title || y.name)) || y).filter((y) => typeof y === 'string').join(', ') : '';
          // title suffixes: "*(N,V,X)" = content warnings, "(ST,L)" = studio / live
          let title = String(x.title), fl = ''; const w = title.match(/\s*\((?:ST|L)(?:,(?:ST|L))*\)\s*$/); if (w) { if (/\bL\b/.test(w[0])) fl = 'l'; title = title.slice(0, w.index); }
          title = title.replace(/\s*,?\s*\*\s*\([A-Z,\s]{1,20}\)\s*$/, '').trim(); if (!title) continue;
          out.push({ ch: 'prima:' + k, s, e, fl, title: title.slice(0, 200), sub: String(x.episodeTitle || '').slice(0, 120), cat: (x.type === 'MOVIE' ? 'film' : '') + (g ? (x.type === 'MOVIE' ? ', ' : '') + g : ''), yr: x.year ? String(x.year) : '' });
        }
      }
      return out;
    },
  },
};

// fetch days [today … today+days-1] from every source; returns { rows, report }
async function fetchAll(days, signal, only) {
  const today = ymd(Date.now()), rows = [], report = {};
  for (const [id, src] of Object.entries(SOURCES)) {
    if (only && !only.includes(id)) continue;
    const r = report[id] = { name: src.name, days: 0, n: 0, err: '' }; const got = [];
    for (let i = 0; i < days; i++) {
      if (signal && signal.aborted) break;
      try { const x = await src.day(addDays(today, i), signal); if (x.length) { got.push(...x); r.days++; } } catch (e) { r.err = String(e.message || e).slice(0, 120); if (i === 0) break; }
      await sleep(1500);
    }
    // per channel: sort, dedupe, end = next start (STVR has no end times)
    const by = new Map(); for (const x of got) { if (!by.has(x.ch)) by.set(x.ch, new Map()); const m = by.get(x.ch); if (!m.has(x.s)) m.set(x.s, x); }
    for (const m of by.values()) {
      const l = [...m.values()].sort((a, b) => a.s - b.s);
      l.forEach((x, i) => { const n = l[i + 1]; if (!x.e) x.e = n && n.s - x.s < 6 * 3600e3 ? n.s : x.s + 60 * 60e3; if (x.e > x.s && x.title) rows.push(x); });
    }
    r.n = got.length; r.chans = by.size;
  }
  return { rows, report };
}
const targets = () => { const t = []; for (const [sid, src] of Object.entries(SOURCES)) for (const [k, res] of Object.entries(src.chans)) t.push({ ch: sid + ':' + k, res }); return t; };

// DB side: cache table epg_off + merge into epg_prog after each EPG refresh (only beyond the last programme of each XMLTV channel)
function install({ pool, kv, getSettings, C, ADULT, JUNK }) {
  const on = (st) => st.off_on !== '0';
  const srcOn = (st) => { const v = st.off_src == null || st.off_src === '' ? Object.keys(SOURCES).join(',') : String(st.off_src); return new Set(v.split(',').filter((k) => SOURCES[k])); };
  let ready = null;
  const init = () => ready || (ready = pool.query(`CREATE TABLE IF NOT EXISTS epg_off (ch TEXT NOT NULL, s TIMESTAMPTZ NOT NULL, e TIMESTAMPTZ NOT NULL, title TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '', cat TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', yr TEXT NOT NULL DEFAULT '', fl TEXT NOT NULL DEFAULT '', PRIMARY KEY (ch, s))`));
  async function fetchStore(st, signal) {
    const want = srcOn(st), { rows, report } = await fetchAll(8, signal, [...want]);
    const by = new Map(); for (const x of rows) { const src = x.ch.split(':')[0]; if (!by.has(src)) by.set(src, []); by.get(src).push(x); }
    for (const [src, l] of by) { // replace a source only when it returned data
      const ins = [];
      for (const x of l) {
        if (JUNK.test(x.title)) continue; const dur = (x.e - x.s) / 60e3; if (dur < 3 || dur > 14 * 60) continue;
        let kind = ADULT.test(x.cat) ? 'adult' : C.classify(x.cat, x.title); if (kind === 'film' && dur < 65) kind = dur < 20 ? '' : 'series';
        ins.push([x.ch, new Date(x.s), new Date(x.e), C.clip(x.title, 200), C.clip(x.sub || '', 80), String(x.cat || '').slice(0, 60), kind, String(x.yr || '').slice(0, 4), x.fl || '']);
      }
      const cl = await pool.connect();
      try {
        await cl.query('BEGIN'); await cl.query(`DELETE FROM epg_off WHERE ch LIKE $1`, [src + ':%']);
        for (let i = 0; i < ins.length; i += 1000) { const b = ins.slice(i, i + 1000); await cl.query(`INSERT INTO epg_off (ch,s,e,title,sub,cat,kind,yr,fl) SELECT * FROM unnest($1::text[],$2::timestamptz[],$3::timestamptz[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::text[]) ON CONFLICT DO NOTHING`, Array.from({ length: 9 }, (_, j) => b.map((r) => r[j]))); }
        await cl.query('COMMIT');
      } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
    }
    await pool.query(`DELETE FROM epg_off WHERE e < now() - interval '1 day'`);
    await kv.set('off_at', new Date().toISOString()); await kv.set('off_report', JSON.stringify(report));
    return report;
  }
  // far = end of the stored window (ms); force = refetch even if cache is fresh
  async function merge(far, force, signal) {
    await init(); const st = await getSettings();
    await pool.query(`DELETE FROM epg_prog WHERE fl LIKE '%o%'`);
    if (!on(st)) return { off: true };
    const last = Date.parse(await kv.get('off_at') || 0) || 0;
    if (force || Date.now() - last > 12 * 3600e3 - 60e3) { try { await fetchStore(st, signal); } catch (e) { console.error('EPG official', e.message); } }
    const ids = (await pool.query(`SELECT DISTINCT epg_id FROM epg_map WHERE epg_id <> ''`)).rows.map((r) => r.epg_id);
    const want = srcOn(st), done = {}; let n = 0;
    for (const t of targets()) {
      if (!want.has(t.ch.split(':')[0])) continue;
      for (const id of ids) {
        if (!t.res.some((re) => re.test(id))) continue;
        const r = await pool.query(`WITH l AS (SELECT COALESCE(MAX(e), now()) AS m FROM epg_prog WHERE epg_id = $1)
          INSERT INTO epg_prog (epg_id,s,e,title,sub,cat,kind,descr,yr,fl) SELECT $1,o.s,o.e,o.title,o.sub,o.cat,o.kind,'',o.yr,o.fl || 'o' FROM epg_off o, l WHERE o.ch = $2 AND o.s >= l.m - interval '2 minutes' AND o.e > now() AND o.s < $3 ON CONFLICT (epg_id,s) DO NOTHING`, [id, t.ch, new Date(far)]);
        done[id] = t.ch; n += r.rowCount;
      }
    }
    await kv.set('off_merge', JSON.stringify({ n, ids: done, at: new Date().toISOString() }));
    return { n, ids: done };
  }
  async function status() {
    await init();
    const [at, rep, mg] = await Promise.all(['off_at', 'off_report', 'off_merge'].map((k) => kv.get(k)));
    const per = (await pool.query(`SELECT split_part(ch, ':', 1) AS src, COUNT(*)::int AS n, MAX(s) AS b FROM epg_off GROUP BY 1`)).rows;
    let report = {}, m = {}; try { report = JSON.parse(rep || '{}'); m = JSON.parse(mg || '{}'); } catch { /* ignore */ }
    return { at, report, merge: m, per };
  }
  return { merge, status, srcOn, on, init };
}
module.exports = { fetchAll, targets, SOURCES, install, _local: local };
