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
