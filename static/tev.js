(function(){
'use strict';
// "Top udalosti" block: keep the live / countdown badges and progress bars fresh without reloading (CSP: external file, no inline JS)
var secs=document.querySelectorAll('section.tevs');if(!secs.length)return;
function upd(){var n=Date.now()/1000;
  [].forEach.call(secs,function(sec){var vis=0;
    [].forEach.call(sec.querySelectorAll('li.tev'),function(li){var s=+li.getAttribute('data-s'),e=+li.getAttribute('data-e'),b=li.querySelector('.tevbg'),pr=li.querySelector('.tevpr'),i=pr&&pr.querySelector('i');
      if(n>=e){li.hidden=true;return;}vis++;
      var on=n>=s;li.classList.toggle('on',on);
      if(b){if(on)b.textContent='● '+b.getAttribute('data-l');else{var m=Math.max(1,Math.round((s-n)/60));
        if(m<12*60&&isToday(s))b.textContent=b.getAttribute('data-o')+(m<60?m+' min':Math.floor(m/60)+' h'+(m%60?' '+(m%60)+' min':''));else b.textContent=b.getAttribute('data-d');}}
      if(pr){pr.hidden=!on;if(on&&i)i.style.width=Math.max(0,Math.min(100,(n-s)/(e-s)*100))+'%';}
    });
    if(!vis)sec.hidden=true;
  });}
var fmt;try{fmt=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bratislava',year:'numeric',month:'2-digit',day:'2-digit'});}catch(e){fmt=null;}
function day(ms){return fmt?fmt.format(new Date(ms)):new Date(ms).toDateString();}
function isToday(s){return day(s*1000)===day(Date.now());}
upd();setInterval(upd,30000);
document.addEventListener('visibilitychange',function(){if(!document.hidden)upd();});
})();
