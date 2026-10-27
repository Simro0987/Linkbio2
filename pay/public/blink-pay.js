// ⚡ /blink-pay – status polling, countdown, automatic new invoice after expiry (same-origin fetch only; no inline JS).
(function () {
  var root = document.getElementById('bl'); if (!root) return;
  var id = root.getAttribute('data-order');
  var st = root.getAttribute('data-state');
  var skew = Date.parse(root.getAttribute('data-now')) - Date.now();
  var exp = Date.parse(root.getAttribute('data-exp') || '') || 0;
  var qk = root.getAttribute('data-qk');
  var $ = function (x) { return document.getElementById(x); };
  var renewing = false, fails = 0;
  function nf(n) { return Number(n).toLocaleString('sk-SK').replace(/\u00a0/g, ' '); }
  function apply(s) {
    if (!s || !s.ok) return;
    st = s.status;
    if (s.status === 'paid') { $('blPay').hidden = true; $('blPaid').hidden = false; return; }
    if (s.expiresAt) exp = Date.parse(s.expiresAt);
    if (s.sats != null) $('blSats').textContent = nf(s.sats);
    if (s.paymentRequest) { $('blPr').textContent = s.paymentRequest; $('blOpen').href = 'lightning:' + s.paymentRequest; }
    if (s.qrKey && s.qrKey !== qk) { qk = s.qrKey; $('blQr').src = '/api/blink-pay/' + encodeURIComponent(id) + '/qr.png?k=' + encodeURIComponent(qk); }
    $('blQr').parentNode.classList.toggle('old', s.status === 'expired');
    if (s.status === 'expired') renew();
  }
  function renew() {
    if (renewing) return; renewing = true;
    $('blSt').innerHTML = '<span class="bl-dot"></span>Faktúra vypršala – vytváram novú…';
    fetch('/api/blink-pay/' + encodeURIComponent(id) + '/renew', { method: 'POST', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        renewing = false;
        if (!s.ok) { $('blSt').innerHTML = '<span class="bl-err">' + String(s.error || 'Chyba').replace(/</g, '&lt;') + '</span>'; return; }
        $('blSt').innerHTML = '<span class="bl-dot"></span>Čakáme na platbu…';
        if (s.status !== 'expired') apply(s);
      })
      .catch(function () { renewing = false; });
  }
  function tick() {
    if (st === 'paid') return;
    var left = Math.max(0, Math.floor((exp - (Date.now() + skew)) / 1000));
    var m = Math.floor(left / 60), s = left % 60;
    $('blCd').textContent = m + ':' + (s < 10 ? '0' : '') + s;
    $('blExp').classList.toggle('soon', left < 60);
    if (left === 0 && !renewing && st !== 'expired') { st = 'expired'; renew(); }
  }
  function poll() {
    if (st === 'paid') return;
    fetch('/api/blink-pay/' + encodeURIComponent(id) + '/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) { fails = 0; apply(s); })
      .catch(function () { fails++; })
      .then(function () { setTimeout(poll, Math.min(15000, 3000 + fails * 2000)); });
  }
  if (st === 'paid') return;
  tick(); setInterval(tick, 1000);
  if (st === 'expired') renew();
  setTimeout(poll, 2500);
})();
