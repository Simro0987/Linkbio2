'use strict';
/**
 * Admin UI: „Reťaz SEPA botov“ — /admin/platby/sepa-chain
 * Default: Telegram channel relay. Slovak help; tokens masked; never logged in full.
 */
const adminSepa = require('./adminSepa');
const chain = require('./sepaBotChain');

const { layout, escapeHtml } = adminSepa;

function helpHtml() {
  return `
<div class="card" id="help">
  <h2>Nastavenie kanála (predvolený režim)</h2>
  <p class="muted">Server posiela žiadosti do <strong>súkromného Telegram kanála</strong> cez <strong>samostatného SEPA kanálového bota</strong> (len pre túto SEPA platbu). Ten istý bot číta <code>channel_post</code> odpovede (vlastný polling) a posiela doklady. <strong>@Plat4Bot sa nemení</strong> — ostáva na všetky bežné notifikácie (nové objednávky, upozornenia pre Ryana, iné metódy) a manuálny SEPA fallback.</p>
  <ol style="line-height:1.65;padding-left:1.3rem">
    <li>V Telegrame otvorte <strong>@BotFather</strong> → <code>/newbot</code> → vytvorte <strong>nového</strong> bota (nie @Plat4Bot). Skopírujte jeho API token.</li>
    <li>Vytvorte <strong>súkromný kanál</strong> v Telegrame.</li>
    <li>Pridajte <strong>nového SEPA kanálového bota</strong> do kanála ako <strong>admina</strong> s právom <em>Post Messages</em> / Posielať správy. Rovnako pridajte <strong>každý bot</strong> z reťaze.</li>
    <li>Token vložte nižšie do poľa <strong>„Token SEPA kanálového bota (len pre SEPA)“</strong> a uložte. Bez tohto tokenu reťaz <em>nebeží</em> a SEPA objednávky idú manuálne cez @Plat4Bot.</li>
    <li>Napíšte do kanála ľubovoľnú správu, potom kliknite <strong>„Zistiť ID kanála“</strong> — vyplní sa chat ID (záporné číslo, napr. <code>-100…</code>).</li>
    <li>Zadajte <strong>tokeny</strong> a <strong>@username</strong> každého bota (bez @). Username slúži na rozpoznanie autora odpovede; párovanie je cez reply_to / FIFO podľa sumy.</li>
    <li>Stlačte <strong>„Test kanála“</strong> — server pošle testovaciu správu a reportne, či každý bot odpovedal v limite.</li>
    <li>Zapnite reťaz checkboxom hore a uložte.</li>
  </ol>
  <div class="warnbox" style="margin-top:.75rem">
    <strong>Dôležité:</strong> Vaše boty reagujú na príspevky v kanáli <em>len ak ich kód spracúva <code>channel_post</code></em>.
    Veľa jednoduchých botov číta iba súkromné správy (DM). Ak „Test kanála“ zlyhá a bot v DM funguje, treba upraviť kód bota, alebo zvoliť fallback režim „externý“ / „spravovaný“.
  </div>
  <h2>Režimy (fallback)</h2>
  <ul class="muted" style="line-height:1.55">
    <li><strong>Kanál (predvolené)</strong> — relay cez spoločný kanál, <code>channel_post</code>.</li>
    <li><strong>Spravovaný</strong> — server smie <code>getUpdates</code> na token kroku (iba ak bot nemá inde bežiaci kód).</li>
    <li><strong>Externý</strong> — server len posiela; odpoveď na <code>POST /api/sepa-chain/reply</code>.</li>
  </ul>
  <h2>Správy v kanáli (suma + LTC)</h2>
  <ol class="muted" style="line-height:1.55;padding-left:1.2rem">
    <li>Predvolená šablóna je <code>{amount}\n{ltc_address}</code> — dva riadky (suma, potom LTC adresa). <strong>Žiadne</strong> <code>#ORDER</code>/<code>#STEP</code>, ID objednávky ani meno.</li>
    <li>LTC adresa sa berie z admin poolu <strong>Adresy peňaženiek</strong> (rotácia <code>nextAddress('ltc')</code>, len LTC). Uloží sa na objednávku ako <code>sepaChain.ltcAddress</code> (zákazník ju na SEPA stránke <em>nevidí</em>).</li>
    <li>Ak nie je žiadna povolená LTC adresa → do kanála ide len suma a Ryan dostane Telegram upozornenie.</li>
    <li>Server uloží <code>message_id</code> každej odoslanej správy. Odpoveď bota sa páruje prednostne ako <strong>Telegram reply</strong> (<code>reply_to_message</code>) na túto správu.</li>
    <li>Ak bot neodpovie reply-om → FIFO: najstaršia čakajúca objednávka na danom kroku. Ak viac objednávok čaká s <em>rovnakou sumou</em> a zhoda je nejednoznačná → Ryan dostane upozornenie (neuhádne sa).</li>
  </ol>
  <h2>Kontrola dokladu (po nahratí zákazníkom)</h2>
  <ol class="muted" style="line-height:1.55;padding-left:1.2rem">
    <li>Zákazník nahrá foto/PDF → server pošle súbor do kanála ako <strong>reply na správu so sumou</strong> danej objednávky (caption prázdny alebo len suma). Bot z poľa <strong>„Krok, ktorý kontroluje platbu“</strong> (predvolene posledný / IBAN krok).</li>
    <li>Bot odpovie verdiktom (ideálne reply na doklad). Predvolené kľúčové slová: <em>OK / PREŠLO / ZAPLATENÉ</em> = platba OK; <em>NEPREŠLO / ZAMIETNUTÉ</em> = zamietnuté. Stav sa ukáže zákazníkovi.</li>
    <li>Ryan dostane <strong>email</strong> s prílohou dokladu + verdiktom a zálohu v Telegrame. Ak bot neodpovie v limite → email/TG s textom <em>neoverené – skontroluj ručne</em>.</li>
  </ol>
  <h2>Email / SMTP</h2>
  <p class="muted">Ak už máte v env <code>SMTP_HOST</code> + <code>SMTP_FROM</code> (PaysafeCard/G2A), stačí vyplniť <strong>notifikačný email</strong>. Inak vyplňte SMTP polia nižšie (heslo sa šifruje ako tokeny). Nikdy nedávajte heslá do gitu.</p>
  <h2>Fallback pri zlyhaní</h2>
  <p class="muted">Timeout / chyba reťaze, alebo chýbajúci token SEPA kanálového bota → manuálny @Plat4Bot. Reťaz je <strong>predvolene vypnutá</strong> a platí <strong>iba pre SEPA (bank_sepa_manual)</strong> — žiadna iná platobná metóda ňou neprechádza. Tokeny sa nikdy neukladajú do gitu.</p>
  <p class="muted">Placeholdery: <code>{amount} {ltc_address}</code> (predvolené), voliteľne <code>{order_id} {currency} {customer_name} {email} {prev_reply} {step_name} {step_index}</code>. Párovanie: <code>reply_to</code> → FIFO; legacy markery <code>#ORDER</code> stále fungujú, ak ich bot pošle.</p>
</div>`;
}

