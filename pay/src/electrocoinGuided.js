'use strict';
/**
 * Guided (NON-automated) Electrocoin SEPA flow.
 * No Playwright, no temp email, no captcha handling, no CDP.
 * Customer buys on electrocoin.eu themselves with THEIR email, pastes the bank
 * details back here; we show copyable fields + QR (existing /bank-sepa-pay UI).
 * Proof upload: customer uploads on electrocoin.eu; our site keeps an optional copy.
 */
const electrocoin = require('./electrocoin');

const BUY_URL = electrocoin.BUY_URL;

/**
 * Electrocoin's buy page (React bundle) reads ONLY these query params:
 * send, receive, send_method, receive_method, send_protocol, receive_protocol,
 * send_amount, receive_amount, config, invoice, tab.
 * No param for BTC address, email, name or country -> those stay copy buttons.
 */
function prefillUrl(order) {
  const u = new URL(BUY_URL);
  u.searchParams.set('send_amount', String(order.amountExact));
  return u.toString();
}

function isGuided() {
  const v = String(process.env.ELECTROCOIN_GUIDED || '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (process.env.RENDER || process.env.VERCEL) return true; // cloud
  return !process.env.ELECTROCOIN_CDP_URL; // CDP unavailable
}

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cleanIban = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function validIban(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Za-z0-9]{10,30}$/.test(iban)) return false;
  const r = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let m = 0;
  for (const ch of r) m = (m * 10 + Number(ch)) % 97;
  return m === 1;
}

async function buildGuidedOrder({ orderId, amountEur, firstName, lastName, email, country }) {
  amountEur = Number(amountEur);
  if (!Number.isFinite(amountEur) || amountEur < 5) {
    const e = new Error('Suma v EUR musí byť aspoň 5'); e.code = 'BAD_AMOUNT'; throw e;
  }
  if (!firstName || !lastName) {
    const e = new Error('Meno a priezvisko sú povinné'); e.code = 'BAD_NAME'; throw e;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const e = new Error('Pre Electrocoin je potrebný váš platný email'); e.code = 'BAD_EMAIL'; throw e;
  }
  const dest = await electrocoin.resolveBtcPayDestination({ orderId, amountEur, email });
  if (!dest || !dest.address) {
    const e = new Error('BTC adresa z BTCPay nie je dostupná'); e.code = 'NOT_CONFIGURED'; throw e;
  }
  const now = new Date().toISOString();
  return {
    orderId,
    amountEur,
    amountExact: amountEur.toFixed(2),
    currency: 'EUR',
    firstName, lastName, fullName: `${firstName} ${lastName}`,
    email, customerEmail: email,
    country: String(country || '').trim().toUpperCase().slice(0, 2) || null,
    provider: 'bank_sepa_manual',
    gateway: 'bank_sepa_manual',
    guided: true,
    resolution: 'electrocoin_guided_sepa',
    providerHost: 'electrocoin.eu',
    bank: null, bankDetailsPublic: false,
    status: 'guided_awaiting_bank',
    automationStage: 'guided',
    automationError: null,
    payoutAddress: dest.address, payoutCoin: 'btc', payoutIndex: dest.index,
    btcAddress: dest.address, btcAmount: dest.btcAmount, invoiceId: dest.invoiceId,
    btcpayCheckout: dest.checkoutLink, paymentLink: dest.paymentLink,
    btcSource: dest.source, btcSourceError: dest.error || null,
    reference: null, purpose: null,
    createdAt: now, deadlineAt: null, deadlineMinutes: null,
    screenshotPath: null, screenshotUploadedAt: null, screenshotConfirmedByCustomer: false,
    electrocoinProofUpload: null,
    guidedStep: 1,
  };
}

