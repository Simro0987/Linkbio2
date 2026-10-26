'use strict';
/** Order chain-status API (JSON + SSE) and a lightweight live order page. */
const watcher = require('./chainWatcher');

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ORDER_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;

function register(app, { loadOrders }) {
  const find = (id) => (ORDER_ID_RE.test(String(id || '')) ? loadOrders()[id] : null);

  app.get('/api/order/:id/chain-status', async (req, res) => {
    const o = find(req.params.id);
    if (!o) return res.status(404).json({ error: 'Objednávka sa nenašla' });
    res.set('Cache-Control', 'no-store');
    res.json(await watcher.statusForOrder(o, { force: req.query.force === '1' }));
  });

  app.get('/api/order/:id/chain-status/stream', async (req, res) => {
    const o = find(req.params.id);
    if (!o) return res.status(404).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders && res.flushHeaders();
    const send = (r) => res.write(`event: status\ndata: ${JSON.stringify(r)}\n\n`);
    send(await watcher.statusForOrder(o));
    const unsub = watcher.subscribe(o.orderId, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    // Per-connection poll too, so stream works even if the sweep is slow.
    const poll = setInterval(async () => { try { send(await watcher.statusForOrder(o)); } catch {} }, 30000);
    req.on('close', () => { unsub(); clearInterval(ping); clearInterval(poll); });
  });

  app.get('/order/:id', (req, res) => {
    const o = find(req.params.id);
    if (!o) return res.status(404).type('html').send('<p>Objednávka nenájdená. <a href="/platby">Späť</a></p>');
    res.type('html').send(`<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Stav objednávky ${esc(o.orderId)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eef9;margin:0;padding:1rem}.wrap{max-width:560px;margin:0 auto}
.card{background:#121a2b;border:1px solid #243044;border-radius:16px;padding:1.2rem;margin:0 0 1rem}.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.25rem 1rem;padding:.35rem 0;border-bottom:1px solid #1e293b}.row>*{min-width:0;overflow-wrap:anywhere}*{box-sizing:border-box}img{max-width:100%;height:auto}
.addr{font-family:ui-monospace,monospace;word-break:break-all;background:#0b1220;border:1px solid #243044;border-radius:10px;padding:.7rem;margin:.5rem 0}
a{color:#93c5fd}</style></head><body><div class="wrap"><div class="card">
<h1 style="font-size:1.3rem">Stav objednávky</h1>
<div class="row"><span>Objednávka</span><b>${esc(o.orderId)}</b></div>
<div class="row"><span>Suma</span><b>${esc(o.amountEur)} EUR</b></div>
<div class="row"><span>Mena</span><b>${esc(String(o.payoutCoin || '').toUpperCase())}</b></div>
<div class="addr">${esc(o.payoutAddress || '')}</div>
<div id="chainStatus" data-order-id="${esc(o.orderId)}"></div>
<p><a href="/platby">← Späť na platby</a></p></div></div>
<script src="/chain-status.js" defer></script></body></html>`);
  });
}

module.exports = { register };
