'use strict';
// 👛/🔗 confirm dialogs for wallet + amount-link forms (no inline JS; CSP script-src 'self')
document.addEventListener('submit', function (e) {
  var f = e.target;
  if (f && f.getAttribute && f.getAttribute('data-confirm') && !window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
});
