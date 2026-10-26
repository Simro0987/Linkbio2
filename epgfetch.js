'use strict';
// SSRF-safe streaming HTTP(S) fetch for admin-supplied EPG URLs (custom XMLTV sources).
// - only http/https, no credentials in the URL, ports 80/443/1024–65535
// - every DNS answer (also after each redirect) must be a public unicast address; the socket connects
//   to exactly the address that was checked (custom lookup → no DNS-rebinding window)
// - manual redirects (max 5, each re-validated), overall deadline, compressed-size limit
// Returns { stream (Node Readable of raw bytes), gz (bool, by magic bytes), url (final), type }.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { Readable } = require('stream');

const BL = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BL.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BL.addSubnet(a, p, 'ipv6');
// 198.18.0.0/15 (benchmarking) is blocked too, unless EPG_FETCH_ALLOW_198_18=1 (only for sandboxes whose DNS returns fake IPs from that range)
if (process.env.EPG_FETCH_ALLOW_198_18 !== '1') BL.addSubnet('198.18.0.0', 15, 'ipv4');
function publicIp(ip) {
  const v = net.isIP(ip); if (!v) return false;
  if (v === 6) { const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); if (m) return publicIp(m[1]); }
  return !BL.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}
function checkUrl(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { throw new Error('neplatná URL'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('povolené je iba http/https');
  if (x.username || x.password) throw new Error('URL nesmie obsahovať meno/heslo');
  const port = +x.port || (x.protocol === 'https:' ? 443 : 80);
  if (!(port === 80 || port === 443 || port >= 1024)) throw new Error('nepovolený port');
  const h = x.hostname.replace(/^\[|\]$/g, '');
  if (!h || /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(h)) throw new Error('súkromná adresa nie je povolená');
  if (net.isIP(h) && !publicIp(h)) throw new Error('súkromná/lokálna IP nie je povolená');
  return x;
}
// dns lookup used by the socket itself: reject if ANY answer is non-public, connect to the first
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !publicIp(a.address))) return cb(Object.assign(new Error('súkromná/lokálna IP nie je povolená'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
function get(x, signal) {
  return new Promise((ok, bad) => {
    const mod = x.protocol === 'https:' ? https : http;
    const req = mod.request(x, { method: 'GET', lookup: safeLookup, signal, headers: { 'user-agent': 'lnkbio-epg/1.0 (+https://lnkbio.onrender.com)', accept: 'application/xml,text/xml,application/gzip,application/octet-stream,*/*;q=0.5', 'accept-encoding': 'identity' }, timeout: 20e3 });
    req.on('timeout', () => req.destroy(new Error('časový limit spojenia')));
    req.on('response', ok); req.on('error', bad); req.end();
  });
}
async function open(url, { signal, maxBytes = 120 * 1024 * 1024 } = {}) {
  let x = checkUrl(url), res;
  for (let hop = 0; ; hop++) {
    res = await get(x, signal);
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume(); if (hop >= 5) throw new Error('príliš veľa presmerovaní');
      x = checkUrl(new URL(res.headers.location, x)); continue;
    }
    break;
  }
  if (res.statusCode !== 200) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
  const len = +res.headers['content-length'] || 0; if (len > maxBytes) { res.destroy(); throw new Error('súbor je príliš veľký'); }
  const it = res[Symbol.asyncIterator]();
  let first = await it.next(); if (first.done) throw new Error('prázdna odpoveď');
  const head = first.value; const gz = head[0] === 0x1f && head[1] === 0x8b;
  let total = 0;
  const stream = Readable.from((async function* () {
    try {
      for (let r = first; !r.done; r = await it.next()) { total += r.value.length; if (total > maxBytes) throw new Error('súbor je príliš veľký'); yield r.value; }
    } finally { res.destroy(); }
  })(), { objectMode: false });
  return { stream, gz, url: x.href, type: String(res.headers['content-type'] || '') };
}
module.exports = { open, checkUrl, publicIp };
