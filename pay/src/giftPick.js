'use strict';
/**
 * One smart gift-card choice: Azteco (Lightning / Onchain / Azteco) vs Amazon DE.
 * Comparison uses TOTAL cost = purchase/base price + provider fees (admin-configured;
 * unknown fees default to 0 — never invented). Prefer Azteco when its total is at most
 * `threshold` EUR above Amazon (default 0.70). Customer UI/API shows face values only
 * (no fees, no costs, no comparison numbers).
 */
const g2a = require('./g2a');
const store = require('./sealedStore');

const DEFAULT_THRESHOLD = 0.70;
const ZERO_FEE = { feePct: 0, feeFix: 0 };
const cfg = store.create('gift-pick', {
  threshold: DEFAULT_THRESHOLD,
  prices: {},
  fees: { azteco: { ...ZERO_FEE }, amazon: { ...ZERO_FEE } },
});
let log = () => {};

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const money = (n) => Math.round(Number(n) * 100) / 100;

function threshold() {
  const t = Number(cfg.get().threshold);
  return Number.isFinite(t) && t >= 0 && t <= 20 ? money(t) : DEFAULT_THRESHOLD;
}

function parseFeePart(v, max) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return money(n);
}

/** Admin fee for a family. Unknown / unset → 0 (never invent rates). */
function feesOf(family) {
  const all = (cfg.get().fees && typeof cfg.get().fees === 'object') ? cfg.get().fees : {};
  const raw = all[family] || {};
  const pct = Number(raw.feePct);
  const fix = Number(raw.feeFix);
  return {
    feePct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? money(pct) : 0,
    feeFix: Number.isFinite(fix) && fix >= 0 && fix <= 50 ? money(fix) : 0,
  };
}

/** Final unit cost for one card: base + % + fix. */
function withFee(base, family) {
  const b = money(base);
  const { feePct, feeFix } = feesOf(family);
  return money(b * (1 + feePct / 100) + feeFix);
}

/** Purchase/base price if the admin entered a real one; otherwise the face value (the only known figure). */
function unitBase(p) {
  const prices = cfg.get().prices || {};
  const raw = prices[p.id] != null ? prices[p.id] : prices[p.aliasId];
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return money(n);
  return money(p.amountEur);
}

function familyOf(p) {
  const t = String(p.type || p.id || '');
  if (t.startsWith('azteco') || t.includes('azteco')) return 'azteco';
  if (t.startsWith('amazon') || t.includes('amazon')) return 'amazon';
  return '';
}

function catalog() {
  return (typeof g2a.listProducts === 'function' ? g2a.listProducts() : []).map((p) => {
    const family = familyOf(p);
    const base = unitBase(p);
    return {
      id: p.id, aliasId: p.aliasId, type: p.type, label: p.label || p.shortLabel,
      amountEur: Number(p.amountEur), buyUrl: p.buyUrl, family,
      base, cost: withFee(base, family),
    };
  }).filter((p) => p.family && Number.isFinite(p.amountEur) && p.amountEur > 0);
}

/**
 * Cheapest combination of the given denominations whose face values sum to >= amount.
 * Unlimited repeats. Minimise total cost (with fees), then overshoot, then card count.
 */
