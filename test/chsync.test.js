'use strict';
const assert = require('assert');
const C = require('../chsync');
const L = require('../panellines');
const P = require('../panel');

const M3U = `#EXTM3U
#EXTINF:-1 tvg-id="ct1.cz" tvg-logo="https://img.example/ct1.png" group-title="České",ČT 1
http://panel.example:8080/live/user/secret/1
#EXTINF:-1 tvg-id="markiza.sk" tvg-name="Markíza" tvg-logo="http://cdn.example/logo.png" group-title="Slovenské",Markíza HD
http://panel.example:8080/live/user/secret/2.ts
# comment
#EXTINF:-1 tvg-id="bad" group-title="X",http://evil.example/name
rtmp://x
#EXTINF:-1 group-title="Šport",Premier Sport
https://panel.example/get.php?username=u&password=p&type=m3u
#EXTINF:-1 tvg-id="ct1.cz" group-title="České",ČT 1
http://dup.example/3
#EXTINF:-1 tvg-logo="https://x.example:8443/l.png",Port logo
http://x/4
`;

(async () => {
  const r = await C.parseM3u(M3U);
  assert.strictEqual(r.droppedUrls, 6);
  assert.strictEqual(r.items.length, 4);
  assert.strictEqual(r.items[2].name, 'Premier Sport');
  assert.strictEqual(r.items[3].name, 'Port logo');
  assert.strictEqual(r.items[3].logo, '');
  assert.deepStrictEqual(r.items[0], { name: 'ČT 1', category: 'České', logo: 'https://img.example/ct1.png', tvgId: 'ct1.cz' });
  assert.strictEqual(r.items[1].name, 'Markíza HD');
  assert.strictEqual(r.items[1].logo, 'https://cdn.example/logo.png'); // http upgraded
  assert.strictEqual(r.items[1].tvgId, 'markiza.sk');
  const dump = JSON.stringify(r);
  assert.ok(!/secret|get\.php|username=u|rtmp:\/\//i.test(dump), 'no stream URLs or credentials in result');

  const xt = C.fromXtream(
    [{ category_id: '1', category_name: 'Šport' }, { category_id: '2', category_name: 'Filmy' }],
    [
      { name: 'Canal+ Sport', category_id: '1', stream_icon: 'https://l.example/c.png', epg_channel_id: 'csport.sk', stream_id: 99, direct_source: 'http://secret.example/live.ts' },
      { name: 'FilmBox', category_id: '2', stream_icon: 'http://l.example/f.png', direct_source: 'http://x' },
      { name: 'http://bad', category_id: '1', stream_id: 1 },
    ]
  );
  assert.strictEqual(xt.items.length, 2);
  assert.strictEqual(xt.items[0].category, 'Šport');
  assert.strictEqual(xt.items[0].tvgId, 'csport.sk');
  assert.strictEqual(xt.items[1].logo, 'https://l.example/f.png');
  assert.strictEqual(xt.items[0].streamId, 99);
  assert.strictEqual(xt.items[1].streamId, undefined);
  const xd = JSON.stringify(xt);
  assert.ok(!/direct_source|secret\.example|live\.ts|"stream_id"/i.test(xd));

  const b = L.parseBulk('jan:tajne\n# skip\neva;heslo2\npeto\tpass3\nmara  pass 4\nbadline\njan:newer\n***:x\n', (u) => /^[A-Za-z0-9_.@+-]{1,64}$/.test(u));
  assert.deepStrictEqual(b.items.map((x) => x.user), ['jan', 'eva', 'peto', 'mara']);
  assert.strictEqual(b.items.find((x) => x.user === 'jan').pass, 'newer');
  assert.strictEqual(b.items.find((x) => x.user === 'mara').pass, 'pass 4');
  assert.ok(b.errors.length >= 2);

  const exp = '2030-01-15T21:30:00.000Z';
  assert.strictEqual(L.fmtDateTime(exp), '15.01.2030 22:30'); // UTC+1 in January
  assert.strictEqual(L.daysLeft(exp, Date.parse('2030-01-10T21:30:00.000Z')), 5);
  assert.strictEqual(L.daysLeft('2099-12-31T00:00:00.000Z'), null);
  assert.strictEqual(L.daysLeft('2000-01-01T00:00:00.000Z'), 0);
  assert.strictEqual(L.statusKind({ found: true, active: true, status: 'Active' }), 'active');
  assert.strictEqual(L.statusKind({ found: true, active: false, status: 'Banned' }), 'banned');
  assert.strictEqual(L.devicesWord(2, false), 'zariadenia');
  assert.strictEqual(L.daysWord(5, false), 'dní');

  const EXP = 1893456000;
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (/action=get_live_categories/.test(url)) return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify([{ category_id: '1', category_name: 'Live' }]) };
    if (/action=get_live_streams/.test(url)) return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify([{ name: 'JOJ', category_id: '1', stream_icon: 'https://l.example/j.png', epg_channel_id: 'joj.sk', stream_id: 7, direct_source: 'http://hidden/stream' }]) };
    if (/player_api\.php\?username=ana/.test(url) && /password=ok/.test(url) && !/action=/.test(url)) {
      return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ user_info: { auth: 1, status: 'Active', exp_date: String(EXP), active_cons: '1', max_connections: '2' } }) };
    }
    return { status: 404, headers: new Map(), text: async () => 'no' };
  };
  const api = P.create({ fetchImpl: f });
  const cat = await api.liveCatalog({ base: 'https://x.example', user: 'res', pass: 'rp' });
  assert.strictEqual(cat.items[0].name, 'JOJ');
  assert.strictEqual(cat.items[0].tvgId, 'joj.sk');
  assert.strictEqual(cat.items[0].streamId, 7);
  assert.ok(!/direct_source|hidden\/stream|"stream_id"/.test(JSON.stringify(cat)));
  assert.ok(calls.every((u) => /player_api\.php/.test(u) && /action=get_live_(categories|streams)/.test(u)));
  assert.ok(calls.every((u) => !/get\.php|m3u|live\//i.test(u)));
  const own = await api.checkOwn({ base: 'https://x.example', type: 'xtream' }, 'ana', 'ok');
  assert.ok(own.found && own.active);
  assert.strictEqual(own.status, 'Active');
  assert.deepStrictEqual(own.connections, { active: 1, max: 2 });

  console.log('chsync: ok');
})().catch((e) => { console.error(e); process.exit(1); });
