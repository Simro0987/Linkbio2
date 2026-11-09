// /ucet: copy affiliate link + show/hide software passwords (no inline scripts – CSP)
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (b) {
      var el = document.getElementById(b.getAttribute('data-copy')); if (!el) return;
      var txt = el.value || el.textContent || '';
      var done = function () { var o = b.textContent; b.textContent = b.getAttribute('data-ok') || '✅'; setTimeout(function () { b.textContent = o; }, 1800); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, function () { el.select(); try { document.execCommand('copy'); done(); } catch (x) {} });
      else { el.focus(); el.select(); try { document.execCommand('copy'); done(); } catch (x) {} }
      return;
    }
    var t = e.target.closest && e.target.closest('[data-reveal]');
    if (!t) return;
    var id = t.getAttribute('data-reveal');
    var span = document.getElementById(id); if (!span) return;
    var show = span.getAttribute('data-show') === '1';
    if (show) {
      span.textContent = span.getAttribute('data-mask') || '••••••••';
      span.setAttribute('data-show', '0');
      t.textContent = t.getAttribute('data-label-show') || '👁️ Ukázať';
    } else {
      span.textContent = span.getAttribute('data-pw') || '';
      span.setAttribute('data-show', '1');
      t.textContent = t.getAttribute('data-label-hide') || '🙈 Skryť';
    }
  });
  document.addEventListener('focusin', function (e) { if (e.target && e.target.id === 'reflink') e.target.select(); });
})();
