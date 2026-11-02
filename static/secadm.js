'use strict';
// admin › Sekcie: formatting toolbar + drag & drop ordering (mouse, touch, pen via Pointer Events; keyboard users use the ↑/↓ buttons)
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

  document.querySelectorAll('ol.dnd[data-form]').forEach(function (ol) {
    var form = document.getElementById(ol.getAttribute('data-form')); if (!form) return;
    var drag = null, start = '', pid = null;
    function ids() { return Array.prototype.map.call(ol.querySelectorAll(':scope > li[data-id]'), function (li) { return li.getAttribute('data-id'); }).join(','); }
    ol.addEventListener('pointerdown', function (e) {
      var h = e.target.closest('.dh'); if (!h || !ol.contains(h) || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = h.closest('li[data-id]'); if (!drag) return;
      e.preventDefault(); pid = e.pointerId; start = ids();
      try { ol.setPointerCapture(pid); } catch (x) {} // capture on the list (never moved), not the handle – moving the item would release capture
      drag.classList.add('drag'); ol.classList.add('dragging');
    });
    ol.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== pid) return;
      e.preventDefault();
      var y = e.clientY, list = Array.prototype.filter.call(ol.children, function (li) { return li !== drag && li.hasAttribute('data-id'); }), before = null;
      for (var i = 0; i < list.length; i++) { var r = list[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { before = list[i]; break; } }
      if (before) { if (drag.nextElementSibling !== before) ol.insertBefore(drag, before); } else if (ol.lastElementChild !== drag) ol.appendChild(drag);
      if (y < 40) window.scrollBy(0, -12); else if (y > window.innerHeight - 40) window.scrollBy(0, 12);
    });
    function end(e) {
      if (!drag || (e && e.pointerId !== pid)) return;
      drag.classList.remove('drag'); ol.classList.remove('dragging'); drag = null;
      var now = ids();
      if (now !== start) { form.querySelector('input[name=order]').value = now; ol.classList.add('saving'); form.submit(); }
    }
    ol.addEventListener('pointerup', end); ol.addEventListener('pointercancel', end); ol.addEventListener('lostpointercapture', end);
  });

  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });
})();
