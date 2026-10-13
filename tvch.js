'use strict';
// TV channel catalog (names, categories, logos only – never stream URLs / playlists / credentials).
const { tx } = require('./uitext');
const crypto = require('crypto');
const zlib = require('zlib');
const multer = require('multer');

const MAX_ROWS = 5000, MAX_BYTES = 5 * 1024 * 1024;
const STREAMISH = /(^|\b)(rtmp|rtsp|rtp|udp|mms|srt|hls)s?:\/\/|\.m3u8?\b|\.ts(\?|$|\b)|\.mpd\b|get\.php|player_api|xmltv\.php|[?&](username|password|user|pass|token)=|^https?:\/\/[^/\s]*:\d{2,5}(\/|$)|^https?:\/\/[^/\s]*@/i;
const ANYURL = /^\s*[a-z][a-z0-9+.-]{1,10}:\/\//i;
const isStream = (v) => STREAMISH.test(String(v || '').trim());
const H_NAME = /^(name|názov|nazov|kanál|kanal|channel|meno)$/i, H_CAT = /^(category|kategória|kategoria|group|skupina|žáner|zaner|genre)$/i, H_LOGO = /^(logo|logo ?url|icon|ikona|tvg-logo)$/i;
const H_BAD = /url|stream|link|odkaz|m3u|playlist|xtream|user|pass|heslo|server|host|port|epg|tvg-id|token/i;

function safeLogo(v) {
  v = String(v || '').trim(); if (!v) return '';
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
  const h = rows[0].map((c) => cleanTxt(c, 60));
  let ni = h.findIndex((c) => H_NAME.test(c)), ci = h.findIndex((c) => H_CAT.test(c)), li = h.findIndex((c) => H_LOGO.test(c));
  let body = rows;
  if (ni >= 0 || ci >= 0) {
    info.header = true; body = rows.slice(1);
    h.forEach((c, i) => { if (i !== ni && i !== ci && i !== li && c) info.ignoredCols.push(c + (H_BAD.test(c) ? ' ⚠' : '')); });
    if (ni < 0) ni = [0, 1, 2].find((i) => i !== ci && i !== li);
  } else { ni = 0; ci = 1; li = 2; }
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
    const name = cleanTxt(r[ni], 120), cat = cleanTxt(r[ci], 80) || 'Ostatné';
    if (!txtOk(name) || !txtOk(cat)) { info.skipped++; continue; }
    let logo = li >= 0 ? safeLogo(r[li]) : '';
    if (logo === null) { info.badLogos++; logo = ''; }
    const k = (name + '|' + cat).toLowerCase(); if (seen.has(k)) { info.dupes++; continue; }
    seen.add(k); items.push({ name, category: cat, logo });
  }
  return { items, info };
}

