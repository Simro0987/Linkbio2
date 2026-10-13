// Rebuild tvlogos-extra.json.gz. Download first to /tmp: iptv-org.github.io/api/channels.json + logos.json (metadata/logos only, no streams), picons/picons git tree (GitHub API), Wikidata SPARQL (TV channels with P154) -> /tmp/wd.json
const crypto=require('crypto'),fs=require('fs'),zlib=require('zlib');
const { normName } = require('/workspace/linkbio/tvlogos.js');
const out={iptv:[],picons:[],wd:[]};
// iptv-org: channel metadata + logos only
const ch=require('/tmp/channels.json'),lg=require('/tmp/logos.json');
const best=new Map();
for(const l of lg){ if(!/^https:\/\//.test(l.url)||l.in_use===false) continue; const sc=(l.feed?0:10)+(/svg|png/i.test(l.format)?3:0)+Math.min(5,(l.width||0)/100); const b=best.get(l.channel); if(!b||sc>b.sc) best.set(l.channel,{u:l.url,sc}); }
for(const c of ch){ if(c.closed||c.is_nsfw) continue; const b=best.get(c.id); if(!b) continue; for(const n of [c.name,...(c.alt_names||[])]){ const k=normName(n).key; if(k) out.iptv.push([k,(c.country||'').toLowerCase(),b.u]); } }
// picons
const pt=require('/tmp/picons.json').tree.map(x=>x.path).filter(p=>/^build-source\/logos\/[^/]+\.(default|light|white)\.(svg|png)$/.test(p));
const pm=new Map(); for(const p of pt){ const f=p.split('/').pop(), base=f.split('.')[0], v=f.split('.')[1]; const r=v==='default'?0:1; if(!pm.has(base)||r<pm.get(base).r) pm.set(base,{p,r}); }
for(const [b,{p}] of pm){ const k=b.replace(/hd$|uhd$|4k$/,'')||b; out.picons.push([k,'',p.replace('build-source/logos/','')]); }
// wikidata P154
const commons=(fn)=>{fn=decodeURIComponent(fn).replace(/ /g,'_');const h=crypto.createHash('md5').update(fn).digest('hex');const e=encodeURIComponent(fn);return `https://upload.wikimedia.org/wikipedia/commons/thumb/${h[0]}/${h.slice(0,2)}/${e}/200px-${e}${/\.svg$/i.test(fn)?'.png':''}`;};
const seen=new Set(); for(const b of require('/tmp/wd.json').results.bindings){ const k=normName(b.l.value).key, u=commons(b.logo.value.split('/FilePath/')[1]); const id=k+u; if(!k||seen.has(id)) continue; seen.add(id); out.wd.push([k,b.cc.value.toLowerCase(),u]); }
const buf=zlib.gzipSync(JSON.stringify({at:new Date().toISOString().slice(0,10),...out}),{level:9});
fs.writeFileSync('/workspace/linkbio/tvlogos-extra.json.gz',buf);console.log(out.iptv.length,out.picons.length,out.wd.length,buf.length);
