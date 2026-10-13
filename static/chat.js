(function(){if(window.__lcChat)return;window.__lcChat=1;
var API='https://chain2pay-checkout-gl.onrender.com',PAY=location.origin+'/platby';
var SK='lc_chat_sid',sid=null;try{sid=sessionStorage.getItem(SK)}catch(e){}
var b=document.createElement('button');b.id='lcB';b.type='button';b.setAttribute('aria-label','Pomoc');b.textContent='💬';
var w=document.createElement('div');w.id='lcW';w.setAttribute('role','dialog');w.setAttribute('aria-label','Pomoc');
w.innerHTML='<div id="lcH"><span><b class="lv">●</b>Pomoc – TV Software</span><button type="button" aria-label="Zavrieť">×</button></div><div id="lcL"></div><button type="button" id="lcHum">🙋 Chcem hovoriť s človekom</button><form id="lcF"><textarea id="lcI" rows="2" maxlength="800" placeholder="Napíšte otázku…"></textarea><button aria-label="Odoslať">➤</button></form>';
document.body.appendChild(w);document.body.appendChild(b);
var L=w.querySelector('#lcL'),I=w.querySelector('#lcI'),F=w.querySelector('#lcF'),busy=false,since=Date.now(),pt=null;
function fill(d,t){d.textContent='';String(t).split(/(https?:\/\/[^\s)]+)/).forEach(function(p){if(/^https?:\/\//.test(p)){var u=p.replace(/[.,;:!?]+$/,''),r=p.slice(u.length);var a=document.createElement('a');a.href=u;a.rel='noopener noreferrer';a.textContent=u;d.appendChild(a);if(r)d.appendChild(document.createTextNode(r))}else if(p)d.appendChild(document.createTextNode(p))})}
function add(t,c){var d=document.createElement('div');d.className='lcM '+c;fill(d,t);L.appendChild(d);L.scrollTop=L.scrollHeight;return d}
add('Dobrý deň 👋 Som asistent TV Software. Poradím s kanálmi, inštaláciou aj platbou. Zaplatiť môžete tu: '+PAY,'lcA');
b.onclick=function(){b.textContent='💬';w.classList.toggle('open');if(w.classList.contains('open'))setTimeout(function(){I.focus()},50)};
w.querySelector('#lcH button').onclick=function(){w.classList.remove('open')};
function poll(){if(!sid)return;fetch(API+'/api/chat/'+sid+'/updates?since='+since).then(function(r){return r.json()}).then(function(j){(j.messages||[]).forEach(function(m){since=Math.max(since,m.t);add('👤 Operátor: '+m.text,'lcO');if(!w.classList.contains('open'))b.textContent='🔔'})}).catch(function(){})}
function startPoll(){if(!pt)pt=setInterval(poll,5000)}if(sid)startPoll();
function send(text,human){if(busy||!text)return;busy=true;add(text,'lcU');var th=add('…','lcA');
fetch(API+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:text,sessionId:sid,human:!!human,lang:document.documentElement.lang||'sk'})}).then(function(r){return r.json()}).then(function(j){if(j.sessionId){sid=j.sessionId;try{sessionStorage.setItem(SK,sid)}catch(e){}startPoll()}fill(th,j.reply||j.error||'Chyba')}).catch(function(){th.textContent='Spojenie zlyhalo, skúste znova.'}).then(function(){busy=false})}
I.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();F.requestSubmit?F.requestSubmit():F.onsubmit(e)}});
F.onsubmit=function(e){e.preventDefault();var t=I.value.trim();I.value='';send(t)};
w.querySelector('#lcHum').onclick=function(){var t=I.value.trim()||'Prosím o pomoc operátora.';I.value='';send(t,true)};
})();