function parseDeadline(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{1,3}$/.test(s)) return new Date(Date.now() + Number(s) * 60000).toISOString();
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(); d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Short CSS/SVG demos — no real private data. */
function demoSvg(kind) {
  const common = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 140" role="img"`;
  if (kind === 'open') return `<svg ${common} aria-label="Demo: otvorenie Electrocoin">
    <rect width="320" height="140" rx="12" fill="#0f172a"/><rect x="16" y="16" width="288" height="108" rx="8" fill="#1e293b"/>
    <rect x="28" y="28" width="120" height="10" rx="3" fill="#475569"/><rect x="28" y="48" width="180" height="28" rx="6" fill="#334155"/>
    <rect x="28" y="88" width="160" height="22" rx="6" fill="#22c55e"><animate attributeName="opacity" values="1;.55;1" dur="1.6s" repeatCount="indefinite"/></rect>
    <text x="48" y="104" fill="#052e16" font-size="11" font-family="system-ui" font-weight="700">Execute exchange</text>
    <circle cx="270" cy="55" r="18" fill="#3b82f6"><animate attributeName="r" values="14;20;14" dur="1.4s" repeatCount="indefinite"/></circle>
    <text x="262" y="59" fill="#fff" font-size="14" font-family="system-ui">↗</text></svg>`;
  if (kind === 'paste') return `<svg ${common} aria-label="Demo: vloženie údajov">
    <rect width="320" height="140" rx="12" fill="#0f172a"/><rect x="16" y="16" width="288" height="108" rx="8" fill="#1e293b"/>
    <rect x="28" y="30" width="200" height="14" rx="3" fill="#334155"/>
    <rect x="28" y="56" width="240" height="18" rx="4" fill="#0b1220" stroke="#3b82f6" stroke-width="2"/>
    <text x="36" y="69" fill="#94a3b8" font-size="10" font-family="ui-monospace,monospace">bc1q… (ukážka)</text>
    <rect x="200" y="90" width="90" height="22" rx="6" fill="#334155"><animate attributeName="fill" values="#334155;#22c55e;#334155" dur="2s" repeatCount="indefinite"/></rect>
    <text x="214" y="105" fill="#fff" font-size="11" font-family="system-ui" font-weight="600">Kopírovať</text></svg>`;
  if (kind === 'bank') return `<svg ${common} aria-label="Demo: bankové údaje">
    <rect width="320" height="140" rx="12" fill="#0f172a"/><rect x="16" y="16" width="288" height="108" rx="8" fill="#1e293b"/>
    <rect x="28" y="28" width="60" height="8" rx="2" fill="#64748b"/><rect x="28" y="42" width="200" height="16" rx="4" fill="#0b1220" stroke="#243044"/>
    <rect x="28" y="68" width="60" height="8" rx="2" fill="#64748b"/><rect x="28" y="82" width="160" height="16" rx="4" fill="#0b1220" stroke="#243044"/>
    <rect x="240" y="40" width="50" height="50" rx="6" fill="#fff"><animate attributeName="opacity" values="1;.7;1" dur="1.5s" repeatCount="indefinite"/></rect>
    <text x="248" y="70" fill="#0b1220" font-size="18" font-family="system-ui">▦</text></svg>`;
  return `<svg ${common} aria-label="Demo: nahratie dokladu">
    <rect width="320" height="140" rx="12" fill="#0f172a"/><rect x="16" y="16" width="288" height="108" rx="8" fill="#1e293b"/>
    <rect x="40" y="36" width="100" height="70" rx="6" fill="#334155"/>
    <path d="M70 70 L90 50 L110 70 L100 70 L100 90 L80 90 L80 70 Z" fill="#94a3b8">
      <animateTransform attributeName="transform" type="translate" values="0 8;0 0;0 8" dur="1.6s" repeatCount="indefinite"/></path>
    <rect x="160" y="48" width="120" height="22" rx="6" fill="#22c55e"/><text x="172" y="63" fill="#052e16" font-size="11" font-family="system-ui" font-weight="700">I have paid!</text>
    <rect x="160" y="80" width="120" height="22" rx="6" fill="#3b82f6"/><text x="185" y="95" fill="#fff" font-size="11" font-family="system-ui" font-weight="700">Confirm</text></svg>`;
}