function bestCombo(denoms, amount) {
  const amt = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amt) || amt <= 0 || !denoms.length) return null;
  const maxFace = Math.max(...denoms.map((d) => Math.round(d.amountEur * 100)));
  const cap = amt + maxFace; // no point overshooting by more than the largest card
  const INF = { cost: Infinity };
  const dp = Array.from({ length: cap + 1 }, () => INF);
  dp[0] = { cost: 0, base: 0, face: 0, cards: [] };
  for (let s = 0; s <= cap; s++) {
    const cur = dp[s]; if (!Number.isFinite(cur.cost)) continue;
    for (const d of denoms) {
      const f = Math.round(d.amountEur * 100), ns = s + f; if (ns > cap) continue;
      const next = {
        cost: money(cur.cost + d.cost),
        base: money(cur.base + d.base),
        face: cur.face + f,
        cards: cur.cards.concat([d]),
      };
      const old = dp[ns];
      if (next.cost < old.cost - 1e-9
        || (Math.abs(next.cost - old.cost) < 1e-9 && (next.face < old.face || (next.face === old.face && next.cards.length < old.cards.length)))) {
        dp[ns] = next;
      }
    }
  }
  let best = null;
  for (let s = amt; s <= cap; s++) {
    const x = dp[s]; if (!Number.isFinite(x.cost)) continue;
    if (!best || x.cost < best.cost - 1e-9
      || (Math.abs(x.cost - best.cost) < 1e-9 && (x.face < best.face || (x.face === best.face && x.cards.length < best.cards.length)))) {
      best = { ...x, coverEur: money(s / 100) };
    }
  }
  return best;
}

function pick(amountEur) {
  const amount = Number(amountEur);
  const all = catalog();
  const az = bestCombo(all.filter((p) => p.family === 'azteco'), amount);
  const am = bestCombo(all.filter((p) => p.family === 'amazon'), amount);
  const thr = threshold();
  let winner = 'none', reason = 'no-option';
  if (az && am) {
    if (az.cost <= money(am.cost + thr)) { winner = 'azteco'; reason = az.cost <= am.cost ? 'azteco-cheaper-or-equal' : 'azteco-within-threshold'; }
    else { winner = 'amazon'; reason = 'amazon-cheaper'; }
  } else if (az) { winner = 'azteco'; reason = 'azteco-only'; }
  else if (am) { winner = 'amazon'; reason = 'amazon-only'; }
  const chosen = winner === 'azteco' ? az : winner === 'amazon' ? am : null;
  return {
    amount: Number.isFinite(amount) ? money(amount) : amount,
    threshold: thr,
    fees: { azteco: feesOf('azteco'), amazon: feesOf('amazon') },
    azteco: az ? pubCombo(az, 'azteco') : null,
    amazon: am ? pubCombo(am, 'amazon') : null,
    winner, reason,
    choice: chosen ? pubCombo(chosen, winner) : null,
  };
}

/** Internal/admin combo summary. `cost` = total with fees (what the picker uses). No fee field names on the choice payload. */
function pubCombo(c, family) {
  const cards = c.cards.map((p) => ({ id: p.id, aliasId: p.aliasId, label: p.label, faceEur: p.amountEur, type: p.type, buyUrl: p.buyUrl }));
  const label = family === 'azteco' ? 'Azteco' : 'Amazon DE';
  const names = cards.map((x) => x.label).join(' + ');
  return { family, label, names, cost: c.cost, base: c.base != null ? c.base : c.cost, coverEur: c.coverEur, cards };
}

/** Public method shown instead of the individual Azteco/Amazon rows. No fees, no prices. */
function publicItem() {
  return {
    id: 'gift_smart', providerId: 'gift_smart', provider_name: 'Darčeková karta', method_label: 'Darčeková karta',
    status: 'active', group: 'vouchers', gateway: 'gift_smart', configured: true, soon: false,
    unavailableLabel: null, preferred: true, giftcard: true, smartGift: true,
    hint: 'Vyberieme vhodnú darčekovú kartu (Azteco alebo Amazon DE) podľa vašej sumy.',
    minimum_amount: 1, minimum_currency: 'EUR',
    logos: ['/logos/azteco.png', '/logos/amazon.svg'],
  };
}

const HIDE_GROUP = new Set(['g2a_amazon', 'g2a_azteco']);
const HIDE_ID = (id) => /^(g2a_amazon|g2a_azteco|gc_azteco|gc_amazon)/.test(String(id || ''));

