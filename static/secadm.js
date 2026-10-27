'use strict';
// admin section editor: tiny formatting toolbar (wraps the selection in whitelisted tags; server sanitizes anyway)
(function () {
  document.querySelectorAll('.tb').forEach(function (tb) {
    var ta = document.getElementById(tb.getAttribute('data-for')); if (!ta) return;
    tb.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tag]'); if (!b) return;
      var t = b.getAttribute('data-tag'), s = ta.selectionStart, en = ta.selectionEnd, sel = ta.value.slice(s, en), ins;
      if (t === 'a') { var u = window.prompt('URL (https://…)', 'https://'); if (!u) return; ins = '<a href="' + u.replace(/"/g, '') + '">' + (sel || u) + '</a>'; }
      else if (t === 'ul') ins = '<ul>\n' + (sel || 'položka').split('\n').map(function (l) { return '<li>' + l + '</li>'; }).join('\n') + '\n</ul>';
      else ins = '<' + t + '>' + (sel || '') + '</' + t + '>';
      ta.setRangeText(ins, s, en, 'end'); ta.focus();
    });
  });
})();