function page(userEmail, notice, error) {
  const s = chain.sanitizeForAdmin(chain.getConfig());
  const stepsJson = JSON.stringify(s.steps).replace(/</g, '\\u003c');
  const presetsJson = JSON.stringify(s.extractPresets).replace(/</g, '\\u003c');
  const mode = s.mode || 'channel';
  const body = `
${notice ? `<div class="ok">${escapeHtml(notice)}</div>` : ''}
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
<div class="card">
  <h1>Reťaz SEPA botov</h1>
  <p class="muted">Automatické odovzdanie SEPA požiadavky cez súkromný Telegram kanál (predvolené). Pri timeoute ostáva manuálny @Plat4Bot.</p>
  <p class="muted">Stav: <strong>${s.enabled ? 'ZAPNUTÁ' : 'vypnutá (predvolené)'}</strong>
    · režim: <strong>${escapeHtml(mode)}</strong>
    ${s.updatedAt ? ` · upravené ${escapeHtml(s.updatedAt)}` : ''}</p>
  ${
    mode === 'channel' && !s.channelBotTokenSet
      ? `<div class="warnbox"><strong>⚠️ Chýba token SEPA kanálového bota.</strong> Reťaz nemôže bežať — SEPA objednávky idú manuálne cez @Plat4Bot. Nastavte ho v poli „Token SEPA kanálového bota (len pre SEPA)“.</div>`
      : ''
  }
  <p><a href="#help">↓ Návod nastavenia (SK)</a> · <a href="/admin/platby/sepa">← SEPA objednávky</a></p>
</div>

<div class="card">
  <form id="chainForm" method="post" action="/admin/platby/sepa-chain/save" autocomplete="off">
    <label><input type="checkbox" name="enabled" value="1" ${s.enabled ? 'checked' : ''}/> Zapnúť reťaz SEPA botov</label>
    <p class="muted" style="margin-top:.25rem">Kým je vypnutá, checkout beží po starom (manuálny @Plat4Bot).</p>

    <h2>Príjemca SEPA platby</h2>
    <label for="recipientName">Meno / názov príjemcu (zobrazí sa zákazníkovi)</label>
    <input id="recipientName" name="recipientName" type="text" maxlength="${s.recipientNameMax || 70}" value="${escapeHtml(s.recipientName || '')}" placeholder="napr. Ján Vzor alebo Firma s.r.o." autocomplete="off"/>
    <p class="muted" style="margin-top:.25rem">Zobrazí sa pri <strong>každej</strong> SEPA platbe (bank_sepa_manual) na stránke <code>/bank-sepa-pay</code> ako riadok „Príjemca“ (aj pri už čakajúcich objednávkach) a použije sa v QR. Má prednosť pred menom z odpovede v kanáli. Prázdne = ako doteraz (meno z odpovede bota, ak ho pošle). Max. ${s.recipientNameMax || 70} znakov.</p>

    <h2>Režim</h2>
    <div style="display:flex;flex-wrap:wrap;gap:1rem;margin:.5rem 0 1rem">
      <label><input type="radio" name="mode" value="channel" ${mode === 'channel' ? 'checked' : ''}/> Kanál (predvolené)</label>
      <label><input type="radio" name="mode" value="managed" ${mode === 'managed' ? 'checked' : ''}/> Spravovaný (getUpdates)</label>
      <label><input type="radio" name="mode" value="external" ${mode === 'external' ? 'checked' : ''}/> Externý (HTTP reply)</label>
    </div>

    <h2>Telegram kanál</h2>
    <label for="channelId">ID kanála</label>
    <input id="channelId" name="channelId" type="text" value="${escapeHtml(s.channelId || '')}" placeholder="-100…"/>
    <p style="margin:.4rem 0">
      <button type="button" class="secondary" id="discoverChannel">Zistiť ID kanála</button>
      <button type="button" class="secondary" id="testChannel">Test kanála</button>
      <span class="muted" id="channelOut"></span>
    </p>
    ${
      s.lastSeenChannelId
        ? `<p class="muted">Posledný videný channel_post: <span class="mono">${escapeHtml(s.lastSeenChannelId)}</span>${
            s.lastSeenChannelTitle ? ' · ' + escapeHtml(s.lastSeenChannelTitle) : ''
          }${s.lastSeenChannelAt ? ' · ' + escapeHtml(s.lastSeenChannelAt) : ''}</p>`
        : `<p class="muted">Zatiaľ žiadny channel_post — pridajte SEPA kanálového bota do kanála a pošlite správu.</p>`
    }

    <label for="preparedEmail">Predpripravený email (krok s „pripojiť email“)</label>
    <input id="preparedEmail" name="preparedEmail" type="email" value="${escapeHtml(s.preparedEmail)}" placeholder="napr. platby@vasadomena.sk"/>

    <h2>Token SEPA kanálového bota (len pre SEPA)</h2>
    <p class="muted">Samostatný bot <strong>iba pre túto SEPA platbu</strong>: posiela sumu + LTC do kanála, číta <code>channel_post</code> odpovede a posiela doklady. Nepoužíva sa na žiadne iné notifikácie ani metódy. <strong>Žiadny fallback</strong> na <code>TELEGRAM_BOT_TOKEN</code> / @Plat4Bot. Postup: @BotFather → <code>/newbot</code> → pridať bota do kanála ako admina s právom <em>Post Messages</em> → vložiť token sem.</p>
    ${
      s.channelBotTokenIsPlat4
        ? `<div class="err">Uložený token je token @Plat4Bot — nepoužije sa. Vytvorte v BotFather nového bota a vložte jeho token.</div>`
        : !s.channelBotTokenSet
        ? `<div class="warnbox"><strong>⚠️ Token SEPA kanálového bota nie je nastavený.</strong> Reťaz v režime kanál nebeží — každá SEPA objednávka ide po starom manuálne cez @Plat4Bot.</div>`
        : `<p class="muted">Polling kanála: <strong>${
            s.channelPoller && s.channelPoller.running ? 'beží' : s.enabled && s.mode === 'channel' ? 'nebeží' : 'vypnutý (reťaz vypnutá / iný režim)'
          }</strong>${
            s.channelPoller && s.channelPoller.botUsername ? ' · bot <span class="mono">@' + escapeHtml(s.channelPoller.botUsername) + '</span>' : ''
          }${
            s.channelPoller && s.channelPoller.lastError ? ' · chyba: ' + escapeHtml(s.channelPoller.lastError) : ''
          }</p>`
    }
    <label for="channelBotToken">API token SEPA kanálového bota ${
      s.channelBotTokenSet || s.channelBotTokenIsPlat4
        ? `(uložený: <span class="mono">${escapeHtml(s.channelBotTokenMasked)}</span>)`
        : '(nenastavený)'
    }</label>
    <input id="channelBotToken" name="channelBotToken" type="password" autocomplete="new-password" placeholder="${
      s.channelBotTokenSet ? '•••• nechať bez zmeny, alebo vložiť nový' : '123456:AA… (nový bot z @BotFather)'
    }"/>
    <label><input type="checkbox" name="clearChannelBotToken" value="1"/> Vymazať token SEPA kanálového bota (reťaz potom nebeží → manuálny @Plat4Bot)</label>

    <h2>Kontrola dokladu a notifikácie</h2>
    <label for="proofCheckStepId">Krok, ktorý kontroluje platbu</label>
    <select id="proofCheckStepId" name="proofCheckStepId">
      <option value="">(posledný krok — predvolené)</option>
    </select>
    <p class="muted">Sem pôjde zákaznícky doklad (ako reply na správu so sumou). Bot z tohto kroku odpovie verdiktom v kanáli.</p>
    <label for="notifyEmail">Ryan — notifikačný email (doklad + verdikt)</label>
    <input id="notifyEmail" name="notifyEmail" type="email" value="${escapeHtml(s.notifyEmail || '')}" placeholder="vas@email.sk"/>
    <label for="proofTimeoutSec">Timeout kontroly dokladu (sekundy)</label>
    <input id="proofTimeoutSec" name="proofTimeoutSec" type="number" min="30" max="3600" value="${Number(s.proofTimeoutSec) || 300}"/>
    <label for="verdictPass">Kľúčové slová = platba OK (čiarkou)</label>
    <input id="verdictPass" name="verdictPass" type="text" value="${escapeHtml((s.verdictPass || []).join(', '))}" placeholder="OK, PREŠLO, ZAPLATENÉ"/>
    <label for="verdictFail">Kľúčové slová = zamietnuté (čiarkou)</label>
    <input id="verdictFail" name="verdictFail" type="text" value="${escapeHtml((s.verdictFail || []).join(', '))}" placeholder="NEPREŠLO, ZAMIETNUTÉ"/>

    <h2>SMTP (ak nie je v env)</h2>
    <p class="muted">${s.smtpEnvFallback ? 'Env SMTP_HOST/FROM je nastavený — admin polia majú prednosť ak ich vyplníte.' : 'Env SMTP nie je nastavený — vyplňte polia nižšie, inak email nepôjde.'}</p>
    <div class="grid">
      <div><label for="smtpHost">SMTP host</label><input id="smtpHost" name="smtpHost" type="text" value="${escapeHtml(s.smtpHost || '')}" placeholder="smtp.example.com"/></div>
      <div><label for="smtpPort">Port</label><input id="smtpPort" name="smtpPort" type="number" value="${Number(s.smtpPort) || 587}"/></div>
    </div>
    <label><input type="checkbox" name="smtpSecure" value="1" ${s.smtpSecure ? 'checked' : ''}/> SMTP secure (TLS/465)</label>
    <label for="smtpUser">SMTP user</label>
    <input id="smtpUser" name="smtpUser" type="text" value="${escapeHtml(s.smtpUser || '')}" autocomplete="off"/>
    <label for="smtpPass">SMTP heslo ${s.smtpPassSet ? '(uložené ••••)' : ''}</label>
    <input id="smtpPass" name="smtpPass" type="password" autocomplete="new-password" placeholder="${s.smtpPassSet ? '•••• nechať bez zmeny' : ''}"/>
    <label><input type="checkbox" name="clearSmtpPass" value="1"/> Vymazať SMTP heslo</label>
    <label for="smtpFrom">From adresa</label>
    <input id="smtpFrom" name="smtpFrom" type="email" value="${escapeHtml(s.smtpFrom || '')}" placeholder="noreply@vasadomena.sk"/>

    <h2>Kroky reťaze <span class="muted">(poradie = poradie behu)</span></h2>
    <div id="steps"></div>
    <p style="margin-top:.75rem">
      <button type="button" class="secondary" id="addStep">+ Pridať krok</button>
      <button type="submit">Uložiť reťaz</button>
    </p>
    <input type="hidden" name="stepsJson" id="stepsJson" value=""/>
  </form>
</div>

${helpHtml()}

<script>
(function(){
  var presets = ${presetsJson};
  var steps = ${stepsJson};
  var box = document.getElementById('steps');
  var defaultTpl = ${JSON.stringify(chain.DEFAULT_TEMPLATE)};

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

  function render(){
    box.innerHTML = '';
    if (!steps.length) {
      box.innerHTML = '<p class="warnbox">Zatiaľ žiadne kroky. Pridajte aspoň jeden (typicky 3: žiadosť → email → IBAN).</p>';
    }
    steps.forEach(function(st, i){
      var card = document.createElement('div');
      card.className = 'card';
      card.style.background = '#0d1524';
      card.dataset.idx = String(i);
      var ex = (st.extract || []).slice();
      var checks = presets.map(function(p){
        return '<label style="display:inline-flex;align-items:center;gap:.35rem;margin-right:.75rem"><input type="checkbox" data-ex="'+esc(p.id)+'" '+(ex.indexOf(p.id)>=0?'checked':'')+'/> '+esc(p.label)+'</label>';
      }).join('');
      card.innerHTML =
        '<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.5rem">' +
          '<strong>#'+(i+1)+'</strong>' +
          '<button type="button" class="secondary" data-up '+(i===0?'disabled':'')+'>↑</button>' +
          '<button type="button" class="secondary" data-down '+(i===steps.length-1?'disabled':'')+'>↓</button>' +
          '<button type="button" class="secondary" data-rm style="margin-left:auto;background:#7f1d1d">Odstrániť</button>' +
        '</div>' +
        '<label>Názov kroku</label><input data-f="name" type="text" value="'+esc(st.name||'')+'"/>' +
        '<label>Bot @username <span class="muted">(bez @ — podľa neho spárujeme channel_post)</span></label>' +
        '<input data-f="botUsername" type="text" value="'+esc(st.botUsername||'')+'" placeholder="napr. MojSepaBot"/>' +
        '<label>Bot token '+(st.tokenSet ? '(uložený: <span class="mono">'+esc(st.tokenMasked)+'</span>)' : '(v režime kanál sa nepoužíva — posiela SEPA kanálový bot; potrebný pre spravovaný/externý režim)')+'</label>' +
        '<input data-f="token" type="password" autocomplete="new-password" placeholder="'+(st.tokenSet?'•••• nechať bez zmeny':'token z @BotFather')+'"/>' +
        '<label><input type="checkbox" data-f="clearToken"/> Vymazať token tohto kroku</label>' +
        '<label>Chat ID <span class="muted">(len pre režim spravovaný/externý)</span></label>' +
        '<input data-f="chatId" type="text" value="'+esc(st.chatId||'')+'" placeholder="-100… alebo číselné ID"/>' +
        '<p style="margin:.4rem 0"><button type="button" class="secondary" data-discover>Zistiť chat ID</button> <span class="muted" data-discover-out></span></p>' +
        '<label>Šablóna odchádzajúcej správy</label><textarea data-f="template" rows="5">'+(st.template!=null?esc(st.template):esc(defaultTpl))+'</textarea>' +
        '<label>Čo vytiahnuť z odpovede</label><div>'+checks+'</div>' +
        '<div class="grid" style="margin-top:.5rem">' +
          '<div><label>Timeout (sekundy)</label><input data-f="timeoutSec" type="number" min="15" max="3600" value="'+(st.timeoutSec||120)+'"/></div>' +
          '<div><label>Režim odpovede v kanáli</label>' +
            '<select data-f="replyMode">' +
              '<option value="extract"'+(st.replyMode!=='next_post'?' selected':'')+'>Parsoviť podľa pravidiel</option>' +
              '<option value="next_post"'+(st.replyMode==='next_post'?' selected':'')+'>Vziať celý ďalší príspevok</option>' +
            '</select></div>' +
          '<div style="padding-top:1.4rem">' +
            '<label><input type="checkbox" data-f="managedByUs" '+(st.managedByUs?'checked':'')+'/> Spravovaný (getUpdates) — fallback režim</label>' +
            '<label><input type="checkbox" data-f="attachPreparedEmail" '+(st.attachPreparedEmail?'checked':'')+'/> Pripojiť predpripravený email</label>' +
          '</div>' +
        '</div>' +
        '<p style="margin-top:.75rem"><button type="button" class="secondary" data-test>Testovať tento krok</button> <span class="muted" data-test-out></span></p>';
      box.appendChild(card);

      card.querySelector('[data-up]') && card.querySelector('[data-up]').addEventListener('click', function(){
        if (i<=0) return; var t=steps[i-1]; steps[i-1]=steps[i]; steps[i]=t; render();
      });
      card.querySelector('[data-down]') && card.querySelector('[data-down]').addEventListener('click', function(){
        if (i>=steps.length-1) return; var t=steps[i+1]; steps[i+1]=steps[i]; steps[i]=t; render();
      });
      card.querySelector('[data-rm]').addEventListener('click', function(){ steps.splice(i,1); render(); });
      card.querySelector('[data-test]').addEventListener('click', function(){
        collectFromDom();
        var out = card.querySelector('[data-test-out]');
        out.textContent = 'Posielam…';
        fetch('/admin/platby/sepa-chain/test/'+encodeURIComponent(st.id), { method:'POST', headers:{'content-type':'application/json','sec-fetch-site':'same-origin'}, body:'{}' })
          .then(function(r){ return r.json(); })
          .then(function(j){ out.textContent = j.ok ? ('OK · test order '+j.testOrderId+(j.reply && j.reply.iban ? ' · IBAN ok' : (j.reply && j.reply.error ? ' · '+j.reply.error : ' · správa odoslaná'))) : ('Chyba: '+(j.error||'?')); })
          .catch(function(e){ out.textContent = 'Chyba: '+e.message; });
      });
      card.querySelector('[data-discover]').addEventListener('click', function(){
        var out = card.querySelector('[data-discover-out]');
        out.textContent = 'Hľadám…';
        fetch('/admin/platby/sepa-chain/discover/'+encodeURIComponent(st.id), { method:'POST', headers:{'content-type':'application/json','sec-fetch-site':'same-origin'}, body:'{}' })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (!j.ok) { out.textContent = j.error || 'Zlyhalo'; return; }
            if (!(j.chats||[]).length) { out.textContent = 'Žiadne recentné chaty — napíšte botovi /start a skúste znova.'; return; }
            out.textContent = j.chats.map(function(c){ return c.id+' ('+c.type+' '+c.title+')'; }).join(' · ');
            if (j.chats[0] && !st.chatId) {
              st.chatId = j.chats[0].id;
              card.querySelector('[data-f=chatId]').value = j.chats[0].id;
            }
          })
          .catch(function(e){ out.textContent = e.message; });
      });
    });
  }

  function collectFromDom(){
    var cards = box.querySelectorAll('[data-idx]');
    var next = [];
    cards.forEach(function(card, i){
      var old = steps[i] || {};
      var ex = [];
      card.querySelectorAll('[data-ex]').forEach(function(cb){ if (cb.checked) ex.push(cb.getAttribute('data-ex')); });
      var tok = card.querySelector('[data-f=token]').value;
      if (card.querySelector('[data-f=clearToken]').checked) tok = '__clear__';
      next.push({
        id: old.id,
        name: card.querySelector('[data-f=name]').value,
        botUsername: card.querySelector('[data-f=botUsername]').value,
        token: tok,
        chatId: card.querySelector('[data-f=chatId]').value,
        template: card.querySelector('[data-f=template]').value,
        extract: ex,
        timeoutSec: Number(card.querySelector('[data-f=timeoutSec]').value) || 120,
        replyMode: card.querySelector('[data-f=replyMode]').value,
        managedByUs: card.querySelector('[data-f=managedByUs]').checked,
        attachPreparedEmail: card.querySelector('[data-f=attachPreparedEmail]').checked,
        tokenSet: old.tokenSet,
        tokenMasked: old.tokenMasked
      });
    });
    steps = next;
  }

  document.getElementById('addStep').addEventListener('click', function(){
    collectFromDom();
    steps.push({
      id: Math.random().toString(16).slice(2,10),
      name: 'Krok '+(steps.length+1),
      botUsername: '',
      token: '', chatId: '', template: defaultTpl,
      extract: steps.length === 0 ? ['raw'] : (steps.length === 1 ? ['email'] : ['iban','note','beneficiary','deadline']),
      timeoutSec: 120, managedByUs: false, replyMode: 'extract',
      attachPreparedEmail: steps.length === 1,
      tokenSet: false, tokenMasked: ''
    });
    render();
  });

  document.getElementById('chainForm').addEventListener('submit', function(){
    collectFromDom();
    document.getElementById('stepsJson').value = JSON.stringify(steps);
  });

  document.getElementById('discoverChannel').addEventListener('click', function(){
    var out = document.getElementById('channelOut');
    out.textContent = 'Hľadám channel_post…';
    fetch('/admin/platby/sepa-chain/discover-channel', { method:'POST', headers:{'content-type':'application/json','sec-fetch-site':'same-origin'}, body:'{}' })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j.ok) { out.textContent = j.error || 'Zlyhalo'; return; }
        var id = (j.lastSeen && j.lastSeen.id) || (j.channels && j.channels[0] && j.channels[0].id);
        if (id) {
          document.getElementById('channelId').value = id;
          out.textContent = 'ID: '+id+(j.lastSeen && j.lastSeen.title ? ' · '+j.lastSeen.title : '');
        } else {
          out.textContent = j.hint || 'Nič nenašiel — pridajte SEPA kanálového bota do kanála a pošlite správu.';
        }
      })
      .catch(function(e){ out.textContent = e.message; });
  });

  document.getElementById('testChannel').addEventListener('click', function(){
    var out = document.getElementById('channelOut');
    out.textContent = 'Testujem kanál (môže trvať ~30s)…';
    fetch('/admin/platby/sepa-chain/test-channel', { method:'POST', headers:{'content-type':'application/json','sec-fetch-site':'same-origin'}, body: JSON.stringify({ timeoutSec: 25 }) })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (j.error && !j.steps) { out.textContent = 'Chyba: '+j.error; return; }
        var lines = (j.steps||[]).map(function(s){
          return '#'+s.name+' @'+(s.botUsername||'?')+': '+(s.responded ? 'odpovedal ✓' : 'neodpovedal ✗');
        });
        out.textContent = (j.ok ? 'OK — ' : 'Čiastočné/zlyhanie — ') + lines.join(' · ');
        if (j.honesty) out.title = j.honesty;
      })
      .catch(function(e){ out.textContent = e.message; });
  });

  function refreshProofStepSelect(){
    var sel = document.getElementById('proofCheckStepId');
    if (!sel) return;
    var cur = sel.value || ${JSON.stringify(s.proofCheckStepId || '')};
    sel.innerHTML = '<option value="">(posledný krok — predvolené)</option>';
    steps.forEach(function(st){
      var o = document.createElement('option');
      o.value = st.id;
      o.textContent = (st.name || st.id) + (st.botUsername ? ' (@'+st.botUsername+')' : '');
      if (st.id === cur) o.selected = true;
      sel.appendChild(o);
    });
  }
  var _render = render;
  render = function(){ _render(); refreshProofStepSelect(); };
  render();
})();
</script>`;

  return layout({
    title: 'Reťaz SEPA botov',
    userEmail,
    body,
  });
}

