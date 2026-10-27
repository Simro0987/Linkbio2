'use strict';
// Custom sections (admin-managed pages in the public nav): text (sanitized rich/plain text + optional image) or video (YouTube/Vimeo/MP4/WebM, click-to-load).
// Security: CSRF on every admin POST, needAuth (+2FA), parameterised SQL, whitelist HTML sanitizer, server-side video URL whitelist, magic-byte image check.
const crypto = require('crypto');
const multer = require('multer');
const { sanitize, parseVideo, embedSrc } = require('./sanitize');

const KINDS = { text: 'Text (+ obrázok)', video: 'Video' };
const TAKEN = new Set(['kanaly', 'kanal', 'kanal-nahlasit', 'kanaly-katalog', 'platby', 'kontakt', 'faq', 'o-nas', 'navody', 'navrhy', 'cennik', 'stav', 'admin', 'api', 'img', 'static', 'pay', 'sekcia', 'checkout']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const slugify = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

module.exports = function install(ctx) {
  const { app, admin, pool, page, esc, hid, csrf, needAuth, wrap, sniff, clean, getSettings } = ctx;
  const audit = (req, a, d) => (ctx.audit ? ctx.audit(req, a, d) : null);
  let cache = null;
  const all = async () => {
    if (cache && cache.t > Date.now() - 30000) return cache.rows;
    const r = await pool.query(`SELECT id,pos,slug,title,title_en,icon,kind,body,body_en,videos,visible,in_nav,img_ver,updated_at FROM site_sections ORDER BY pos,id`);
    cache = { t: Date.now(), rows: r.rows }; return r.rows;
  };
  const drop = () => { cache = null; };
  ctx.sectionsDrop = drop;

  ctx.sectionsInit = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS site_sections (
      id serial PRIMARY KEY, pos int NOT NULL DEFAULT 0, slug text UNIQUE NOT NULL, title text NOT NULL, title_en text NOT NULL DEFAULT '', icon text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT 'text', body text NOT NULL DEFAULT '', body_en text NOT NULL DEFAULT '', body_raw text NOT NULL DEFAULT '', body_en_raw text NOT NULL DEFAULT '',
      videos jsonb NOT NULL DEFAULT '[]'::jsonb, visible boolean NOT NULL DEFAULT true, in_nav boolean NOT NULL DEFAULT true,
      img_mime text, img_data bytea, img_ver text, updated_at timestamptz NOT NULL DEFAULT now())`);
  };

  // ---- public ----
  const titleOf = (req, x) => (req.lang === 'en' && x.title_en ? x.title_en : x.title);
  ctx.sectionsNav = async (req, slug, active) => (await all()).filter((x) => x.visible && x.in_nav)
    .map((x) => `<li><a href="/${esc(slug)}/${esc(x.slug)}"${active === 'sec:' + x.slug ? ' class="on" aria-current="page"' : ''}><span class="ni">${esc(x.icon || '📄')}</span>${esc(titleOf(req, x))}</a></li>`).join('');
  ctx.sectionsSitemap = async () => (await all()).filter((x) => x.visible).map((x) => '/' + x.slug);

  const thumbOf = (v) => v.thumb || (v.t === 'yt' ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : '');
  function videoHtml(v, i, T) {
    const title = v.title || '';
    if (v.t === 'file') return `<figure class="vid"><div class="vbox"><video controls preload="none" playsinline${v.poster ? ` poster="${esc(v.poster)}"` : ''}><source src="${esc(v.url)}" type="${esc(v.type)}"></video></div>${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
    const th = thumbOf(v), label = (title || T('Prehrať video')) + (v.t === 'yt' ? ' (YouTube)' : ' (Vimeo)');
    return `<figure class="vid"><div class="vbox"><button type="button" class="vplay" data-src="${esc(embedSrc(v))}" data-title="${esc(title || 'Video ' + (i + 1))}" aria-label="${esc(T('Prehrať') + ': ' + label)}">${th ? `<img src="${esc(th)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}<span class="vbtn" aria-hidden="true">▶</span><span class="vsrc">${v.t === 'yt' ? 'YouTube' : 'Vimeo'}</span></button></div>${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
  }
  ctx.sectionRoute = (shell, slugOk, T, loc) => app.get('/:slug/:sec([a-z0-9-]{1,40})', wrap(async (req, res, next) => {
    if (TAKEN.has(req.params.sec)) return next();
    const s = await slugOk(req); if (!s) return next();
    const x = (await all()).find((y) => y.slug === req.params.sec && y.visible); if (!x) return next();
    const en = req.lang === 'en', t = (k) => T(req, k);
    const body = en && x.body_en ? x.body_en : x.body;
    const img = x.img_ver ? `<img class="secimg" src="/sekcia-img/${x.id}?v=${esc(x.img_ver)}" alt="" loading="lazy" decoding="async">` : '';
    const vids = x.kind === 'video' ? `<div class="vids">${(x.videos || []).map((v, i) => videoHtml(v, i, t)).join('') || `<p class="hint">${t('Zatiaľ žiadne videá.')}</p>`}</div><script src="/static/sec.js?v=${SEC_V}" defer></script>` : '';
    await shell(req, res, s, 'sec:' + x.slug, titleOf(req, x) + ' – ' + loc(req, s, 'title'),
      `<h1 class="ph">${x.icon ? `<span aria-hidden="true">${esc(x.icon)}</span> ` : ''}${esc(titleOf(req, x))}</h1>${img}${body ? `<div class="prose sec">${body}</div>` : ''}${vids}`);
  }));
  const SEC_V = (() => { try { return crypto.createHash('sha1').update(['sec.js', 'secadm.js'].map((f) => require('fs').readFileSync(require('path').join(__dirname, 'static', f), 'utf8')).join()).digest('hex').slice(0, 10); } catch { return '1'; } })();
  app.get('/sekcia-img/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query(`SELECT img_mime,img_data,img_ver FROM site_sections WHERE id=$1 AND img_data IS NOT NULL AND visible`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).end();
    const im = r.rows[0];
    res.setHeader('Content-Type', im.img_mime); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', req.query.v === im.img_ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.end(im.img_data);
  }));

  // ---- admin ----
  const M = { ok: 'Uložené.', bad: 'Neplatné údaje (názov je povinný).', slug: 'Adresa (slug) je obsadená alebo neplatná – použite a-z, 0-9 a pomlčky.', big: 'Obrázok je príliš veľký (max 2 MB).', badimg: 'Povolené len PNG, JPEG, WebP.', vid: 'Niektoré odkazy na video boli odmietnuté – povolené sú YouTube, Vimeo a priame https odkazy na .mp4/.webm.', del: 'Sekcia zmazaná.', conf: 'Na zmazanie zaškrtnite potvrdenie.' };
  const msg = (q, extra) => (M[q] ? `<div class="msg${q === 'ok' || q === 'del' ? '' : ' err'}">${esc(M[q])}${extra ? ' ' + esc(extra) : ''}</div>` : '');
  const anav = `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="/admin/sekcie">🧩 Sekcie</a><a class="btnl" href="/admin#l-nav">🧭 Navigácia</a></p>`;
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 20, fieldSize: 24000 } }).single('image');
  const withImg = (h) => [needAuth, (req, res, next) => up(req, res, (e) => (e ? res.redirect(303, '/admin/sekcie?m=' + (e.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad')) : next())), csrf, wrap(h)];

  admin.get('/sekcie', needAuth, wrap(async (req, res) => {
    const l = await all(), s = await getSettings();
    const rows = l.map((x, i) => `<div class="card secrow"><div class="sech"><span class="seci">${esc(x.icon || '📄')}</span><div><b>${esc(x.title)}</b> ${x.visible ? '' : '<span class="tag off">skryté</span>'}${x.in_nav ? '' : ' <span class="tag">mimo menu</span>'}<br><span class="hint">${esc(KINDS[x.kind] || x.kind)} · <a href="/${esc(s.slug)}/${esc(x.slug)}" target="_blank" rel="noopener">/${esc(s.slug)}/${esc(x.slug)}</a>${x.kind === 'video' ? ` · ${(x.videos || []).length} video` : ''}</span></div></div>
<div class="row"><a class="btnl" href="/admin/sekcie/${x.id}">✏️ Upraviť</a>${mv(req, x.id, 'up', i === 0)}${mv(req, x.id, 'down', i === l.length - 1)}<form method="post" action="/admin/sekcie/${x.id}/visible">${hid(req)}<button class="g">${x.visible ? '🙈 Skryť' : '👁 Zobraziť'}</button></form></div></div>`).join('');
    res.send(page('Sekcie', `<h1>🧩 Vlastné sekcie</h1>${anav}${msg(req.query.m)}<p class="hint">Sekcie sa zobrazia v ľavom menu webu (za položkami Cenník/Kanály/Kontakt…) v rovnakom štýle. Typ „Video“ prehrá YouTube, Vimeo alebo priame .mp4/.webm odkazy priamo na stránke.</p>
${rows || '<p class="hint">Zatiaľ žiadne sekcie.</p>'}
<details class="card"${l.length ? '' : ' open'}><summary>➕ Pridať sekciu</summary><form method="post" action="/admin/sekcie">${hid(req)}<label>Názov</label><input name="title" required maxlength="60" placeholder="napr. Videonávody"><label>Ikona (emoji, voliteľné)</label><input name="icon" maxlength="8" placeholder="🎬"><label>Typ</label><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select><label>Adresa (slug, voliteľné – inak z názvu)</label><input name="slug" maxlength="40" pattern="[a-z0-9\\-]*"><button>➕ Vytvoriť sekciu</button></form></details>`, 'a adm'));
  }));
  const mv = (req, id, dir, dis) => `<form method="post" action="/admin/sekcie/${id}/move">${hid(req)}<input type="hidden" name="dir" value="${dir}"><button class="g"${dis ? ' disabled' : ''} aria-label="${dir === 'up' ? 'Posunúť vyššie' : 'Posunúť nižšie'}">${dir === 'up' ? '↑' : '↓'}</button></form>`;
  const okSlug = async (sl, id) => SLUG.test(sl) && !TAKEN.has(sl) && !(await pool.query(`SELECT 1 FROM site_sections WHERE slug=$1 AND id<>$2`, [sl, id || 0])).rowCount;
  const icon = (v) => clean(v, 8).replace(/[<>&"'`]/g, '');

  admin.post('/sekcie', needAuth, csrf, wrap(async (req, res) => {
    const t = clean(req.body.title, 60); if (!t) return res.redirect(303, '/admin/sekcie?m=bad');
    const sl = clean(req.body.slug, 40) || slugify(t); if (!(await okSlug(sl))) return res.redirect(303, '/admin/sekcie?m=slug');
    const kind = KINDS[req.body.kind] ? req.body.kind : 'text';
    const r = await pool.query(`INSERT INTO site_sections (slug,title,icon,kind,pos) VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(pos),0)+1 FROM site_sections)) ON CONFLICT (slug) DO NOTHING RETURNING id`, [sl, t, icon(req.body.icon), kind]);
    drop(); if (!r.rowCount) return res.redirect(303, '/admin/sekcie?m=slug');
    await audit(req, 'section_add', sl); res.redirect(303, '/admin/sekcie/' + r.rows[0].id + '?m=ok');
  }));

  admin.get('/sekcie/:id(\\d+)', needAuth, wrap(async (req, res, next) => {
    const r = await pool.query(`SELECT * FROM site_sections WHERE id=$1`, [Number(req.params.id)]); if (!r.rowCount) return next();
    const x = r.rows[0], s = await getSettings();
    const vtext = (x.videos || []).map((v) => (v.src || '') + (v.title ? ' | ' + v.title : '')).join('\n');
    const prev = x.kind === 'video' && (x.videos || []).length ? `<div class="card"><h2>Náhľad videí</h2><div class="vids">${x.videos.map((v, i) => videoHtml(v, i, (k) => k)).join('')}</div><script src="/static/sec.js?v=${SEC_V}" defer></script></div>` : '';
    res.send(page('Sekcia – ' + x.title, `<h1>${esc(x.icon || '📄')} ${esc(x.title)}</h1>${anav}${msg(req.query.m, req.query.n ? `(${Number(req.query.n) || 0}×)` : '')}
<p class="hint">Verejne: <a href="/${esc(s.slug)}/${esc(x.slug)}" target="_blank" rel="noopener">/${esc(s.slug)}/${esc(x.slug)}</a>${x.visible ? '' : ' – <b>skryté</b>'}</p>
<form method="post" action="/admin/sekcie/${x.id}" enctype="multipart/form-data" class="card secedit">${hid(req)}
<div class="g2"><div><label>Názov (SK)</label><input name="title" value="${esc(x.title)}" maxlength="60" required></div><div><label>Názov (EN, voliteľné)</label><input name="title_en" value="${esc(x.title_en)}" maxlength="60"></div>
<div><label>Ikona (emoji, voliteľné)</label><input name="icon" value="${esc(x.icon)}" maxlength="8"></div><div><label>Adresa (slug)</label><input name="slug" value="${esc(x.slug)}" maxlength="40" pattern="[a-z0-9\\-]+" required></div></div>
<label>Typ</label><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${x.kind === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
<label>Text (SK) – obyčajný text (prázdny riadok = nový odsek) alebo HTML: &lt;b&gt; &lt;i&gt; &lt;u&gt; &lt;h2&gt; &lt;h3&gt; &lt;ul&gt;&lt;li&gt; &lt;a href&gt; &lt;blockquote&gt;</label>
<div class="tb" data-for="sb_sk" role="toolbar" aria-label="Formátovanie"><button type="button" class="g" data-tag="b"><b>B</b></button><button type="button" class="g" data-tag="i"><i>I</i></button><button type="button" class="g" data-tag="h2">H2</button><button type="button" class="g" data-tag="ul">• Zoznam</button><button type="button" class="g" data-tag="a">🔗 Odkaz</button></div>
<textarea id="sb_sk" name="body" rows="10" maxlength="20000">${esc(x.body_raw)}</textarea>
<label>Text (EN, voliteľné)</label><textarea name="body_en" rows="5" maxlength="20000">${esc(x.body_en_raw)}</textarea>
<label>Videá – jeden odkaz na riadok, voliteľne s názvom: <code>https://youtu.be/xxxx | Názov videa</code> (YouTube, Vimeo, priamy https .mp4/.webm)</label>
<textarea name="videos" rows="5" maxlength="12000" placeholder="https://www.youtube.com/watch?v=… | Ako nastaviť aplikáciu">${esc(vtext)}</textarea>
${x.img_ver ? `<img class="gprev" src="/sekcia-img/${x.id}?v=${esc(x.img_ver)}" alt="" width="320" height="180"><label class="ck"><input type="checkbox" name="img_del" value="1"> Odstrániť obrázok</label>` : ''}
<label>Obrázok (voliteľné, PNG/JPEG/WebP, max 2 MB)</label><input type="file" name="image" accept="image/png,image/jpeg,image/webp">
<label class="ck"><input type="checkbox" name="visible" value="1"${x.visible ? ' checked' : ''}> Zobraziť verejne</label>
<label class="ck"><input type="checkbox" name="in_nav" value="1"${x.in_nav ? ' checked' : ''}> Zobraziť v ľavom menu</label>
<button>💾 Uložiť</button></form>${prev}
<form method="post" action="/admin/sekcie/${x.id}/delete" class="card">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> Áno, natrvalo zmazať túto sekciu</label><button class="d">🗑️ Zmazať sekciu</button></form>
<script src="/static/secadm.js?v=${SEC_V}" defer></script>`, 'a adm'));
  }));

  async function vimeoMeta(v) {
    try {
      const r = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${v.id}${v.h ? '/' + v.h : ''}`)}&width=640`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!r.ok) return {}; const j = await r.json();
      let th = ''; try { const u = new URL(String(j.thumbnail_url || '')); if (u.protocol === 'https:' && /(^|\.)vimeocdn\.com$/.test(u.hostname)) th = u.href; } catch {}
      return { thumb: th, title: clean(j.title, 120) };
    } catch { return {}; }
  }
  admin.post('/sekcie/:id(\\d+)', ...withImg(async (req, res) => {
    const id = Number(req.params.id);
    const cur = await pool.query(`SELECT videos FROM site_sections WHERE id=$1`, [id]); if (!cur.rowCount) return res.redirect(303, '/admin/sekcie');
    const t = clean(req.body.title, 60), sl = clean(req.body.slug, 40);
    if (!t) return res.redirect(303, `/admin/sekcie/${id}?m=bad`);
    if (!(await okSlug(sl, id))) return res.redirect(303, `/admin/sekcie/${id}?m=slug`);
    let im = null;
    if (req.file && req.file.buffer.length) { const mime = sniff(req.file.buffer); if (!mime) return res.redirect(303, `/admin/sekcie/${id}?m=badimg`); im = { mime, buf: req.file.buffer, ver: crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 12) }; }
    const raw = String(req.body.body || '').replace(/\r/g, '').slice(0, 20000), rawEn = String(req.body.body_en || '').replace(/\r/g, '').slice(0, 20000);
    const old = new Map((cur.rows[0].videos || []).map((v) => [v.src, v]));
    const vids = []; let rejected = 0;
    for (const line of String(req.body.videos || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 30)) {
      const [u, ...rest] = line.split('|'); const src = u.trim(), v = parseVideo(src);
      if (!v) { rejected++; continue; }
      v.src = src.slice(0, 1000); v.title = clean(rest.join('|'), 120);
      if (v.t === 'vimeo') { const o = old.get(src); const meta = o && o.thumb !== undefined ? { thumb: o.thumb } : await vimeoMeta(v); v.thumb = meta.thumb || ''; if (!v.title && meta.title) v.title = meta.title; }
      vids.push(v);
    }
    await pool.query(`UPDATE site_sections SET title=$1,title_en=$2,icon=$3,slug=$4,kind=$5,body=$6,body_en=$7,body_raw=$8,body_en_raw=$9,videos=$10::jsonb,visible=$11,in_nav=$12,updated_at=now()${im ? ',img_mime=$14,img_data=$15,img_ver=$16' : req.body.img_del === '1' ? ',img_mime=NULL,img_data=NULL,img_ver=NULL' : ''} WHERE id=$13`,
      [t, clean(req.body.title_en, 60), icon(req.body.icon), sl, KINDS[req.body.kind] ? req.body.kind : 'text', sanitize(raw), sanitize(rawEn), raw, rawEn, JSON.stringify(vids), req.body.visible === '1', req.body.in_nav === '1', id, ...(im ? [im.mime, im.buf, im.ver] : [])]);
    drop(); await audit(req, 'section_save', sl);
    res.redirect(303, `/admin/sekcie/${id}?m=${rejected ? 'vid&n=' + rejected : 'ok'}`);
  }));
  admin.post('/sekcie/:id(\\d+)/move', needAuth, csrf, wrap(async (req, res) => {
    const l = await all(), i = l.findIndex((x) => x.id === Number(req.params.id)), j = i + (req.body.dir === 'up' ? -1 : 1);
    if (i >= 0 && j >= 0 && j < l.length) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const ord = l.map((x) => x.id); [ord[i], ord[j]] = [ord[j], ord[i]]; for (let k = 0; k < ord.length; k++) await c.query(`UPDATE site_sections SET pos=$1 WHERE id=$2`, [k + 1, ord[k]]); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      drop();
    }
    res.redirect(303, '/admin/sekcie');
  }));
  admin.post('/sekcie/:id(\\d+)/visible', needAuth, csrf, wrap(async (req, res) => {
    await pool.query(`UPDATE site_sections SET visible=NOT visible,updated_at=now() WHERE id=$1`, [Number(req.params.id)]); drop(); res.redirect(303, '/admin/sekcie?m=ok');
  }));
  admin.post('/sekcie/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => {
    const id = Number(req.params.id); if (req.body.confirm !== '1') return res.redirect(303, `/admin/sekcie/${id}?m=conf`);
    const r = await pool.query(`DELETE FROM site_sections WHERE id=$1 RETURNING slug`, [id]); drop();
    if (r.rowCount) await audit(req, 'section_delete', r.rows[0].slug);
    res.redirect(303, '/admin/sekcie?m=del');
  }));
  return ctx;
};
module.exports.slugify = slugify; module.exports.TAKEN = TAKEN;
