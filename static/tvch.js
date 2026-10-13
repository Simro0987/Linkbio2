(function(){
function fb(img){var s=document.createElement('span');s.className='tli';s.textContent=img.getAttribute('data-l')||'?';img.replaceWith(s);}
[].forEach.call(document.querySelectorAll('img.tlg'),function(i){if(i.complete&&i.naturalWidth===0&&i.getAttribute('src'))fb(i);else i.addEventListener('error',function(){fb(i);},{once:true});});
var q=document.getElementById('tvq');if(!q)return;var gs=[].slice.call(document.querySelectorAll('.tvg')),none=document.getElementById('tvnone');
q.addEventListener('input',function(){var v=q.value.trim().toLowerCase(),any=false;gs.forEach(function(g){var n=0;[].forEach.call(g.querySelectorAll('.tch'),function(li){var m=!v||li.getAttribute('data-n').indexOf(v)>=0;li.hidden=!m;if(m)n++;});g.hidden=!n;if(n)any=true;g.open=!!v&&n>0;});none.hidden=any;});})();
