// Affiliate tier editor (admin /admin/zakaznici/nastavenia): add/remove rows, validation, live preview. CSP-safe (no innerHTML with input).
(function () {
  var t = document.getElementById('afft'); if (!t) return;
  var tb = t.tBodies[0], form = document.getElementById('afform'), prev = document.getElementById('afprev'),
    errBox = document.getElementById('aferr'), save = document.getElementById('afsave'), rowsIn = document.getElementById('afrows');
  var prices = {}; try { prices = JSON.parse(t.getAttribute('data-prices') || '{}'); } catch (e) {}
  var pk = Object.keys(prices).map(Number).sort(function (a, b) { return a - b; });
  document.documentElement.classList.add('afjs');
  function el(tag, txt, cls) { var e = document.createElement(tag); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; }
  function eur(n) { return n.toFixed(2).replace('.', ',') + ' €'; }
  function renumber() {
    Array.prototype.forEach.call(tb.rows, function (tr, i) {
      Array.prototype.forEach.call(tr.querySelectorAll('input'), function (inp) {
        if (inp.name) inp.name = inp.name.replace(/^t\d+_/, 't' + i + '_');
        if (inp.id) inp.id = inp.id.replace(/^t\d+_/, 't' + i + '_');
      });
      var lb = tr.querySelector('label.sr'); if (lb) lb.htmlFor = 't' + i + '_min';
    });
    rowsIn.value = tb.rows.length;
  }
  function read() {
    var rows = [], errs = [];
    Array.prototype.forEach.call(tb.rows, function (tr) {
      var minIn = tr.querySelector('input[name$="_min"]'), del = tr.querySelector('input[name$="_del"]');
      Array.prototype.forEach.call(tr.querySelectorAll('input'), function (i) { i.classList.remove('bad'); });
      var v = minIn.value.trim(); if (v === '' || (del && del.checked)) return;
      var r = { min: +v, bonus: {}, dev: {}, tr: tr };
      if (!/^\d{1,6}$/.test(v) || +v > 100000) { minIn.classList.add('bad'); errs.push('Počet aktívnych musí byť celé číslo 0 – 100000.'); }
      pk.forEach(function (m) {
        var b = tr.querySelector('input[name$="_m' + m + '"]'), d = tr.querySelector('input[name$="_d' + m + '"]');
        var bv = b.value.trim() || '0';
        if (!/^\d{1,3}$/.test(bv) || +bv > 120) { b.classList.add('bad'); errs.push('Bonus musí byť celé číslo 0 – 120 mesiacov.'); }
        r.bonus[m] = +bv || 0; r.dev[m] = !!(d && d.checked);
      });
      rows.push(r);
    });
    var seen = {}; rows.forEach(function (r) { if (seen[r.min]) { r.tr.querySelector('input[name$="_min"]').classList.add('bad'); errs.push('Každá úroveň musí mať iný počet aktívnych.'); } seen[r.min] = 1; });
    if (rows.length > 20) errs.push('Najviac 20 úrovní.');
    rows.sort(function (a, b) { return a.min - b.min; });
    return { rows: rows, errs: errs.filter(function (e, i, a) { return a.indexOf(e) === i; }) };
  }
  function render() {
    var d = read();
    errBox.hidden = !d.errs.length; errBox.textContent = d.errs.join(' ');
    save.disabled = !!d.errs.length;
    while (prev.firstChild) prev.removeChild(prev.firstChild);
    var cols = pk.filter(function (m) { return prices[m] != null && d.rows.some(function (r) { return r.bonus[m] || r.dev[m]; }); });
    if (!cols.length) { prev.appendChild(el('p', 'Žiadne bonusy – tabuľka sa zákazníkom nezobrazí.', 'hint')); return; }
    var tbl = el('table', null, 'tbl acctier'), th = tbl.createTHead().insertRow();
    th.appendChild(el('th', 'Aktívni odporučení'));
    cols.forEach(function (m) { var c = el('th', m + ' m'); c.appendChild(el('br')); c.appendChild(el('span', eur(prices[m]) + ' · ' + eur(prices[m] / m) + '/mes.', 'hint')); th.appendChild(c); });
    var body = tbl.createTBody();
    d.rows.forEach(function (r) {
      if (!cols.some(function (m) { return r.bonus[m] || r.dev[m]; })) return;
      var tr = body.insertRow(); tr.appendChild(el('th', r.min > 0 ? '≥ ' + r.min : 'každý'));
      cols.forEach(function (m) {
        var td = tr.insertCell(), b = r.bonus[m];
        if (b) {
          td.appendChild(el('b', m + ' + ' + b + ' m')); td.appendChild(el('br'));
          td.appendChild(document.createTextNode(eur(prices[m] / (m + b)) + ' / mes.')); td.appendChild(el('br'));
          td.appendChild(el('span', '−' + Math.round(b / (m + b) * 100) + ' %', 'accdisc'));
          if (r.dev[m]) { td.appendChild(el('br')); td.appendChild(el('span', 'alebo 🖥️ 2. zariadenie zadarmo *', 'hint')); }
        } else if (r.dev[m]) td.appendChild(el('b', '🖥️ 2. zariadenie zadarmo'));
        else td.textContent = '–';
      });
    });
    prev.appendChild(tbl);
  }
  function addRow() {
    var last = tb.rows[tb.rows.length - 1], n = last.cloneNode(true);
    Array.prototype.forEach.call(n.querySelectorAll('input'), function (i) { if (i.type === 'checkbox') i.checked = false; else i.value = /_min$/.test(i.name) ? '' : '0'; });
    tb.appendChild(n); renumber(); var f = n.querySelector('input'); if (f) f.focus(); render();
  }
  tb.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.afrm'); if (!b) return;
    var tr = b.closest('tr');
    if (tb.rows.length > 1) tb.removeChild(tr); else Array.prototype.forEach.call(tr.querySelectorAll('input'), function (i) { if (i.type === 'checkbox') i.checked = false; else i.value = /_min$/.test(i.name) ? '' : '0'; });
    renumber(); render();
  });
  document.getElementById('afadd').addEventListener('click', addRow);
  form.addEventListener('input', render); form.addEventListener('change', render);
  form.addEventListener('submit', function (e) { renumber(); if (read().errs.length) { e.preventDefault(); render(); errBox.focus && errBox.focus(); } });
  renumber(); render();
})();
