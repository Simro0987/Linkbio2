'use strict';
// Subscription-panel adapters with a mocked fetch: detection, lookups, date parsing, cache, read-only, no credential leaks.
const assert = require('assert');
const P = require('../panel');
let n = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);
const EXP = 1893456000; // 2030-01-01
function mock(routes) {
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push({ url, opt });
    for (const [re, h] of routes) if (re.test(url)) { const r = await h(url, opt); return { status: r.status || 200, headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })), text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }; }
    return { status: 404, headers: new Map(), text: async () => 'not found' };
  };
  f.calls = calls; return f;
}

t('normBase / parseDate', () => {
  assert.strictEqual(P.normBase('panel.example.com:8080/player_api.php'), 'https://panel.example.com:8080');
  assert.strictEqual(P.normBase('http://x.example/stalker_portal/c/'), 'http://x.example');
  assert.strictEqual(P.normBase('https://u:p@x.example'), null);
  assert.strictEqual(P.normBase('ftp://x'), null);
  assert.strictEqual(P.parseDate(EXP), '2030-01-01T00:00:00.000Z');
  assert.strictEqual(P.parseDate(String(EXP * 1000)), '2030-01-01T00:00:00.000Z');
  assert.strictEqual(P.parseDate('2030-01-01 10:00:00'), '2030-01-01T10:00:00.000Z');
  assert.strictEqual(P.parseDate('31.12.2029'), '2029-12-31T23:59:59.000Z');
  assert.strictEqual(P.parseDate('unlimited'), 'unlimited');
  assert.strictEqual(P.parseDate(''), null); assert.strictEqual(P.parseDate('nonsense'), null);
});
t('auto-detect Xtream UI / XUI.one + lookup uses admin user/pass, never api_key', async () => {
  const f = mock([[/action=get_lines/, () => ({ body: [{ username: 'jan', exp_date: EXP, enabled: 1, max_connections: 2, active_cons: 1 }, { username: 'eva', exp_date: 1000000000, enabled: 1 }] }) ], [/action=get_line/, () => ({ body: { data: { username: 'jan', exp_date: EXP, enabled: 1, status: 'Active', max_connections: 2, active_cons: 1 } } })]]);
  const p = P.create({ fetchImpl: f });
  const c = { base: 'https://p.example', user: 'admin', pass: 'secret' };
  const d = await p.detect(c); assert.strictEqual(d.type, 'xui'); assert.ok(d.canLookup);
  const r = await p.lookup({ ...c, type: 'xui' }, 'JAN'); assert.ok(r.found); assert.ok(r.active); assert.strictEqual(r.expiry, '2030-01-01T00:00:00.000Z');
  assert.strictEqual(r.status, 'Active');
  assert.deepStrictEqual(r.connections, { active: 1, max: 2 });
  const e = await p.lookup({ ...c, type: 'xui' }, 'eva'); assert.ok(e.found); assert.ok(!e.active);
  const x = await p.lookup({ ...c, type: 'xui' }, 'nobody'); assert.ok(!x.found);
  assert.ok(f.calls.every((k) => !/api_key=/i.test(k.url) && !String(k.opt && k.opt.body || '').includes('api_key')));
  assert.ok(f.calls.every((k) => !/[?&]password=/.test(k.url)), 'password stays in POST body, not in the URL');
  assert.ok(f.calls.every((k) => /username=admin/.test(String(k.opt && k.opt.body || ''))));
  const view = p.publicView(r);
  const dump = JSON.stringify(view);
  assert.ok(!/secret|api_key|p\.example|password|direct_source/i.test(dump));
  assert.strictEqual(view.found, true);
});
t('Xtream UI api.php user info with admin body (no api_key)', async () => {
  const f = mock([[/api\.php\?action=user&sub=info/, (url, opt) => {
    const body = String(opt.body || '');
    assert.ok(/username=admin/.test(body) && /password=secret/.test(body));
    assert.ok((opt.method || 'GET') === 'POST');
    let data = {};
    try { data = JSON.parse(new URLSearchParams(body).get('data') || '{}'); } catch { data = {}; }
    if (data.username === 'jan') return { body: { result: true, data: { username: 'jan', password: 'line-secret', exp_date: EXP, status: 'Active', max_connections: 1, active_cons: 0 } } };
    return { body: { result: false } };
  }]]);
  const p = P.create({ fetchImpl: f });
  const c = { base: 'https://p.example', user: 'admin', pass: 'secret' };
  const d = await p.detect(c); assert.strictEqual(d.type, 'xui');
  const r = await p.lookup({ ...c, type: 'xui' }, 'jan');
  assert.ok(r.found && r.active);
  assert.ok(!JSON.stringify(r).includes('line-secret'));
  assert.ok(f.calls.every((k) => !/api_key=/i.test(k.url) && !String(k.opt.body || '').includes('api_key')));
});
t('Stalker / Ministra', async () => {
  const f = mock([[/api\/accounts\/__lnkbio_probe__/, () => ({ body: { status: 'ERROR', error: 'not found' } })], [/api\/accounts\/peter/, () => ({ body: { status: 'OK', results: [{ login: 'peter', tariff_expired_date: '2030-01-01 00:00:00', status: 1 }] } })], [/api\/accounts\//, () => ({ body: { status: 'ERROR', error: 'x' } })]]);
  const p = P.create({ fetchImpl: f }); const c = { base: 'https://s.example', user: 'api', pass: 'pw' };
  assert.strictEqual((await p.detect(c)).type, 'stalker');
  const r = await p.lookup({ ...c, type: 'stalker' }, 'peter'); assert.ok(r.found && r.active);
  assert.ok(!(await p.lookup({ ...c, type: 'stalker' }, 'ghost')).found);
  const st = f.calls.filter((k) => /api\/accounts/.test(k.url));
  assert.ok(st.length);
  assert.ok(st.every((k) => /^Basic /.test(k.opt.headers.authorization) && !k.url.includes('pw')));
  assert.ok(f.calls.every((k) => !k.url.includes('pw') && !/api_key=/i.test(k.url)));
});
t('panel_api.php reseller list + Xtream line check', async () => {
  const f = mock([[/panel_api\.php/, () => ({ body: { users: { 1: { username: 'ana', password: 'hidden-line', exp_date: EXP, enabled: '1', status: 'Active', max_connections: 2, active_cons: 1 } } } })], [/player_api\.php\?username=ana&password=ok/, () => ({ body: { user_info: { auth: 1, status: 'Active', exp_date: String(EXP) } } })], [/player_api\.php/, () => ({ body: { user_info: { auth: 0 } } })]]);
  const p = P.create({ fetchImpl: f }); const c = { base: 'https://x.example', user: 'res', pass: 'rp' };
  assert.strictEqual((await p.detect(c)).type, 'panel_api');
  const lr = await p.lookup({ ...c, type: 'panel_api' }, 'ana'); assert.ok(lr.active);
  assert.deepStrictEqual(lr.connections, { active: 1, max: 2 });
  assert.ok(!JSON.stringify(lr).includes('hidden-line'));
  const own = await p.checkOwn({ ...c, type: 'xtream' }, 'ana', 'ok'); assert.ok(own.found && own.active);
  const bad = await p.checkOwn({ ...c, type: 'xtream' }, 'ana', 'wrong'); assert.ok(!bad.found);
});
t('Xtream-only: detect works, admin lookup unavailable', async () => {
  const f = mock([[/player_api\.php/, () => ({ body: { user_info: { auth: 1, status: 'Active', exp_date: null } } })]]);
  const p = P.create({ fetchImpl: f }); const c = { base: 'https://x.example', user: 'u', pass: 'p' };
  const d = await p.detect(c); assert.strictEqual(d.type, 'xtream'); assert.strictEqual(d.canLookup, false);
  assert.strictEqual((await p.lookup({ ...c, type: 'xtream' }, 'u')).error, 'nolookup');
});
t('custom template + JSON path', async () => {
  const f = mock([[/api\.example\/status\/zuzka/, () => ({ body: { data: { sub: { until: '2030-01-01' } } } })]]);
  const p = P.create({ fetchImpl: f }); const c = { base: '', tpl: 'https://api.example/status/{username}', datePath: 'data.sub.until' };
  assert.strictEqual((await p.detect(c)).type, 'custom');
  const r = await p.lookup({ ...c, type: 'custom' }, 'zuzka'); assert.ok(r.found); assert.strictEqual(r.expiry, '2030-01-01T23:59:59.000Z');
});
t('15-minute cache', async () => {
  let clock = 0; const f = mock([[/get_line/, () => ({ body: { username: 'jan', exp_date: EXP } })]]);
  const p = P.create({ fetchImpl: f, now: () => clock }); const c = { base: 'https://p.example', user: 'admin', pass: 'secret', type: 'xui' };
  await p.lookup(c, 'jan'); await p.lookup(c, 'jan'); assert.strictEqual(f.calls.length, 1);
  clock = 14 * 60e3; await p.lookup(c, 'jan'); assert.strictEqual(f.calls.length, 1);
  clock = 16 * 60e3; await p.lookup(c, 'jan'); assert.strictEqual(f.calls.length, 2);
});
t('read-only: refuses stream/playlist content, does not follow off-host redirects', async () => {
  const f = mock([[/panel_api\.php/, () => ({ headers: { 'content-type': 'application/x-mpegurl' }, body: '#EXTM3U' })]]);
  const p = P.create({ fetchImpl: f });
  await assert.rejects(() => p.lookup({ base: 'https://x.example', user: 'a', pass: 'b', type: 'panel_api' }, 'z'));
  assert.ok(f.calls.every((k) => k.opt.redirect === 'manual' && (k.opt.method || 'GET') === 'GET'));
  assert.ok(f.calls.every((k) => !/get\.php|m3u|live\/|movie\//i.test(k.url)));
});
t('http panel URL: tries https first and follows same-host http→https redirect', async () => {
  assert.strictEqual(P.httpsTwin('http://p.example:8080/x'), 'https://p.example:8080/x');
  assert.ok(P.sameSafeRedirect('http://p.example/a', 'https://p.example/a').startsWith('https://'));
  assert.strictEqual(P.sameSafeRedirect('https://p.example/a', 'https://evil.example/a'), null);
  const calls = [];
  const f = async (url, opt = {}) => {
    calls.push({ url, opt });
    if (url.startsWith('http://p.example/')) {
      return { status: 301, headers: new Map([['location', 'https://p.example/' + url.split('://')[1].split('/').slice(1).join('/')]]), text: async () => '' };
    }
    if (url.includes('action=get_lines')) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify([{ username: 'jan', exp_date: EXP, enabled: 1 }]) };
    }
    if (url.includes('action=get_line')) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ username: 'jan', exp_date: EXP, enabled: 1 }) };
    }
    return { status: 404, headers: new Map(), text: async () => 'no' };
  };
  const p = P.create({ fetchImpl: f });
  const c = { base: 'http://p.example', user: 'admin', pass: 'secret' };
  const d = await p.detect(c); assert.strictEqual(d.type, 'xui');
  const r = await p.lookup({ ...c, type: 'xui' }, 'jan'); assert.ok(r.found);
  assert.ok(calls.some((k) => k.url.startsWith('https://p.example/')));
  assert.ok(calls.every((k) => k.opt.redirect === 'manual'));
  assert.ok(calls.every((k) => !/api_key=/i.test(k.url)));
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } }
  console.log(`panel: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
