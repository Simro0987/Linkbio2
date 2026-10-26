'use strict';
// Payment module (former standalone checkout) running inside lnkbio – one site, one admin.
// PAY_MODULE: off (default, nothing loaded) | shadow (data read-only preview at /platby-preview, admin at
// /admin/platby, NO bots/pollers/jobs – the old checkout is still the live one) | live (also serves /platby,
// still no jobs) | on (everything: Telegram bots, SEPA channel poller, chain watcher, backups).
const fs = require('fs');
const path = require('path');
const express = require('express');
const payMode = require('./src/payMode');

// paths lnkbio itself answers – never handed to the payment app
const LNK_TOP = new Set(['', 'admin', 'static', 'healthz', 'robots.txt', 'sitemap.xml', 'favicon.ico', 'img', 'theme.css', 's', 'tvlogo', 'navody-img', 'index.html', 'platby']);
const LNK_API = new Set(['backup', 'plans', 'agent', 'epg', 'site-info', 'status-alert', 'admin-bridge']);

function firstSegs(router) {
  const out = new Set();
  for (const l of (router && router.stack) || []) {
    const r = l.route;
    const paths = r ? [].concat(r.path) : [];
    for (const p of paths) if (typeof p === 'string') { const m = /^\/([^/:(?*]+)/.exec(p); if (m) out.add(m[1]); }
  }
  return out;
}
function apiSegs(router) {
  const out = new Set();
  for (const l of (router && router.stack) || []) {
    const r = l.route;
    for (const p of r ? [].concat(r.path) : []) if (typeof p === 'string') { const m = /^\/api\/([^/:(?*]+)/.exec(p); if (m) out.add(m[1]); }
  }
  return out;
}

/**
 * @param {import('express').Express} app lnkbio app (call right after app.disable('x-powered-by'), before helmet)
 * @param {{ isAdmin:(req)=>Promise<boolean>, getPlan:(id:number)=>Promise<object|null>, log?:Function }} hooks
 */
function install(app, hooks) {
  const mode = payMode.mode();
  if (mode === 'off') return null;
  const log = hooks.log || ((m) => console.log('[pay] ' + m));
  global.__lnkbioPlan = hooks.getPlan;
  const payApp = require('./src/server');
  let ready = false;
  payApp.payBoot().then(() => { ready = true; log('ready mode=' + mode); }).catch((e) => { ready = true; log('boot error ' + (e && e.message)); });

  const top = firstSegs(payApp._router);
  try { for (const f of fs.readdirSync(path.join(__dirname, 'public'))) top.add(f); } catch {}
  const api = apiSegs(payApp._router);
  for (const s of LNK_TOP) top.delete(s);
  for (const s of LNK_API) api.delete(s);
  top.delete('api');

  const sameOrigin = (req) => {
    const host = String(req.headers.host || '');
    const src = req.headers.origin || req.headers.referer || '';
    try { return !!src && new URL(src).host === host; } catch { return false; }
  };

  const gate = express.Router();
  gate.use((req, res, next) => {
    const p = req.path;
    const seg = p.split('/')[1] || '';
    // customer payment page
    if (p === '/platby' || p === '/platby/' || p === '/platby-preview') {
      if (p.startsWith('/platby-preview') ? mode === 'off' : !payMode.servesPlatby()) return next('router');
      const q = req.url.indexOf('?');
      req.url = '/' + (q >= 0 ? req.url.slice(q) : '');
      return next();
    }
    // payment admin – only behind the lnkbio login (password + 2FA, pwver)
    if (p === '/admin/platby' || p.startsWith('/admin/platby/')) {
      return Promise.resolve(hooks.isAdmin(req)).then((ok) => {
        if (!ok) return res.redirect(303, '/admin/login');
        if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return res.status(403).type('text').send('Neplatný pôvod požiadavky.');
        // shadow: the old checkout still owns live orders and caches – the merged admin is read-only until cutover
        if (!['GET', 'HEAD'].includes(req.method) && !payMode.servesPlatby()) return res.status(409).type('text').send('Náhľad (PAY_MODULE=shadow) – zmeny zatiaľ robte v starom admine. Po prepnutí bude tento admin plne funkčný.');
        req.lnkAdmin = true;
        res.setHeader('X-Robots-Tag', 'noindex');
        next();
      }).catch(next);
    }
    if (seg === 'api') {
      const a = p.split('/')[2] || '';
      if (a === 'telegram' && p.startsWith('/api/telegram/ideas')) return next('router');
      return api.has(a) ? next() : next('router');
    }
    return top.has(seg) ? next() : next('router');
  });
  gate.use((req, res, next) => {
    if (ready || req.path === '/health') return next();
    res.setHeader('Retry-After', '5');
    res.status(503).type('text').send('Platby sa práve spúšťajú, skúste o pár sekúnd.');
  });
  gate.use(payApp);
  app.use(gate);
  log('mounted mode=' + mode + ' top=' + [...top].sort().join(',') + ' api=' + [...api].sort().join(','));

  return {
    mode,
    segments: top,
    ready: () => ready,
    /** in-process call of a former HTTP admin bridge action (pay-methods / wallets / amount-links) */
    async callBridge(routePath, action, body) {
      const reg = global.__payBridge && global.__payBridge[routePath];
      const fn = reg && reg[action];
      if (typeof fn !== 'function') return null;
      return fn(JSON.parse(JSON.stringify(body || {})));
    },
  };
}

module.exports = { install };
