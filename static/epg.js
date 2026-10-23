(function(){
'use strict';
var cfgEl=document.getElementById('epgcfg'),L=cfgEl?cfgEl.dataset:{};
function t(k,d){return L[k]||d;}
var fmt;try{fmt=new Intl.DateTimeFormat('sk-SK',{timeZone:'Europe/Bratislava',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch(e){fmt=new Intl.DateTimeFormat('sk-SK',{hour:'2-digit',minute:'2-digit'});}
var skew=0;function now(){return Date.now()/1000+skew;}
function hm(s){return fmt.format(new Date(s*1000));}
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function pct(s,e){var n=now();return Math.max(0,Math.min(100,(n-s)/(e-s)*100));}
function left(e){return Math.max(1,Math.round((e-now())/60));}
function remLink(cls,id,s){var a=el('a',cls,'🔔');a.href='/api/epg/ics/'+id+'/'+s;a.rel='nofollow';a.setAttribute('download','');a.title=t('rem','Pripomenúť');a.setAttribute('aria-label',t('rem','Pripomenúť'));return a;}
var RM=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var ICON={film:'🎬',sport:'⚽',news:'📰',kids:'🧸',series:'📺',doc:'🌍',show:'🎤',music:'🎵'};

/* ---------- homepage: Dnes v TV (auto-scrolling strip) ---------- */
var sec=document.querySelector('section.dnes');
if(sec){(function(){
  var v=sec.querySelector('.dnv'),ul=v&&v.querySelector('.dnl-list'),btn=sec.querySelector('.dnpp');if(!ul)return;
  var speed=Math.max(5,Math.min(150,+sec.getAttribute('data-speed')||40)),W=0,pos=0,set=-1,last=0,run=false,user=false,hover=false,focus=false,touch=false,tt=0,clones=[];
  function tickDnes(){var n=now(),vis=0;[].forEach.call(ul.querySelectorAll('.dni'),function(li){var s=+li.getAttribute('data-s'),e=+li.getAttribute('data-e');if(n>=e){li.hidden=true;return;}if(!li.classList.contains('dncl'))vis++;var on=n>=s;li.classList.toggle('live',on);var b=li.querySelector('.dpb i');if(b)b.style.width=(on?pct(s,e):0)+'%';});if(!vis)sec.hidden=true;measure();}
  function measure(){if(!clones.length){W=0;return;}var a=ul.querySelector('.dni:not([hidden]):not(.dncl)'),b=ul.querySelector('.dncl:not([hidden])');W=a&&b?b.offsetLeft-a.offsetLeft:0;if(W>0&&pos>=W)pos-=W;}
  function paused(){return user||hover||focus||touch||document.hidden;}
  function ui(){if(!btn)return;btn.setAttribute('aria-pressed',user?'true':'false');btn.textContent=user?btn.getAttribute('data-play'):btn.getAttribute('data-pause');}
  function frame(ts){var dt=last?Math.min(0.1,(ts-last)/1000):0;last=ts;if(W>0&&!paused()&&v.scrollWidth>v.clientWidth+4){pos+=speed*dt;if(pos>=W)pos-=W;set=pos;v.scrollLeft=pos;}requestAnimationFrame(frame);}
  function start(){
    if(RM||run)return;var items=[].slice.call(ul.children);if(!items.length)return;
    if(ul.scrollWidth<=v.clientWidth+8)return; // everything fits – no need to move
    items.forEach(function(li){var c=li.cloneNode(true);c.classList.add('dncl');c.setAttribute('aria-hidden','true');[].forEach.call(c.querySelectorAll('a,button'),function(a){a.tabIndex=-1;});ul.appendChild(c);clones.push(c);});
    run=true;sec.classList.add('dnrun');if(btn){btn.hidden=false;ui();}measure();requestAnimationFrame(frame);
  }
  v.addEventListener('scroll',function(){if(Math.abs(v.scrollLeft-set)>2){pos=v.scrollLeft;if(W>0&&pos>=W){pos-=W;set=pos;v.scrollLeft=pos;}}});
  v.addEventListener('pointerenter',function(e){if(e.pointerType==='mouse')hover=true;});
  v.addEventListener('pointerleave',function(e){if(e.pointerType==='mouse')hover=false;});
  v.addEventListener('focusin',function(){focus=true;});v.addEventListener('focusout',function(){focus=false;});
  v.addEventListener('touchstart',function(){touch=true;clearTimeout(tt);},{passive:true});
  v.addEventListener('touchend',function(){clearTimeout(tt);tt=setTimeout(function(){touch=false;},3500);},{passive:true});
  if(btn)btn.addEventListener('click',function(){user=!user;ui();});
  window.addEventListener('resize',function(){measure();});
  tickDnes();setInterval(tickDnes,60000);
  if(document.readyState==='complete')start();else window.addEventListener('load',start);setTimeout(start,1500);
})();}

/* ---------- Kanály: Teraz / Potom per channel ---------- */
var tiles=[].slice.call(document.querySelectorAll('li.tch[data-id]'));
if(!tiles.length||!cfgEl)return;
var data={},loaded=0,byId={};
function reg(li){var id=li.getAttribute('data-id');(byId[id]=byId[id]||[]).push(li);}
tiles.forEach(reg);

/* favourites (stored only in this browser) */
var FK='tvfav',fav=[];try{fav=JSON.parse(localStorage.getItem(FK)||'[]').filter(function(x){return /^\d+$/.test(x);}).slice(0,200);}catch(e){fav=[];}
var cat=document.getElementById('katalog'),favG=null,favU=null,favN=null;
function saveFav(){try{localStorage.setItem(FK,JSON.stringify(fav));}catch(e){}}
function favBtn(li){var b=li.querySelector('.tfav');if(!b){b=el('button','tfav');b.type='button';li.insertBefore(b,li.querySelector('.trb'));}var on=fav.indexOf(li.getAttribute('data-id'))>=0;b.textContent=on?'★':'☆';b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false');b.title=on?t('favdel','Odobrať z obľúbených'):t('favadd','Pridať do obľúbených');b.setAttribute('aria-label',b.title);}
function buildFav(){
  if(!cat)return;
  if(!favG){var first=cat.querySelector('details.tvg');if(!first)return;favG=el('details','tvg tvfavg');favG.open=true;var sm=el('summary');sm.appendChild(el('span','tt','⭐ '+t('fav','Obľúbené')));favN=el('span','tm','');sm.appendChild(favN);favG.appendChild(sm);favU=el('ul','tvl');favG.appendChild(favU);first.parentNode.insertBefore(favG,first);}
  [].forEach.call(favU.querySelectorAll('li'),function(li){var id=li.getAttribute('data-id');byId[id]=(byId[id]||[]).filter(function(x){return x!==li;});li.remove();});
  fav.forEach(function(id){var src=tiles.filter(function(x){return x.getAttribute('data-id')===id;})[0];if(!src)return;var c=src.cloneNode(true);c.hidden=false;var ep=c.querySelector('.tep');if(ep)ep.remove();c.classList.remove('hasep');favU.appendChild(c);reg(c);favBtn(c);if(data[id])render(c,data[id]);});
  var n=favU.children.length;favG.hidden=!n;favN.textContent=n?String(n):'';
}
tiles.forEach(favBtn);
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.tfav');if(!b)return;e.preventDefault();var id=b.closest('li.tch').getAttribute('data-id'),i=fav.indexOf(id);if(i>=0)fav.splice(i,1);else fav.unshift(id);saveFav();(byId[id]||[]).forEach(favBtn);buildFav();});
buildFav();

function render(li,list){
  var n=now();list=list.filter(function(p){return p[1]>n;});
  var box=li.querySelector('.tep');
  if(!list.length){if(box&&!box.querySelector('.tday:not([hidden])'))box.remove();li.classList.remove('hasep');return;}
  if(!box){box=el('div','tep');li.appendChild(box);li.classList.add('hasep');var ul=li.parentNode;if(ul&&!ul.classList.contains('ep'))ul.classList.add('ep');}
  var day=box.querySelector('.tday'),btn=box.querySelector('.tdb');
  [].slice.call(box.querySelectorAll('.ten,.tpw,.tnx')).forEach(function(x){x.remove();});
  var cur=list[0],first=box.firstChild,on=cur[0]<=n;
  var r1=el('div','ten');r1.appendChild(el('span','tel'+(on?'':' tel2'),on?t('now','Teraz'):t('next','Potom')));r1.appendChild(el('span','tetm',hm(cur[0])));var tt=el('b','tet',(ICON[cur[3]]?ICON[cur[3]]+' ':'')+cur[2]);tt.title=cur[2];r1.appendChild(tt);
  box.insertBefore(r1,first);
  if(on){var pw=el('div','tpw'),pb=el('div','tpb'),i=el('i');i.style.width=pct(cur[0],cur[1])+'%';pb.appendChild(i);pw.appendChild(pb);pw.appendChild(el('span','tlf',t('left','ešte')+' '+left(cur[1])+' '+t('min','min')));box.insertBefore(pw,first);}
  list.slice(1,on?3:2).forEach(function(p,ix){var r=el('div','tnx');if(ix===0)r.appendChild(el('span','tel tel2',t('next','Potom')));else r.appendChild(el('span','tel tel3',''));r.appendChild(el('span','tetm',hm(p[0])));var b=el('span','tnt',p[2]);b.title=p[2];r.appendChild(b);r.appendChild(remLink('trm',li.getAttribute('data-id'),p[0]));box.insertBefore(r,first);});
  if(!btn){btn=el('button','tdb','📅 '+t('day','Celý program dnes'));btn.type='button';btn.setAttribute('aria-expanded','false');day=el('ol','tday');day.hidden=true;box.appendChild(btn);box.appendChild(day);btn.addEventListener('click',function(){openDay(li,btn,day);});}
}
function openDay(li,btn,day){
  var open=day.hidden;day.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(!open||day.getAttribute('data-ok'))return markDay(day);
  day.textContent='';day.appendChild(el('li','tdl',t('load','Načítavam…')));
  var gone=function(){day.textContent='';day.hidden=true;btn.hidden=true;};
  var id=li.getAttribute('data-id');
  fetch('/api/epg/day/'+id,{credentials:'omit'}).then(function(r){return r.ok?r.json():{p:[]};}).then(function(d){
    day.textContent='';if(!d.p||!d.p.length)return gone();
    d.p.forEach(function(p){var x=el('li','tdi');x.setAttribute('data-s',p[0]);x.setAttribute('data-e',p[1]);x.appendChild(el('span','tetm',hm(p[0])));var b=el('span','tdt');b.appendChild(el('b',null,(ICON[p[3]]?ICON[p[3]]+' ':'')+p[2]));if(p[4])b.appendChild(el('span','tds',' – '+p[4]));if(p[5]||p[6])b.appendChild(el('small','tdd',[p[5],p[6]].filter(Boolean).join(' · ')));x.appendChild(b);if(p[0]>now())x.appendChild(remLink('tdr',id,p[0]));day.appendChild(x);});
    day.setAttribute('data-ok','1');markDay(day,true);
  }).catch(gone);
}
function markDay(day,scroll){var n=now(),c=null;[].forEach.call(day.querySelectorAll('.tdi'),function(x){var s=+x.getAttribute('data-s'),e=+x.getAttribute('data-e');x.classList.toggle('past',e<=n);var on=s<=n&&e>n;x.classList.toggle('cur',on);if(on)c=x;});if(scroll&&c&&day.scrollTo)day.scrollTop=Math.max(0,c.offsetTop-day.offsetTop-8);}
function each(fn){Object.keys(data).forEach(function(id){(byId[id]||[]).forEach(function(li){fn(li,id);});});}
function load(){fetch('/api/epg/now',{credentials:'omit'}).then(function(r){return r.ok?r.json():null;}).then(function(d){if(!d||!d.c)return;skew=d.t-Date.now()/1000;if(Math.abs(skew)<90)skew=0;data=d.c;loaded=Date.now();each(function(li,id){render(li,data[id]);});}).catch(function(){});}
function tick(){var need=Date.now()-loaded>10*60000;each(function(li,id){var l=data[id].filter(function(p){return p[1]>now();});if(l.length<2)need=true;render(li,data[id]);var d=li.querySelector('.tday[data-ok]');if(d&&!d.hidden)markDay(d);});if(need)load();}
load();setInterval(tick,60000);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&Date.now()-loaded>60000)tick();});

/* ---------- Šport dnes ---------- */
if(L.sport&&cat){(function(){
  var bar=el('div','tvtools'),b=el('button','tsb',t('sport','⚽ Šport dnes'));b.type='button';b.setAttribute('aria-expanded','false');bar.appendChild(b);
  var pn=el('div','spt');pn.hidden=true;pn.id='sport-dnes';b.setAttribute('aria-controls','sport-dnes');
  var h=cat.querySelector('h2');cat.insertBefore(bar,h?h.nextSibling:cat.firstChild);bar.parentNode.insertBefore(pn,bar.nextSibling);
  var got=null,only=null;
  function draw(){
    pn.textContent='';pn.appendChild(el('p','sph',t('sporth','Dnešné športové prenosy')));
    var n=now(),lst=got.l.filter(function(x){return x[2]>n;}),hasSk=lst.some(function(x){return got.ch[x[0]]&&got.ch[x[0]][2];});
    if(hasSk){var lb=el('label','spf');only=only||el('input');only.type='checkbox';if(!only.dataset.init){only.checked=true;only.dataset.init='1';only.addEventListener('change',draw);}lb.appendChild(only);lb.appendChild(document.createTextNode(' SK/CZ'));pn.appendChild(lb);if(only.checked)lst=lst.filter(function(x){return got.ch[x[0]]&&got.ch[x[0]][2];});}
    if(!lst.length){pn.appendChild(el('p','hint',t('sportnone','Dnes už žiadne športové prenosy.')));return;}
    var ol=el('ol','spl');
    lst.forEach(function(x){var c=got.ch[x[0]]||['',''];var li=el('li','spi'+(x[1]<=n?' on':'')+(x[5]?' big':''));li.appendChild(el('span','tetm',hm(x[1])));
      var m=el('span','spm');var tt=el('b','spt2',x[3]);m.appendChild(tt);var ch=el('span','spc');if(c[1]){var im=el('img');im.src=c[1];im.alt='';im.width=18;im.height=18;im.loading='lazy';ch.appendChild(im);}ch.appendChild(document.createTextNode(c[0]));m.appendChild(ch);li.appendChild(m);
      if(x[1]<=n)li.appendChild(el('span','tel',t('now','Teraz')));else li.appendChild(remLink('tdr',x[0],x[1]));ol.appendChild(li);});
    pn.appendChild(ol);
  }
  b.addEventListener('click',function(){var open=pn.hidden;pn.hidden=!open;b.setAttribute('aria-expanded',open?'true':'false');if(!open)return;if(got&&Date.now()-got.at<5*60000)return draw();pn.textContent=t('load','Načítavam…');
    fetch('/api/epg/sport',{credentials:'omit'}).then(function(r){return r.ok?r.json():{l:[],ch:{}};}).then(function(d){got=d;got.at=Date.now();draw();}).catch(function(){pn.hidden=true;b.setAttribute('aria-expanded','false');});});
})();}
})();
