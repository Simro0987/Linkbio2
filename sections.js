'use strict';
// Section manager loader. Own pages (/:slug/:sec) + home blocks + menu order live in ./sections/*.
// Security: CSRF on every admin POST, needAuth (+2FA), parameterised SQL, whitelist HTML sanitizer, server-side video URL whitelist, magic-byte image check, CSP-safe output.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { embedSrc } = require('./sanitize');
const { slugify, KINDS } = require('./sections/types');

const TAKEN = new Set(['kanaly', 'kanal', 'kanal-nahlasit', 'kanaly-katalog', 'platby', 'kontakt', 'faq', 'o-nas', 'navody', 'navrhy', 'cennik', 'stav', 'admin', 'api', 'img', 'static', 'pay', 'sekcia', 'checkout', 'sekcie']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SEC_V = (() => { try { return crypto.createHash('sha1').update(['sec.js', 'secadm.js'].map((f) => fs.readFileSync(path.join(__dirname, 'static', f), 'utf8')).join()).digest('hex').slice(0, 10); } catch { return '1'; } })();

module.exports = function install(ctx) {
  const { app, pool, esc, wrap } = ctx;
  require('./sections/db')(ctx);
  ctx.sectionsInit = () => ctx.secMigrate();

  const titleOf = (req, x) => (req.lang === 'en' && x.title_en ? x.title_en : x.title);
  // Menu items for own pages (keyed s<id> so the admin menu order can place them anywhere).
  ctx.sectionsNavItems = async (req, slug, active) => (await ctx.secPages()).filter((x) => x.visible && x.in_nav)
    .map((x) => ({ k: 's' + x.id, href: `/${slug}/${x.slug}`, on: active === 'sec:' + x.slug, icon: x.icon || '📄', label: titleOf(req, x) }));
  ctx.sectionsNav = async (req, slug, active) => (await ctx.sectionsNavItems(req, slug, active))
    .map((i) => `<li><a href="${esc(i.href)}"${i.on ? ' class="on" aria-current="page"' : ''}><span class="ni">${esc(i.icon)}</span>${esc(i.label)}</a></li>`).join('');
  ctx.sectionsSitemap = async () => (await ctx.secPages()).filter((x) => x.visible).map((x) => '/' + x.slug);

  const thumbOf = (v) => v.thumb || (v.t === 'yt' ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : '');
  function videoHtml(v, i, T) {
    const title = v.title || '';
    if (v.t === 'file') return `<figure class="vid"><div class="vbox"><video controls preload="none" playsinline${v.poster ? ` poster="${esc(v.poster)}"` : ''}><source src="${esc(v.url)}" type="${esc(v.type)}"></video></div>${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
    const th = thumbOf(v), label = (title || T('Prehrať video')) + (v.t === 'yt' ? ' (YouTube)' : ' (Vimeo)');
    return `<figure class="vid"><div class="vbox"><button type="button" class="vplay" data-src="${esc(embedSrc(v))}" data-title="${esc(title || 'Video ' + (i + 1))}" aria-label="${esc(T('Prehrať') + ': ' + label)}">${th ? `<img src="${esc(th)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}<span class="vbtn" aria-hidden="true">▶</span><span class="vsrc">${v.t === 'yt' ? 'YouTube' : 'Vimeo'}</span></button></div>${title ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
  }
  require('./sections/render')(ctx, { videoHtml, SEC_V });

  ctx.sectionRoute = (shell, slugOk, T, loc) => app.get('/:slug/:sec([a-z0-9-]{1,40})', wrap(async (req, res, next) => {
    if (TAKEN.has(req.params.sec)) return next();
    const s = await slugOk(req); if (!s) return next();
    const x = (await ctx.secPages()).find((y) => y.slug === req.params.sec && y.visible); if (!x) return next();
    const en = req.lang === 'en', t = (k) => T(req, k);
    const h1 = `<h1 class="ph">${x.icon ? `<span aria-hidden="true">${esc(x.icon)}</span> ` : ''}${esc(titleOf(req, x))}</h1>`;
    let content;
    if (x.kind === 'text' || x.kind === 'video') {
      const body = en && x.body_en ? x.body_en : x.body;
      const img = x.img_ver ? `<img class="secimg" src="/sekcia-img/${x.id}?v=${esc(x.img_ver)}" alt="" loading="lazy" decoding="async">` : '';
      const vids = x.kind === 'video' ? `<div class="vids">${(x.videos || []).map((v, i) => videoHtml(v, i, t)).join('') || `<p class="hint">${t('Zatiaľ žiadne videá.')}</p>`}</div><script src="/static/sec.js?v=${SEC_V}" defer></script>` : '';
      content = `${h1}${img}${body ? `<div class="prose sec">${body}</div>` : ''}${vids}`;
    } else content = h1 + ((await ctx.secPageBody(req, s, x)) || `<p class="hint">${t('Obsah pripravujeme.')}</p>`);
    await shell(req, res, s, 'sec:' + x.slug, titleOf(req, x) + ' – ' + loc(req, s, 'title'), content);
  }));
  app.get('/sekcia-img/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query(`SELECT img_mime,img_data,img_ver FROM site_sections WHERE id=$1 AND img_data IS NOT NULL AND visible`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).end();
    const im = r.rows[0];
    res.setHeader('Content-Type', im.img_mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', req.query.v === im.img_ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.end(im.img_data);
  }));

  require('./sections/admin')(ctx, { SEC_V, TAKEN, SLUG });
  require('./sections/edit')(ctx, { SEC_V, videoHtml });
  require('./sections/save')(ctx);
  return ctx;
};
module.exports.slugify = slugify; module.exports.TAKEN = TAKEN; module.exports.KINDS = KINDS;