function collapse(res) {
  if (!res || !res.groups) return res;
  const filterList = (arr) => (arr || []).filter((p) => p && p.id !== 'gift_smart' && !HIDE_GROUP.has(p.group) && !HIDE_ID(p.id));
  for (const k of [...HIDE_GROUP]) delete res.groups[k];
  if (res.groups.vouchers) {
    res.groups.vouchers.providers = filterList(res.groups.vouchers.providers);
    res.groups.vouchers.soon = filterList(res.groups.vouchers.soon);
  } else {
    res.groups.vouchers = { label: 'Poukážky / darčekové karty', color: '#f59e0b', providers: [], soon: [] };
  }
  const item = publicItem();
  res.groups.vouchers.providers.unshift(item);
  res.providers = filterList(res.providers);
  res.providers.unshift(item);
  if (res.soonProviders) res.soonProviders = filterList(res.soonProviders);
  return res;
}

function adminView() {
  const prices = { ...(cfg.get().prices || {}) };
  const fees = { azteco: feesOf('azteco'), amazon: feesOf('amazon') };
  const rows = catalog().map((p) => ({
    id: p.id, label: p.label, family: p.family, faceEur: p.amountEur,
    priceEur: prices[p.id] != null && Number(prices[p.id]) > 0 ? money(prices[p.id]) : null,
    baseEur: p.base,
    totalEur: p.cost,
  }));
  return { ok: true, threshold: threshold(), prices, fees, rows, seeded: cfg.get().threshold == null };
}

async function saveAdmin(b) {
  const t = Number(String(b.threshold != null ? b.threshold : '').replace(',', '.'));
  if (!Number.isFinite(t) || t < 0 || t > 20) return { ok: false, status: 400, error: 'Prah musí byť 0 až 20 €.' };
  const prices = { ...(cfg.get().prices || {}) };
  if (b.prices && typeof b.prices === 'object') {
    for (const [k, v] of Object.entries(b.prices)) {
      const id = clip(k, 60); if (!id) continue;
      const n = v === '' || v == null ? NaN : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) delete prices[id];
      else prices[id] = money(n);
    }
  }
  const fees = { azteco: feesOf('azteco'), amazon: feesOf('amazon') };
  if (b.fees && typeof b.fees === 'object') {
    for (const fam of ['azteco', 'amazon']) {
      const src = b.fees[fam];
      if (!src || typeof src !== 'object') continue;
      const pct = parseFeePart(src.feePct, 100);
      const fix = parseFeePart(src.feeFix, 50);
      if (pct == null || fix == null) return { ok: false, status: 400, error: 'Poplatok: % 0–100, fix 0–50 €.' };
      fees[fam] = { feePct: pct, feeFix: fix };
    }
  }
  await cfg.save({ threshold: money(t), prices, fees });
  log('GIFTPICK_SAVED threshold=' + money(t)
    + ' azteco_fee=' + fees.azteco.feePct + '%+' + fees.azteco.feeFix
    + ' amazon_fee=' + fees.amazon.feePct + '%+' + fees.amazon.feeFix);
  return adminView();
}

function mount(app) {
  require('./payMethods').serveSigned(app, '/api/admin-bridge/giftpick', {
    gp_get: async () => adminView(),
    gp_save: async (b) => saveAdmin(b || {}),
  }, 'GIFTPICK');
  app.get('/api/gift-pick', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const amount = Number(String(req.query.amount || '').replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Zadajte sumu.' });
    const r = pick(amount);
    // Public payload: no costs, no fees, no comparison numbers — face/cover only.
    const c = r.choice;
    res.json({
      ok: !!c, amount: r.amount, winner: r.winner,
      label: c ? c.label : null, names: c ? c.names : null, coverEur: c ? c.coverEur : null,
      cards: c ? c.cards.map((x) => ({ id: x.id, aliasId: x.aliasId, label: x.label, faceEur: x.faceEur, buyUrl: x.buyUrl })) : [],
    });
  });
}

async function init(appendLog) { if (appendLog) log = appendLog; await cfg.load(); }

module.exports = {
  DEFAULT_THRESHOLD, threshold, feesOf, withFee, pick, bestCombo, catalog,
  collapse, publicItem, adminView, saveAdmin, mount, init,
  _set: (c) => cfg.set(c), _cfg: cfg,
};
