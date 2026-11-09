'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../shortepg');
const P = require('../panel');

const TITLE = Buffer.from('Večerné správy', 'utf8').toString('base64');
const DESC = Buffer.from('Hlavné spravodajstvo', 'utf8').toString('base64');
const t0 = 1730000000; // fixed unix

{
  const plain = S.maybeB64('Správy');
  assert.strictEqual(plain, 'Správy');
  assert.strictEqual(S.maybeB64(TITLE), 'Večerné správy');
  assert.strictEqual(S.maybeB64(DESC), 'Hlavné spravodajstvo');
  assert.ok(S.unixSec(t0) === t0);
  assert.strictEqual(S.unixSec(t0 * 1000), t0);
  assert.strictEqual(S.unixSec(String(t0)), t0);
  assert.strictEqual(S.unixSec('2024-01-01 12:00:00'), Date.parse('2024-01-01T12:00:00Z') / 1000);
}

{
  const listings = S.parseShortEpg({
    epg_listings: [
      { title: TITLE, description: DESC, start_timestamp: String(t0), stop_timestamp: String(t0 + 3600) },
      { title: Buffer.from('Nasleduje film', 'utf8').toString('base64'), start_timestamp: t0 + 3600, stop_timestamp: t0 + 7200 },
      { title: 'broken', start_timestamp: t0, stop_timestamp: t0 },
    ],
  });
  assert.strictEqual(listings.length, 2);
  assert.strictEqual(listings[0].title, 'Večerné správy');
  assert.strictEqual(listings[0].descr, 'Hlavné spravodajstvo');
  const now = S.toNowList(listings, t0 + 60);
  assert.strictEqual(now.length, 2);
  assert.deepStrictEqual(now[0], [t0, t0 + 3600, 'Večerné správy', '', '']);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sepg-'));
  const fetched = [];
  let clock = t0 * 1000;
  const api = S.create({
    cacheDir: dir,
    now: () => clock,
    getConf: async () => ({ base: 'https://p.example', user: 'ad', pass: 'pw' }),
    fetchShort: async (c, sid) => {
      fetched.push(sid);
      assert.ok(c.user === 'ad' && c.pass === 'pw');
      if (sid === 99) {
        return { epg_listings: [{ title: TITLE, start_timestamp: t0, stop_timestamp: t0 + 1800 }] };
      }
      if (sid === 100) return { epg_listings: [{ title: 'News', start: '2024-10-27 00:13:20', end: '2024-10-27 01:13:20' }] };
      return null;
    },
    streamIdsFor: async (ids) => {
      const m = {};
      if (ids.includes(1)) m[1] = 99;
      if (ids.includes(2)) m[2] = 100;
      if (ids.includes(3)) m[3] = 101;
      return m;
    },
  });
  const body = await api.forCatalogIds([1, 2, 3, 1, 999]);
  assert.ok(body.c[1] && body.c[1][0][2] === 'Večerné správy');
  assert.strictEqual(fetched.filter((x) => x === 99).length, 1);
  const dump = JSON.stringify(body);
  assert.ok(!/player_api|username=|password=|direct_source|stream_id|p\.example|ad\b|pw\b/i.test(dump));
  assert.ok(!('99' in body.c) && !(99 in body.c));

  const n1 = fetched.length;
  clock += 60e3; // still within 8 min TTL
  await api.forCatalogIds([1]);
  assert.strictEqual(fetched.length, n1, 'cache hit');

  clock += 10 * 60e3;
  await api.forCatalogIds([1]);
  assert.ok(fetched.length > n1, 'ttl expired');

  // concurrency: 5 ids, at most CONCUR=3 in flight
  let inflight = 0, peak = 0;
  const api2 = S.create({
    cacheDir: dir,
    now: () => Date.now(),
    getConf: async () => ({ base: 'https://p.example', user: 'ad', pass: 'pw' }),
    fetchShort: async (c, sid) => {
      inflight++; if (inflight > peak) peak = inflight;
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { epg_listings: [{ title: 'X' + sid, start_timestamp: t0, stop_timestamp: t0 + 60 }] };
    },
    streamIdsFor: async (ids) => Object.fromEntries(ids.map((id) => [id, id + 1000])),
  });
  await api2.forCatalogIds([10, 11, 12, 13, 14]);
  assert.ok(peak <= 3, 'concurrency cap, peak=' + peak);

  // panel.shortEpg uses get_short_epg only
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (/action=get_short_epg/.test(url) && /stream_id=99/.test(url)) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ epg_listings: [{ title: TITLE, start_timestamp: t0, stop_timestamp: t0 + 10 }] }) };
    }
    return { status: 404, headers: new Map(), text: async () => 'no' };
  };
  const pan = P.create({ fetchImpl: f });
  const raw = await pan.shortEpg({ base: 'https://x.example', user: 'res', pass: 'rp' }, 99);
  assert.ok(raw && raw.epg_listings);
  assert.ok(calls.every((u) => /player_api\.php/.test(u) && /action=get_short_epg/.test(u) && /stream_id=99/.test(u)));
  assert.ok(calls.every((u) => !/get\.php|xmltv|m3u/i.test(u)));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  console.log('shortepg: ok');
})().catch((e) => { console.error(e); process.exit(1); });
