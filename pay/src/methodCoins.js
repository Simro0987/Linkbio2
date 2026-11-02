'use strict';
/**
 * Per-method coin choice (admin „Platobné metódy“ → edit → „Kryptomeny pre zákazníka“).
 * A method record (custom cm_* or built-in override ov:<id>) may carry `coins: ['btc','ltc',…]`.
 *   - coins undefined → legacy behaviour (nothing changes for existing methods)
 *   - coins []        → no crypto address shown
 * Addresses per order follow the existing logic exactly: xpub configured for the coin (BTC/LTC) → fresh derived
 * address per order (xpub.nextAddress, deduped by orderId); otherwise the first enabled address of the network in
 * 👛 Adresy peňaženiek (wallets.forChain, EVM chains fall back to the shared EVM address). BTC reuses an address the
 * order already has (pool rotation / xpub from the checkout step) so the customer never sees two BTC addresses.
 */
const wallets = require('./wallets');
const xpub = require('./xpub');

let cd = null; // lazy (cryptoDirect requires payMethods → avoid a require cycle)
const CD = () => cd || (cd = require('./cryptoDirect'));
const ASSETS = () => CD().ASSETS.filter((a) => !a.ln); // Lightning needs an invoice per order (Blink) – not a plain address
const BY_ID = () => Object.fromEntries(ASSETS().map((a) => [a.id, a]));

function availability(a) {
  const hd = !!(a.watch && safe(() => xpub.has(a.watch)));
  const w = safe(() => wallets.forChain(a.net));
  return { available: hd || !!(w && w.address), xpub: hd };
}
function safe(f) { try { return f(); } catch { return null; } }

/** Admin choices: [{id,label,group,available,xpub,note}] */
function choices() {
  return ASSETS().map((a) => {
    const av = availability(a);
    return { id: a.id, label: a.label, group: a.group, available: av.available, xpub: av.xpub,
      note: av.available ? (av.xpub ? 'nová adresa pre každú objednávku (xpub)' : 'adresa z 👛 Adresy peňaženiek') : 'nie je nastavená adresa v 👛 Adresy peňaženiek' };
  });
}

/** Form fields → coins array or undefined (when the form had no coin section). */
function parse(fields, prev) {
  if (!fields || String(fields.coinsSent || '') !== '1') return prev;
  if (!fields.coinsCustom) return undefined; // „vlastný výber“ off → legacy behaviour
  const ids = BY_ID();
  const raw = Array.isArray(fields.coins) ? fields.coins : String(fields.coins || '').split(',');
  return [...new Set(raw.map((s) => String(s).trim().toLowerCase()).filter((s) => ids[s]))].slice(0, 40);
}

/** Assign (idempotent) one address per chosen coin and store it on the order as order.coinAddrs. Returns the list. */
async function ensure(order, coins, { saveOrders, loadOrders, log } = {}) {
  if (!order || !Array.isArray(coins) || !coins.length) return [];
  const have = Array.isArray(order.coinAddrs) ? order.coinAddrs : [];
  const ids = BY_ID(); const out = []; let changed = false;
  for (const id of coins) {
    const a = ids[id]; if (!a) continue;
    const prev = have.find((x) => x.id === id);
    if (prev && prev.address) { out.push(prev); continue; }
    let address = null; let memo = null; let source = 'wallet';
    if (id === 'btc' && order.payoutCoin === 'btc' && order.payoutAddress) { address = order.payoutAddress; source = order.payoutSource || 'pool'; }
    if (!address && a.watch && safe(() => xpub.has(a.watch))) {
      const hd = await xpub.nextAddress(a.watch, order.orderId).catch(() => null);
      if (hd && hd.address) { address = hd.address; source = 'xpub'; }
    }
    if (!address) { const w = safe(() => wallets.forChain(a.net)); if (w && w.address) { address = w.address; memo = w.memo || null; } }
    if (!address) continue;
    out.push({ id, label: a.label, ticker: a.tk, net: a.net, address, memo, source }); changed = true;
  }
  if (changed) {
    order.coinAddrs = out;
    if (loadOrders && saveOrders) { const all = loadOrders(); if (all[order.orderId]) { all[order.orderId].coinAddrs = out; saveOrders(all); } }
    if (log) log(`COIN_ADDRS ${order.orderId} ${out.map((x) => x.id + ':' + x.source).join(',')}`);
  }
  return out;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Customer HTML block: one box per coin, address + copy button (data-cp → csp-handlers.js). */
function html(list, { title = 'Zaplatiť kryptom', amountEur } = {}) {
  if (!list || !list.length) return '';
  const rows = list.map((c, i) => `<div class="mc-coin" style="border-top:1px solid rgba(127,127,127,.25);padding:10px 0">
<div><b>${esc(c.label)}</b></div>
<code id="mc_${i}" style="display:block;font-size:15px;margin:6px 0;word-break:break-all;background:rgba(127,127,127,.12);padding:8px;border-radius:8px">${esc(c.address)}</code>
${c.memo ? `<div style="font-size:14px">Memo / tag: <code id="mcm_${i}">${esc(c.memo)}</code> <button type="button" data-cp="mcm_${i}">Kopírovať</button></div>` : ''}
<button type="button" class="big" style="width:100%;padding:12px;font-size:16px" data-cp="mc_${i}">📋 Kopírovať adresu ${esc(c.ticker)}</button></div>`).join('');
  return `<div class="box mc-box"><div><b>${esc(title)}</b>${amountEur != null ? ` — pošlite ekvivalent <b>${esc(amountEur)} EUR</b>` : ''} na jednu z adries:</div>${rows}
<small>Posielajte iba danú menu na uvedenej sieti.</small></div>`;
}

module.exports = { choices, parse, ensure, html, availability };
