'use strict';
const assert = require('assert');
const S = require('../subcheck');
const P = require('../panel');
const EXP = 1893456000;

(async () => {
  const conf = { base: 'https://p.example', user: 'admin', pass: 'secret', type: 'panel_api' };
  const calls = [];
  const checkOwn = async (c, u, p) => {
    calls.push({ u, p });
    assert.ok(!Object.prototype.hasOwnProperty.call(c, 'password') || c.pass === 'secret');
    const name = String(u).toLowerCase();
    if (name === 'ana' && p === 'line-secret') return { found: true, active: true, expiry: '2030-01-01T00:00:00.000Z', status: 'Active', connections: { active: 1, max: 2 } };
    if (name === 'eva' && p === 'bad') return { found: false, authFailed: true };
    if (name === 'down') return { error: 'offline' };
    return { found: false };
  };
  const lines = { ana: 'line-secret' };
  const fulfill = { bob: 'bob-secret' };
  const software = { bob: { until_at: '2030-06-01T00:00:00.000Z' }, old: { until_at: '2020-01-01T00:00:00.000Z' } };
  let listing = { jan: 'jan-pass' };
  let listingError = null;

  const api = S.create({
    getConf: async () => conf,
    checkOwn,
    findPanelPassword: async (c, u) => {
      if (listingError) return { found: false, pass: '', error: listingError };
      const want = String(u).toLowerCase();
      const ent = Object.entries(listing).find(([k]) => k.toLowerCase() === want);
      if (!ent) return { found: false, pass: '' };
      return { found: true, user: ent[0], pass: ent[1] };
    },
    linePass: async (u) => lines[String(u).toLowerCase()] || null,
    fulfillPass: (u) => fulfill[String(u).toLowerCase()] || null,
    softwareByName: async (u) => software[String(u).toLowerCase()] || null,
  });

  const r1 = await api.check({ username: 'ANA' });
  assert.ok(r1.found && r1.active);
  assert.strictEqual(r1.status, 'Active');
  assert.deepStrictEqual(r1.connections, { active: 1, max: 2 });
  assert.strictEqual(calls[0].u, 'ANA');
  assert.strictEqual(calls[0].p, 'line-secret');
  assert.ok(!JSON.stringify(r1).includes('line-secret'));
  assert.ok(!('password' in r1) && !('pass' in r1));

  // local list is cheaper: do not need listing when line exists
  listing = {};
  const r1b = await api.check({ username: 'ana' });
  assert.ok(r1b.found);

  // fulfil password used when not in local list
  calls.length = 0;
  const r2 = await api.check({ username: 'bob' });
  // bob's fulfill pass is used with checkOwn; mock only accepts ana — so auth fails then last known
  assert.strictEqual(calls[0].p, 'bob-secret');
  assert.strictEqual(r2.source, 'known');
  assert.ok(r2.found);
  assert.ok(!JSON.stringify(r2).includes('bob-secret'));

  // panel listing password
  calls.length = 0;
  listing = { jan: 'jan-pass' };
  const r3api = S.create({
    getConf: async () => conf,
    checkOwn: async (c, u, p) => (u.toLowerCase() === 'jan' && p === 'jan-pass' ? { found: true, active: true, expiry: '2030-01-01T00:00:00.000Z', status: 'Active' } : { found: false }),
    findPanelPassword: async (c, u) => (String(u).toLowerCase() === 'jan' ? { found: true, user: 'jan', pass: 'jan-pass' } : { found: false, pass: '' }),
    linePass: async () => null,
    fulfillPass: () => null,
    softwareByName: async () => null,
  });
  const r3 = await r3api.check({ username: 'JAN' });
  assert.ok(r3.found && r3.active);
  assert.ok(!JSON.stringify(r3).includes('jan-pass'));

  const miss = await api.check({ username: 'nobody' });
  assert.strictEqual(miss.err, 'panelmissing');

  const auth = await api.check({ username: 'eva', password: 'bad' });
  assert.strictEqual(auth.err, 'panelauth');

  const down = await api.check({ username: 'down', password: 'x' });
  // no last known for 'down'
  assert.strictEqual(down.err, 'paneloff');

  const known = await api.check({ username: 'old' });
  assert.strictEqual(known.source, 'known');
  assert.ok(known.found && !known.active);

  // listing unreachable + no local → paneloff, not "not found"
  const off = S.create({
    getConf: async () => conf,
    checkOwn: async () => ({ error: 'fail' }),
    findPanelPassword: async () => ({ found: false, pass: '', error: 'nolist' }),
    linePass: async () => null,
    fulfillPass: () => null,
    softwareByName: async () => null,
  });
  assert.strictEqual((await off.check({ username: 'ghost' })).err, 'paneloff');

  // panel.js listAccounts + findPanelPassword + player_api check
  const fcalls = [];
  const f = async (url, opt = {}) => {
    fcalls.push(url);
    assert.ok(!/get\.php/i.test(url));
    if (/panel_api\.php/.test(url)) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ users: { 1: { username: 'ana', password: 'hidden-line', exp_date: EXP, enabled: '1' } } }) };
    }
    if (/player_api\.php/.test(url) && /username=ana/.test(url) && /password=hidden-line/.test(url)) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ user_info: { auth: 1, status: 'Active', exp_date: String(EXP), max_connections: 2, active_cons: 1 } }) };
    }
    if (/player_api\.php/.test(url) && /username=ana/.test(url)) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ user_info: { auth: 0 } }) };
    }
    return { status: 404, headers: new Map(), text: async () => 'no' };
  };
  const pan = P.create({ fetchImpl: f });
  const list = await pan.listAccounts({ base: 'https://x.example', user: 'res', pass: 'rp', type: 'panel_api' });
  assert.strictEqual(list.users.length, 1);
  assert.strictEqual(list.users[0].password, 'hidden-line');
  const fp = await pan.findPanelPassword({ base: 'https://x.example', user: 'res', pass: 'rp', type: 'panel_api' }, 'ANA');
  assert.ok(fp.found && fp.pass === 'hidden-line');
  const n1 = fcalls.filter((u) => /panel_api/.test(u)).length;
  await pan.findPanelPassword({ base: 'https://x.example', user: 'res', pass: 'rp', type: 'panel_api' }, 'ana');
  const n2 = fcalls.filter((u) => /panel_api/.test(u)).length;
  assert.strictEqual(n2, n1, 'admin listing is cached');
  const own = await pan.checkOwn({ base: 'https://x.example', type: 'xtream' }, 'ana', fp.pass);
  assert.ok(own.found && own.active);
  const view = pan.publicView(own);
  assert.ok(!JSON.stringify(view).includes('hidden-line'));
  const badAuth = await pan.checkOwn({ base: 'https://x.example', type: 'xtream' }, 'ana', 'wrong');
  assert.ok(badAuth && badAuth.authFailed);

  console.log('subcheck: ok');
})().catch((e) => { console.error(e); process.exit(1); });
