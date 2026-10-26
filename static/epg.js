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

/* ---------- homepage: Top dnes / Top týždňa (3–5 cards, one highlighted) as moving strips ---------- */
[].forEach.call(document.querySelectorAll('section.hls'),function(sec){
  var ol=sec.querySelector('.hll'),v=sec.querySelector('.hlv'),btn=sec.querySelector('.dnpp');if(!ol)return;
  var mv=sec.hasAttribute('data-speed')&&!RM&&v,speed=Math.max(5,Math.min(150,+sec.getAttribute('data-speed')||28));
  var W=0,pos=0,set=-1,last=0,run=false,user=false,hover=false,focus=false,touch=false,tt=0,sig='';
  function orig(){return [].slice.call(ol.querySelectorAll('.hli:not(.hlcl)'));}
  function tick(){var n=now(),vis=[];orig().forEach(function(li){var s=+li.getAttribute('data-s'),e=+li.getAttribute('data-e');if(n>=e){li.hidden=true;li.classList.remove('best');return;}li.classList.toggle('live',n>=s);vis.push(li);});
    if(vis.length<3){sec.hidden=true;stop();return;}
    if(!vis.some(function(li){return li.classList.contains('best');})){var b=vis.slice().sort(function(a,c){return(+a.getAttribute('data-r')||9)-(+c.getAttribute('data-r')||9);})[0];b.classList.add('best');ol.insertBefore(b,ol.firstChild);}
    sec.classList.toggle('odd',vis.length%2===0);
    if(mv){var k=vis.map(function(li){return li.getAttribute('data-s')+(li.className);}).join('|');if(k!==sig){sig=k;build();}}}
  // clone the visible set as many times as needed so the loop is seamless even when 3 cards fit on screen
  function build(){
    [].forEach.call(ol.querySelectorAll('.hlcl'),function(c){c.remove();});
    sec.classList.add('mv');var items=orig().filter(function(li){return !li.hidden;});if(!items.length)return;
    function addSet(){items.forEach(function(li){var c=li.cloneNode(true);c.classList.add('hlcl');c.setAttribute('aria-hidden','true');[].forEach.call(c.querySelectorAll('a,button'),function(x){x.tabIndex=-1;});ol.appendChild(c);});}
    addSet();measure();var guard=0;while(W>0&&ol.scrollWidth<v.clientWidth+W+40&&guard++<8)addSet();
    if(!run){run=true;if(btn){btn.hidden=false;ui();}requestAnimationFrame(frame);}
  }
  function stop(){[].forEach.call(ol.querySelectorAll('.hlcl'),function(c){c.remove();});W=0;}
  function measure(){var a=ol.querySelector('.hli:not(.hlcl):not([hidden])'),b=ol.querySelector('.hlcl');W=a&&b?b.offsetLeft-a.offsetLeft:0;if(W>0&&pos>=W)pos-=W;}
  function paused(){return user||hover||focus||touch||document.hidden;}
  function ui(){if(!btn)return;btn.setAttribute('aria-pressed',user?'true':'false');btn.textContent=user?btn.getAttribute('data-play'):btn.getAttribute('data-pause');}
  function frame(ts){var dt=last?Math.min(0.1,(ts-last)/1000):0;last=ts;if(W>0&&!paused()){pos+=speed*dt;if(pos>=W)pos-=W;set=pos;v.scrollLeft=pos;}requestAnimationFrame(frame);}
  if(mv){
    v.addEventListener('scroll',function(){if(Math.abs(v.scrollLeft-set)>2){pos=v.scrollLeft;if(W>0&&pos>=W){pos-=W;set=pos;v.scrollLeft=pos;}}});
    v.addEventListener('pointerenter',function(e){if(e.pointerType==='mouse')hover=true;});
    v.addEventListener('pointerleave',function(e){if(e.pointerType==='mouse')hover=false;});
    v.addEventListener('focusin',function(){focus=true;});v.addEventListener('focusout',function(){focus=false;});
    v.addEventListener('touchstart',function(){touch=true;clearTimeout(tt);},{passive:true});
    v.addEventListener('touchend',function(){clearTimeout(tt);tt=setTimeout(function(){touch=false;},3500);},{passive:true});
    if(btn)btn.addEventListener('click',function(){user=!user;ui();});
    var rt=0;window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(function(){sig='';tick();},200);});
    window.addEventListener('load',function(){sig='';tick();}); // images loaded → widths final
  }
  tick();setInterval(tick,60000);
});

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

