'use strict';
// Fetch a remote logo once (https only, public IPs only, image/* only, ≤2 MB), normalize to 200px PNG via sharp.
const https = require('https'), dns = require('dns').promises, net = require('net');
let sharp = null; try { sharp = require('sharp'); } catch { sharp = null; }
const MAX = 2 * 1024 * 1024;
function privateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase(); const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return privateIp(m[1]);
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}
const STREAMY = /\.(m3u8?|ts|mpd)(\?|$)|get\.php|player_api|xmltv\.php|[?&](username|password)=/i;
async function get(url, hops = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || STREAMY.test(url)) throw new Error('nepovolená URL');
  const all = net.isIP(u.hostname) ? [{ address: u.hostname, family: net.isIP(u.hostname) }] : await dns.lookup(u.hostname, { all: true });
  if (!all.length || all.some((a) => privateIp(a.address))) throw new Error('blokovaná adresa');
  const addr = all[0];
  return new Promise((resolve, reject) => {
    const rq = https.request(u, { method: 'GET', timeout: 10000, servername: net.isIP(u.hostname) ? undefined : u.hostname, headers: { 'user-agent': 'Mozilla/5.0 (lnkbio logo cache)', accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8' },
      lookup: (h, o, cb) => (o && o.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)) }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); if (hops >= 3) return reject(new Error('príliš veľa presmerovaní')); return resolve(get(new URL(r.headers.location, u).href, hops + 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const ct = String(r.headers['content-type'] || '').toLowerCase();
      if (!/^image\//.test(ct) && !(ct.startsWith('text/xml') || ct.startsWith('application/xml') || ct === 'application/octet-stream')) { r.destroy(); return reject(new Error('nie je obrázok (' + (ct || '?') + ')')); }
      if (+r.headers['content-length'] > MAX) { r.destroy(); return reject(new Error('väčšie ako 2 MB')); }
      const ch = []; let n = 0;
      r.on('data', (d) => { n += d.length; if (n > MAX) { r.destroy(); reject(new Error('väčšie ako 2 MB')); } else ch.push(d); });
      r.on('end', () => resolve({ buf: Buffer.concat(ch), ct })); r.on('error', reject);
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', (e) => reject(new Error(e.code || e.message))); rq.end();
  });
}
const STD = [250, 330, 500, 960];
function normalizeUrl(url) {
  let u = String(url || '').trim();
  let m = /^https?:\/\/(?:commons|[a-z]{2,3})\.(?:m\.)?wikipedia\.org\/wiki\/(?:File|Soubor|Súbor|Datei|Fichier):(.+)$/i.exec(u) || /^https?:\/\/commons\.(?:m\.)?wikimedia\.org\/wiki\/File:(.+)$/i.exec(u);
  if (m) u = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + m[1].split(/[?#]/)[0];
  u = u.replace(/^http:\/\/(commons\.wikimedia\.org|upload\.wikimedia\.org|i\.imgur\.com)\//i, 'https://$1/');
  u = u.replace(/^(https:\/\/upload\.wikimedia\.org\/.+\/thumb\/.+\/)(\d+)px-/, (a, pre, w) => pre + (STD.find((x) => x >= +w) || 960) + 'px-');
  u = u.replace(/^(https:\/\/i\.imgur\.com\/\w+)\.gifv$/i, '$1.png');
  return u;
}
async function fetchPng(url) {
  url = normalizeUrl(url);
  const { buf, ct } = await get(url);
  if (!buf.length) throw new Error('prázdny súbor');
  if (/^(text|application)\/(xml|html)/.test(ct) && !/<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'))) throw new Error('nie je obrázok');
  if (!sharp) { if (/^image\/(png|jpeg|gif|webp)$/.test(ct)) return { png: buf, type: ct }; throw new Error('formát nepodporovaný bez sharp'); }
  try {
    const png = await sharp(buf, { density: 144, limitInputPixels: 40e6, animated: false }).resize(200, 200, { fit: 'inside', withoutEnlargement: false }).png({ compressionLevel: 9 }).toBuffer();
    return { png, type: 'image/png' };
  } catch (e) { throw new Error('neplatný obrázok (' + e.message.slice(0, 60) + ')'); }
}
module.exports = { normalizeUrl, fetchPng, hasSharp: !!sharp };