function guidedPage(order) {
  const btc = esc(order.btcAddress);
  const amt = esc(order.amountExact);
  const id = esc(order.orderId);
  const email = esc(order.customerEmail || '');
  const resumeStep = Number(order.guidedStep) || 1;
  return `<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SEPA cez Electrocoin – návod</title>
<style>
:root{--bg:#0b1220;--card:#121a2b;--bd:#243044;--muted:#94a3b8;--ok:#22c55e;--blue:#3b82f6}
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:var(--bg);color:#e8eef9;margin:0;padding:.75rem}
.wrap{max-width:640px;margin:0 auto}
.progress{position:sticky;top:0;z-index:5;background:var(--bg);padding:.55rem 0 .7rem;margin:0 0 .6rem;border-bottom:1px solid var(--bd)}
.progress .lbl{font-size:.95rem;font-weight:700;margin:0 0 .45rem}
.bar{display:flex;gap:.35rem}.bar i{flex:1;height:6px;border-radius:99px;background:#1e293b}.bar i.on{background:var(--ok)}.bar i.cur{background:var(--blue)}
.card{background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:1rem;margin:0 0 .85rem}
.card[hidden]{display:none!important}
h1{font-size:1.25rem;margin:.2rem 0}.hint{color:var(--muted);font-size:.88rem;line-height:1.45}
.n{display:inline-flex;align-items:center;justify-content:center;background:var(--blue);border-radius:50%;width:1.7rem;height:1.7rem;font-weight:700;margin-right:.4rem}
.row{display:flex;gap:.5rem;align-items:stretch;background:var(--bg);border:1px solid var(--bd);border-radius:12px;padding:.55rem;margin:.4rem 0}
.row code{flex:1;word-break:break-all;font-size:.95rem;padding:.35rem 0;align-self:center}
.lbl{font-size:.8rem;color:var(--muted);margin-top:.55rem}
button,.big{cursor:pointer;border:0;border-radius:12px;font-weight:700;font:inherit}
.row button{padding:.85rem 1rem;min-height:52px;min-width:7.5rem;background:#334155;color:#fff;font-size:1rem}
.big{display:block;width:100%;text-align:center;text-decoration:none;font-size:1.1rem;padding:1.05rem;background:var(--ok);color:#052e16;margin:.7rem 0}
input{width:100%;padding:.85rem;border-radius:12px;border:1px solid #334155;background:var(--bg);color:#fff;font-size:1.05rem;margin:.2rem 0 .55rem;min-height:48px}
ol{padding-left:1.2rem;line-height:1.55}img,svg.demo{max-width:100%;border-radius:12px;border:1px solid var(--bd);margin:.45rem 0;display:block}
.err{color:#f87171;min-height:1.2em}.ok{color:#4ade80}
.nav{display:flex;gap:.5rem;margin-top:.6rem}
.nav button{flex:1;padding:.9rem;background:#1e293b;color:#e8eef9;font-size:1rem;min-height:50px}
.nav button.primary{background:var(--blue)}
.resume{background:#1e3a8a44;border:1px solid #3b82f688;border-radius:12px;padding:.75rem .9rem;margin:0 0 .85rem;font-size:.9rem}
@media(max-width:768px){.row{flex-direction:column}.row button{width:100%}.row code{align-self:stretch;overflow-wrap:anywhere;word-break:normal}input{font-size:16px}}@media(max-width:480px){.card{padding:.85rem}.nav{flex-direction:column-reverse}.nav span:empty{display:none}}
</style></head><body><div class="wrap">
<div class="progress" id="progress">
  <div class="lbl" id="stepLbl">Krok 1 zo 4</div>
  <div class="bar" aria-hidden="true"><i class="cur"></i><i></i><i></i><i></i></div>
</div>
<div class="resume" id="resumeBanner" hidden>Pokračujete v objednávke <b>${id}</b> – obnovili sme váš postup.</div>
<p class="hint" style="margin:.2rem 0 .8rem">Objednávka ${id} · ${esc(order.fullName)} · ${amt} EUR</p>

<div class="card step" data-step="1">
<h1><span class="n">1</span>Otvorte Electrocoin</h1>
${demoSvg('open')}
<a class="big" id="openEc" href="${esc(prefillUrl(order))}" target="_blank" rel="noopener">Otvoriť Electrocoin (SEPA → BTC, ${amt} EUR) ↗</a>
<p class="hint">Suma <b>${amt} EUR</b> a smer EUR→BTC (SEPA) sa predvyplnia. Adresu, email a meno vložte tlačidlami nižšie.</p>
<div class="lbl">BTC adresa príjemcu (BTCPay)</div>
<div class="row"><code id="cBtc">${btc}</code><button type="button" data-copy="cBtc">Kopírovať</button></div>
<div class="lbl">Váš email</div>
<div class="row"><code id="cMail">${email}</code><button type="button" data-copy="cMail">Kopírovať</button></div>
<div class="lbl">Meno a priezvisko</div>
<div class="row"><code id="cName">${esc(order.fullName)}</code><button type="button" data-copy="cName">Kopírovať</button></div>
${order.country ? `<div class="lbl">Krajina</div><div class="row"><code id="cCty">${esc(order.country)}</code><button type="button" data-copy="cCty">Kopírovať</button></div>` : ''}
<div class="lbl">Suma (EUR)</div>
<div class="row"><code id="cAmt">${amt}</code><button type="button" data-copy="cAmt">Kopírovať</button></div>
${demoSvg('paste')}
<div class="nav"><span></span><button type="button" class="primary" data-next>Ďalej →</button></div>
</div>

<div class="card step" data-step="2" hidden>
<h1><span class="n">2</span>Na Electrocoin skontrolujte a odošlite</h1>
${demoSvg('open')}
<ol><li>Skontrolujte sumu <b>${amt}</b> EUR, vložte BTC adresu a <b>svoj</b> email.</li>
<li>Potvrďte captchu sami a kliknite <b>Execute exchange</b>.</li>
<li>Otvorte email od Electrocoin → odkaz na objednávku (IBAN, PURPOSE, timer).</li>
<li>Túto stránku nechajte otvorenú a vráťte sa sem.</li></ol>
<p class="hint">Electrocoin sa otvorí v novej karte — my nič neautomatizujeme.</p>
<div class="nav"><button type="button" data-prev>← Späť</button><button type="button" class="primary" data-next>Mám bankové údaje →</button></div>
</div>

<div class="card step" data-step="3" hidden>
<h1><span class="n">3</span>Zadajte bankové údaje</h1>
${demoSvg('bank')}
<p class="hint">Prepíšte údaje z Electrocoin objednávky („Payment instructions“).</p>
<form id="f">
<label>IBAN</label><input name="iban" required placeholder="napr. LT12 3456 …" autocomplete="off"/>
<label>Príjemca (Beneficiary)</label><input name="beneficiary" required autocomplete="name"/>
<label>Suma EUR (presne podľa Electrocoin)</label><input name="amount" required inputmode="decimal" value="${amt}"/>
<label>PURPOSE / DESCRIPTION</label><input name="purpose" required autocomplete="off"/>
<label>Termín (voliteľné: minúty alebo 18:30)</label><input name="deadline"/>
<div class="err" id="err"></div>
<button type="submit" class="big" style="background:var(--blue);color:#fff">Zobraziť platobné údaje + QR</button>
</form>
<div class="nav"><button type="button" data-prev>← Späť</button></div>
</div>

<div class="card step" data-step="4" hidden>
<h1><span class="n">4</span>Po zaplatení nahrajte doklad</h1>
${demoSvg('upload')}
<ol><li>Pošlite SEPA platbu z banky (s presným PURPOSE).</li>
<li>Na electrocoin.eu → <b>I have paid!</b> → <b>Confirm</b>.</li>
<li><b>Select a file</b> → screenshot/PDF z banky → <b>Confirm</b>.</li>
<li>Stav: <b>Payment confirmed</b>. Hotovo.</li></ol>
<img src="/guides/electrocoin/ec-upload-steps.png" alt="Electrocoin: I have paid → Confirm → Select a file → Confirm" loading="lazy"/>
<p class="hint">Ukážka po nahratí (osobné údaje rozmazané):</p>
<img src="/guides/electrocoin/ec-after-upload.png" alt="Electrocoin Payment confirmed" loading="lazy"/>
<p class="hint">Doklad nahrávate na Electrocoin vy – my ho za vás nenahrávame.</p>
<div id="chainStatus" data-order-id="${id}"></div>
<div class="nav"><button type="button" data-prev>← Späť</button>
<a class="big" style="flex:1;margin:0" href="/bank-sepa-pay?orderId=${encodeURIComponent(order.orderId)}">Údaje + QR platby →</a></div>
</div>
</div>
<script>
(function(){
  var ORDER_ID=${JSON.stringify(order.orderId)};
  var KEY='sepaGuided:'+ORDER_ID;
  var TOTAL=4;
  var step=${JSON.stringify(resumeStep)};
  try{var s=JSON.parse(localStorage.getItem(KEY)||'{}');if(s.step>=1&&s.step<=TOTAL){step=s.step;document.getElementById('resumeBanner').hidden=false;}}catch(e){}
  function save(st){try{localStorage.setItem(KEY,JSON.stringify({step:st,t:Date.now(),orderId:ORDER_ID}));}catch(e){}
    fetch('/api/sepa-guided/'+encodeURIComponent(ORDER_ID)+'/step',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({step:st})}).catch(function(){});}
  function show(st){
    step=Math.max(1,Math.min(TOTAL,st|0));
    document.querySelectorAll('.step').forEach(function(c){c.hidden=Number(c.dataset.step)!==step;});
    document.getElementById('stepLbl').textContent='Krok '+step+' zo '+TOTAL;
    document.querySelectorAll('.bar i').forEach(function(i,idx){i.className=idx+1<step?'on':(idx+1===step?'cur':'');});
    save(step);window.scrollTo({top:0,behavior:'smooth'});
  }
  document.querySelectorAll('[data-next]').forEach(function(b){b.onclick=function(){show(step+1);};});
  document.querySelectorAll('[data-prev]').forEach(function(b){b.onclick=function(){show(step-1);};});
  document.getElementById('openEc').addEventListener('click',function(){if(step===1)setTimeout(function(){show(2);},400);});
  document.querySelectorAll('[data-copy]').forEach(function(b){b.onclick=async function(){var t=document.getElementById(b.dataset.copy).textContent.trim();
    try{await navigator.clipboard.writeText(t);}catch(e){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();}
    b.textContent='Skopírované ✓';setTimeout(function(){b.textContent='Kopírovať';},1500);};});
  document.getElementById('f').onsubmit=async function(ev){ev.preventDefault();var err=document.getElementById('err');err.textContent='';
    var d=Object.fromEntries(new FormData(ev.target).entries());
    var r=await fetch('/api/sepa-guided/'+encodeURIComponent(ORDER_ID)+'/bank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
    var j=await r.json().catch(function(){return{};});if(!r.ok){err.textContent=j.error||'Chyba';return;}
    try{localStorage.setItem(KEY,JSON.stringify({step:4,t:Date.now(),orderId:ORDER_ID,bank:true}));}catch(e){}
    location.href=j.payUrl;};
  show(step);
})();
</script>
<script src="/chain-status.js" defer></script>
</body></html>`;
}

