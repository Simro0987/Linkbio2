'use strict';
const assert = require('assert');
const { sanitize, parseVideo, embedSrc } = require('../sanitize');
const { slugify } = require('../sections');
let n = 0, f = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  ✓ ' + name); } catch (e) { f++; console.log('  ✗ ' + name + ': ' + e.message); } };
const noXss = (h) => { assert(!/<script|<img|<svg|<iframe|on\w+=|javascript:/i.test(h), 'unsafe: ' + h); };
t('script/img/svg/iframe payloads are neutralised', () => {
  for (const p of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="https://evil"></iframe>', '<b onmouseover="x()">b</b>', '<a href="javascript:alert(1)">x</a>', '<a href="jav&#x09;ascript:alert(1)">x</a>', '<a href=" JaVaScRiPt:alert(1)">x</a>', '<p style="x" onclick=y>p</p>', '<scr<script>ipt>alert(1)</script>', '<math><mtext><img src=x onerror=1></mtext></math>'])
    noXss(sanitize(p));
});
t('allowed formatting kept, attributes stripped, tags balanced', () => {
  assert.strictEqual(sanitize('<b class="x">a</b><i>b'), '<b>a</b><i>b</i>');
  assert.strictEqual(sanitize('<h2>T</h2>'), '<h2>T</h2>');
});
t('safe links get rel=noopener', () => {
  const h = sanitize('<a href="https://example.com/x">x</a>'); assert(/href="https:&#47;&#47;example.com&#47;x" rel="noopener noreferrer nofollow"/.test(h), h);
  assert.strictEqual(sanitize('<a href="//evil.com">p</a>'), '<a>p</a>');
});
t('plain text → paragraphs, escaped', () => assert.strictEqual(sanitize('a < b\n\nc\nd'), '<p>a &#60; b</p><p>c<br>d</p>'));
t('YouTube variants parse to 11-char id + start', () => {
  assert.deepStrictEqual(parseVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s'), { t: 'yt', id: 'dQw4w9WgXcQ', start: 65 });
  for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ']) assert.strictEqual(parseVideo(u).id, 'dQw4w9WgXcQ', u);
  assert(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/.test(embedSrc(parseVideo('https://youtu.be/dQw4w9WgXcQ'))));
});
t('Vimeo parses id (+private hash)', () => {
  assert.deepStrictEqual(parseVideo('https://vimeo.com/76979871'), { t: 'vimeo', id: '76979871', h: '' });
  assert.deepStrictEqual(parseVideo('https://player.vimeo.com/video/123?h=abc123ff'), { t: 'vimeo', id: '123', h: 'abc123ff' });
});
t('direct files: https .mp4/.webm only, no IP/localhost/credentials/ports', () => {
  assert.strictEqual(parseVideo('https://cdn.example.com/a.webm').type, 'video/webm');
  for (const u of ['http://cdn.example.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://localhost/a.mp4', 'https://u:p@ex.com/a.mp4', 'https://ex.com:8443/a.mp4', 'https://[::1]/a.mp4', 'https://ex.com/a.mp4.exe', 'javascript:alert(1)', 'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/<script>'])
    assert.strictEqual(parseVideo(u), null, u);
});
t('slugify', () => assert.strictEqual(slugify('Videonávody – Ako začať!'), 'videonavody-ako-zacat'));

// ---- section manager helpers (sections/types.js) ----
const ST = require('../sections/types');
const { safeHref } = require('../sanitize');
t('orderKeys keeps saved order, appends new keys after their natural predecessor', () => {
  assert.deepStrictEqual(ST.orderKeys(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'd', 'a', 'b']);
  assert.deepStrictEqual(ST.orderKeys(['a', 'b'], []), ['a', 'b']);
  assert.deepStrictEqual(ST.orderKeys(['a', 'b'], ['x', 'b', 'a']), ['b', 'a']);
});
t('move up/down clamps at the ends', () => {
  assert.deepStrictEqual(ST.move(['a', 'b', 'c'], 'b', 'up'), ['b', 'a', 'c']);
  assert.deepStrictEqual(ST.move(['a', 'b', 'c'], 'c', 'down'), ['a', 'b', 'c']);
});
t('cleanCfg: colours hex only, anchors validated, reserved ids refused', () => {
  const c = ST.cleanCfg('text', { bg_on: '1', bg: 'red;}body{x', fg_on: '1', fg: '#ABCDEF', anchor: 'cennik', vis: 'evil', showTitle: '1' }, {});
  assert(!c.bg); assert.strictEqual(c.fg.toLowerCase(), '#abcdef'); assert(!c.anchor); assert(!c.vis || c.vis === 'all'); assert(c.showTitle);
  assert.strictEqual(ST.cleanCfg('text', { anchor: 'akcia-2' }, {}).anchor, 'akcia-2');
  assert(!ST.cleanCfg('text', { anchor: '"><script>' }, {}).anchor);
});
t('cssFor emits only validated colours', () => {
  const css = ST.cssFor([{ id: 7, cfg: { bg: '#112233', fg: '#ffffff' } }, { id: 8, cfg: { bg: 'url(x)' } }]);
  assert(/\.xs-7\{background:#112233;color:#ffffff;?\}/.test(css), css); assert(!/xs-8|url\(/.test(css), css);
});
t('parseLinks: only safe hrefs, emoji optional', () => {
  const l = ST.parseLinks('Web | https://example.com | 🌐\nZlé | javascript:alert(1)\nKotva | #akcia\n | https://x.test', safeHref);
  assert.deepStrictEqual(l.map((x) => x.u), ['https://example.com/', '#akcia'].map((u) => u === '#akcia' ? u : l[0].u));
  assert.strictEqual(l[0].e, '🌐'); assert(!l.some((x) => /javascript/i.test(x.u)));
});
t('parseFaq splits blocks on blank lines', () => {
  const f = ST.parseFaq('Q1?\nA1\nA1b\n\n\nQ2?\nA2'); assert.strictEqual(f.length, 2); assert.strictEqual(f[0].q, 'Q1?'); assert(/A1b/.test(f[0].a));
});
t('countdown time zone Europe/Bratislava round-trips', () => {
  const e = ST.zonedToEpoch('2027-01-01T00:00'); assert.strictEqual(new Date(e).toISOString(), '2026-12-31T23:00:00.000Z'); assert.strictEqual(ST.epochToZoned(e), '2027-01-01T00:00');
  const s = ST.zonedToEpoch('2027-07-01T12:30'); assert.strictEqual(new Date(s).toISOString(), '2027-07-01T10:30:00.000Z');
  assert(!ST.zonedToEpoch('nonsense'));
});
t('every kind has label + icon; one-only kinds are the page-wide built-ins', () => {
  for (const [k, v] of Object.entries(ST.KINDS)) assert(v.l && v.i, k);
  assert(ST.KINDS.hero.one && ST.KINDS.chat.one && !ST.KINDS.pricing.one && !ST.KINDS.payments.one && !ST.KINDS.channels.one);
});

(async () => {
  const secDb = require('../sections/db');
  n++;
  try {
    let shouldFail = false;
    const sample = [{ id: 1, place: 'home', kind: 'hero', visible: true }];
    const ctx = secDb({
      pool: {
        query: async () => {
          if (shouldFail) throw new Error('Your account or project has exceeded the quota. Upgrade your plan to increase limits.');
          return { rows: sample };
        },
      },
      getSettings: async () => ({}),
      setSettings: async () => {},
    });
    assert.deepStrictEqual(await ctx.secHome(), sample);
    ctx.secDrop();
    shouldFail = true;
    assert.deepStrictEqual(await ctx.secHome(), sample, 'falls back to last known rows when DB fails');
    const coldCtx = secDb({
      pool: { query: async () => { throw new Error('quota exceeded'); } },
      getSettings: async () => ({}),
      setSettings: async () => {},
    });
    assert.deepStrictEqual(await coldCtx.secHome(), [], 'returns empty array on cold start when DB fails');
    console.log('  ✓ sections/db falls back gracefully on DB quota/connection errors');
  } catch (e) {
    f++;
    console.log('  ✗ sections/db fallback: ' + e.message);
  }
  console.log(`\n${n} tests, ${f} failed`);
  if (f) process.exit(1);
})();
