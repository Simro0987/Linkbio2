'use strict';

(function () {
  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  var burger = q('#adBurger'), side = q('.adside'), search = q('#adSearch'), hits = q('#adHits');
  if (burger && side) {
    burger.addEventListener('click', function () { document.body.classList.toggle('ad-nav-open'); });
    document.addEventListener('click', function (e) {
      if (!document.body.classList.contains('ad-nav-open')) return;
      if (side.contains(e.target) || burger.contains(e.target)) return;
      document.body.classList.remove('ad-nav-open');
    });
  }
  var path = location.pathname.replace(/\/$/, '') || '/admin';
  qa('.adside a').forEach(function (a) {
    var h = (a.getAttribute('href') || '').replace(/\/$/, '');
    if (h && (path === h || (h !== '/admin' && path.indexOf(h) === 0))) a.classList.add('on');
  });
  /* Keep in sync with panel.normBase: http/https, IP/domain, custom port; missing scheme → http:// */
  function normPanelBase(u) {
    var s = String(u || '').trim();
    if (!s) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    var x;
    try { x = new URL(s); } catch (e) { return null; }
    if (!/^https?:$/.test(x.protocol) || x.username || x.password || !x.hostname) return null;
    return x.origin + x.pathname.replace(/\/+$/, '');
  }
  var pu = q('#pu');
  if (pu) {
    function checkPu() {
      var v = (pu.value || '').trim();
      if (!v) { pu.setCustomValidity(''); return true; }
      if (normPanelBase(v)) { pu.setCustomValidity(''); return true; }
      pu.setCustomValidity('Zadajte http:// alebo https:// adresu (IP alebo doména a voliteľný port).');
      return false;
    }
    pu.addEventListener('input', checkPu);
    if (pu.form) pu.form.addEventListener('submit', function (e) {
      if (!checkPu()) { e.preventDefault(); pu.reportValidity(); }
    });
  }
  if (!search) return;
  var tiles = qa('.adt').map(function (el) {
    return { href: el.getAttribute('href'), title: (el.querySelector('.tt') || el).textContent, hint: (el.querySelector('.tm') || {}).textContent || '', q: (el.getAttribute('data-q') || el.textContent).toLowerCase(), el: el };
  });
  function run() {
    var s = (search.value || '').trim().toLowerCase();
    qa('.adg').forEach(function (g) { g.hidden = false; });
    tiles.forEach(function (t) { if (t.el) t.el.hidden = false; });
    if (!s) { if (hits) hits.hidden = true; return; }
    var m = tiles.filter(function (t) { return t.q.indexOf(s) !== -1; });
    if (hits) {
      hits.hidden = false;
      hits.innerHTML = m.length ? m.slice(0, 12).map(function (t) {
        return '<a href="' + t.href + '"><strong>' + t.title + '</strong> <span>' + (t.hint || '') + '</span></a>';
      }).join('') : '<p class="hint">Nič sa nenašlo pre „' + search.value.replace(/[<>]/g, '') + '“.</p>';
    }
    if (qa('.adt').length) {
      tiles.forEach(function (t) { if (t.el) t.el.hidden = m.indexOf(t) === -1; });
      qa('.adg').forEach(function (g) { g.hidden = !qa('.adt:not([hidden])', g).length; });
    }
  }
  search.addEventListener('input', run);
  search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var first = hits && !hits.hidden ? hits.querySelector('a') : q('.adt:not([hidden])');
      if (first) location.href = first.href;
    }
    if (e.key === 'Escape') { search.value = ''; run(); search.blur(); }
  });
})();
