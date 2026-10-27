// /ucet: copy the affiliate link (no inline scripts – CSP)
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]'); if (!b) return;
    var el = document.getElementById(b.getAttribute('data-copy')); if (!el) return;
    var txt = el.value || el.textContent || '';
    var done = function () { var o = b.textContent; b.textContent = b.getAttribute('data-ok') || '✅'; setTimeout(function () { b.textContent = o; }, 1800); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, function () { el.select(); try { document.execCommand('copy'); done(); } catch (x) {} });
    else { el.focus(); el.select(); try { document.execCommand('copy'); done(); } catch (x) {} }
  });
  document.addEventListener('focusin', function (e) { if (e.target && e.target.id === 'reflink') e.target.select(); });
})();
