// /platby: logged-in lnkbio customer → show the affiliate bonus for the chosen plan (read-only, no influence on price or flow).
(function () {
  'use strict';
  var id = (new URLSearchParams(location.search).get('plan') || '').replace(/[^0-9]/g, '');
  var en = document.documentElement.lang === 'en';
  function add(box, cls, text, href, linkText) {
    var p = document.createElement('p'); p.className = cls; p.textContent = text;
    if (href) { var a = document.createElement('a'); a.href = href; a.textContent = linkText; p.appendChild(document.createTextNode(' ')); p.appendChild(a); }
    box.appendChild(p);
  }
  function run() {
    var box = document.getElementById('planBox'); if (!box) return;
    fetch('/api/ucet-bonus', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j) return;
      if (!j.logged) { if (id) add(box, 'hint acc-note', en ? 'Have an account? Log in so the payment counts towards your licence.' : 'Máte účet? Prihláste sa, aby sa platba pripísala k vášmu účtu.', '/prihlasenie?next=' + encodeURIComponent(location.pathname + location.search), en ? 'Log in' : 'Prihlásiť sa'); return; }
      var pl = id && j.plans && j.plans[id];
      if (pl && pl.label) add(box, 'acc-bonus', '🎁 ' + pl.label);
      add(box, 'hint acc-note', (en ? 'Logged in as ' : 'Prihlásený ako ') + j.username + (en ? ' – the order will be linked to your account.' : ' – objednávka sa pripíše k vášmu účtu.'));
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
