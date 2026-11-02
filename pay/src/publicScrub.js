'use strict';
/**
 * Safety net for public JSON: the internal brand name must never reach customers
 * (the only allowed occurrence is the Lightning address below). Also strips
 * internal-only keys (notify e-mails, BTCPay store slug/page, admin paths, temp files).
 */
const ALLOWED = 'tokigo@blink.sv';
const BRAND_RE = /tokigo/i;
const DROP_KEYS = new Set(['notifyEmail', 'storeSlug', 'storePage', 'loginPath', 'listPath', 'jsonPath', 'instructionsPath']);

function hasBrand(str) {
  if (typeof str !== 'string' || !BRAND_RE.test(str)) return false;
  return BRAND_RE.test(str.split(new RegExp(ALLOWED.replace(/[.@]/g, '\\$&'), 'gi')).join(''));
}

function scrub(v, depth = 0) {
  if (depth > 40 || v == null) return v;
  if (typeof v === 'string') return hasBrand(v) ? null : v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1)).filter((x) => x !== null || false);
  if (typeof v === 'object') {
    if (typeof v.toJSON === 'function' && !(v.constructor === Object)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEYS.has(k) || hasBrand(k)) continue;
      out[k] = scrub(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** Applies to customer-facing (non-admin) JSON responses. */
function middleware(req, res, next) {
  const p = req.path || '';
  if (/^\/(admin|api\/admin)\b/.test(p)) return next();
  const orig = res.json.bind(res);
  res.json = (body) => {
    try { return orig(scrub(body)); } catch { return orig(body); }
  };
  next();
}

module.exports = { scrub, hasBrand, middleware };
