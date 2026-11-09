(function () {
  var box = document.getElementById('stavbox');
  if (!box) return;
  var lang = (document.documentElement.lang || 'sk').slice(0, 2);
  var last = (lang === 'en') ? 'Last check' : 'Posledná kontrola';
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function draw(items) {
    if (!items || !items.length) return;
    var h = '<ul class="stl">';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      h += '<li><span class="dot ' + esc(it.cls) + '"></span><span class="sm">' + esc(it.msg) + '</span><span class="st">' + esc(last) + ': ' + esc(it.atLabel || '') + '</span></li>';
    }
    h += '</ul>';
    box.innerHTML = h;
  }
  function tick() {
    fetch('/api/tv/stav.json?lang=' + encodeURIComponent(lang), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) draw(j.items); })
      .catch(function () {});
  }
  setInterval(tick, 60000);
})();