/* ---------- Program podľa žánru: genre tabs + day tabs, lazy per genre/day ---------- */
if(L.guide&&cat){(function(){
  var G;try{G=JSON.parse(L.guide);}catch(e){return;}if(!G.length)return;
  var st={g:L.gdef||G[0][0],d:0,f:L.gscope==='all'?'all':'skcz',n:60},got={},days=null,favS=null;
  var bar=el('div','tvtools gbar'),pn=el('div','gpn');pn.hidden=true;pn.id='tv-zanre';
  bar.appendChild(el('span','gbh','🗓 '+t('gtitle','Čo dávajú – program podľa žánru')));
  var chips=el('div','gtabs');chips.setAttribute('role','tablist');bar.appendChild(chips);
  G.forEach(function(x){var b=el('button','gch',x[1]);b.type='button';b.setAttribute('data-g',x[0]);b.setAttribute('aria-controls','tv-zanre');b.setAttribute('role','tab');chips.appendChild(b);});
  var h=cat.querySelector('h2');cat.insertBefore(bar,h?h.nextSibling:cat.firstChild);bar.parentNode.insertBefore(pn,bar.nextSibling);
  var dbar=el('div','gdays'),fbar=el('div','gflt'),box=el('div','gbox');pn.appendChild(dbar);pn.appendChild(fbar);pn.appendChild(box);
  [['skcz','SK/CZ'],['all',t('gall','Všetky')],['fav','⭐ '+t('fav','Obľúbené')]].forEach(function(x){var b=el('button','gfc',x[1]);b.type='button';b.setAttribute('data-f',x[0]);fbar.appendChild(b);});
  function mark(){[].forEach.call(chips.children,function(b){var on=!pn.hidden&&b.getAttribute('data-g')===st.g;b.classList.toggle('on',on);b.setAttribute('aria-selected',on?'true':'false');});
    [].forEach.call(fbar.children,function(b){b.classList.toggle('on',b.getAttribute('data-f')===st.f);});
    [].forEach.call(dbar.children,function(b){b.classList.toggle('on',+b.getAttribute('data-d')===st.d);});}
  function drawDays(){dbar.textContent='';(days||[[0,'Dnes']]).forEach(function(x){var b=el('button','gdc',x[1]);b.type='button';b.setAttribute('data-d',x[0]);dbar.appendChild(b);});}
  function favs(){try{return JSON.parse(localStorage.getItem('tvfav')||'[]');}catch(e){return[];}}
  function draw(){
    var r=got[st.g+'|'+st.d];box.textContent='';mark();if(!r)return;
    var n=now(),fv=st.f==='fav'?favs():null,lst=r.l.filter(function(x){if(x[2]<=n)return false;var c=r.ch[x[0]];if(st.f==='skcz')return c&&c[2];if(fv)return fv.indexOf(String(x[0]))>=0;return true;});
    if(!lst.length){box.appendChild(el('p','hint',t('gnone','V tento deň tu nič nie je.')));return;}
    var ol=el('ol','gl');
    lst.slice(0,st.n).forEach(function(x){var c=r.ch[x[0]]||['',''],live=x[1]<=n,f=x[5]||'';var li=el('li','gi'+(live?' on':'')+(f.indexOf('h')>=0?' hl':''));
      li.appendChild(el('span','tetm',hm(x[1])));
      if(x[6]){var p=el('img','gpo');p.src=x[6];p.alt='';p.width=36;p.height=52;p.loading='lazy';p.referrerPolicy='no-referrer';li.appendChild(p);}
      var m=el('span','spm'),tt=el('b','spt2');if(f.indexOf('h')>=0)tt.appendChild(el('span','gtip','★ '+t('gtop','Tip')));tt.appendChild(document.createTextNode(x[3]));m.appendChild(tt);if(x[4])m.appendChild(el('span','gsub',x[4]));
      var ch=el('span','spc');if(c[1]){var im=el('img');im.src=c[1];im.alt='';im.width=18;im.height=18;im.loading='lazy';ch.appendChild(im);}ch.appendChild(document.createTextNode(c[0]));if(f.indexOf('l')>=0&&!live)ch.appendChild(el('span','glv',t('glive','Naživo')));m.appendChild(ch);li.appendChild(m);
      if(live)li.appendChild(el('span','tel',t('now','Teraz')));else li.appendChild(remLink('tdr',x[0],x[1]));ol.appendChild(li);});
    box.appendChild(ol);
    if(lst.length>st.n){var mb=el('button','gmore',t('gmore','Zobraziť ďalšie')+' ('+(lst.length-st.n)+')');mb.type='button';mb.addEventListener('click',function(){st.n+=80;draw();});box.appendChild(mb);}
  }
  function load(){var k=st.g+'|'+st.d,r=got[k];st.n=60;if(r&&Date.now()-r.at<5*60000)return draw();box.textContent=t('load','Načítavam…');mark();
    fetch('/api/epg/guide?g='+encodeURIComponent(st.g)+'&d='+st.d+'&l='+(L.l||'sk'),{credentials:'omit'}).then(function(x){return x.ok?x.json():null;}).then(function(d){if(!d){box.textContent='';return;}d.at=Date.now();got[d.g+'|'+d.d]=d;if(d.days&&!days){days=d.days;drawDays();}if(d.g===st.g&&d.d===st.d)draw();}).catch(function(){box.textContent='';});}
  chips.addEventListener('click',function(e){var b=e.target.closest('.gch');if(!b)return;var g=b.getAttribute('data-g');if(!pn.hidden&&g===st.g){pn.hidden=true;mark();return;}st.g=g;pn.hidden=false;load();});
  dbar.addEventListener('click',function(e){var b=e.target.closest('.gdc');if(!b)return;st.d=+b.getAttribute('data-d');load();});
  fbar.addEventListener('click',function(e){var b=e.target.closest('.gfc');if(!b)return;st.f=b.getAttribute('data-f');st.n=60;draw();});
  drawDays();mark();
  setInterval(function(){if(!pn.hidden)draw();},60000);
})();}
})();
