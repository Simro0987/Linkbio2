'use strict';
// POST /admin/sekcie/:id – validate & store. Images: magic-byte check (sniff), 2 MB each, max 24 in a gallery.
const crypto = require('crypto');
const multer = require('multer');
const { sanitize, parseVideo } = require('../sanitize');
const { KINDS, cleanCfg, str } = require('./types');

module.exports = function save(ctx) {
  const { admin: r, pool, csrf, needAuth, wrap, setSettings, sniff } = ctx;
  const audit = (req, a, d) => (ctx.audit ? ctx.audit(req, a, d) : null);
  const up = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 13, fields: 400, fieldSize: 32000 } }).fields([{ name: 'image', maxCount: 1 }, { name: 'gal', maxCount: 12 }]);
  const pre = (req, res, next) => up(req, res, (e) => (e ? res.redirect(303, `/admin/sekcie/${Number(req.params.id) || ''}?m=` + (e.code === 'LIMIT_FILE_SIZE' ? 'big' : 'bad')) : next()));
  const ver = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

  async function vimeoMeta(v) {
    try {
      const q = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${v.id}${v.h ? '/' + v.h : ''}`)}&width=640`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!q.ok) return {}; const j = await q.json();
      let th = ''; try { const u = new URL(String(j.thumbnail_url || '')); if (u.protocol === 'https:' && /(^|\.)vimeocdn\.com$/.test(u.hostname)) th = u.href; } catch {}
      return { thumb: th, title: str(j.title, 120) };
    } catch { return {}; }
  }
  async function parseVids(raw, oldList) {
    const old = new Map((oldList || []).map((v) => [v.src, v])); const vids = []; let rejected = 0;
    for (const line of String(raw || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 30)) {
      const [u, ...rest] = line.split('|'); const src = u.trim(), v = parseVideo(src);
      if (!v) { rejected++; continue; }
      v.src = src.slice(0, 1000); v.title = str(rest.join('|'), 120);
      if (v.t === 'vimeo') { const o = old.get(src); const meta = o && o.thumb !== undefined ? { thumb: o.thumb } : await vimeoMeta(v); v.thumb = meta.thumb || ''; if (!v.title && meta.title) v.title = meta.title; }
      vids.push(v);
    }
    return { vids, rejected };
  }

  r.post('/sekcie/:id(\\d+)', needAuth, pre, csrf, wrap(async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, back = (m) => res.redirect(303, `/admin/sekcie/${id}?m=${m}`);
    const q = await pool.query(`SELECT id,kind,place,slug,cfg,videos FROM site_sections WHERE id=$1`, [id]); if (!q.rowCount) return res.redirect(303, '/admin/sekcie');
    const x = q.rows[0], isPage = x.place !== 'home';
    const title = str(b.title, 60); if (!title) return back('bad');
    let slug = x.slug; if (isPage) { slug = str(b.slug, 40); if (!(await ctx.secOkSlug(slug, id))) return back('slug'); }
    const kind = isPage && ['text', 'video'].includes(x.kind) && ['text', 'video'].includes(b.kind) ? b.kind : x.kind;
    if (!KINDS[kind]) return back('bad');
    const cfg = cleanCfg(kind, b, x.cfg);
    if (kind === 'countdown' && !cfg.t) return back('cd');
    const files = req.files || {}, sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    add('title', title); add('title_en', str(b.title_en, 60)); add('icon', ctx.secIcon(b.icon)); add('slug', slug); add('kind', kind);
    add('visible', b.visible === '1'); add('in_nav', isPage ? b.in_nav === '1' : false);
    let rejected = 0;
    if (kind === 'text' || kind === 'video') {
      const raw = String(b.body || '').replace(/\r/g, '').slice(0, 20000), rawEn = String(b.body_en || '').replace(/\r/g, '').slice(0, 20000);
      add('body', sanitize(raw)); add('body_en', sanitize(rawEn)); add('body_raw', raw); add('body_en_raw', rawEn);
    }
    if (kind === 'video') { const v = await parseVids(b.videos, x.videos); rejected = v.rejected; add('videos', JSON.stringify(v.vids)); sets[sets.length - 1] += '::jsonb'; }
    if (kind === 'text') {
      const f = (files.image || [])[0];
      if (f && f.buffer.length) { const mime = sniff(f.buffer); if (!mime) return back('badimg'); add('img_mime', mime); add('img_data', f.buffer); add('img_ver', ver(f.buffer)); }
      else if (b.img_del === '1') sets.push('img_mime=NULL', 'img_data=NULL', 'img_ver=NULL');
    }
    if (kind === 'gallery') {
      const g = await pool.query(`SELECT id FROM site_section_imgs WHERE sec_id=$1`, [id]), have = g.rows.map((y) => y.id);
      const del = have.filter((gid) => b['gdel_' + gid] === '1'), keep = have.length - del.length, fl = (files.gal || []).filter((f) => f.buffer.length);
      if (keep + fl.length > 24) return back('many');
      const typed = fl.map((f) => ({ f, mime: sniff(f.buffer) })); if (typed.some((t) => !t.mime)) return back('badimg');
      for (const gid of have) if (!del.includes(gid) && b['alt_' + gid] !== undefined) await pool.query(`UPDATE site_section_imgs SET alt=$1 WHERE id=$2 AND sec_id=$3`, [str(b['alt_' + gid], 120), gid, id]);
      if (del.length) await pool.query(`DELETE FROM site_section_imgs WHERE sec_id=$1 AND id=ANY($2::int[])`, [id, del]);
      let pos = (await pool.query(`SELECT COALESCE(MAX(pos),0) AS p FROM site_section_imgs WHERE sec_id=$1`, [id])).rows[0].p;
      for (const t of typed) await pool.query(`INSERT INTO site_section_imgs (sec_id,pos,alt,mime,data,ver) VALUES ($1,$2,'',$3,$4,$5)`, [id, ++pos, t.mime, t.f.buffer, ver(t.f.buffer)]);
    }
    add('cfg', JSON.stringify(cfg)); sets[sets.length - 1] += '::jsonb';
    vals.push(id);
    await pool.query(`UPDATE site_sections SET ${sets.join(',')},updated_at=now() WHERE id=$${vals.length}`, vals);
    ctx.secDrop();
    if (kind === 'chat') await setSettings({ chat_enabled: b.visible === '1' ? '1' : '0' });
    await audit(req, 'section_save', kind + ':' + slug);
    res.redirect(303, `/admin/sekcie/${id}?m=${rejected ? 'vid&n=' + rejected : 'ok'}`);
  }));
  return ctx;
};
