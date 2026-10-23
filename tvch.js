'use strict';
// TV channel catalog (names, categories, logos only – never stream URLs / playlists / credentials).
const { tx } = require('./uitext');
const crypto = require('crypto');
const zlib = require('zlib');
const multer = require('multer');
const LOGOS = require('./tvlogos');
const LP = require('./logoproxy');

const MAX_ROWS = 5000, MAX_BYTES = 5 * 1024 * 1024;
const STREAMISH = /(^|\b)(rtmp|rtsp|rtp|udp|mms|srt|hls)s?:\/\/|\.m3u8?\b|\.ts(\?|$|\b)|\.mpd\b|get\.php|player_api|xmltv\.php|[?&](username|password|user|pass|token)=|^https?:\/\/[^/\s]*:\d{2,5}(\/|$)|^https?:\/\/[^/\s]*@/i;
const ANYURL = /^\s*[a-z][a-z0-9+.-]{1,10}:\/\//i;
const isStream = (v) => STREAMISH.test(String(v || '').trim());
const H_NAME = /^(name|názov|nazov|kanál|kanal|channel|meno)$/i, H_CAT = /^(category|kategória|kategoria|group|skupina|žáner|zaner|genre)$/i, H_LOGO = /^(logo|logo ?url|icon|ikona|tvg-logo)$/i;
const normH = (x) => String(x || '').replace(/^\uFEFF/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
const N_NAME = ['nazov kanala', 'nazov', 'kanal', 'channel', 'channel name', 'name', 'tvg-name', 'tvg name', 'title', 'meno'];
const N_CAT = ['kategoria', 'skupina', 'group', 'group-title', 'group title', 'category', 'zaner', 'genre'];
const N_LOGO = ['logo', 'logo url', 'tvg-logo', 'tvg logo', 'ikona', 'icon', 'image', 'obrazok'];
const N_NUM = ['c.', 'c', '#', 'id', 'no', 'no.', 'cislo', 'nr', 'p.c.', 'por.', 'poradie'];
const H_BAD = /url|stream|link|odkaz|m3u|playlist|xtream|user|pass|heslo|server|host|port|epg|tvg-id|token/i;

function safeLogo(v) {
  v = LP.normalizeUrl(String(v || '').trim()); if (!v) return '';
  if (v.length > 500 || isStream(v)) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  return u.href;
}
const cleanTxt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const txtOk = (s) => s && !ANYURL.test(s) && !isStream(s);

// ---- CSV ----
function decode(buf) {
  let s = buf.toString('utf8');
  if (s.includes('\uFFFD')) { try { s = new TextDecoder('windows-1250').decode(buf); } catch { /* keep utf8 */ } }
  return s.replace(/^\uFEFF/, '');
}
function parseCsv(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const cnt = (c) => first.split(c).length - 1;
  const d = [['\t', cnt('\t')], [';', cnt(';')], [',', cnt(',')]].sort((a, b) => b[1] - a[1])[0];
  const del = d[1] ? d[0] : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
    if (ch === '"' && f === '') q = true;
    else if (ch === del) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; if (rows.length > MAX_ROWS + 2) break; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return { rows: rows.filter((r) => r.some((c) => String(c).trim())), del };
}
// ---- minimal XLSX (zip + XML) reader, first worksheet ----
function unzip(buf) {
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('zip');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = {}; let total = 0;
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip');
    const meth = buf.readUInt16LE(p + 10), csz = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
    if (!/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/.test(name)) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(ds, ds + csz);
    const data = meth === 0 ? raw : meth === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 60 * 1024 * 1024 }) : null;
    if (!data) throw new Error('zip');
    total += data.length; if (total > 80 * 1024 * 1024) throw new Error('zip');
    out[name] = data.toString('utf8');
  }
  return out;
}
const xdec = (s) => s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e.toLowerCase()] || (e[1] === 'x' || e[1] === 'X' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10))));
const tText = (x) => [...x.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xdec(m[1])).join('');
function parseXlsx(buf) {
  const z = unzip(buf);
  const ss = z['xl/sharedStrings.xml'] ? [...z['xl/sharedStrings.xml'].matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => tText(m[1])) : [];
  let sheet = null;
  try { const rid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(z['xl/workbook.xml'])[1]; const tgt = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(z['xl/_rels/workbook.xml.rels']) || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(z['xl/_rels/workbook.xml.rels']); sheet = z['xl/' + tgt[1].replace(/^\/?xl\//, '')]; } catch { /* fallback */ }
  if (!sheet) sheet = z[Object.keys(z).filter((k) => /worksheets\/sheet\d+/.test(k)).sort()[0]];
  if (!sheet) throw new Error('sheet');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1], body = cm[2] || '', ref = /r="([A-Z]+)/.exec(a), t = (/t="(\w+)"/.exec(a) || [])[1];
      let col = r.length; if (ref) { col = 0; for (const ch of ref[1]) col = col * 26 + ch.charCodeAt(0) - 64; col--; }
      const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
      r[col] = t === 's' ? (ss[+v] || '') : t === 'inlineStr' ? tText(body) : v != null ? xdec(v) : '';
    }
    rows.push(Array.from(r, (x) => x || ''));
    if (rows.length > MAX_ROWS + 2) break;
  }
  return { rows: rows.filter((r) => r.some((c) => String(c).trim())), del: 'xlsx' };
}
// ---- map rows -> channels ----
function analyze(rows) {
  const info = { ignoredCols: [], badLogos: 0, skipped: 0, dupes: 0, header: false, tooMany: false };
  if (!rows.length) return { items: [], info };
  const h = rows[0].map((c) => cleanTxt(String(c).replace(/^\uFEFF/, ''), 60));
  const hn = h.map(normH);
  const pick = (list, not = []) => { for (const k of list) { const i = hn.findIndex((c, j) => c === k && !not.includes(j)); if (i >= 0) return i; } return -1; };
  let ni = pick(N_NAME), ci = pick(N_CAT, [ni]), li = pick(N_LOGO, [ni, ci]);
  let body = rows;
  const numCol = (i) => { if (N_NUM.includes(hn[i])) return true; const v = rows.slice(1, 201).map((r) => String(r[i] || '').trim()).filter(Boolean); return v.length > 0 && v.filter((x) => /^\d+[.)]?$/.test(x)).length / v.length > 0.8; };
  if (ni >= 0 || ci >= 0 || li >= 0) {
    info.header = true; body = rows.slice(1);
    if (ni < 0 || numCol(ni)) ni = hn.findIndex((c, i) => i !== ci && i !== li && c && !numCol(i) && !H_BAD.test(c) && !N_NUM.includes(c));
    if (li < 0) { // fallback: an unmapped column with https image links
      li = hn.findIndex((c, i) => { if (i === ni || i === ci) return false; const v = body.slice(0, 200).map((r) => String(r[i] || '').trim()).filter(Boolean); return v.length && v.filter((x) => /^https:\/\/\S+\.(png|jpe?g|svg|webp|gif)(\?\S*)?$/i.test(x) && !isStream(x)).length / v.length > 0.5; });
    }
    h.forEach((c, i) => { if (i !== ni && i !== ci && i !== li && c) info.ignoredCols.push(c + (H_BAD.test(c) ? ' ⚠' : '')); });
    info.map = { name: ni >= 0 ? h[ni] : '—', category: ci >= 0 ? h[ci] : '— (Ostatné)', logo: li >= 0 ? h[li] : '—' };
    if (ni < 0) return { items: [], info };
  } else { ni = 0; ci = 1; li = 2; info.map = { name: 'stĺpec 1', category: 'stĺpec 2', logo: 'stĺpec 3' }; }
  // any column (other than chosen) whose values look like stream links is ignored; also chosen columns full of stream URLs
  const width = Math.max(...body.slice(0, 200).map((r) => r.length), 0);
  for (let i = 0; i < width; i++) {
    const vals = body.slice(0, 200).map((r) => r[i]).filter((v) => String(v || '').trim());
    const s = vals.filter(isStream).length;
    if (vals.length && s / vals.length > 0.3) { if (i === ni || i === ci) info.streamInMain = true; else if (i !== li && !info.header) info.ignoredCols.push('#' + (i + 1) + ' (stream URL)'); }
  }
  if (!info.header && li >= 0) { const vals = body.slice(0, 200).map((r) => r[li]).filter(Boolean); if (vals.length && !vals.some((v) => /^https?:\/\//i.test(String(v).trim()))) { if (vals.length) info.ignoredCols.push('#' + (li + 1)); li = -1; } }
  info.ignoredCols = [...new Set(info.ignoredCols)];
  if (body.length > MAX_ROWS) { info.tooMany = true; }
  const seen = new Set(), items = [];
  for (const r of body.slice(0, MAX_ROWS)) {
    const name = cleanTxt(r[ni], 120), cat = cleanTxt(ci >= 0 ? r[ci] : '', 80) || 'Ostatné';
    if (!txtOk(name) || !txtOk(cat)) { info.skipped++; continue; }
    let logo = li >= 0 ? safeLogo(r[li]) : '';
    if (logo === null) { info.badLogos++; logo = ''; }
    const k = (name + '|' + cat).toLowerCase(); if (seen.has(k)) { info.dupes++; continue; }
    seen.add(k); items.push({ name, category: cat, logo });
  }
  info.sample = items.slice(0, 5);
  return { items, info };
}

module.exports = function install(ctx) {
  const { app, admin, pool, page, esc, hid, csrf, needAuth, wrap } = ctx;
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5, fieldSize: 1024 } }).single('file');
  const pending = new Map();
  let cache = null; const drop = () => { cache = null; brokenCache = null; };
  const all = async () => cache || (cache = (await pool.query('SELECT id,name,category,logo,ord,visible FROM tv_channels ORDER BY ord,id')).rows);
  const nextOrd = async (c) => (await c.query('SELECT COALESCE(MAX(ord),0)+1 AS n FROM tv_channels')).rows[0].n;
  const groups = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.category)) m.set(r.category, []); m.get(r.category).push(r); } return m; };
  const back = (res, m, a = '') => res.redirect(303, '/admin/kanaly-katalog?m=' + m + (a ? '#' + a : ''));
  const MS = { ok: 'Uložené.', added: 'Kanál pridaný.', trashed: 'Presunuté do koša – obnoviť v Admin › Kôš.', bad: 'Neplatný názov alebo kategória (nesmie obsahovať URL).', badlogo: 'Logo musí byť https odkaz na obrázok (bez portu, nie stream/playlist).', needconfirm: 'Akciu treba potvrdiť zaškrtnutím.', nofile: 'Chýba súbor.', big: 'Súbor je väčší ako 5 MB.', badfile: 'Súbor sa nepodarilo prečítať (CSV alebo .xlsx).', many: 'Príliš veľa riadkov (max 5000).', logos: 'Logá uložené (vrátiť sa dá z Koša).', expired: 'Náhľad vypršal – nahrajte súbor znova.', imported: 'Import dokončený.', dupe: 'Kanál s týmto názvom už v kategórii existuje.', badepg: 'Kanál uložený, ale zadané EPG id v zdroji neexistuje – vyberte ho cez 🔎 vybrať.' };

  ctx.tvchInit = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS tv_channel_reports (id SERIAL PRIMARY KEY, channel_id INT, channel_name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', resolved BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tv_logo_cache (channel_id INT PRIMARY KEY, src TEXT NOT NULL, png BYTEA, ok BOOLEAN NOT NULL DEFAULT false, err TEXT NOT NULL DEFAULT '', fetched_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tv_channels (id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Ostatné', logo TEXT NOT NULL DEFAULT '', ord INT NOT NULL DEFAULT 0, visible BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  };
  // restore from l_trash (called by server restore route inside its transaction)
  ctx.tvchRestore = async (c, x) => {
    if (x.t === 'tvch_logos') { for (const ch of x.data.changes || []) await c.query('UPDATE tv_channels SET logo=$1 WHERE id=$2 AND logo=$3', [ch.old || '', ch.id, ch.url]); drop(); return; }
    const rows = x.t === 'tvch_bulk' ? (x.data.rows || []) : [x.data];
    let o = await nextOrd(c);
    for (const r of rows) await c.query('INSERT INTO tv_channels (name,category,logo,ord,visible) VALUES ($1,$2,$3,$4,$5)', [r.name, r.category, r.logo || '', o++, r.visible !== false]);
    drop();
  };
  // ---------- logo proxy/cache: /tvlogo/:id → normalized 200px PNG ----------
  const lhash = (u) => crypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 10);
  const lsrc = (r, broken) => `/tvlogo/${r.id}?v=${r.logo && !(broken && broken.has(r.id)) ? lhash(r.logo) : 'b' + lhash(r.name + '|' + r.category)}`;
  const inflight = new Map(); let active = 0; const waiters = [];
  const slot = () => new Promise((ok) => { if (active < 6) { active++; ok(); } else waiters.push(ok); });
  const free = () => { const w = waiters.shift(); if (w) w(); else active--; };
  async function ensureLogo(ch, force) {
    const cur = (await pool.query('SELECT src,ok,err,fetched_at,png FROM tv_logo_cache WHERE channel_id=$1', [ch.id])).rows[0];
    if (!force && cur && cur.src === ch.logo && (cur.ok || Date.now() - new Date(cur.fetched_at) < 6 * 3600e3)) return cur;
    const k = ch.id + '|' + ch.logo; if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      await slot();
      try {
        let row;
        try { const { png } = await LP.fetchPng(ch.logo); row = { src: ch.logo, ok: true, err: '', png }; }
        catch (e) { row = { src: ch.logo, ok: false, err: String(e.message).slice(0, 200), png: null }; }
        await pool.query(`INSERT INTO tv_logo_cache (channel_id,src,png,ok,err,fetched_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (channel_id) DO UPDATE SET src=$2,png=$3,ok=$4,err=$5,fetched_at=now()`, [ch.id, row.src, row.png, row.ok, row.err]);
        brokenCache = null; return row;
      } finally { free(); }
    })().finally(() => inflight.delete(k));
    inflight.set(k, p); return p;
  }
  let brokenCache = null;
  const brokenIds = async () => brokenCache || (brokenCache = new Set((await pool.query('SELECT c.channel_id FROM tv_logo_cache c JOIN tv_channels t ON t.id=c.channel_id AND t.logo=c.src WHERE NOT c.ok')).rows.map((r) => r.channel_id)));
  // generated badge (TV Software look, color from category) for channels without a working logo
  const xe = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  function badge(name, cat) {
    const hue = parseInt(crypto.createHash('md5').update(String(cat || '')).digest('hex').slice(0, 4), 16) % 360;
    const words = String(name).replace(/\s+/g, ' ').trim().split(' '); const lines = []; let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length <= 11 || !cur) cur = (cur + ' ' + w).trim(); else { lines.push(cur); cur = w; } } if (cur) lines.push(cur);
    const L = lines.slice(0, 3); if (lines.length > 3) L[2] = L[2].slice(0, 10) + '…';
    const longest = Math.max(...L.map((l) => l.length), 1), fs = Math.max(20, Math.min(54, Math.floor(300 / longest), L.length === 1 ? 54 : L.length === 2 ? 40 : 32));
    const y0 = 108 - ((L.length - 1) * fs * 1.1) / 2 + fs * 0.35;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,26%)"/><stop offset="1" stop-color="#0d0d10"/></linearGradient></defs><rect width="200" height="200" rx="28" fill="url(#g)"/><rect x="1.5" y="1.5" width="197" height="197" rx="27" fill="none" stroke="hsl(${hue},70%,55%)" stroke-opacity=".45" stroke-width="3"/><path d="M18 18 L34 27 L18 36 Z" fill="#e50914"/><rect x="18" y="170" width="${Math.min(164, 30 + String(cat || '').length * 7)}" height="4" rx="2" fill="hsl(${hue},75%,55%)"/>${L.map((l, i) => `<text x="100" y="${(y0 + i * fs * 1.1).toFixed(1)}" text-anchor="middle" font-family="Inter,Segoe UI,Roboto,Arial,Helvetica,sans-serif" font-weight="800" font-size="${fs}" fill="#fff">${xe(l)}</text>`).join('')}</svg>`;
  }
  const sendBadge = (res, ch) => { res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }); res.send(badge(ch.name, ch.category)); };
  app.get('/tvlogo/:id(\\d+)', wrap(async (req, res) => {
    const ch = (await all()).find((r) => r.id === +req.params.id);
    if (!ch) return res.status(404).end();
    if (!ch.logo) return sendBadge(res, ch);
    const r = await ensureLogo(ch);
    if (!r.ok || !r.png) return sendBadge(res, ch);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }); res.send(r.png);
  }));
  ctx.tvchAll = all; ctx.tvchLogoSrc = (r) => lsrc(r);
  const logoImg = (r, sz, broken) => `<img class="tlg" src="${esc(lsrc(r, broken))}" alt="" loading="lazy" decoding="async" width="${sz}" height="${sz}" data-l="${esc([...r.name][0].toUpperCase())}">`;
  ctx.tvchPublic = async (req) => {
    const en = req.lang === 'en';
    const rows = (await all()).filter((r) => r.visible); if (!rows.length) return '';
    const g = groups(rows), broken = await brokenIds();
    const rm = req.query.rep === 'ok' ? `<div class="msg">${esc(tx(en, 'Ďakujeme, problém bol nahlásený. Pozrieme sa na to.', 'Thank you, the problem was reported. We will look into it.'))}</div>` : '';
    return `<section class="tvcat" id="katalog">${rm}<h2 class="ph">${esc(tx(en, 'Zoznam kanálov', 'Channel list'))}</h2><p class="lead">${esc(tx(en, 'Kanály podľa kategórií. Kliknite na kategóriu pre rozbalenie.', 'Channels by category. Click a category to expand.'))}</p>
<input type="search" id="tvq" class="tvq" placeholder="${esc(tx(en, '🔎 Hľadať kanál…', '🔎 Search channel…'))}" aria-label="${esc(tx(en, 'Hľadať kanál', 'Search channel'))}" autocomplete="off">
<p class="hint" id="tvnone" hidden>${esc(tx(en, 'Žiadny kanál nezodpovedá hľadaniu.', 'No channel matches your search.'))}</p>
${[...g].map(([c, l]) => `<details class="tvg"><summary><span class="tt">${esc(c)}</span><span class="tm">${l.length} ${esc(tx(en, 'kanálov', 'channels'))}</span></summary><ul class="tvl">${l.map((r) => `<li class="tch" data-id="${r.id}" data-n="${esc((r.name + ' ' + c).toLowerCase())}">${logoImg(r, 40, broken)}<span class="tcn">${esc(r.name)}</span><a class="trb" href="/${esc(req.params.slug)}/kanal-nahlasit/${r.id}${en ? '?lang=en' : ''}" rel="nofollow" title="${esc(tx(en, 'Nahlásiť problém', 'Report a problem'))}">⚠<span> ${esc(tx(en, 'Nahlásiť problém', 'Report a problem'))}</span></a></li>`).join('')}</ul></details>`).join('')}
<p class="hint">${rows.length} ${esc(tx(en, 'kanálov celkom', 'channels in total'))}</p></section><script src="/static/tvch.js?v=2" defer></script>`;
  };

  // ---------- user problem reports ----------
  const RTYPES = ['nefunguje', 'seka', 'logo', 'ine'];
  const rtLabel = (en, t) => ({ nefunguje: tx(en, 'Nefunguje', 'Not working'), seka: tx(en, 'Seká / zamŕza', 'Buffering / freezing'), logo: tx(en, 'Zlé logo alebo názov', 'Wrong logo or name'), ine: tx(en, 'Iné', 'Other') })[t] || t;
  const SECRET = String(process.env.SESSION_SECRET || 'x');
  const rTok = () => { const t = Date.now().toString(36); return t + '.' + crypto.createHmac('sha256', SECRET).update('tvrep:' + t).digest('base64url').slice(0, 22); };
  const rTokOk = (v) => { const [t, sig] = String(v || '').split('.'); if (!t || !sig) return false; const want = crypto.createHmac('sha256', SECRET).update('tvrep:' + t).digest('base64url').slice(0, 22), age = Date.now() - parseInt(t, 36); return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) && age > 2000 && age < 3600e3; };
  const hits = new Map();
  const over = (k, n, ms) => { const now = Date.now(), a = (hits.get(k) || []).filter((t) => now - t < ms); hits.set(k, a); return a.length >= n; };
  const hit = (...ks) => ks.forEach((k) => hits.get(k).push(Date.now()));
  setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
  const HASLINK = /(https?|ftp|rtmp|rtsp|udp):\/\/|www\.|\.m3u8?\b|\b[a-z0-9-]+\.(com|net|org|sk|cz|eu|io|tv|me|ru|info|xyz|top|link|ly|to|be|co|app|site|online|de|uk)\b(\/|\s|$)|t\.me\//i;
  const reportPage = async (req, res, s, ch, err) => {
    const en = req.lang === 'en';
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
    await ctx.shell(req, res, s, 'channels', tx(en, 'Nahlásiť problém', 'Report a problem') + ' – ' + ch.name, `<h1 class="ph">⚠ ${esc(tx(en, 'Nahlásiť problém', 'Report a problem'))}</h1>
<p class="lead"><b>${esc(ch.name)}</b> · ${esc(ch.category)}</p>${err ? `<div class="msg err">${esc(err)}</div>` : ''}
<form method="post" action="/${esc(s.slug)}/kanal-nahlasit/${ch.id}${en ? '?lang=en' : ''}" class="card idea"><input type="hidden" name="t" value="${esc(rTok())}"><div class="hp" aria-hidden="true"><label>Web</label><input name="web" tabindex="-1" autocomplete="off"></div>
<label>${esc(tx(en, 'Typ problému', 'Problem type'))}</label>${RTYPES.map((t, i) => `<label class="ck"><input type="radio" name="type" value="${t}"${i ? '' : ' checked'}> ${esc(rtLabel(en, t))}</label>`).join('')}
<label for="rn">${esc(tx(en, 'Poznámka (voliteľné, bez odkazov)', 'Note (optional, no links)'))}</label><textarea id="rn" name="note" maxlength="500" rows="3"></textarea>
<label for="rc">${esc(tx(en, 'Kontakt (voliteľné – e-mail alebo Telegram)', 'Contact (optional – e-mail or Telegram)'))}</label><input id="rc" name="contact" maxlength="120">
<button class="b">${esc(tx(en, 'Odoslať hlásenie', 'Send report'))}</button></form><p><a href="/${esc(s.slug)}/kanaly${en ? '?lang=en' : ''}">← ${esc(tx(en, 'Späť na kanály', 'Back to channels'))}</a></p>`);
  };
  const chById = async (id) => (await all()).find((r) => r.id === +id && r.visible);
  app.get('/:slug/kanal-nahlasit/:id(\\d+)', wrap(async (req, res, next) => {
    const s = await ctx.slugOk(req); if (!s) return next(); const ch = await chById(req.params.id); if (!ch) return next();
    await reportPage(req, res, s, ch);
  }));
  app.post('/:slug/kanal-nahlasit/:id(\\d+)', wrap(async (req, res, next) => {
    const s = await ctx.slugOk(req); if (!s) return next(); const ch = await chById(req.params.id); if (!ch) return next();
    const en = req.lang === 'en', b = req.body || {};
    if (b.web || !rTokOk(b.t)) return reportPage(req, res.status(400), s, ch, tx(en, 'Formulár vypršal, skúste znova.', 'The form expired, please try again.'));
    const kIp = 'ip:' + req.ip, kCh = 'ch:' + req.ip + ':' + ch.id;
    if (over(kIp, 3, 600e3) || over(kCh, 1, 1800e3) || over('global', 60, 3600e3)) return reportPage(req, res.status(429), s, ch, tx(en, 'Príliš veľa hlásení. Skúste neskôr.', 'Too many reports. Please try later.'));
    const type = RTYPES.includes(b.type) ? b.type : 'ine';
    const note = cleanTxt(String(b.note || ''), 500), contact = cleanTxt(String(b.contact || ''), 120);
    if (HASLINK.test(note) || /(https?|ftp):\/\/|www\./i.test(contact)) return reportPage(req, res.status(400), s, ch, tx(en, 'Poznámka ani kontakt nesmú obsahovať odkazy.', 'The note and contact must not contain links.'));
    hit(kIp, kCh, 'global');
    const r = (await pool.query('INSERT INTO tv_channel_reports (channel_id,channel_name,category,type,note,contact,ip) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [ch.id, ch.name, ch.category, type, note, contact, String(req.ip || '').slice(0, 64)])).rows[0];
    const pub = String(process.env.LNKBIO_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://lnkbio.onrender.com').replace(/\/$/, '');
    const sent = ctx.notify ? await ctx.notify('admin', `📺⚠ Nahlásený problém s kanálom #${r.id}\nKanál: ${ch.name} (${ch.category})\nProblém: ${rtLabel(false, type)}${note ? '\nPoznámka: ' + note : ''}${contact ? '\nKontakt: ' + contact : ''}\n${pub}/admin/kanaly-katalog#reports`).catch(() => false) : false;
    if (!sent) console.error('tvrep notify failed', r.id);
    res.redirect(303, `/${s.slug}/kanaly?rep=ok${en ? '&lang=en' : ''}#katalog`);
  }));
  admin.post('/tvch/rep/:id(\\d+)/resolve', needAuth, csrf, wrap(async (req, res) => { await pool.query('UPDATE tv_channel_reports SET resolved=NOT resolved WHERE id=$1', [+req.params.id]); back(res, 'ok', 'reports'); }));
  admin.post('/tvch/rep/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => { if (req.body.confirm !== '1') return back(res, 'needconfirm', 'reports'); await pool.query('DELETE FROM tv_channel_reports WHERE id=$1', [+req.params.id]); back(res, 'ok', 'reports'); }));
  const reportsAdmin = async (req) => {
    const rs = (await pool.query('SELECT * FROM tv_channel_reports ORDER BY resolved, created_at DESC LIMIT 300')).rows, open = rs.filter((r) => !r.resolved).length;
    return `<div class="card" id="reports"><h2>⚠ Hlásenia problémov (${open} otvorených)</h2><p class="hint">Hlásenia od návštevníkov (tlačidlo „Nahlásiť problém“ pri kanáli). Každé nové príde aj ako Telegram správa.</p>
${rs.map((r) => `<div class="card"><p><b>${esc(r.channel_name)}</b> <span class="hint">${esc(r.category)} · ${esc(rtLabel(false, r.type))} · ${esc(new Date(r.created_at).toLocaleString('sk-SK', { timeZone: 'Europe/Zurich' }))}${r.resolved ? ' · ✅ vyriešené' : ''}</span></p>${r.note ? `<p>${esc(r.note)}</p>` : ''}${r.contact ? `<p class="hint">Kontakt: ${esc(r.contact)}</p>` : ''}
<div class="row"><form method="post" action="/admin/tvch/rep/${r.id}/resolve">${hid(req)}<button class="g">${r.resolved ? '↩ Znovu otvoriť' : '✅ Vyriešené'}</button></form><form method="post" action="/admin/tvch/rep/${r.id}/delete">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> potvrdiť</label><button class="d">🗑 Zmazať</button></form></div></div>`).join('') || '<p class="hint">Žiadne hlásenia.</p>'}</div>`;
  };
  // ---------- logos from GitHub tv-logo/tv-logos ----------
  const logoTrash = async (c, changes, label) => { if (changes.length) await c.query(`INSERT INTO l_trash (t,data,label) VALUES ('tvch_logos',$1::jsonb,$2)`, [JSON.stringify({ changes }), label.slice(0, 200)]); };
  const jobs = new Map();
  admin.post('/tvch/logos/preview', needAuth, csrf, wrap(async (req, res) => {
    for (const [k, v] of jobs) if (v.exp < Date.now()) jobs.delete(k);
    const running = [...jobs.entries()].find(([, v]) => !v.done && v.kind !== 'check'); if (running) return res.redirect(303, '/admin/tvch/logos/job/' + running[0]);
    const miss = (await all()).filter((r) => !r.logo), id = crypto.randomBytes(12).toString('hex');
    const j = { done: false, n: 0, total: miss.length, exp: Date.now() + 30 * 60e3, err: '', res: null }; jobs.set(id, j);
    LOGOS.matchAll(miss, (d) => { j.n = d; }).then((m) => { j.res = m; }).catch((e) => { j.err = e.message; console.error('tvlogos job failed:', e.message); }).finally(() => { j.done = true; });
    res.redirect(303, '/admin/tvch/logos/job/' + id);
  }));
  admin.get('/tvch/logos/job/:id([a-f0-9]{24})', needAuth, wrap(async (req, res) => {
    const j = jobs.get(req.params.id); if (!j) return back(res, 'expired');
    const ls = LOGOS.status(), src = `<p class="hint">Zoznam log: ${esc(ls.source || '—')}${ls.at ? ' (' + esc(ls.at) + ')' : ''}${ls.lastErr ? ' · posledná chyba: ' + esc(ls.lastErr) : ''}</p>`;
    if (!j.done) { res.setHeader('Cache-Control', 'no-store'); return res.send(page('Hľadám logá…', `<meta http-equiv="refresh" content="2"><h1>🖼 Hľadám logá…</h1><p>Spracované <b>${j.n}</b> / ${j.total} kanálov. Stránka sa obnovuje automaticky.</p>${src}<p><a href="/admin/kanaly-katalog">← Späť</a></p>`, 'adm')); }
    if (j.err) return res.send(page('Logá', `<h1>Logá</h1><p class="err">Repozitár log je nedostupný: ${esc(j.err)}</p>${src}<p><a href="/admin/kanaly-katalog">← Späť</a></p>`, 'adm'));
    const m = j.res, hit = m.filter((x) => x.url), no = m.filter((x) => !x.url);
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
    const tok = crypto.randomBytes(18).toString('hex'); pending.set(tok, { logos: hit.map((x) => ({ id: x.id, url: x.url })), exp: Date.now() + 30 * 60e3 });
    res.setHeader('Cache-Control', 'no-store');
    res.send(page('Doplniť logá', `<h1>🖼 Doplniť chýbajúce logá – náhľad</h1><p><a href="/admin/kanaly-katalog">← Späť</a></p>
<div class="card"><p>Kanálov bez loga: <b>${m.length}</b> · nájdené (overené obrázky): <b>${hit.length}</b> · nenájdené: <b>${no.length}</b></p><p class="hint">Podľa zdroja: ${Object.entries(hit.reduce((a, x) => (a[x.src] = (a[x.src] || 0) + 1, a), {})).map(([k, n]) => esc(LOGOS.SRC_LABEL[k] || k) + ' ' + n).join(' · ')}</p><p class="hint">Zdroje v poradí: GitHub tv-logo/tv-logos (záložne cdn.jsdelivr.net) → iptv-org (len logá) → picons/picons → Wikidata/Commons; pre filmy/seriály/VOD plagát z Wikipédie (titul + rok). Plagáty z Wikipédie môžu byť chránené autorským právom. Každé logo bolo overené (HTTP 200, obrázok). Uložia sa len kanálom, ktoré stále nemajú logo; akcia sa dá vrátiť z Koša.</p>${src}</div>
${hit.length ? `<div class="card"><h2>Ukážka</h2>${hit.slice(0, 24).map((x) => `<p><img src="${esc(x.url)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer" style="object-fit:contain;vertical-align:middle"> <b>${esc(x.name)}</b> <span class="hint">${esc(x.category)} · ${esc(LOGOS.SRC_LABEL[x.src] || x.src)} · ${esc(LOGOS.short(x.url))}</span></p>`).join('')}</div>
<form method="post" action="/admin/tvch/logos/confirm" class="card">${hid(req)}<input type="hidden" name="tok" value="${tok}"><label class="ck"><input type="checkbox" name="confirm" value="1" required> Uložiť ${hit.length} log</label><button>Uložiť logá</button></form>` : ''}
${no.length ? `<details class="card"><summary>Nenájdené (${no.length}) – zobrazí sa im automaticky generované logo s názvom</summary><p>${no.slice(0, 6).map((x) => `<img src="/tvlogo/${x.id}?v=b" alt="" width="64" height="64"> `).join('')}</p><p class="hint">${no.slice(0, 1000).map((x) => esc(x.name)).join(', ')}</p></details>` : ''}`, 'adm'));
  }));
  admin.post('/tvch/logos/confirm', needAuth, csrf, wrap(async (req, res) => {
    if (req.body.confirm !== '1') return back(res, 'needconfirm');
    const pd = pending.get(String(req.body.tok || '')); if (!pd || !pd.logos) return back(res, 'expired'); pending.delete(String(req.body.tok));
    const c = await pool.connect(); const ch = [];
    try {
      await c.query('BEGIN');
      for (const x of pd.logos) if (safeLogo(x.url) === x.url && (await c.query(`UPDATE tv_channels SET logo=$1 WHERE id=$2 AND logo='' RETURNING id`, [x.url, x.id])).rowCount) ch.push({ id: x.id, old: '', url: x.url });
      await logoTrash(c, ch, `Doplnené logá – ${ch.length} kanálov (obnoviť = vrátiť späť)`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); drop(); }
    back(res, 'logos');
  }));
  admin.get('/tvch/:id(\\d+)/logo', needAuth, wrap(async (req, res) => {
    const r = (await all()).find((x) => x.id === +req.params.id); if (!r) return back(res, 'ok');
    let sg = [], err = ''; try { sg = await LOGOS.suggest(r.name, r.category); } catch (e) { err = e.message; console.error('tvlogos suggest failed:', e.message); } if (!sg.length && LOGOS.status().lastErr) err = err || LOGOS.status().lastErr;
    res.send(page('Nájsť logo', `<h1>🔎 Logo pre „${esc(r.name)}“</h1><p><a href="/admin/kanaly-katalog">← Späť</a></p>${err ? `<p class="err">Problém so zdrojom log: ${esc(err)}</p>` : ''}
${r.logo ? `<p>Aktuálne: <img src="${esc(r.logo)}" alt="" width="48" height="48" referrerpolicy="no-referrer"></p>` : ''}
${sg.map((x) => `<form method="post" action="/admin/tvch/${r.id}/setlogo" class="card">${hid(req)}<input type="hidden" name="logo" value="${esc(x.url)}"><p><img src="${esc(x.url)}" alt="" width="64" height="64" referrerpolicy="no-referrer" style="object-fit:contain;vertical-align:middle"> <span class="hint">${esc(LOGOS.SRC_LABEL[x.src] || x.src)}${x.country ? ' · ' + esc(x.country) : ''} · ${esc(LOGOS.short(x.url))}</span></p><button>Použiť toto logo</button></form>`).join('') || (err ? '' : '<p class="hint">Nenašlo sa žiadne logo. Môžete zadať vlastnú https URL v úprave kanála.</p>')}`, 'adm'));
  }));
  admin.post('/tvch/:id(\\d+)/setlogo', needAuth, csrf, wrap(async (req, res) => {
    const url = String(req.body.logo || ''); if (!url || safeLogo(url) !== url) return back(res, 'badlogo');
    const c = await pool.connect();
    try { await c.query('BEGIN'); const o = (await c.query('SELECT name,logo FROM tv_channels WHERE id=$1 FOR UPDATE', [+req.params.id])).rows[0];
      if (o) { await c.query('UPDATE tv_channels SET logo=$1 WHERE id=$2', [url, +req.params.id]); await logoTrash(c, [{ id: +req.params.id, old: o.logo, url }], `Zmena loga – ${o.name} (obnoviť = vrátiť späť)`); }
      await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); drop(); }
    back(res, 'ok');
  }));
  admin.post('/tvch/logos/check', needAuth, csrf, wrap(async (req, res) => {
    for (const [k, v] of jobs) if (v.exp < Date.now()) jobs.delete(k);
    const running = [...jobs.entries()].find(([, v]) => !v.done && v.kind === 'check'); if (running) return res.redirect(303, '/admin/tvch/logos/check/' + running[0]);
    const list = (await all()).filter((r) => r.logo), id = crypto.randomBytes(12).toString('hex');
    const j = { kind: 'check', done: false, n: 0, total: list.length, exp: Date.now() + 30 * 60e3, bad: [] }; jobs.set(id, j);
    (async () => { let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const ch = list[i++]; const r = await ensureLogo(ch, true).catch((e) => ({ ok: false, err: e.message })); if (!r.ok) j.bad.push({ id: ch.id, name: ch.name, url: ch.logo, err: r.err }); j.n++; } })); })().catch((e) => console.error('logo check', e.message)).finally(() => { j.done = true; });
    res.redirect(303, '/admin/tvch/logos/check/' + id);
  }));
  admin.get('/tvch/logos/check/:id([a-f0-9]{24})', needAuth, wrap(async (req, res) => {
    const j = jobs.get(req.params.id); if (!j || j.kind !== 'check') return back(res, 'expired');
    res.setHeader('Cache-Control', 'no-store');
    if (!j.done) return res.send(page('Kontrola log…', `<meta http-equiv="refresh" content="2"><h1>🩺 Kontrolujem logá…</h1><p>Skontrolované <b>${j.n}</b> / ${j.total}.</p><p><a href="/admin/kanaly-katalog">← Späť</a></p>`, 'adm'));
    const tok = crypto.randomBytes(18).toString('hex'); pending.set(tok, { clear: j.bad.map((b) => ({ id: b.id, url: b.url })), exp: Date.now() + 30 * 60e3 });
    res.send(page('Kontrola log', `<h1>🩺 Kontrola log</h1><p><a href="/admin/kanaly-katalog">← Späť</a></p><div class="card"><p>Skontrolovaných: <b>${j.total}</b> · funkčných: <b>${j.total - j.bad.length}</b> · nefunkčných: <b>${j.bad.length}</b></p><p class="hint">Funkčné logá sú uložené v cache ako PNG a stránka ich zobrazuje z vlastnej adresy (/tvlogo/…).</p></div>
${j.bad.length ? `<div class="card"><h2>Nefunkčné</h2>${j.bad.slice(0, 500).map((b) => `<p><b>${esc(b.name)}</b> <span class="hint">${esc(b.err)} · ${esc(String(b.url).slice(0, 100))}</span></p>`).join('')}</div>
<form method="post" action="/admin/tvch/logos/clear" class="card">${hid(req)}<input type="hidden" name="tok" value="${tok}"><label class="ck"><input type="checkbox" name="confirm" value="1" required> Vymazať ${j.bad.length} nefunkčných log (dá sa vrátiť z Koša)</label><button class="d">Vymazať nefunkčné logá</button></form>` : ''}`, 'adm'));
  }));
  admin.post('/tvch/logos/clear', needAuth, csrf, wrap(async (req, res) => {
    if (req.body.confirm !== '1') return back(res, 'needconfirm');
    const pd = pending.get(String(req.body.tok || '')); if (!pd || !pd.clear) return back(res, 'expired'); pending.delete(String(req.body.tok));
    const c = await pool.connect(); const ch = [];
    try {
      await c.query('BEGIN');
      for (const x of pd.clear) if ((await c.query(`UPDATE tv_channels SET logo='' WHERE id=$1 AND logo=$2 RETURNING id`, [x.id, x.url])).rowCount) ch.push({ id: x.id, old: x.url, url: '' });
      await logoTrash(c, ch, `Vymazané nefunkčné logá – ${ch.length} kanálov (obnoviť = vrátiť späť)`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); drop(); brokenCache = null; }
    back(res, 'ok');
  }));
  const catSel = (cats, cur, nm) => `<select name="${nm}">${cats.map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('')}<option value="">➕ nová kategória…</option></select>`;
  const input = (b) => {
    const name = cleanTxt(b.name, 120), category = cleanTxt(b.newcat, 80) || cleanTxt(b.category, 80) || 'Ostatné';
    if (!txtOk(name) || !txtOk(category)) return { err: 'bad' };
    const logo = safeLogo(b.logo); if (logo === null) return { err: 'badlogo' };
    return { name, category, logo };
  };
  admin.get('/kanaly-katalog', needAuth, wrap(async (req, res) => {
    const rows = await all(), g = groups(rows), cats = [...g.keys()], broken = await brokenIds();
    const ep = ctx.epgAdminPrep ? await ctx.epgAdminPrep() : null;
    const rc = Object.fromEntries((await pool.query('SELECT channel_id, COUNT(*) FILTER (WHERE NOT resolved)::int AS o, COUNT(*)::int AS n FROM tv_channel_reports GROUP BY channel_id')).rows.map((r) => [r.channel_id, r]));
    const rcs = (id) => rc[id] ? ` <span class="hint">⚠ ${rc[id].o} otvorených / ${rc[id].n} hlásení</span>` : '';
    const m = MS[req.query.m] ? `<p class="${/^(ok|added|trashed|imported|logos)$/.test(req.query.m) ? 'ok' : 'err'}">${esc(MS[req.query.m])}</p>` : '';
    res.send(page('Katalóg kanálov', `<h1>📺 Katalóg kanálov</h1>${m}<p><a href="/admin">← Admin</a> · <a href="/admin#kanaly">nastavenia sekcie</a> · <a href="/admin#trash">🗑️ Kôš</a> · <a href="/admin/epg">🗓 TV program (EPG)</a></p>
<p class="hint">Ukladajú sa iba <b>názvy, kategórie a logá</b>. Stream URL, M3U/Xtream údaje ani playlist odkazy sa neprijímajú. Verejne sa zobrazuje na stránke Kanály (zoskupené podľa kategórií, s vyhľadávaním). Texty na verejnej stránke upravíte v <a href="/admin/texty">✏️ Texty</a>.</p>
<form method="post" action="/admin/tvch" class="card" id="add">${hid(req)}<h2>➕ Pridať kanál</h2>
<label>Názov</label><input name="name" maxlength="120" required>
<label>Kategória</label>${cats.length ? catSel(cats, '', 'category') : ''}<input name="newcat" maxlength="80" placeholder="${cats.length ? 'alebo nová kategória' : 'Kategória'}">
<label>Logo (voliteľné, https URL obrázka)</label><input name="logo" type="url" maxlength="500" placeholder="https://…/logo.png"><button>Pridať</button></form>
<script src="/static/tvch.js?v=2" defer></script><form method="post" action="/admin/tvch/logos/check" class="card">${hid(req)}<h2>🩺 Skontrolovať logá</h2><p class="hint">Stiahne a overí všetky uložené logá (cez vlastnú cache/proxy, prevod na PNG). Nefunkčné (${broken.size} známych) ukáže a po potvrdení ich vymaže (vrátiť z Koša).</p><button>Skontrolovať logá</button></form>
<form method="post" action="/admin/tvch/logos/preview" class="card" id="logos">${hid(req)}<h2>🖼 Logá</h2><p class="hint">Vyhľadá logá pre kanály bez loga vo verejnom repozitári GitHub tv-logo/tv-logos (podľa názvu a kategórie). Pred uložením uvidíte náhľad. Načítanie môže trvať do ~1 minúty.</p><button>Doplniť chýbajúce logá</button></form>
<form method="post" action="/admin/tvch/import" enctype="multipart/form-data" class="card" id="import">${hid(req)}<h2>⬆ Import z CSV / Excel (.xlsx)</h2>
<p class="hint">Stĺpce: <b>name/názov</b>, <b>category/kategória</b>, <b>logo</b> (voliteľné). Hlavička a oddeľovač (, ; tab) sa zistia automaticky, UTF-8 s diakritikou. Max 5 MB, 5000 riadkov. Stĺpce s URL streamov/playlistov sa ignorujú. Pred uložením uvidíte náhľad. <a href="/admin/tvch/sablona.csv">⬇ Stiahnuť šablónu CSV</a></p>
<input type="file" name="file" accept=".csv,.txt,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required><button>Náhľad importu</button></form>
${await reportsAdmin(req)}<h2>Kanály (${rows.length})</h2>
${[...g].map(([c, l]) => `<details class="card"><summary><b>${esc(c)}</b> <span class="hint">${l.length} kanálov${l.some((r) => rc[r.id] && rc[r.id].o) ? ' · ⚠ ' + l.reduce((a, r) => a + ((rc[r.id] || {}).o || 0), 0) + ' hlásení' : ''}${l.some((r) => !r.visible) ? ` · ${l.filter((r) => !r.visible).length} skrytých` : ''}</span></summary>
${l.map((r, i) => `<div class="card"><form method="post" action="/admin/tvch/${r.id}/edit">${hid(req)}<p>${logoImg(r, 28, broken)}${r.logo ? '' : ' <span class="hint">(generované)</span>'} <b>${esc(r.name)}</b>${r.visible ? '' : ' <span class="hint">(skrytý)</span>'}${rcs(r.id)}</p>
<label>Názov</label><input name="name" maxlength="120" value="${esc(r.name)}" required><label>Kategória</label>${catSel(cats, c, 'category')}<input name="newcat" maxlength="80" placeholder="alebo nová kategória">
<label>Logo (https) · <a href="/admin/tvch/${r.id}/logo">🔎 Nájsť logo</a></label><input name="logo" type="url" maxlength="500" value="${esc(r.logo)}">${ep ? ctx.epgAdminField(ep, r) : ''}<label class="ck"><input type="checkbox" name="visible" value="1"${r.visible ? ' checked' : ''}> Viditeľný</label><button>Uložiť</button></form>
<div class="row">${i > 0 ? `<form method="post" action="/admin/tvch/${r.id}/move">${hid(req)}<input type="hidden" name="dir" value="up"><button>▲</button></form>` : ''}${i < l.length - 1 ? `<form method="post" action="/admin/tvch/${r.id}/move">${hid(req)}<input type="hidden" name="dir" value="down"><button>▼</button></form>` : ''}
<form method="post" action="/admin/tvch/${r.id}/toggle">${hid(req)}<button>${r.visible ? '🙈 Skryť' : '👁 Zobraziť'}</button></form>
<form method="post" action="/admin/tvch/${r.id}/delete">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> potvrdiť</label><button class="d">🗑 Zmazať</button></form></div></div>`).join('')}</details>`).join('') || '<p class="hint">Katalóg je prázdny.</p>'}`, 'adm'));
  }));
  admin.get('/tvch/sablona.csv', needAuth, (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kanaly-sablona.csv"' });
    res.send('\uFEFFnázov;kategória;logo\nJednotka;Slovenské;https://example.com/logo-jednotka.png\nMarkíza;Slovenské;\nČT1;České;\nEurosport 1;Šport;\n');
  });
  admin.post('/tvch', needAuth, csrf, wrap(async (req, res) => {
    const r = input(req.body); if (r.err) return back(res, r.err, 'add');
    if ((await pool.query('SELECT 1 FROM tv_channels WHERE lower(name)=lower($1) AND lower(category)=lower($2)', [r.name, r.category])).rowCount) return back(res, 'dupe', 'add');
    await pool.query('INSERT INTO tv_channels (name,category,logo,ord) VALUES ($1,$2,$3,(SELECT COALESCE(MAX(ord),0)+1 FROM tv_channels))', [r.name, r.category, r.logo]); drop(); back(res, 'added');
  }));
  admin.post('/tvch/:id(\\d+)/edit', needAuth, csrf, wrap(async (req, res) => {
    const r = input(req.body); if (r.err) return back(res, r.err);
    await pool.query('UPDATE tv_channels SET name=$1,category=$2,logo=$3,visible=$4 WHERE id=$5', [r.name, r.category, r.logo, !!req.body.visible, +req.params.id]); drop();
    if (ctx.epgOnEdit && !(await ctx.epgOnEdit(+req.params.id, req.body))) return back(res, 'badepg');
    back(res, 'ok');
  }));
  admin.post('/tvch/:id(\\d+)/toggle', needAuth, csrf, wrap(async (req, res) => { await pool.query('UPDATE tv_channels SET visible=NOT visible WHERE id=$1', [+req.params.id]); drop(); back(res, 'ok'); }));
  admin.post('/tvch/:id(\\d+)/move', needAuth, csrf, wrap(async (req, res) => {
    const rows = await all(), me = rows.find((r) => r.id === +req.params.id);
    if (me) {
      const l = rows.filter((r) => r.category === me.category), i = l.indexOf(me), j = req.body.dir === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < l.length) { const o = l[j]; const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('UPDATE tv_channels SET ord=$1 WHERE id=$2', [o.ord === me.ord ? o.ord + (j > i ? 1 : -1) : o.ord, me.id]); await c.query('UPDATE tv_channels SET ord=$1 WHERE id=$2', [me.ord, o.id]); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); drop(); } }
    }
    back(res, 'ok');
  }));
  admin.post('/tvch/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => {
    if (req.body.confirm !== '1') return back(res, 'needconfirm');
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = (await c.query('DELETE FROM tv_channels WHERE id=$1 RETURNING *', [+req.params.id])).rows[0]; if (r) await c.query(`INSERT INTO l_trash (t,data,label) VALUES ('tvch',$1::jsonb,$2)`, [JSON.stringify(r), (r.name + ' (' + r.category + ')').slice(0, 200)]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); drop(); }
    back(res, 'trashed');
  }));
  admin.post('/tvch/import', needAuth, (req, res, next) => up(req, res, (e) => (e ? back(res, e.code === 'LIMIT_FILE_SIZE' ? 'big' : 'badfile', 'import') : next())), csrf, wrap(async (req, res) => {
    if (!req.file || !req.file.buffer.length) return back(res, 'nofile', 'import');
    const b = req.file.buffer; let p;
    try { p = b[0] === 0x50 && b[1] === 0x4b ? parseXlsx(b) : parseCsv(decode(b)); } catch { return back(res, 'badfile', 'import'); }
    const { items, info } = analyze(p.rows);
    if (info.tooMany) return back(res, 'many', 'import');
    const existing = new Set((await all()).map((r) => (r.name + '|' + r.category).toLowerCase()));
    const newOnes = items.filter((x) => !existing.has((x.name + '|' + x.category).toLowerCase())).length;
    for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
    const tok = crypto.randomBytes(18).toString('hex'); pending.set(tok, { items, exp: Date.now() + 30 * 60e3 });
    const g = groups(items), cur = (await all()).length;
    res.send(page('Náhľad importu', `<h1>⬆ Náhľad importu</h1><p><a href="/admin/kanaly-katalog">← Späť</a></p>
<div class="card"><p>Súbor: <b>${esc(req.file.originalname || '')}</b> · formát: ${p.del === 'xlsx' ? 'Excel .xlsx' : 'CSV, oddeľovač „' + (p.del === '\t' ? 'tab' : esc(p.del)) + '“'} · hlavička: ${info.header ? 'áno' : 'nie (stĺpce: názov, kategória, logo)'}</p>
<p>Mapovanie stĺpcov: názov ← <b>${esc(info.map.name)}</b> · kategória ← <b>${esc(info.map.category)}</b> · logo ← <b>${esc(info.map.logo)}</b></p>
<table><tr><th>Názov</th><th>Kategória</th><th>Logo</th></tr>${(info.sample || []).map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.category)}</td><td>${x.logo ? esc(x.logo.slice(0, 60)) : '—'}</td></tr>`).join('')}</table>
<p>Platných kanálov: <b>${items.length}</b> v <b>${g.size}</b> kategóriách · nových oproti katalógu: <b>${newOnes}</b> · duplicít v súbore: ${info.dupes} · preskočených riadkov: ${info.skipped} · neplatných log: ${info.badLogos}</p>
${info.ignoredCols.length ? `<p class="err">⚠ Ignorované stĺpce (neukladáme stream URL, playlisty ani prihlasovacie údaje): ${info.ignoredCols.map(esc).join(', ')}</p>` : ''}${info.streamInMain ? '<p class="err">⚠ Niektoré riadky obsahovali stream odkazy v názve/kategórii – boli preskočené.</p>' : ''}${info.badLogos ? '<p class="hint">Logá, ktoré nie sú https obrázky (napr. stream odkazy alebo porty), boli vynechané.</p>' : ''}</div>
<div class="card"><h2>Kategórie</h2>${[...g].slice(0, 60).map(([c, l]) => `<p><b>${esc(c)}</b> (${l.length}): <span class="hint">${l.slice(0, 8).map((x) => esc(x.name)).join(', ')}${l.length > 8 ? ' …' : ''}</span></p>`).join('')}</div>
${items.length ? `<form method="post" action="/admin/tvch/import/confirm" class="card">${hid(req)}<input type="hidden" name="tok" value="${tok}">
<label class="ck"><input type="radio" name="mode" value="append" checked> Pridať k existujúcim (${cur}) – duplicity (názov+kategória) sa preskočia</label>
<label class="ck"><input type="radio" name="mode" value="replace"> Nahradiť celý katalóg – súčasných ${cur} kanálov pôjde do koša (dá sa vrátiť)</label>
<label class="ck"><input type="checkbox" name="confirm" value="1" required> Potvrdzujem import</label><button>Importovať</button></form>` : '<p class="err">Nenašli sa žiadne platné kanály.</p>'}`, 'adm'));
  }));
  admin.post('/tvch/import/confirm', needAuth, csrf, wrap(async (req, res) => {
    if (req.body.confirm !== '1') return back(res, 'needconfirm', 'import');
    const pd = pending.get(String(req.body.tok || '')); if (!pd || pd.exp < Date.now()) return back(res, 'expired', 'import');
    pending.delete(String(req.body.tok));
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      let existing = new Set();
      if (req.body.mode === 'replace') {
        const old = (await c.query('DELETE FROM tv_channels RETURNING name,category,logo,visible')).rows;
        if (old.length) await c.query(`INSERT INTO l_trash (t,data,label) VALUES ('tvch_bulk',$1::jsonb,$2)`, [JSON.stringify({ rows: old }), `Katalóg kanálov – ${old.length} kanálov (pred importom)`]);
      } else existing = new Set((await c.query('SELECT name,category FROM tv_channels')).rows.map((r) => (r.name + '|' + r.category).toLowerCase()));
      let o = await nextOrd(c); const add = pd.items.filter((x) => !existing.has((x.name + '|' + x.category).toLowerCase()));
      for (let i = 0; i < add.length; i += 500) {
        const ch = add.slice(i, i + 500), v = [];
        await c.query(`INSERT INTO tv_channels (name,category,logo,ord) VALUES ${ch.map((x, k) => { v.push(x.name, x.category, x.logo, o++); return `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4})`; }).join(',')}`, v);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); drop(); }
    back(res, 'imported');
  }));
  return ctx;
};
module.exports._test = { parseCsv, parseXlsx, analyze, decode, safeLogo };
