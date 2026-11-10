'use strict';
// Public rendering of section blocks (home page + extra kinds on section pages). All output escaped/sanitized; no inline style/script (CSP).
const crypto = require('crypto');
const { sanitize, safeHref, para: sPara } = require('../sanitize');
const { KINDS, parseLinks, parseFaq, cssFor, needsWrap, HEX } = require('./types');

module.exports = function render(ctx, { videoHtml, SEC_V }) {
  const { esc, T, getSettings } = ctx;
  const tx = (en, sk, e) => (en ? e : sk);
  const para = (t) => (sPara ? sPara(t) : esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join(''));
  const titleOf = (req, x) => (req.lang === 'en' && x.title_en ? x.title_en : x.title);
  const H = (req, x, h = 'h2') => `<${h} class="ph xsh">${x.icon ? `<span aria-hidden="true">${esc(x.icon)}</span> ` : ''}${esc(titleOf(req, x))}</${h}>`;
  const logged = (req) => (ctx.accLogged ? ctx.accLogged(req) : /(?:^|;\s*)__Host-acc=/.test(String(req.headers.cookie || '')));

  let cssCache = { v: '', css: '' };
  const cssOf = (rows) => { const css = cssFor(rows); if (css !== cssCache.css) cssCache = { css, v: crypto.createHash('sha1').update(css).digest('hex').slice(0, 10) }; return cssCache; };
  ctx.app.get('/sekcie.css', ctx.wrap(async (req, res) => {
    const c = cssOf(await ctx.secAll()); res.type('text/css');
    res.setHeader('Cache-Control', req.query.v === c.v ? 'public, max-age=31536000, immutable' : 'public, max-age=60'); res.send(c.css);
  }));
  ctx.app.get('/sekcia-gal/:id(\\d+)', ctx.wrap(async (req, res) => {
    const r = await ctx.pool.query(`SELECT g.mime,g.data,g.ver FROM site_section_imgs g JOIN site_sections s ON s.id=g.sec_id WHERE g.id=$1 AND s.visible`, [Number(req.params.id)]).catch(() => ({ rowCount: 0 }));
    if (!r.rowCount) return res.status(404).end();
    const im = r.rows[0];
    res.setHeader('Content-Type', im.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', req.query.v === im.ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60'); res.end(im.data);
  }));

  async function payItems(ids) {
    const br = global.__payBridge && global.__payBridge['/api/admin-bridge/pay-methods'];
    if (!br || !br.state) return [];
    let st; try { st = await br.state(); } catch { return []; }
    const okLogo = (u) => typeof u === 'string' && (/^\/(?!\/)[\w./?=&%-]{1,300}$/.test(u) || /^https:\/\/[\w.-]+\/[\w./?=&%-]{0,300}$/.test(u));
    const out = [];
    for (const g of (st && st.groups) || []) for (const it of g.items || []) {
      if (!it.on || it.soon || /tokigo/i.test(String(it.name || '') + String(it.id || ''))) continue;
      if (ids && ids.length && !ids.includes(String(it.id))) continue;
      out.push({ id: String(it.id), name: String(it.name || ''), logos: (it.logos || []).filter(okLogo).slice(0, 3), g: String(g.label || '') });
    }
    return out;
  }
  ctx.secPayItems = payItems;

  const countdown = (req, c) => {
    const en = req.lang === 'en', left = c.t ? c.t - Date.now() : -1, done = c.done || tx(en, 'Už je to tu!', 'It is here!');
    const L = { d: tx(en, 'dní', 'd'), h: tx(en, 'hod', 'h'), m: tx(en, 'min', 'min'), s: tx(en, 's', 's') };
    if (!c.t) return '';
    const parts = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60]; };
    const [d, h, m, s] = parts(left);
    const u = (n, k, l) => `<span class="cdu"><b data-k="${k}">${n}</b><small>${esc(l)}</small></span>`;
    return `<div class="cd" data-t="${Number(c.t)}" data-done="${esc(done)}" role="timer" aria-live="off">${left > 0 ? u(d, 'd', L.d) + u(String(h).padStart(2, '0'), 'h', L.h) + u(String(m).padStart(2, '0'), 'm', L.m) + u(String(s).padStart(2, '0'), 's', L.s) : `<p class="cdd">${esc(done)}</p>`}</div><script src="/static/sec.js?v=${SEC_V}" defer></script>`;
  };
  const linkA = (l, cls) => { const ext = /^https?:/i.test(l.u); return `<a${cls ? ` class="${cls}"` : ''} href="${esc(l.u)}"${ext ? ' rel="noopener noreferrer nofollow" target="_blank"' : ''}>${l.e ? esc(l.e) + ' ' : ''}${esc(l.t)}</a>`; };

  // Render one block body (without wrapper). st = per-request state (first pricing id, epg once…).
  async function body(req, s, x, st) {
    const c = x.cfg || {}, en = req.lang === 'en', B = ctx.homeBuiltins || {}, base = '/' + s.slug;
    switch (x.kind) {
      case 'banner': return ctx.monitorBanner ? ctx.monitorBanner(req.lang).catch(() => '') : '';
      case 'evhero': return ctx.eventsHero ? ctx.eventsHero(req, s, 'home') : '';
      case 'hero': return B.hero ? B.hero(req, s) : '';
      case 'events': return ctx.eventsBlock ? ctx.eventsBlock(req, s, 'home') : '';
      case 'dnes': return ctx.dnesBlock ? ctx.dnesBlock(req, s) : '';
      case 'buttons': return B.buttons ? B.buttons(req, s) : '';
      case 'social': return B.social ? B.social(req, s, c) : '';
      case 'chat': return '';
      case 'pricing': {
        const id = st.pricing ? '' : 'cennik'; st.pricing = 1;
        const renamed = !c.seed || x.title !== 'Cenník' ? titleOf(req, x) : '';
        return B.pricing ? B.pricing(req, s, { id, title: renamed || '', plans: c.plans || [], why: !!c.why, notes: !!c.notes, intro: !!c.intro, seed: !!c.seed }) : '';
      }
      case 'payments': {
        const it = await payItems(c.methods); if (!it.length) return '';
        return `<div class="xpm">${it.map((m) => `<span class="xpmi">${m.logos.map((u) => `<img src="${esc(u)}" alt="" width="40" height="26" loading="lazy" decoding="async">`).join('')}<span>${esc(m.name)}</span></span>`).join('')}</div>${c.btn ? `<a class="b xpmb" href="${esc(base)}/platby">💳 ${esc(tx(en, 'Všetky spôsoby platby', 'All payment methods'))}</a>` : ''}`;
      }
      case 'channels': {
        const chs = ctx.monitorChannels ? await ctx.monitorChannels(req.lang).catch(() => []) : [];
        const l = c.limit ? chs.slice(0, c.limit) : chs; if (!l.length) return '';
        const list = `<div class="guide">${l.map((h, i) => `<div class="gi"><span class="gn">${i + 1}</span><span class="gt">${esc(h.name)}</span>${c.status ? `<span class="tbadge"><span class="dot ${esc(h.cls)}"></span>${esc(T(req, h.label))}</span>` : '<span class="gp">▶</span>'}</div>`).join('')}</div>`;
        const epg = c.epg && !st.epg && ctx.epgAssets ? await ctx.epgAssets(req) : ''; if (epg) st.epg = 1;
        return list + epg + (chs.length > l.length ? `<p class="xsm"><a href="${esc(base)}/kanaly">${esc(tx(en, 'Všetky kanály', 'All channels'))} ›</a></p>` : '');
      }
      case 'auth': {
        if (ctx.accEnabled && !(await ctx.accEnabled())) return '';
        if (logged(req)) return `<a class="b" href="/ucet">👤 ${esc(tx(en, 'Môj účet', 'My account'))}</a>`;
        return `${c.note ? `<div class="prose">${para(c.note)}</div>` : ''}<div class="xauth"><a class="b" href="/registracia">📝 ${esc(tx(en, 'Registrácia', 'Sign up'))}</a><a class="b" href="/prihlasenie">🔑 ${esc(tx(en, 'Prihlásenie', 'Log in'))}</a></div>`;
      }
      case 'why': return ctx.accWhyForReq ? ctx.accWhyForReq(req).catch(() => '') : '';
      case 'affiliate': {
        const t = ctx.accWhyHtml ? await ctx.accWhyHtml(req, 'table') : ''; if (!t) return '';
        return `${c.note ? `<div class="prose">${para(c.note)}</div>` : ''}${t}<a class="b" href="${logged(req) ? '/ucet' : '/registracia'}">🤝 ${esc(logged(req) ? tx(en, 'Môj affiliate odkaz', 'My referral link') : tx(en, 'Zaregistrovať sa a získať odkaz', 'Sign up and get your link'))}</a>`;
      }
      case 'subcheck': return `${c.note ? `<div class="prose">${para(c.note)}</div>` : ''}<a class="b" href="/overit-predplatne">🔎 ${esc(tx(en, 'Overiť predplatné', 'Check subscription'))}</a>`;
      case 'text': {
        const b = en && x.body_en ? x.body_en : x.body;
        return `${x.img_ver ? `<img class="secimg" src="/sekcia-img/${x.id}?v=${esc(x.img_ver)}" alt="" loading="lazy" decoding="async">` : ''}${b ? `<div class="prose sec">${b}</div>` : ''}`;
      }
      case 'gallery': {
        const g = x.gal || []; if (!g.length) return '';
        return `<div class="xgal c${c.cols || 3}">${g.map((im) => `<figure><img src="/sekcia-gal/${im.id}?v=${esc(im.ver)}" alt="${esc(im.alt)}" loading="lazy" decoding="async">${im.alt ? `<figcaption>${esc(im.alt)}</figcaption>` : ''}</figure>`).join('')}</div>`;
      }
      case 'video': {
        const v = x.videos || []; if (!v.length) return '';
        const b = en && x.body_en ? x.body_en : x.body;
        return `${b ? `<div class="prose sec">${b}</div>` : ''}<div class="vids">${v.map((y, i) => videoHtml(y, i, (k) => T(req, k))).join('')}</div><script src="/static/sec.js?v=${SEC_V}" defer></script>`;
      }
      case 'links': {
        const l = parseLinks(c.links, safeHref); if (!l.length) return '';
        return c.style === 'list' ? `<ul class="xlinks">${l.map((y) => `<li>${linkA(y)}</li>`).join('')}</ul>` : l.map((y) => linkA(y, 'b')).join('\n');
      }
      case 'faq': {
        let f;
        if (c.src === 'list') f = (ctx.getList ? await ctx.getList('faq') : []).map((y) => ({ q: en && y.q_en ? y.q_en : y.q, a: para(en && y.a_en ? y.a_en : y.a) }));
        else f = parseFaq(c.faq).map((y) => ({ q: y.q, a: sanitize(y.a) }));
        return f.map((y) => `<details class="qa"><summary>${esc(y.q)}</summary>${y.a}</details>`).join('');
      }
      case 'countdown': return countdown(req, c);
      default: return '';
    }
  }

  const visOk = (req, c) => !c.vis || (c.vis === 'in' ? logged(req) : c.vis === 'out' ? !logged(req) : true);
  async function block(req, s, x, st) {
    const c = x.cfg || {};
    if (!x.visible || !KINDS[x.kind] || !visOk(req, c)) return '';
    let h = await body(req, s, x, st); if (!h) return '';
    const head = c.showTitle && x.kind !== 'hero' ? H(req, x) : '';
    if (!needsWrap(c)) return head + h;
    const cl = ['xs'];
    if (c.bg || c.fg) { cl.push('xs-' + x.id); st.css = 1; }
    if (c.box || c.bg) cl.push('xs-c');
    if (c.vis === 'mobile') cl.push('xs-mob'); if (c.vis === 'desktop') cl.push('xs-desk');
    return `<section class="${cl.join(' ')}"${c.anchor ? ` id="${esc(c.anchor)}"` : ''}>${head}${h}</section>`;
  }
  async function renderList(req, s, rows, st = {}) {
    let out = '';
    for (const x of rows) out += await block(req, s, x, st);
    if (st.css) out = `<link rel="stylesheet" href="/sekcie.css?v=${cssOf(await ctx.secAll()).v}">` + out;
    return out;
  }
  // Home page = ordered home blocks. null → not seeded yet (server falls back to legacy markup).
  ctx.homeRender = async (req, s) => {
    const rows = await ctx.secHome(); if (!rows.length) return null;
    return renderList(req, s, rows);
  };
  // Extra content for a page-section (kinds other than legacy text/video), rendered under the h1.
  ctx.secPageBody = async (req, s, x) => renderList(req, s, [Object.assign({}, x, { visible: true, cfg: Object.assign({}, x.cfg, { showTitle: 0 }) })]);
  ctx.secBody = body;
  return ctx;
};
