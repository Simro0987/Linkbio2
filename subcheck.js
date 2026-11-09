'use strict';
/**
 * Public username-only subscription check: resolve a client password from the
 * local encrypted list, fulfilment records, or a cached admin panel listing,
 * then call player_api.php. Passwords never appear in the returned view.
 */
function publicFields(r, extra = {}) {
  if (!r) return { found: false, ...extra };
  return {
    found: !!r.found,
    active: !!r.active,
    expiry: r.expiry || null,
    status: r.status || '',
    connections: r.connections || null,
    ...extra,
  };
}

function lastKnown(rec, now) {
  if (!rec || !rec.until_at) return null;
  const exp = new Date(rec.until_at);
  const n = now || new Date();
  const active = exp > n;
  return publicFields({ found: true, active, expiry: exp, status: active ? 'Active' : 'Expired' }, { source: 'known' });
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConf
 * @param {(c, user, pass) => Promise<object|null>} deps.checkOwn
 * @param {(c, user) => Promise<{found?:boolean, pass?:string, error?:string}>} deps.findPanelPassword
 * @param {(user) => Promise<string|null>} deps.linePass
 * @param {(user) => string|null|Promise<string|null>} deps.fulfillPass
 * @param {(user) => Promise<{until_at?:any}|null>} deps.softwareByName
 */
function create(deps = {}) {
  const {
    getConf, checkOwn, findPanelPassword, linePass, fulfillPass, softwareByName,
    now = () => new Date(),
  } = deps;

  async function resolvePass(username, conf) {
    let known = false;
    if (linePass) {
      const p = await linePass(username);
      if (p) return { pass: p, known: true, src: 'lines' };
    }
    if (fulfillPass) {
      const p = await fulfillPass(username);
      if (p) return { pass: p, known: true, src: 'fulfill' };
    }
    let listingError = null;
    if (findPanelPassword && conf && conf.base) {
      try {
        const p = await findPanelPassword(conf, username);
        if (p && p.error && !p.found) listingError = p.error;
        if (p && p.found) {
          known = true;
          if (p.pass) return { pass: p.pass, known: true, src: 'panel', user: p.user || username };
          return { pass: '', known: true, src: 'panel', user: p.user || username, listingError };
        }
      } catch (e) { listingError = 'fail'; }
    }
    return { pass: '', known, src: '', listingError };
  }

  async function check({ username, password }) {
    const user = String(username || '').trim();
    const typed = password == null ? '' : String(password);
    if (!user) return { err: 'panelmissing' };
    const conf = getConf ? await getConf() : null;
    const rec = softwareByName ? await softwareByName(user) : null;

    if (typed) {
      if (!conf || !conf.base) {
        const known = lastKnown(rec, now());
        return known || { err: 'paneloff' };
      }
      let r;
      try { r = await checkOwn(conf, user, typed); } catch { r = { error: 'fail' }; }
      if (r && r.found) return publicFields(r);
      if (r && r.authFailed) return { err: 'panelauth' };
      if (r && r.error) return lastKnown(rec, now()) || { err: 'paneloff' };
      return { err: 'panelbad' };
    }

    const got = await resolvePass(user, conf);
    if (got.pass && conf && conf.base) {
      let r;
      try { r = await checkOwn(conf, got.user || user, got.pass); } catch { r = { error: 'fail' }; }
      if (r && r.found) return publicFields(r);
      if (r && r.authFailed) return { err: 'panelauth' };
      if (r && r.error) return lastKnown(rec, now()) || { err: 'paneloff' };
      return lastKnown(rec, now()) || { err: 'panelauth' };
    }

    if (got.listingError && !got.known && !got.pass) {
      return lastKnown(rec, now()) || { err: 'paneloff' };
    }
    if (!got.known && !got.pass) {
      const known = lastKnown(rec, now());
      if (known) return known;
      return { err: 'panelmissing' };
    }
    // username known but no password, or no panel
    return lastKnown(rec, now()) || { err: (conf && conf.base) ? 'panelauth' : 'paneloff' };
  }

  return { check, resolvePass, publicFields, lastKnown };
}

module.exports = { create, publicFields, lastKnown };
