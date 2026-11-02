'use strict';
// Affiliate tier bonuses (pure logic + paid-order processing over an abstract store; pg in production, memory in tests).
// The number of ACTIVE referred members (valid subscription: manual override > panel expiry > order licence) at the moment
// the REFERRER buys a package selects the tier; the tier matrix gives bonus months on top of that package (price unchanged).
// Lower tiers inherit upward when a higher tier has no value for a package. A tier may allow "2nd device" instead of months.
// 2026-11-02: admin editor saves explicit values for every package (no inheritance surprises), thresholds may start at 0,
// and "2nd device free" is per tier AND package (devPk); with 0 bonus months the device is given automatically.
// 2026-10-27: removed ≥5 '3m +1' and ≥20 '12m +12' → 3m has no bonus below 20 active; 12m at ≥20 inherits +6 from ≥15.
const DEF_TIERS = [
  { min: 5, bonus: { 6: 1, 12: 1 } },
  { min: 10, bonus: { 6: 3, 12: 3 } },
  { min: 15, bonus: { 12: 6 } },
  { min: 20, bonus: { 3: 3, 6: 6 }, device: true },
];
// previous defaults – stored settings that still equal these are migrated to DEF_TIERS (admin-edited tables are left alone)
const OLD_DEF_TIERS = [
  { min: 5, bonus: { 3: 1, 6: 1, 12: 1 } },
  { min: 10, bonus: { 6: 3, 12: 3 } },
  { min: 15, bonus: { 12: 6 } },
  { min: 20, bonus: { 3: 3, 6: 6, 12: 12 }, device: true },
];
const DEF_PACKAGES = [1, 3, 6, 7, 12, 15];
function cleanTiers(t) {
  if (!Array.isArray(t)) return null;
  const out = [];
  for (const x of t) {
    const min = parseInt(x && x.min, 10); if (!(min >= 0 && min <= 100000) || !/^\d{1,6}$/.test(String(x && x.min).trim())) return null;
    const bonus = {};
    for (const [k, v] of Object.entries((x && x.bonus) || {})) { const m = parseInt(k, 10), b = parseInt(v, 10); if (!(m >= 1 && m <= 120) || !(b >= 0 && b <= 120)) return null; bonus[m] = b; }
    let devPk = null; // per-package "2nd device free" (new editor); legacy tier-level `device` = every package that has a bonus
    if (x && x.devPk && typeof x.devPk === 'object' && !Array.isArray(x.devPk)) {
      devPk = {};
      for (const [k, v] of Object.entries(x.devPk)) { const m = parseInt(k, 10); if (!(m >= 1 && m <= 120)) return null; if (v === true || v === 1 || v === '1') devPk[m] = true; }
    }
    const o = { min, bonus, device: devPk ? Object.keys(devPk).length > 0 : !!(x && x.device) };
    if (devPk) o.devPk = devPk;
    out.push(o);
  }
  out.sort((a, b) => a.min - b.min);
  for (let i = 1; i < out.length; i++) if (out[i].min === out[i - 1].min) return null;
  return out.length <= 20 ? out : null;
}
function settings(s = {}) {
  let tiers = null; try { tiers = cleanTiers(JSON.parse(s.aff_tiers || 'null')); } catch { tiers = null; }
  return { on: s.aff_on !== '0', tiers: tiers || DEF_TIERS.map((t) => ({ ...t, bonus: { ...t.bonus } })), blockIp: s.aff_block_ip === '1' };
}
/** highest reached tier (or null) */
const tierFor = (active, tiers) => tiers.filter((t) => active >= t.min).pop() || null;
const nextTier = (active, tiers) => tiers.find((t) => active < t.min) || null;
/** bonus months for a package: value of the highest reached tier that defines this package (inheritance upward) */
function bonusFor(active, months, tiers) {
  let b = 0;
  for (const t of tiers) if (active >= t.min && Object.prototype.hasOwnProperty.call(t.bonus, months)) b = t.bonus[months];
  return b;
}
const canon = (t) => JSON.stringify((t || []).map((x) => ({ min: +x.min, device: !!x.device, devPk: x.devPk ? Object.keys(x.devPk).map(Number).sort((a, b) => a - b) : null, bonus: Object.keys(x.bonus || {}).map(Number).sort((a, b) => a - b).map((k) => [k, +x.bonus[k]]) })));
/** stored aff_tiers JSON → new JSON string if it still equals the OLD defaults, else null (no change) */
function migrateTiers(raw) {
  if (!raw) return null;
  let t = null; try { t = cleanTiers(JSON.parse(raw)); } catch { return null; }
  return t && canon(t) === canon(OLD_DEF_TIERS) ? JSON.stringify(cleanTiers(DEF_TIERS)) : null;
}
/** does the highest reached tier offer a 2nd device for any package (→ show the months/device choice) */
const deviceAllowed = (active, tiers) => { const t = tierFor(active, tiers); return !!(t && t.device); };
/** 2nd device free for this package at the reached tier: per-package flag (editor) or legacy tier flag on packages with a bonus */
function deviceFor(active, months, tiers) {
  const t = tierFor(active, tiers); if (!t) return false;
  if (t.devPk) return !!t.devPk[months];
  return !!t.device && bonusFor(active, months, tiers) > 0;
}
/** reward for one purchase: device instead of months when the tier offers it and the customer chose it (or the package has no months) */
function rewardFor(active, months, tiers, choice) {
  const b = bonusFor(active, months, tiers), d = deviceFor(active, months, tiers);
  return d && (b === 0 || choice === 'device') ? { bonus: 0, device: true, alt: b } : { bonus: b, device: false, alt: d };
}
/** matrix of effective bonuses per tier (with inheritance) for display */
function matrix(tiers, packages = DEF_PACKAGES) {
  const pk = [...new Set([...packages, ...tiers.flatMap((t) => [...Object.keys(t.bonus), ...Object.keys(t.devPk || {})].map(Number))])].sort((a, b) => a - b);
  return { packages: pk, rows: tiers.map((t) => { const dev = Object.fromEntries(pk.map((m) => [m, deviceFor(t.min, m, tiers)])); return { min: t.min, device: Object.values(dev).some(Boolean), dev, bonus: Object.fromEntries(pk.map((m) => [m, bonusFor(t.min, m, tiers)])) }; }) };
}
/** explicit tiers (every package listed, no inheritance) – what the admin editor shows and saves (WYSIWYG) */
function materialize(tiers, packages = DEF_PACKAGES) {
  const mx = matrix(tiers, packages);
  return mx.rows.map((r) => ({ min: r.min, bonus: { ...r.bonus }, devPk: Object.fromEntries(Object.entries(r.dev).filter(([, v]) => v).map(([k]) => [k, true])), device: r.device }));
}
function addMonths(d, m) {
  const x = new Date(d.getTime()); const day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + m);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last)); return x;
}
/** effective subscription end: manual override > panel expiry (source of truth when synced) > order-based licence */
function effectiveUntil(u) {
  const t = (v) => (v ? new Date(v) : null);
  return t(u.override_until) || (u.panel_user && u.panel_synced_at && u.panel_expiry ? t(u.panel_expiry) : null) || t(u.licence_until) || null;
}
const isActive = (u, now = new Date()) => !u.disabled && !!effectiveUntil(u) && effectiveUntil(u) > now;
const PAID = new Set(['paid', 'confirmed']);
const isPaidOrder = (o) => !!o && (PAID.has(o.status) || (o.provider === 'crypto_direct' && o.chainStatus === 'confirmed'));

