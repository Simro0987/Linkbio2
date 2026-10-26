/* Live on-chain status widget. Mounts into #chainStatus or auto-creates one when ?orderId= is present. */
(function () {
  var el = document.getElementById('chainStatus');
  var id = el && el.getAttribute('data-order-id');
  if (!id) { try { id = new URLSearchParams(location.search).get('orderId'); } catch (e) {} }
  if (!id) return;
  if (!el) {
    el = document.createElement('div'); el.id = 'chainStatus';
    var host = document.querySelector('.shotbox') || document.querySelector('.card') || document.body;
    host.parentNode ? host.parentNode.insertBefore(el, host.nextSibling) : document.body.appendChild(el);
  }
  var css = document.createElement('style');
  css.textContent = '.cs{margin:1rem 0;padding:.9rem 1rem;border-radius:14px;border:1px solid #334155;background:#0f172a;color:#e8eef9;font:inherit}' +
    '.cs b{font-size:1.05rem}.cs .dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.45rem;vertical-align:middle;background:#94a3b8}' +
    '.cs.waiting .dot{animation:csp 1.4s infinite}.cs.unconfirmed{border-color:#f59e0b}.cs.unconfirmed .dot{background:#f59e0b;animation:csp 1s infinite}' +
    '.cs.confirmed{border-color:#22c55e;background:#052e1a}.cs.confirmed .dot{background:#22c55e}.cs small{display:block;color:#94a3b8;margin-top:.3rem;font-size:.78rem;word-break:break-all}' +
    '.cs button{margin-top:.5rem;border:0;border-radius:10px;padding:.6rem .8rem;background:#334155;color:#fff;font-weight:600;cursor:pointer}' +
    '@keyframes csp{0%,100%{opacity:1}50%{opacity:.25}}';
  document.head.appendChild(css);
  var last = null;
  var supportsN = 'Notification' in window;
  function render(s) {
    if (!s || s.status === 'unsupported') { el.innerHTML = ''; return; }
    var st = s.status === 'error' ? 'waiting' : s.status;
    var label = { waiting: 'čaká sa', unconfirmed: 'prijaté – nepotvrdené', confirmed: 'potvrdené' }[st];
    var tx = (s.txs || [])[0];
    el.innerHTML = '<div class="cs ' + st + '" role="status" aria-live="polite"><span class="dot"></span>Stav platby na blockchaine: <b>' + label + '</b>' +
      (tx ? '<small>TX: ' + tx.txid + '</small>' : '') +
      '<small>Aktualizuje sa automaticky · posledná kontrola ' + new Date(s.checkedAt || Date.now()).toLocaleTimeString('sk-SK') + (s.source ? ' · ' + s.source : '') + '</small>' +
      (supportsN && Notification.permission === 'default' && st !== 'confirmed' ? '<button type="button" id="csNotify">Upozorniť ma notifikáciou</button>' : '') + '</div>';
    var b = document.getElementById('csNotify');
    if (b) b.onclick = function () { Notification.requestPermission().then(function () { render(s); }); };
    if (last && last !== st && st !== 'waiting' && supportsN && Notification.permission === 'granted') {
      try { new Notification('Platba ' + label, { body: 'Objednávka ' + id }); } catch (e) {}
    }
    last = st;
  }
  var url = '/api/order/' + encodeURIComponent(id) + '/chain-status';
  function poll() { fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(render).catch(function () {}); }
  if (window.EventSource) {
    var es = new EventSource(url + '/stream'), fails = 0;
    es.addEventListener('status', function (e) { fails = 0; try { render(JSON.parse(e.data)); } catch (x) {} });
    es.onerror = function () { if (++fails > 3) { es.close(); poll(); setInterval(poll, 30000); } };
  } else { poll(); setInterval(poll, 30000); }
})();
