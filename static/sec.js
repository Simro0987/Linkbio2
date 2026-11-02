'use strict';
// click-to-load video embeds (no third-party requests until the visitor clicks); src is built server-side from a whitelisted host + ID
(function () {
  var OK = /^https:\/\/(www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}|player\.vimeo\.com\/video\/\d{1,12})(\?[A-Za-z0-9_=&.-]*)?$/;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button.vplay'); if (!b) return;
    var src = b.getAttribute('data-src') || ''; if (!OK.test(src)) return;
    var f = document.createElement('iframe');
    f.src = src; f.title = b.getAttribute('data-title') || 'Video';
    f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    f.setAttribute('allowfullscreen', ''); f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('loading', 'eager');
    b.replaceWith(f); f.focus();
  });
})();
// countdown blocks: <div class="cd" data-t="epoch-ms" data-done="text"> with <b data-k="d|h|m|s">
(function () {
  var els = document.querySelectorAll('.cd[data-t]'); if (!els.length) return;
  function tick() {
    var now = Date.now();
    els.forEach(function (el) {
      var t = +el.getAttribute('data-t') || 0, left = Math.max(0, t - now);
      if (!left) { if (!el.querySelector('.cdd')) { var p = document.createElement('p'); p.className = 'cdd'; p.textContent = el.getAttribute('data-done') || ''; el.replaceChildren(p); } return; }
      var v = { d: Math.floor(left / 864e5), h: Math.floor(left / 36e5) % 24, m: Math.floor(left / 6e4) % 60, s: Math.floor(left / 1e3) % 60 };
      el.querySelectorAll('b[data-k]').forEach(function (b) { var k = b.getAttribute('data-k'), n = v[k]; b.textContent = k === 'd' ? String(n) : (n < 10 ? '0' : '') + n; });
    });
  }
  tick(); setInterval(tick, 1000);
})();