function register(app, { loadOrders, saveOrders, appendLog }) {
  app.get('/api/sepa-guided/mode', (req, res) => res.json({ guided: isGuided(), buyUrl: BUY_URL }));

  app.get('/bank-sepa-pay', (req, res, next) => {
    const order = loadOrders()[String(req.query.orderId || '').trim()];
    if (order && order.guided && !(order.bank && order.bank.iban)) {
      return res.redirect(302, `/sepa-guided?orderId=${encodeURIComponent(order.orderId)}`);
    }
    next();
  });

  app.get('/sepa-guided', (req, res) => {
    const order = loadOrders()[String(req.query.orderId || '').trim()];
    if (!order || !order.guided) return res.status(404).type('html').send('<p>Objednávka nenájdená. <a href="/platby">Späť</a></p>');
    res.type('html').send(guidedPage(order));
  });

  app.post('/api/sepa-guided/:orderId/step', (req, res) => {
    const orders = loadOrders();
    const order = orders[String(req.params.orderId || '').trim()];
    if (!order || !order.guided) return res.status(404).json({ error: 'not found' });
    const step = Math.max(1, Math.min(4, Number(req.body && req.body.step) || 1));
    order.guidedStep = step;
    orders[order.orderId] = order;
    saveOrders(orders);
    res.json({ ok: true, step });
  });

  app.post('/api/sepa-guided/:orderId/bank', (req, res) => {
    const orders = loadOrders();
    const order = orders[String(req.params.orderId || '').trim()];
    if (!order || !order.guided) return res.status(404).json({ error: 'Objednávka sa nenašla' });
    const b = req.body || {};
    const iban = cleanIban(b.iban);
    const beneficiary = String(b.beneficiary || '').trim().slice(0, 140);
    const purpose = String(b.purpose || '').trim().slice(0, 140);
    const amount = Number(String(b.amount || '').replace(',', '.').replace(/[^\d.]/g, ''));
    if (!validIban(iban)) return res.status(400).json({ error: 'IBAN nie je platný – skontrolujte ho.' });
    if (beneficiary.length < 2) return res.status(400).json({ error: 'Vyplňte príjemcu.' });
    if (!purpose) return res.status(400).json({ error: 'Vyplňte PURPOSE / účel platby.' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Neplatná suma.' });
    const deadlineAt = parseDeadline(b.deadline);
    order.bank = { iban, beneficiary };
    order.amountExact = amount.toFixed(2);
    order.purpose = purpose;
    order.reference = purpose;
    order.deadlineAt = deadlineAt;
    order.deadlineMinutes = deadlineAt ? Math.max(0, Math.round((Date.parse(deadlineAt) - Date.now()) / 60000)) : null;
    order.status = 'awaiting_payment';
    order.guidedStep = 4;
    order.bankEnteredAt = new Date().toISOString();
    orders[order.orderId] = order;
    saveOrders(orders);
    appendLog(`SEPA_GUIDED_BANK ${order.orderId} iban=${iban.slice(0, 4)}… eur=${order.amountExact}`);
    res.json({ ok: true, payUrl: `/bank-sepa-pay?orderId=${encodeURIComponent(order.orderId)}` });
  });
}

module.exports = { prefillUrl, isGuided, buildGuidedOrder, register, BUY_URL, validIban, parseDeadline };
