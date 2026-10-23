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
var ICON={film:'🎬',sport:'⚽',news:'📰',kids:'🧸',series:'📺',doc:'🌍',show:'🎤',music:'🎵'};

/* ---------- homepage: Dnes v TV ---------- */
var dn=[].slice.call(document.querySelectorAll('.dni'));
function tickDnes(){var n=now(),vis=0;dn.forEach(function(li){var s=+li.getAttribute('data-s'),e=+li.getAttribute('data-e');if(n>=e){li.hidden=true;return;}vis++;var on=n>=s;li.classList.toggle('live',on);var b=li.querySelector('.dpb i');if(b)b.style.width=(on?pct(s,e):0)+'%';});var sec=document.querySelector('.dnes');if(sec&&dn.length&&!vis)sec.hidden=true;}
if(dn.length){tickDnes();setInterval(tickDnes,60000);}

/* ---------- Kanály: Teraz / Potom per channel ---------- */
var tiles=[].slice.call(document.querySelectorAll('li.tch[data-id]'));
if(!tiles.length||!cfgEl)return;
var data={},loaded=0,byId={};tiles.forEach(function(li){byId[li.getAttribute('data-id')]=li;});
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
  list.slice(1,on?3:2).forEach(function(p,ix){var r=el('div','tnx');if(on&&ix===0||!on&&ix===0)r.appendChild(el('span','tel tel2',t('next','Potom')));else r.appendChild(el('span','tel tel3',''));r.appendChild(el('span','tetm',hm(p[0])));var b=el('span','tnt',p[2]);b.title=p[2];r.appendChild(b);box.insertBefore(r,first);});
  if(!btn){btn=el('button','tdb','📅 '+t('day','Celý program dnes'));btn.type='button';btn.setAttribute('aria-expanded','false');day=el('ol','tday');day.hidden=true;box.appendChild(btn);box.appendChild(day);btn.addEventListener('click',function(){openDay(li,btn,day);});}
}
function openDay(li,btn,day){
  var open=day.hidden;day.hidden=!open;btn.setAttribute('aria-expanded',open?'true':'false');if(!open||day.getAttribute('data-ok'))return markDay(day);
  day.textContent='';day.appendChild(el('li','tdl',t('load','Načítavam…')));
  fetch('/api/epg/day/'+li.getAttribute('data-id'),{credentials:'omit'}).then(function(r){return r.ok?r.json():{p:[]};}).then(function(d){
    day.textContent='';if(!d.p||!d.p.length){day.appendChild(el('li','tdl',t('none','Program nie je k dispozícii.')));return;}
    d.p.forEach(function(p){var x=el('li','tdi');x.setAttribute('data-s',p[0]);x.setAttribute('data-e',p[1]);x.appendChild(el('span','tetm',hm(p[0])));var b=el('span','tdt');b.appendChild(el('b',null,(ICON[p[3]]?ICON[p[3]]+' ':'')+p[2]));if(p[4])b.appendChild(el('span','tds',' – '+p[4]));if(p[5]||p[6])b.appendChild(el('small','tdd',[p[5],p[6]].filter(Boolean).join(' · ')));x.appendChild(b);day.appendChild(x);});
    day.setAttribute('data-ok','1');markDay(day,true);
  }).catch(function(){day.textContent='';day.appendChild(el('li','tdl',t('none','Program nie je k dispozícii.')));});
}
function markDay(day,scroll){var n=now(),c=null;[].forEach.call(day.querySelectorAll('.tdi'),function(x){var s=+x.getAttribute('data-s'),e=+x.getAttribute('data-e');x.classList.toggle('past',e<=n);var on=s<=n&&e>n;x.classList.toggle('cur',on);if(on)c=x;});if(scroll&&c&&day.scrollTo)day.scrollTop=Math.max(0,c.offsetTop-day.offsetTop-8);}
function load(){fetch('/api/epg/now',{credentials:'omit'}).then(function(r){return r.ok?r.json():null;}).then(function(d){if(!d||!d.c)return;skew=d.t-Date.now()/1000;if(Math.abs(skew)<90)skew=0;data=d.c;loaded=Date.now();Object.keys(data).forEach(function(id){if(byId[id])render(byId[id],data[id]);});}).catch(function(){});}
function tick(){var need=Date.now()-loaded>10*60000;Object.keys(data).forEach(function(id){var li=byId[id];if(!li)return;var l=data[id].filter(function(p){return p[1]>now();});if(l.length<2)need=true;render(li,data[id]);var d=li.querySelector('.tday[data-ok]');if(d&&!d.hidden)markDay(d);});if(need)load();}
load();setInterval(tick,60000);
document.addEventListener('visibilitychange',function(){if(!document.hidden&&Date.now()-loaded>60000)tick();});
})();
