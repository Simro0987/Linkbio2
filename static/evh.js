(function(){
'use strict';
// "Top udalosť týždňa" hero carousel: one slide at a time, auto-rotates every 7 s (paused on hover / touch / focus /
// hidden tab, off with prefers-reduced-motion), swipe on touch screens, arrows + dots + ←/→ keys; live/countdown badges.
// CSP: external file, no inline styles in HTML (progress width is set via CSSOM).
var root=document.querySelector('section.evh');if(!root)return;
var slides=[].slice.call(root.querySelectorAll('.evh-s')),dots=[].slice.call(root.querySelectorAll('.evh-dots button'));
var cur=0,timer=null,paused=0,touchT=null,rm=window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
function live(){return slides.filter(function(s){return !s.hasAttribute('data-gone');});}
function show(i){var v=live();if(!v.length){root.hidden=true;return;}
  cur=(i%v.length+v.length)%v.length;
  slides.forEach(function(s){var on=s===v[cur];s.classList.toggle('on',on);s.setAttribute('aria-hidden',on?'false':'true');if(on)s.removeAttribute('inert');else s.setAttribute('inert','');});
  dots.forEach(function(d){var s=slides[+d.getAttribute('data-i')],k=v.indexOf(s);d.hidden=k<0;d.setAttribute('aria-current',k===cur?'true':'false');});
  root.setAttribute('data-n',String(v.length));}
function tick(){if(paused||document.hidden||(rm&&rm.matches))return;show(cur+1);}
function restart(){if(timer)clearInterval(timer);timer=setInterval(tick,7000);}
function go(d){show(cur+d);restart();}
var prev=root.querySelector('.evh-prev'),next=root.querySelector('.evh-next');
if(prev)prev.addEventListener('click',function(){go(-1);});
if(next)next.addEventListener('click',function(){go(1);});
dots.forEach(function(d){d.addEventListener('click',function(){var k=live().indexOf(slides[+d.getAttribute('data-i')]);if(k>=0){show(k);restart();}});});
root.addEventListener('mouseenter',function(){paused|=1;});
root.addEventListener('mouseleave',function(){paused&=~1;});
root.addEventListener('focusin',function(e){var t=e.target;try{if(t.matches(':focus-visible'))paused|=2;}catch(_){paused|=2;}});
root.addEventListener('focusout',function(e){if(!e.relatedTarget||!root.contains(e.relatedTarget))paused&=~2;});
root.addEventListener('keydown',function(e){if(e.key==='ArrowLeft'){go(-1);e.preventDefault();}else if(e.key==='ArrowRight'){go(1);e.preventDefault();}});
var x0=null,y0=0;
root.addEventListener('touchstart',function(e){var t=e.touches[0];x0=t.clientX;y0=t.clientY;paused|=4;if(touchT)clearTimeout(touchT);},{passive:true});
root.addEventListener('touchend',function(e){var t=e.changedTouches[0];if(x0!==null){var dx=t.clientX-x0,dy=t.clientY-y0;if(Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)*1.3)go(dx<0?1:-1);}x0=null;
  touchT=setTimeout(function(){paused&=~4;},10000);},{passive:true});
// badges: ● NAŽIVO / o 25 min / o 3 h 10 min / o 4 dni; progress bar while on air; drop finished slides
function upd(){var n=Date.now()/1000,ch=false;
  slides.forEach(function(s){var a=+s.getAttribute('data-s'),e=+s.getAttribute('data-e'),b=s.querySelector('.evh-b'),pr=s.querySelector('.evh-pr'),i=pr&&pr.querySelector('i');
    if(n>=e){if(!s.hasAttribute('data-gone')){s.setAttribute('data-gone','');ch=true;}return;}
    var on=n>=a;s.classList.toggle('live',on);
    if(b){if(on)b.textContent='● '+b.getAttribute('data-l');else{var m=Math.max(1,Math.round((a-n)/60)),o=b.getAttribute('data-o'),w=(b.getAttribute('data-d')||'').split('|');
      if(m<60)b.textContent=o+m+' min';else if(m<1440)b.textContent=o+Math.floor(m/60)+' h'+(m%60?' '+(m%60)+' min':'');
      else{var d=Math.round(m/1440);b.textContent=o+d+' '+(d===1?w[0]:d<5?w[1]:w[2]);}}}
    if(pr){pr.hidden=!on;if(on&&i)i.style.width=Math.max(0,Math.min(100,(n-a)/(e-a)*100))+'%';}
  });
  if(ch)show(cur);}
upd();show(0);restart();setInterval(upd,30000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)upd();});
})();