function mount(app, { appendLog }) {
  const origLayout = layout;

  app.get('/admin/platby/sepa-chain', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(page(req.adminSession.email));
  });

  app.post('/admin/platby/sepa-chain/save', async (req, res) => {
    try {
      let steps = [];
      try {
        steps = JSON.parse(String(req.body.stepsJson || '[]'));
      } catch {
        steps = [];
      }
      const body = {
        enabled: req.body.enabled === '1' || req.body.enabled === 'on' || req.body.enabled === true,
        mode: req.body.mode || 'channel',
        channelId: req.body.channelId,
        preparedEmail: req.body.preparedEmail,
        recipientName: req.body.recipientName,
        channelBotToken: req.body.clearChannelBotToken ? '__clear__' : req.body.channelBotToken,
        proofCheckStepId: req.body.proofCheckStepId,
        notifyEmail: req.body.notifyEmail,
        proofTimeoutSec: req.body.proofTimeoutSec,
        verdictPass: req.body.verdictPass,
        verdictFail: req.body.verdictFail,
        smtpHost: req.body.smtpHost,
        smtpPort: req.body.smtpPort,
        smtpSecure: req.body.smtpSecure === '1' || req.body.smtpSecure === 'on',
        smtpUser: req.body.smtpUser,
        smtpFrom: req.body.smtpFrom,
        smtpPass: req.body.clearSmtpPass ? '__clear__' : req.body.smtpPass,
        steps,
      };
      const next = chain.applyAdminUpdate(body);
      await chain.save(next, appendLog);
      appendLog(
        `SEPA_CHAIN_SAVED by=${req.adminSession.email} enabled=${next.enabled} mode=${next.mode} steps=${next.steps.length} channel=${next.channelId || '-'} recipient=${next.recipientName ? 'set' : '-'}`
      );
      res.type('html').send(page(req.adminSession.email, 'Reťaz uložená.'));
    } catch (e) {
      appendLog('SEPA_CHAIN_SAVE_ERR ' + e.message);
      res.status(400).type('html').send(page(req.adminSession.email, null, e.message));
    }
  });

  app.post('/admin/platby/sepa-chain/test/:stepId', async (req, res) => {
    try {
      const result = await chain.testStep(req.params.stepId, appendLog);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
  });

  app.post('/admin/platby/sepa-chain/discover/:stepId', async (req, res) => {
    try {
      const result = await chain.discoverChatId(req.params.stepId, appendLog);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
  });

  app.post('/admin/platby/sepa-chain/discover-channel', async (req, res) => {
    try {
      const result = await chain.discoverChannelId(appendLog);
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
  });

  app.post('/admin/platby/sepa-chain/test-channel', async (req, res) => {
    try {
      const result = await chain.testChannel(appendLog, {
        timeoutSec: req.body && req.body.timeoutSec,
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
  });

  app.get('/admin/platby/sepa-chain.json', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(chain.sanitizeForAdmin(chain.getConfig()));
  });

  return { origLayout };
}

/** Public (HMAC / shared secret) inbound reply for external bots. */
function mountPublic(app, { appendLog }) {
  app.post('/api/sepa-chain/reply', async (req, res) => {
    try {
      const secret = String(process.env.SEPA_CHAIN_REPLY_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
      const provided = String(req.get('x-sepa-chain-secret') || req.body?.secret || '').trim();
      if (secret) {
        const a = Buffer.from(require('crypto').createHash('sha256').update(provided).digest());
        const b = Buffer.from(require('crypto').createHash('sha256').update(secret).digest());
        if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
          return res.status(401).json({ error: 'bad secret' });
        }
      } else if (process.env.RENDER) {
        return res.status(503).json({ error: 'SEPA_CHAIN_REPLY_SECRET not configured' });
      }
      const orderId = String(req.body?.orderId || '').trim();
      const text = String(req.body?.text || req.body?.message || '').trim();
      const chatId = req.body?.chatId != null ? String(req.body.chatId) : '';
      const replyToMessageId = req.body?.replyToMessageId || req.body?.reply_to_message_id;
      if (!text) return res.status(400).json({ error: 'text required' });
      const ok = chain.ingestExternalReply({
        orderId,
        text,
        chatId,
        messageId: req.body?.messageId,
        replyToMessageId,
      });
      if (appendLog) appendLog(`SEPA_CHAIN_REPLY_IN order=${orderId || '-'} ok=${ok}`);
      res.json({ ok });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { mount, mountPublic, page, helpHtml };
