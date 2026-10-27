'use strict';
// "Dnes v TV · Top udalosti": big events (Ballon d'Or, Champions League, finals, MS/ME, Olympics, F1, Oscar, Eurovision…)
// picked automatically from the stored EPG by an admin-editable keyword list + sports channel + live flag + prime time.
// Admin-pinned events (title, channel, time, optional image) always come first. Program info only – never stream links.
const C = require('./epgcore');
const { tx } = require('./uitext');

const DEF_KW0 = `# jedno kľúčové slovo / fráza na riadok, voliteľne „= váha“ (predvolená 40). Diakritika a veľkosť písmen sa ignorujú.
Ballon d'Or = 60
Zlatá lopta = 60
Zlatý míč = 60
Liga majstrov = 45
Ligy majstrov = 45
Liga mistrů = 45
Ligy mistrů = 45
Champions League = 45
Európska liga = 30
Evropská liga = 30
Europa League = 30
Konferenčná liga = 22
Konferenční liga = 22
Conference League = 22
finále = 35
final = 30
semifinále = 25
semifinal = 22
Majstrovstvá sveta = 45
Mistrovství světa = 45
Majstrovstvá Európy = 45
Mistrovství Evropy = 45
World Cup = 40
MS v hokeji = 55
Hokej MS = 55
Hokejové MS = 55
MS vo futbale = 50
MS = 25
ME = 22
EURO 2028 = 45
olympiáda = 50
olympijské hry = 50
olympijské = 45
olympic = 45
ZOH = 50
LOH = 50
El Clásico = 55
Clásico = 50
derby = 30
Formula 1 = 40
Formule 1 = 40
F1 = 35
Veľká cena = 35
Velká cena = 35
Grand Prix = 30
MotoGP = 25
Wimbledon = 40
Roland Garros = 35
US Open = 30
Australian Open = 30
Davis Cup = 30
Stanley Cup = 45
NHL = 15
hokej = 10
Super Bowl = 50
Tour de France = 30
Oscary = 50
Oscarov = 50
Academy Awards = 50
Academy Awards = 50
Zlatý glóbus = 40
Golden Globe = 40
Grammy = 40
Eurovízia = 50
Eurovize = 50
Eurovision = 50
Zlatý slávik = 35
OKTAGON MMA = 55
Oktagon = 50
UFC = 40
Česko Slovensko má talent = 25`;
// + non-sport TV events (reality/show finals, galas, Eurovision, elections, New Year's Eve…) shared with the hero (evsources.js)
const DEF_KW = DEF_KW0 + '\n# zábava, gala, voľby, Silvester\n' + require('./evsources').EXTRA_KW;
const D = { ev_on: '1', ev_kanaly: '1', ev_n: '6', ev_min: '55', ev_scope: 'skcz', ev_title: 'Dnes v TV · Top udalosti', ev_title_en: 'Today on TV · Top events', ev_kw: DEF_KW };
const SPORTCH = /sport|šport|arena|eurosport|nova sport|premier sport|dazn|sky sport|\bespn|golf|fight|motor|canal\+ sport|polsat sport|\brtvs sport|:sport|joj šport|ct ?sport|čt ?sport|ct ?4|čt ?4|digi sport|orange sport/i;
const LIVEW = /\b(priamy prenos|priamom prenose|přímý přenos|přímém přenosu|naživo|nazivo|live)\b|\bp\.\s?p\./i;
const RERUN = /\b(záznam|zaznam|repríza|repriza|reprízа|opakovanie|sestřih|zostrih|highlights|best of)\b/i;
const MAJOR = /markíz|markiz|\bjoj\b|joj plus|\bnova\b|nova cinema|prima|jednotka|dvojka|stvr|rtvs|čt ?1|ct ?1|čt ?2|ct ?2|voyo/i;
const BIGNEWS = /vo[lľ]by|volby|debat|superdebat|inaugur|korunov/i;
// unicode-aware word boundaries (JS \b treats š/í/ý as non-word: „štúdio“, „magazín“, „príbeh“ never matched)
const DOCSTORY = /(?<![\p{L}\d])(osobn[ýíá] (?:príbeh|příběh)|príbeh|příběh|dokument\p{L}*|documentar\p{L}*|portrét|portrait)(?![\p{L}\d])/iu;
const MAG = /(?<![\p{L}\d])(studio|štúdio|magazín|magazin|news|noviny|správy|zprávy|preview|pred zápasom|před zápasem|osobn[ýíá] (?:príbeh|příběh)|príbeh|příběh|dokument\p{L}*|documentar\p{L}*|výzva|vyzva)(?![\p{L}\d])/iu;

