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
console.log(`\n${n} tests, ${f} failed`); if (f) process.exit(1);