/**
 * Process one paid order of a logged-in customer (idempotent via store.recordPurchase).
 * The buyer's licence is extended by package months; if the buyer is a referrer with enough ACTIVE referred members,
 * the tier bonus is added on top (or, at a "device" tier with choice 'device', a 2nd device slot for the same period).
 * store: { getUser, recordPurchase, setLicence, countActiveReferred, addLedger, addDevice }
 */
async function processPaidOrder(store, order, st, now = new Date()) {
  if (!isPaidOrder(order) || !order.acct || !order.acct.id) return { skipped: 'not-paid' };
  const months = Number(order.planMonths) || 0;
  const user = await store.getUser(order.acct.id); if (!user) return { skipped: 'no-user' };
  const fresh = await store.recordPurchase({ orderId: order.orderId, userId: user.id, months, amount: Number(order.amountEur || order.amount) || 0, planId: order.planId || null });
  if (!fresh) return { skipped: 'done' };
  const out = { orderId: order.orderId, months, bonus: 0, device: false, active: 0 };
  let bonus = 0, device = false, active = 0;
  if (st.on && months > 0 && !user.disabled) {
    active = await store.countActiveReferred(user.id, now);
    const rw = rewardFor(active, months, st.tiers, user.aff_choice);
    bonus = rw.bonus; device = rw.device;
  }
  if (months > 0) {
    const base = user.licence_until && new Date(user.licence_until) > now ? new Date(user.licence_until) : now;
    const until = addMonths(base, months + bonus);
    user.licence_until = until; await store.setLicence(user.id, until);
    out.licenceUntil = until;
    if (device) await store.addDevice({ user_id: user.id, order_id: order.orderId, from: base, until: addMonths(base, months) });
  }
  out.active = active; out.bonus = bonus; out.device = device;
  if (bonus > 0 || device) {
    const t = tierFor(active, st.tiers);
    const row = { user_id: user.id, order_id: order.orderId, kind: device ? 'device' : 'bonus', package_months: months, bonus_months: bonus, active_count: active, tier_min: t ? t.min : 0, note: device ? (bonusFor(active, months, st.tiers) > 0 ? '2. zariadenie namiesto bonusových mesiacov' : '2. zariadenie zadarmo') : '' };
    await store.addLedger(row);
    out.ledger = { ...row, username: user.username };
  }
  return out;
}

function memoryStore() {
  const users = new Map(), purchases = new Map(), ledger = [], devices = [];
  return {
    users, purchases, ledger, devices,
    addUser(u) { users.set(u.id, { disabled: false, licence_until: null, referrer_id: null, ...u }); return users.get(u.id); },
    async getUser(id) { return users.get(id) || null; },
    async recordPurchase(p) { if (purchases.has(p.orderId)) return false; purchases.set(p.orderId, p); return true; },
    async setLicence(id, until) { users.get(id).licence_until = until; },
    async countActiveReferred(refId, now) { return [...users.values()].filter((u) => u.referrer_id === refId && !u.ref_blocked && isActive(u, now)).length; },
    async addLedger(r) { ledger.push(r); },
    async addDevice(d) { devices.push(d); },
  };
}
module.exports = { DEF_TIERS, OLD_DEF_TIERS, migrateTiers, DEF_PACKAGES, cleanTiers, settings, tierFor, nextTier, bonusFor, deviceAllowed, deviceFor, rewardFor, matrix, materialize, addMonths, effectiveUntil, isActive, isPaidOrder, processPaidOrder, memoryStore };