function parseKw(txt) {
  const out = [];
  for (let line of String(txt || '').split(/\r?\n/)) {
    line = line.trim(); if (!line || line.startsWith('#')) continue;
    let w = 40; const m = /^(.*?)\s*(?:=|\|)\s*(\d{1,3})$/.exec(line); if (m) { line = m[1]; w = Math.max(1, Math.min(100, +m[2])); }
    const k = C.clip(line, 60).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const short = k.replace(/ /g, '').length <= 3, raw = rawNorm(line);
    // short ALL-CAPS abbreviations (MS, ME, F1, NHL, ZOH) only match in capitals: „ME“ ≠ Czech „mě“
    if (k && !out.some((x) => x.k === k)) out.push({ k, w, label: line, short, cs: short && /[A-Z]/.test(raw) && raw === raw.toUpperCase() ? raw : '' });
    if (out.length >= 200) break;
  }
  return out;
}
// keyword hit at a word start; short keywords (MS, ME, F1, ZOH…) must be whole words
const rawNorm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
function hits(text, kws) {
  const r = ' ' + rawNorm(text) + ' ', t = r.toLowerCase(), out = [];
  for (const x of kws) { if (x.cs ? r.includes(' ' + x.cs + ' ') : t.includes(' ' + x.k + (x.short ? ' ' : ''))) out.push(x); }
  return out.sort((a, b) => b.w - a.w);
}

