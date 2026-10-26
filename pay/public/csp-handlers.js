// Delegated handlers so pages need no inline on* attributes (CSP without 'unsafe-inline' for scripts).
(function () {
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-cp],[data-href]') : null;
    if (!t) return;
    if (t.hasAttribute('data-href')) { location.href = t.getAttribute('data-href'); return; }
    var el = document.getElementById(t.getAttribute('data-cp')); if (!el) return;
    navigator.clipboard.writeText(el.textContent.trim()).then(function () {
      var o = t.textContent; t.textContent = '✅ Skopírované'; setTimeout(function () { t.textContent = o; }, 1500);
    });
  });
  document.addEventListener('error', function (e) {
    var i = e.target;
    if (i && i.tagName === 'IMG' && i.dataset.fallback && !i.dataset.fb) { i.dataset.fb = 1; i.src = i.dataset.fallback; }
  }, true);
})();
