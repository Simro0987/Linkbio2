'use strict';
// 💳 Platobné metódy – dashboard panel loader + one-click toggles (no inline JS; CSP script-src 'self')
(function () {
  function qs(r, s) { return r.querySelector(s); }
  function qsa(r, s) { return Array.prototype.slice.call(r.querySelectorAll(s)); }
  function counts(root, c) {
    if (!c) return;
    var on = qs(root, '[data-pm="on"]'), off = qs(root, '[data-pm="off"]');
    if (on) on.textContent = c.on + ' zapnutých';
    if (off) off.textContent = c.off + ' vypnutých';
  }
  function groupCount(sec) {
    if (!sec) return;
    var rows = qsa(sec, '.pmr'), n = rows.filter(function (r) { return !r.classList.contains('off'); }).length;
    var s = qs(sec, '.pmgh small'); if (s) s.textContent = n + '/' + rows.length;
  }
  function bind(root) {
    qsa(root, 'form[data-confirm]').forEach(function (f) {
      f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
    });
    qsa(root, 'form.pmt').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = qs(f, 'button'), row = f.closest('.pmr'), st = qs(f, 'input[name="state"]');
        btn.disabled = true; var old = btn.textContent; btn.textContent = '…';
        fetch(f.action, { method: 'POST', credentials: 'same-origin', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(new FormData(f)).toString() })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) {
            btn.disabled = false;
            if (!x.ok || !x.j.ok) { btn.textContent = old; window.alert(x.j.error || 'Chyba'); return; }
            var on = !!x.j.enabled;
            row.classList.toggle('off', !on);
            st.value = on ? 'off' : 'on';
            btn.textContent = on ? 'Vypnúť' : 'Zapnúť';
            btn.classList.toggle('g', on);
            var tag = qs(row, '.pms'); if (tag) { tag.textContent = on ? 'zapnuté' : 'vypnuté'; tag.classList.toggle('ok', on); }
            counts(root.closest ? (root.closest('.pmw') || document) : document, x.j.counts);
            groupCount(row.closest('.pmg'));
          })
          .catch(function () { btn.disabled = false; btn.textContent = old; window.alert('Spojenie zlyhalo. Skúste to znova.'); });
      });
    });
  }
  function load(sec) {
    var box = qs(sec, '.pmbody') || sec;
    fetch(sec.getAttribute('data-pm-src'), { credentials: 'same-origin', headers: { 'Accept': 'text/html' } })
      .then(function (r) { if (r.redirected || !r.ok) throw new Error('x'); return r.text(); })
      .then(function (h) { box.innerHTML = h; bind(sec); })
      .catch(function () { box.innerHTML = '<p class="msg err">Platobné metódy sa nepodarilo načítať. <a href="/admin/platobne-metody">Otvoriť samostatne</a></p>'; });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var lazy = qsa(document, '[data-pm-src]');
    if (lazy.length) lazy.forEach(load); else qsa(document, '.pmw').forEach(bind);
  });
})();