module.exports = function events(ctx, h) {
  const { app, admin, pool, esc, hid, csrf, needAuth, wrap, getSettings, setSettings } = ctx;
  const { visibleMapped, skcz, dayStart, dayLbl, hm, localHour, tnorm, JUNK, ADULT, channels, fromLocal, toLocal, ASSET_V } = h;
  const cfg = (s) => { const o = {}; for (const k of Object.keys(D)) o[k] = s[k] == null || s[k] === '' ? D[k] : String(s[k]); return o; };
  let cache = null, kwCache = null, oktNums = null, H = null;
  const drop = () => { cache = null; if (H) H.stale(); };
  const setOkt = (nums) => { oktNums = nums && nums.size ? nums : null; };
  // „veľký zápas“ detector context (hero only: parsed evh_big config + league top-4 standings)
  let bigCtx = null; const setBig = (x) => { bigCtx = x || null; };
  const BIG = require('./evbig'), SPORTCAT = /sport|šport|futbal|hokej|tenis|mma|box|formula|motogp|basketbal|cykl|atlet|lyž|biatlon|hádzan|volejbal|šípk|snooker|olymp/i;
  const kwOf = (c) => { if (!kwCache || kwCache.src !== c.ev_kw) kwCache = { src: c.ev_kw, l: parseKw(c.ev_kw) }; return kwCache.l; };

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ev_pin (id SERIAL PRIMARY KEY, title TEXT NOT NULL, channel_id INT, channel_txt TEXT NOT NULL DEFAULT '', s TIMESTAMPTZ NOT NULL, e TIMESTAMPTZ NOT NULL, img_url TEXT NOT NULL DEFAULT '', img BYTEA, note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ev_hide (k TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    if (H) await H.init();
  }

  // score one programme; returns { score, kw:[labels], live, rerun } or null when it is not an event
  // wide = hero mode: all genres (film/series/show premieres, reality finals, galas, elections…), smaller sport bonus
  function score(p, ch, c, kws, wide) {
    const s = +p.s, e = +p.e, dur = (e - s) / 60e3; if (dur < 25 || dur > 600) return null;
    if (JUNK.test(p.title) || p.kind === 'adult' || ADULT.test(p.cat || '') || ADULT.test(ch.category || '')) return null;
    let ht = hits(p.title + ' ' + (p.sub || ''), kws); const hd = hits((p.cat || '') + ' ' + (p.descr || ''), kws);
    // a film/series merely titled like an event keyword („Oscar“ 1967) is not the event
    if (/^(film|series)$/.test(p.kind || '')) { const tn = String(p.title).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); ht = ht.filter((x) => x.k !== tn); }
    const hr0 = localHour(s), prem = (p.fl || '').includes('p') && !(p.fl || '').includes('r');
    // first-run film/series/show/documentary in prime time on a major SK/CZ channel = a candidate even without keywords
    const primeP = !!wide && prem && /^(film|series|show|doc|music)$/.test(p.kind || '') && hr0 >= 19.5 && hr0 < 23 && MAJOR.test(ch.name) && dur >= 40;
    const bg = bigCtx && (p.kind === 'sport' || SPORTCH.test(ch.name + ' ' + ch.category) || SPORTCAT.test((p.cat || '') + ' ' + p.title)) ? BIG.detect(bigCtx, p) : { pts: 0, why: [] };
    if (!ht.length && !hd.length && !primeP && !bg.pts) return null;
    // title: best keyword + half of a second, different one (final/finále count once); description/category: only strong
    // keywords (weight ≥ 45, e.g. Ballon d'Or, Liga majstrov, olympiáda) at 60 % – generic words there (finále, derby…) are noise
    const ov = (a, b) => a.k.startsWith(b.k) || b.k.startsWith(a.k);
    const t2 = ht.find((x) => x !== ht[0] && !ov(x, ht[0]));
    let kw = ht.length ? ht[0].w + (t2 ? Math.round(t2.w * 0.5) : 0) : 0;
    const dBest = hd.find((x) => x.w >= 45 && !ht.some((y) => ov(x, y))); if (dBest) kw += Math.round(dBest.w * (ht.length ? 0.3 : 0.6));
    let pk = false; if (primeP && kw < 33) { kw = 33; pk = true; }
    if (!kw && !bg.pts) return null;
    kw = Math.min(kw, 95);
    // big match: keyword score and detector overlap (both see „finále“) → detector adds 70 % on top of keywords, full when no keyword
    const bp = kw ? Math.round(bg.pts * 0.5) : bg.pts; // keywords often already describe the same thing (MS, finále…)
    let sc = kw + bp;
    const head = p.title + ' ' + (p.sub || '') + ' ' + String(p.descr || '').slice(0, 60);
    // OKTAGON <n> where n is not an upcoming card in the official calendar = archive fight night (Premier Sport reruns)
    const on = /\boktagon\s*(\d{1,3})\b/i.exec(p.title), arch = !!(on && oktNums && oktNums.size && !oktNums.has(+on[1]));
    const live = (p.fl || '').includes('l') || LIVEW.test(head), rerun = (p.fl || '').includes('r') || RERUN.test(head) || arch;
    const why = [...(kw ? [(pk ? 'premiéra v hlavnom čase +' : 'kľúč. slová +') + kw] : []), ...(bp ? ['veľký zápas +' + bp + ' (' + bg.why.join(', ') + ')'] : [])], spb = wide ? 3 : 8, prb = wide ? 10 : 5;
    if (SPORTCH.test(ch.name + ' ' + ch.category) || p.kind === 'sport') { sc += spb; why.push('šport +' + spb); }
    if (live && !rerun) { sc += 15; why.push('naživo +15'); } if (rerun) { sc -= 30; why.push((arch ? 'archív' : 'záznam') + ' −30'); } else if ((p.fl || '').includes('p')) { sc += prb; why.push('premiéra +' + prb); }
    // documentary / personal story about a big event or star („Ballon d'Or – Osobný príbeh“): the keyword is not the event itself
    if (DOCSTORY.test(p.title + ' ' + (p.sub || '')) && !pk) { sc -= 30; why.push('dokument/príbeh −30'); }
    else if (MAG.test(p.title) && !(wide && (p.kind === 'doc' || BIGNEWS.test(head)))) { sc -= 15; why.push('štúdio/magazín −15'); }
    const hr = localHour(s), tb = hr >= 19.5 && hr < 23 ? 12 : hr >= 17 && hr < 19.5 ? 6 : hr >= 23 || hr < 1 ? 2 : hr >= 4 && hr < 12 ? -10 : 0;
    if (tb) { sc += tb; why.push((tb > 0 ? 'večer +' : 'ráno ') + tb); }
    if (c.ev_scope === 'all') sc += skcz(ch) ? 8 : -8;
    if (s <= Date.now() && e > Date.now()) sc += 5;
    return { score: sc, kw: [...new Set([...ht, ...(dBest ? [dBest] : [])].map((x) => x.label))].slice(0, 3), big: bg.pts ? bg.why : null, bigStrong: !!(bg.pts && bg.strong), live: live && !rerun, rerun, why };
  }

  async function pinsList(until) {
    const all = await channels();
    return (await pool.query(`SELECT id,title,channel_id,channel_txt,s,e,img_url,(img IS NOT NULL) AS hasimg,note FROM ev_pin WHERE e > now() ${until ? 'AND s < $1' : ''} ORDER BY s`, until ? [new Date(until)] : [])).rows.map((p) => {
      const ch = p.channel_id ? all.find((r) => r.id === p.channel_id) : null;
      return { k: 'pin:' + p.id, pin: p.id, title: p.title, s: +p.s, e: +p.e, ch: ch ? { id: ch.id, name: ch.name, category: ch.category, logo: ch.logo } : null, chName: ch ? ch.name : p.channel_txt, img: p.hasimg ? '/ev-img/' + p.id + '?v=' + (+p.s % 1e7) : '', note: p.note, score: 999 };
    });
  }

  // scored EPG programmes running/starting in [from, to) on visible mapped channels
  // allow: Set of channel ids (hero: SK/CZ channels of the Kanály catalogue) – replaces the ev_scope filter
  async function scan(c, kws, from, to, wide, allow) {
    const vm = (await visibleMapped()).filter((r) => !ADULT.test(r.category) && !r.sh && (allow ? allow.has(r.id) : c.ev_scope === 'all' || skcz(r)));
    const byEpg = new Map(); for (const r of vm) { if (!byEpg.has(r.epg)) byEpg.set(r.epg, []); byEpg.get(r.epg).push(r); }
    const cand = [];
    if (!byEpg.size || !kws.length) return cand;
    // only kinds where events live (no films/series/kids/news/docs) → small result
    const q = await pool.query(`SELECT epg_id,s,e,title,sub,cat,kind,fl,left(descr,240) AS descr FROM epg_prog WHERE epg_id = ANY($1) AND e > $2 AND s < $3 AND (kind IN ('sport','show','music','')${wide ? ` OR (kind IN ('film','series','doc','news') AND (COALESCE(fl,'') LIKE '%p%' OR title ~* '(vo[lľ]by|volby|debat|silvest|eurov|oscar|grammy|fin[aá]le|premi[eé]r|korunov)'))` : ''}) AND e - s >= interval '25 minutes'`, [[...byEpg.keys()], new Date(from), new Date(to)]);
    for (const p of q.rows) {
      const chs = byEpg.get(p.epg_id); const ch = chs.find((x) => skcz(x)) || chs[0];
      const r = score(p, ch, c, kws, wide); if (!r) continue;
      cand.push({ k: 'p:' + p.epg_id + '|' + +p.s, tk: 't:' + tnorm(p.title), title: p.title, sub: p.sub || '', descr: wide ? p.descr || '' : '', s: +p.s, e: +p.e, kind: p.kind, ch, chName: ch.name, pred: /q/.test(p.fl || ''), ext: /x/.test(p.fl || ''), score: r.score, kw: r.kw, big: r.big, bigStrong: r.bigStrong, why: r.why, live: r.live, rerun: r.rerun });
    }
    return cand;
  }

  // all candidates today (until 02:00) + tomorrow; opt.all → full scored list for admin
  async function items(opt = {}) {
    if (!opt.all && cache && Date.now() - cache.t < 120e3) return cache.d;
    const st = await getSettings(), c = cfg(st), now = Date.now(), ds = dayStart(now), end = dayStart(ds + 36 * 3600e3) + 26 * 3600e3; // end of tomorrow (+02:00)
    const kws = kwOf(c), n = Math.max(3, Math.min(12, parseInt(c.ev_n, 10) || 6)), min = Math.max(1, Math.min(200, parseInt(c.ev_min, 10) || 55));
    const hidden = new Set((await pool.query('SELECT k FROM ev_hide')).rows.map((r) => r.k));
    const cand = (await scan(c, kws, now + 5 * 60e3, end)).map((x) => Object.assign(x, { hidden: hidden.has(x.k) || hidden.has(x.tk), ok: x.score >= min }));
    cand.sort((a, b) => b.score - a.score || a.s - b.s);
    const pins = await pinsList(end + 6 * 86400e3);
    // dedupe titles (HD/SD/+1 variants, reruns – keep the best airing), max 2 per channel
    const seen = new Set(pins.map((x) => 't:' + tnorm(x.title))), perCh = new Map(), picked = [];
    for (const x of cand) {
      if (!x.ok || x.hidden) continue; if (seen.has(x.tk)) { x.dupe = true; continue; }
      const pc = perCh.get(x.ch.id) || 0; if (pc >= 2) continue;
      seen.add(x.tk); perCh.set(x.ch.id, pc + 1); picked.push(x); if (picked.length >= Math.max(0, n - pins.length)) break;
    }
    const top = picked[0]; if (top) top.best = true;
    // pinned first; then on-air, then by start time
    picked.sort((a, b) => (b.s <= now) - (a.s <= now) || a.s - b.s);
    const d = { list: [...pins, ...picked].slice(0, Math.max(n, pins.length)), pins, cand, kws, c };
    if (!opt.all) cache = { t: Date.now(), d };
    return d;
  }

  const until = (ms, en) => { const m = Math.max(1, Math.round((ms - Date.now()) / 60e3)); if (m < 60) return tx(en, 'o ', 'in ') + m + ' min'; const hh = Math.floor(m / 60), mm = m % 60; return tx(en, 'o ', 'in ') + hh + ' h' + (mm ? ' ' + mm + ' min' : ''); };
  // public block for the homepage / Kanály page
  async function block(req, s, where) {
    try {
      const st = await getSettings(), c = cfg(st); if (c.ev_on !== '1' || (where === 'kanaly' && c.ev_kanaly !== '1') || (where === 'home' && H && H.cardsOffHome(st))) return '';
      const d = await items(); const now = Date.now(); const list = d.list.filter((x) => x.e > now); if (!list.length) return '';
      const en = req.lang === 'en';
      const logo = (ch) => (ch ? (ctx.tvchLogoSrc ? ctx.tvchLogoSrc(ch) : '/tvlogo/' + ch.id) : '');
      const card = (x) => {
        const on = x.s <= now, soon = !on && x.s - now < 12 * 3600e3 && dayStart(x.s) === dayStart(now);
        const badge = on ? `● ${tx(en, 'NAŽIVO', 'LIVE')}` : soon ? until(x.s, en) : `${dayLbl(x.s, en)} ${hm(x.s)}`;
        const img = x.img ? `<img class="tevi" src="${esc(x.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : x.ch ? `<img class="tevi tevl" src="${esc(logo(x.ch))}" alt="" loading="lazy" decoding="async" width="72" height="72">` : '<span class="tevi tevx">📺</span>';
        return `<li class="tev${x.pin ? ' pin' : ''}${x.best ? ' best' : ''}${on ? ' on' : ''}" data-s="${Math.round(x.s / 1000)}" data-e="${Math.round(x.e / 1000)}">${img}<div class="tevb"><div class="tevt"><span class="tevbg" data-l="${esc(tx(en, 'NAŽIVO', 'LIVE'))}" data-o="${esc(tx(en, 'o ', 'in '))}" data-d="${esc(dayLbl(x.s, en))} ${esc(hm(x.s))}">${esc(badge)}</span>${x.pin ? `<span class="tevp">📌 ${esc(tx(en, 'Odporúčame', 'Featured'))}</span>` : x.best ? `<span class="tevp">★ ${esc(tx(en, 'Top', 'Top'))}</span>` : ''}</div><div class="tevn">${esc(x.title)}</div><div class="tevc">${x.ch ? `<img src="${esc(logo(x.ch))}" alt="" width="20" height="20" loading="lazy" decoding="async">` : ''}<b>${esc(x.chName || '')}</b>${x.pred ? `<small class="tevq">${esc(tx(en, 'predpokladaný kanál', 'expected channel'))}</small>` : ''}<span class="tevh"><time datetime="${new Date(x.s).toISOString()}">${esc(hm(x.s))}</time>–${esc(hm(x.e))}</span></div>${x.note ? `<div class="tevd">${esc(x.note)}</div>` : ''}<div class="tevpr"${on ? '' : ' hidden'}><i></i></div></div></li>`;
      };
      const title = (en && c.ev_title_en) || c.ev_title;
      return `<link rel="stylesheet" href="/static/epg.css?v=${ASSET_V}"><section class="tevs" aria-labelledby="tev-h-${where}"><h2 class="tevh2" id="tev-h-${where}"><span class="tevdot">●</span> ${esc(title)}</h2><ol class="tevl">${list.map(card).join('')}</ol><p class="tevf">${esc(tx(en, 'Iba TV program (čas a kanál) – orientačné údaje z EPG.', 'TV schedule info only (time and channel) – indicative EPG data.'))}</p></section><script src="/static/tev.js?v=${ASSET_V}" defer></script>`;
    } catch (e) { console.error('events', e.message); return ''; }
  }

  // ---------- public: uploaded pin image ----------
  app.get('/ev-img/:id(\\d+)', wrap(async (req, res) => {
    const r = (await pool.query('SELECT img FROM ev_pin WHERE id=$1 AND img IS NOT NULL', [+req.params.id])).rows[0]; if (!r) return res.status(404).end();
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); res.send(r.img);
  }));

  // ---------- admin ----------
  const multer = require('multer');
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 12, fieldSize: 2048 } }).single('image');
  const MSG = { ok: 'Uložené.', pin: 'Udalosť pripnutá – zobrazuje sa ako prvá.', del: 'Zmazané.', hid: 'Skryté.', unhid: 'Znovu zobrazené.', bad: 'Vyplňte názov, kanál a čas začiatku.', badimg: 'Obrázok sa nepodarilo načítať (JPG/PNG/WebP do 3 MB).', badurl: 'Obrázok sa nepodarilo stiahnuť – zadajte https:// odkaz na obrázok alebo na stránku udalosti (og:image).', kw: 'Kľúčové slová uložené.', kwdef: 'Obnovený predvolený zoznam kľúčových slov.' };
  const back = (res, m, a = '') => res.redirect(303, '/admin/udalosti?m=' + m + (a ? '#' + a : ''));
  const noUrl = (v, n) => C.clip(String(v || '').replace(/\b[a-z][a-z0-9+.-]{1,10}:\/\/\S+/gi, ''), n);
  admin.get('/udalosti', needAuth, wrap(async (req, res) => {
    const d = await items({ all: true }), c = d.c, vis = (await channels()).filter((r) => r.visible), now = Date.now();
    const allPins = (await pool.query('SELECT id,title,channel_id,channel_txt,s,e,img_url,(img IS NOT NULL) AS hasimg FROM ev_pin ORDER BY s DESC LIMIT 60')).rows;
    const hidden = (await pool.query('SELECT k,title FROM ev_hide ORDER BY created_at DESC LIMIT 100')).rows;
    const chName = (id, t) => (vis.find((r) => r.id === id) || {}).name || t || '—';
    const m = MSG[req.query.m] ? `<p class="${/^bad/.test(req.query.m) ? 'err' : 'ok'}">${esc(MSG[req.query.m])}</p>` : '';
    const row = (x) => `<div class="row"><span>${x.ok && !x.hidden && !x.dupe && d.list.includes(x) ? '✅ ' : ''}<b>${esc(dayLbl(x.s, false))} ${esc(hm(x.s))}</b> ${esc(x.title)} · <span class="hint">${esc(x.chName)} · skóre ${x.score}${x.ok ? '' : ' (pod hranicou)'} · ${esc(x.kw.join(', '))}${x.live ? ' · živé' : ''}${x.rerun ? ' · záznam' : ''}${x.dupe ? ' · duplicita' : ''}${x.hidden ? ' · skryté' : ''}</span></span>${x.hidden ? '' : `<form method="post" action="/admin/udalosti/hide">${hid(req)}<input type="hidden" name="k" value="${esc(x.tk)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>🙈 Skryť</button></form>`}<form method="post" action="/admin/udalosti/pin" enctype="multipart/form-data">${hid(req)}<input type="hidden" name="channel_id" value="${x.ch.id}"><input type="hidden" name="s" value="${esc(toLocal(x.s))}"><input type="hidden" name="dur" value="${Math.round((x.e - x.s) / 60e3)}"><input type="hidden" name="title" value="${esc(x.title)}"><button>📌 Pripnúť</button></form></div>`;
    res.send(ctx.page('Top udalosti v TV', `<h1>🔥 Dnes v TV · Top udalosti</h1>${m}<p><a href="/admin">← Admin</a> · <a href="/admin/epg">🗓 TV program (EPG)</a> · <a href="/${esc((await getSettings()).slug)}" target="_blank" rel="noopener">Zobraziť web ↗</a></p>
<p class="hint">Blok navrchu domovskej stránky a stránky Kanály. Automaticky vyberá veľké udalosti z TV programu (EPG) podľa kľúčových slov, športových kanálov, priameho prenosu a hlavného vysielacieho času (dnes do 02:00 a zajtra). Pripnuté udalosti sú vždy prvé. Iba informácie o programe – žiadne odkazy na streamy.</p>
${H ? await H.adminHtml(req) : ''}<div class="card"><h2>👀 Teraz na webe (${d.list.length})</h2>${d.list.map((x) => `<div class="row"><span>${x.pin ? '📌 ' : x.best ? '★ ' : ''}<b>${esc(dayLbl(x.s, false))} ${esc(hm(x.s))}–${esc(hm(x.e))}</b> ${esc(x.title)} · <span class="hint">${esc(x.chName || '')}${x.pin ? ' · pripnuté' : ' · skóre ' + x.score}${x.s <= now ? ' · NAŽIVO' : ''}</span></span></div>`).join('') || '<p class="hint">Momentálne nič – blok je skrytý. Pripnite udalosť nižšie alebo upravte kľúčové slová.</p>'}</div>
<form method="post" action="/admin/udalosti/pin" enctype="multipart/form-data" class="card" id="pin">${hid(req)}<h2>📌 Pripnúť / zvýrazniť udalosť</h2>
<label>Názov</label><input name="title" maxlength="160" required placeholder="napr. Zlatá lopta 2026 – slávnostné vyhlásenie">
<label>Kanál</label><select name="channel_id"><option value="">— iný (napíšte nižšie) —</option>${vis.map((r) => `<option value="${r.id}">${esc(r.name)} (${esc(r.category)})</option>`).join('')}</select>
<label>Iný kanál (ak nie je v zozname)</label><input name="channel_txt" maxlength="60">
<label>Začiatok (čas SK/CZ)</label><input type="datetime-local" name="s" required><label>Dĺžka (min)</label><input type="number" name="dur" min="5" max="720" value="150">
<label>Krátky popis (voliteľné)</label><input name="note" maxlength="140">
<label>Obrázok (voliteľné) – súbor JPG/PNG/WebP do 3 MB…</label><input type="file" name="image" accept="image/jpeg,image/png,image/webp">
<label>…alebo https odkaz na obrázok / stránku udalosti (stiahne sa og:image, bez hotlinku)</label><input name="img_url" maxlength="400" placeholder="https://…">
<button>📌 Pripnúť</button></form>
<div class="card" id="piny"><h2>📋 Pripnuté udalosti</h2>${allPins.map((p) => `<div class="row"><span>${+p.e < now ? '<span class="hint">(skončené)</span> ' : ''}<b>${esc(dayLbl(+p.s, false))} ${esc(hm(+p.s))}–${esc(hm(+p.e))}</b> ${esc(p.title)} · <span class="hint">${esc(chName(p.channel_id, p.channel_txt))}${p.hasimg || p.img_url ? ' · 🖼' : ''}</span></span><form method="post" action="/admin/udalosti/pin/${p.id}/delete">${hid(req)}<button class="d">🗑 Zmazať</button></form></div>`).join('') || '<p class="hint">Žiadne.</p>'}</div>
<form method="post" action="/admin/udalosti/settings" class="card" id="nast">${hid(req)}<h2>⚙ Nastavenia</h2>
<label class="ck"><input type="checkbox" name="ev_on" value="1"${c.ev_on === '1' ? ' checked' : ''}> Zobraziť blok na domovskej stránke</label>
<label class="ck"><input type="checkbox" name="ev_kanaly" value="1"${c.ev_kanaly === '1' ? ' checked' : ''}> Zobraziť blok aj na stránke Kanály (TV)</label>
<label>Nadpis (SK)</label><input name="ev_title" maxlength="60" value="${esc(c.ev_title)}"><label>Nadpis (EN)</label><input name="ev_title_en" maxlength="60" value="${esc(c.ev_title_en)}">
<label>Max. počet udalostí</label><input type="number" name="ev_n" min="3" max="12" value="${esc(c.ev_n)}">
<label>Minimálne skóre <span class="hint">(kľúčové slovo + šport. kanál +8, priamy prenos +15, prime time 19:30–23:00 +12, SK/CZ +8, záznam −30, štúdio/magazín −15, ráno −10)</span></label><input type="number" name="ev_min" min="1" max="200" value="${esc(c.ev_min)}">
<label>Kanály</label><select name="ev_scope"><option value="skcz"${c.ev_scope !== 'all' ? ' selected' : ''}>Iba slovenské a české kanály</option><option value="all"${c.ev_scope === 'all' ? ' selected' : ''}>Všetky kanály na webe (SK/CZ +8, zahraničné −8)</option></select>
<button>Uložiť</button></form>
<form method="post" action="/admin/udalosti/kw" class="card" id="kw">${hid(req)}<h2>🔑 Kľúčové slová (${d.kws.length})</h2><p class="hint">Jedno na riadok, voliteľne „= váha“ 1–100 (bez váhy 40). Zhoda v názve relácie = plná váha; v popise sa rátajú len silné slová (váha ≥ 45) na 60 %. Krátke (MS, ME, F1) len ako celé slovo. Riadky s # sú poznámky.</p>
<textarea name="ev_kw" rows="18" maxlength="8000">${esc(c.ev_kw)}</textarea><div class="row"><button>Uložiť kľúčové slová</button><label class="ck"><input type="checkbox" name="reset" value="1"> obnoviť predvolené</label></div></form>
<div class="card" id="kand"><h2>🔎 Kandidáti z EPG (${d.cand.length})</h2><p class="hint">Dnes a zajtra, zoradené podľa skóre. ✅ = na webe.</p>${d.cand.slice(0, 60).map(row).join('') || '<p class="hint">Žiadna relácia nezodpovedá kľúčovým slovám.</p>'}
${hidden.length ? `<h3>🙈 Skryté</h3>${hidden.map((x) => `<div class="row"><span>${esc(x.title || x.k)}</span><form method="post" action="/admin/udalosti/unhide">${hid(req)}<input type="hidden" name="k" value="${esc(x.k)}"><button>👁 Zobraziť</button></form></div>`).join('')}` : ''}</div>`, 'adm'));
  }));
  admin.post('/udalosti/pin', needAuth, (req, res, next) => up(req, res, (e) => (e ? back(res, 'badimg', 'pin') : next())), csrf, wrap(async (req, res) => {
    const b = req.body, s = fromLocal(b.s), dur = Math.max(5, Math.min(720, parseInt(b.dur, 10) || 120)), title = noUrl(b.title, 160);
    const cid = parseInt(b.channel_id, 10) || null, ctxt = noUrl(b.channel_txt, 60);
    if (!title || !Number.isFinite(s) || (!cid && !ctxt) || (cid && !(await channels()).some((r) => r.id === cid))) return back(res, 'bad', 'pin');
    let url = String(b.img_url || '').trim().slice(0, 400), img = null;
    if (url && !/^https:\/\/[^\s"'<>]+$/i.test(url)) return back(res, 'badurl', 'pin');
    if (req.file && req.file.size) {
      try { img = await H.toWebp(req.file.buffer); url = ''; } catch { return back(res, 'badimg', 'pin'); }
    } else if (url) {
      // never hotlink: download the image (or the page's og:image) once and keep a small webp copy
      try { img = await H.fetchImage(url); } catch { return back(res, 'badurl', 'pin'); }
    }
    await pool.query('INSERT INTO ev_pin (title,channel_id,channel_txt,s,e,img_url,img,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [title, cid, cid ? '' : ctxt, new Date(s), new Date(s + dur * 60e3), url, img, noUrl(b.note, 140)]);
    drop(); if (ctx.audit) await ctx.audit(req, 'ev_pin', title); back(res, 'pin', 'piny');
  }));
  admin.post('/udalosti/pin/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => { await pool.query('DELETE FROM ev_pin WHERE id=$1', [+req.params.id]); drop(); back(res, 'del', 'piny'); }));
  admin.post('/udalosti/hide', needAuth, csrf, wrap(async (req, res) => { const k = String(req.body.k || '').slice(0, 300); if (/^(p|t):/.test(k)) await pool.query('INSERT INTO ev_hide (k,title) VALUES ($1,$2) ON CONFLICT (k) DO NOTHING', [k, noUrl(req.body.title, 160)]); drop(); back(res, 'hid', 'kand'); }));
  admin.post('/udalosti/unhide', needAuth, csrf, wrap(async (req, res) => { await pool.query('DELETE FROM ev_hide WHERE k=$1', [String(req.body.k || '')]); drop(); back(res, 'unhid', 'kand'); }));
  admin.post('/udalosti/settings', needAuth, csrf, wrap(async (req, res) => {
    const b = req.body, clean = (v, d) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || d;
    await setSettings({ ev_on: b.ev_on ? '1' : '0', ev_kanaly: b.ev_kanaly ? '1' : '0', ev_title: clean(b.ev_title, D.ev_title), ev_title_en: clean(b.ev_title_en, D.ev_title_en), ev_n: String(Math.max(3, Math.min(12, parseInt(b.ev_n, 10) || 6))), ev_min: String(Math.max(1, Math.min(200, parseInt(b.ev_min, 10) || 55))), ev_scope: b.ev_scope === 'skcz' ? 'skcz' : 'all' });
    drop(); back(res, 'ok', 'nast');
  }));
  admin.post('/udalosti/kw', needAuth, csrf, wrap(async (req, res) => {
    if (req.body.reset === '1') { await setSettings({ ev_kw: DEF_KW }); drop(); return back(res, 'kwdef', 'kw'); }
    const v = String(req.body.ev_kw || '').replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f<>]/g, '').split(/\r?\n/).map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 220).join('\n');
    await setSettings({ ev_kw: v || DEF_KW }); drop(); back(res, 'kw', 'kw');
  }));

  H = require('./epghero')(ctx, h, { cfg, kwOf, scan, score, pinsList, setOkt, setBig, D, back, up, noUrl, MSG });
  const bigPts = (p) => { try { return bigCtx ? BIG.detect(bigCtx, p).pts : 0; } catch { return 0; } }; // importance for external-schedule channel prediction
  return { init, block, drop, items, bigPts, hero: H.render, _score: score, _parseKw: parseKw, _hero: H };
};
module.exports.parseKw = parseKw; module.exports.hits = hits; module.exports.DEF_KW = DEF_KW; module.exports.MAG = MAG; module.exports.DOCSTORY = DOCSTORY;