module.exports = function install(ctx) {
  const { app, admin, pool, page, esc, hid, csrf, needAuth, wrap } = ctx;
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 5, fieldSize: 1024 } }).single('file');
  const pending = new Map();
  let cache = null; const drop = () => { cache = null; };
  const all = async () => cache || (cache = (await pool.query('SELECT id,name,category,logo,ord,visible FROM tv_channels ORDER BY ord,id')).rows);
  const nextOrd = async (c) => (await c.query('SELECT COALESCE(MAX(ord),0)+1 AS n FROM tv_channels')).rows[0].n;
  const groups = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.category)) m.set(r.category, []); m.get(r.category).push(r); } return m; };
  const back = (res, m, a = '') => res.redirect(303, '/admin/kanaly-katalog?m=' + m + (a ? '#' + a : ''));
  const MS = { ok: 'Uložené.', added: 'Kanál pridaný.', trashed: 'Presunuté do koša – obnoviť v Admin › Kôš.', bad: 'Neplatný názov alebo kategória (nesmie obsahovať URL).', badlogo: 'Logo musí byť https odkaz na obrázok (bez portu, nie stream/playlist).', needconfirm: 'Akciu treba potvrdiť zaškrtnutím.', nofile: 'Chýba súbor.', big: 'Súbor je väčší ako 5 MB.', badfile: 'Súbor sa nepodarilo prečítať (CSV alebo .xlsx).', many: 'Príliš veľa riadkov (max 5000).', expired: 'Náhľad vypršal – nahrajte súbor znova.', imported: 'Import dokončený.', dupe: 'Kanál s týmto názvom už v kategórii existuje.' };

  ctx.tvchInit = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS tv_channels (id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Ostatné', logo TEXT NOT NULL DEFAULT '', ord INT NOT NULL DEFAULT 0, visible BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  };
  // restore from l_trash (called by server restore route inside its transaction)
  ctx.tvchRestore = async (c, x) => {
    const rows = x.t === 'tvch_bulk' ? (x.data.rows || []) : [x.data];
    let o = await nextOrd(c);
    for (const r of rows) await c.query('INSERT INTO tv_channels (name,category,logo,ord,visible) VALUES ($1,$2,$3,$4,$5)', [r.name, r.category, r.logo || '', o++, r.visible !== false]);
    drop();
  };
  ctx.tvchPublic = async (req) => {
    const en = req.lang === 'en';
    const rows = (await all()).filter((r) => r.visible); if (!rows.length) return '';
    const g = groups(rows);
    return `<section class="tvcat"><h2 class="ph">${esc(tx(en, 'Zoznam kanálov', 'Channel list'))}</h2><p class="lead">${esc(tx(en, 'Kanály podľa kategórií. Kliknite na kategóriu pre rozbalenie.', 'Channels by category. Click a category to expand.'))}</p>
<input type="search" id="tvq" class="tvq" placeholder="${esc(tx(en, '🔎 Hľadať kanál…', '🔎 Search channel…'))}" aria-label="${esc(tx(en, 'Hľadať kanál', 'Search channel'))}" autocomplete="off">
<p class="hint" id="tvnone" hidden>${esc(tx(en, 'Žiadny kanál nezodpovedá hľadaniu.', 'No channel matches your search.'))}</p>
${[...g].map(([c, l]) => `<details class="tvg"><summary><span class="tt">${esc(c)}</span><span class="tm">${l.length} ${esc(tx(en, 'kanálov', 'channels'))}</span></summary><ul class="tvl">${l.map((r) => `<li class="tch" data-n="${esc((r.name + ' ' + c).toLowerCase())}">${r.logo ? `<img src="${esc(r.logo)}" alt="" loading="lazy" decoding="async" width="40" height="40" referrerpolicy="no-referrer">` : `<span class="tli">${esc([...r.name][0].toUpperCase())}</span>`}<span>${esc(r.name)}</span></li>`).join('')}</ul></details>`).join('')}
<p class="hint">${rows.length} ${esc(tx(en, 'kanálov celkom', 'channels in total'))}</p></section><script src="/static/tvch.js?v=1" defer></script>`;
  };

  const catSel = (cats, cur, nm) => `<select name="${nm}">${cats.map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('')}<option value="">➕ nová kategória…</option></select>`;
  const input = (b) => {
    const name = cleanTxt(b.name, 120), category = cleanTxt(b.newcat, 80) || cleanTxt(b.category, 80) || 'Ostatné';
    if (!txtOk(name) || !txtOk(category)) return { err: 'bad' };
    const logo = safeLogo(b.logo); if (logo === null) return { err: 'badlogo' };
    return { name, category, logo };
  };
  admin.get('/kanaly-katalog', needAuth, wrap(async (req, res) => {
    const rows = await all(), g = groups(rows), cats = [...g.keys()];
    const m = MS[req.query.m] ? `<p class="${/^(ok|added|trashed|imported)$/.test(req.query.m) ? 'ok' : 'err'}">${esc(MS[req.query.m])}</p>` : '';
    res.send(page('Katalóg kanálov', `<h1>📺 Katalóg kanálov</h1>${m}<p><a href="/admin">← Admin</a> · <a href="/admin#kanaly">nastavenia sekcie</a> · <a href="/admin#trash">🗑️ Kôš</a></p>
<p class="hint">Ukladajú sa iba <b>názvy, kategórie a logá</b>. Stream URL, M3U/Xtream údaje ani playlist odkazy sa neprijímajú. Verejne sa zobrazuje na stránke Kanály (zoskupené podľa kategórií, s vyhľadávaním). Texty na verejnej stránke upravíte v <a href="/admin/texty">✏️ Texty</a>.</p>
<form method="post" action="/admin/tvch" class="card" id="add">${hid(req)}<h2>➕ Pridať kanál</h2>
<label>Názov</label><input name="name" maxlength="120" required>
<label>Kategória</label>${cats.length ? catSel(cats, '', 'category') : ''}<input name="newcat" maxlength="80" placeholder="${cats.length ? 'alebo nová kategória' : 'Kategória'}">
<label>Logo (voliteľné, https URL obrázka)</label><input name="logo" type="url" maxlength="500" placeholder="https://…/logo.png"><button>Pridať</button></form>
<form method="post" action="/admin/tvch/import" enctype="multipart/form-data" class="card" id="import">${hid(req)}<h2>⬆ Import z CSV / Excel (.xlsx)</h2>
<p class="hint">Stĺpce: <b>name/názov</b>, <b>category/kategória</b>, <b>logo</b> (voliteľné). Hlavička a oddeľovač (, ; tab) sa zistia automaticky, UTF-8 s diakritikou. Max 5 MB, 5000 riadkov. Stĺpce s URL streamov/playlistov sa ignorujú. Pred uložením uvidíte náhľad. <a href="/admin/tvch/sablona.csv">⬇ Stiahnuť šablónu CSV</a></p>
<input type="file" name="file" accept=".csv,.txt,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required><button>Náhľad importu</button></form>
<h2>Kanály (${rows.length})</h2>
${[...g].map(([c, l]) => `<details class="card"><summary><b>${esc(c)}</b> <span class="hint">${l.length} kanálov${l.some((r) => !r.visible) ? ` · ${l.filter((r) => !r.visible).length} skrytých` : ''}</span></summary>
${l.map((r, i) => `<div class="card"><form method="post" action="/admin/tvch/${r.id}/edit">${hid(req)}<p>${r.logo ? `<img src="${esc(r.logo)}" alt="" width="28" height="28" loading="lazy" referrerpolicy="no-referrer"> ` : ''}<b>${esc(r.name)}</b>${r.visible ? '' : ' <span class="hint">(skrytý)</span>'}</p>
<label>Názov</label><input name="name" maxlength="120" value="${esc(r.name)}" required><label>Kategória</label>${catSel(cats, c, 'category')}<input name="newcat" maxlength="80" placeholder="alebo nová kategória">
<label>Logo (https)</label><input name="logo" type="url" maxlength="500" value="${esc(r.logo)}"><label class="ck"><input type="checkbox" name="visible" value="1"${r.visible ? ' checked' : ''}> Viditeľný</label><button>Uložiť</button></form>
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
    await pool.query('UPDATE tv_channels SET name=$1,category=$2,logo=$3,visible=$4 WHERE id=$5', [r.name, r.category, r.logo, !!req.body.visible, +req.params.id]); drop(); back(res, 'ok');
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
