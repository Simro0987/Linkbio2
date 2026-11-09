'use strict';
// SSRF-safe streaming HTTP(S) fetch for admin-supplied EPG URLs (custom XMLTV sources).
// - only http/https, no credentials in the URL, ports 80/443/1024–65535
// - every DNS answer (also after each redirect) must be a public unicast address; the socket connects
//   to exactly the address that was checked (custom lookup → no DNS-rebinding window)
// - manual redirects (max 5, each re-validated), overall deadline, compressed-size limit
// Format is decided by CONTENT (gzip / xz / zip / plain XML), never by the URL; playlists, streams, HTML and JSON are rejected.
// Returns { stream (Node Readable of decompressed XMLTV bytes), gz: false, url (final), type }.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { Readable } = require('stream');
const zlib = require('zlib');

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
  const type = String(res.headers['content-type'] || '').toLowerCase();
  if (/mpegurl|scpls|x-m3u/.test(type)) { res.destroy(); throw notEpg(NOT_EPG_M3U); }
  if (/^(video|audio)\/|dash\+xml/.test(type)) { res.destroy(); throw notEpg(NOT_EPG_STREAM); }
  const len = +res.headers['content-length'] || 0; if (len > maxBytes) { res.destroy(); throw new Error('súbor je príliš veľký'); }
  // raw bytes with the download-size limit
  let total = 0;
  const raw = Readable.from((async function* () {
    try { for await (const c of res) { total += c.length; if (total > maxBytes) throw new Error('súbor je príliš veľký'); yield c; } } finally { res.destroy(); }
  })(), { objectMode: false });
  const body = await decode(raw);
  return { stream: body, gz: false, url: x.href, type };
}

// ---------- content sniffing: format is decided by the bytes, never by the URL/extension ----------
const NOT_EPG_M3U = 'Odkaz vracia IPTV playlist (M3U/M3U8), nie TV program. Zadajte odkaz na XMLTV EPG.';
const NOT_EPG_STREAM = 'Odkaz vracia video/audio stream, nie TV program. Zadajte odkaz na XMLTV EPG.';
// playlist/stream answers are flagged so the caller never keeps such a URL
const notEpg = (m) => Object.assign(new Error(m), { code: 'NOTEPG' });
// read from an async iterator until at least n bytes (or the end); returns { head, rest }
async function peek(stream, n) {
  const it = stream[Symbol.asyncIterator](), bufs = []; let len = 0, done = false;
  while (len < n) { const r = await it.next(); if (r.done) { done = true; break; } const b = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value); bufs.push(b); len += b.length; }
  const head = Buffer.concat(bufs);
  async function* rest() { try { if (head.length) yield head; if (!done) for (let r = await it.next(); !r.done; r = await it.next()) yield r.value; } finally { if (it.return) await it.return(); } }
  return { head, rest };
}
function sniffText(b) {
  let t = b.toString('utf8', 0, Math.min(b.length, 256 * 1024)); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const s = t.replace(/^\s+/, '');
  if (b.length >= 377 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return NOT_EPG_STREAM; // MPEG-TS
  if (/^#EXTM3U|#EXTINF[:\s]|#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/i.test(s.slice(0, 4096)) || /^#EXTINF/im.test(t)) return NOT_EPG_M3U;
  if (/^[{[]/.test(s)) return 'Odkaz vracia JSON – podporovaný je iba formát XMLTV (<tv> s <channel>/<programme>).';
  if (/^(<!doctype html|<html)/i.test(s)) return 'Odkaz vracia webovú stránku (HTML), nie XMLTV súbor s programom.';
  if (/<(MPD|SmilDocument)\b/.test(s.slice(0, 4096))) return NOT_EPG_STREAM;
  if (!/<tv[\s>]/i.test(t) && !/<(channel|programme)[\s>]/i.test(t)) return 'Obsah nie je XMLTV (chýba <tv>, <channel> alebo <programme>).';
  return '';
}
// xz via the system "xz" binary (no extra npm dependency); output is still size-limited by the parser
function unxz(src) {
  const { spawn } = require('child_process');
  const p = spawn('xz', ['-dc', '-q'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const errP = new Promise((_, bad) => p.on('error', (e) => bad(new Error(e.code === 'ENOENT' ? 'formát .xz nie je na serveri podporovaný (použite .gz alebo .zip)' : 'xz: ' + e.message))));
  errP.catch(() => {});
  src.on('error', (e) => p.stdout.destroy(e)); src.pipe(p.stdin).on('error', () => {});
  p.stdin.on('error', () => {});
  p.on('close', (code) => { if (code) p.stdout.destroy(new Error('poškodený .xz súbor')); });
  const out = p.stdout; out.on('close', () => { try { p.kill(); } catch {} });
  return { out, errP };
}
// first file of a .zip (stored or deflate), streamed from the local file headers
async function unzip(stream) {
  let { head, rest } = await peek(stream, 64 * 1024); let it = rest()[Symbol.asyncIterator](), buf = Buffer.alloc(0);
  const need = async (n) => { while (buf.length < n) { const r = await it.next(); if (r.done) throw new Error('poškodený .zip súbor'); buf = Buffer.concat([buf, r.value]); } };
  head = null;
  for (let i = 0; i < 50; i++) {
    await need(30); if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('.zip neobsahuje XMLTV súbor');
    const flags = buf.readUInt16LE(6), method = buf.readUInt16LE(8), csize = buf.readUInt32LE(18), nlen = buf.readUInt16LE(26), xlen = buf.readUInt16LE(28);
    await need(30 + nlen + xlen); const name = buf.toString('utf8', 30, 30 + nlen); buf = buf.subarray(30 + nlen + xlen);
    if (flags & 1) throw new Error('zaheslovaný .zip nie je podporovaný');
    const skip = /\/$/.test(name) || /(^|\/)(__MACOSX|\.)/.test(name) || (/\.(txt|md|nfo|jpe?g|png|m3u8?)$/i.test(name) && !(flags & 8));
    if (skip && !(flags & 8)) { await need(csize); buf = buf.subarray(csize); continue; }
    if (method !== 0 && method !== 8) throw new Error('nepodporovaná kompresia v .zip');
    if (method === 0 && (flags & 8)) throw new Error('nepodporovaný .zip');
    const first = buf; const known = !(flags & 8) ? csize : Infinity;
    const data = Readable.from((async function* () { let left = known; let b = first.subarray(0, Math.min(first.length, left)); left -= b.length; if (b.length) yield b; while (left > 0) { const r = await it.next(); if (r.done) break; const c = r.value.subarray(0, Math.min(r.value.length, left)); left -= c.length; yield c; } if (it.return) await it.return(); })(), { objectMode: false });
    if (method === 0) return data;
    const inf = zlib.createInflateRaw(); data.on('error', (e) => inf.destroy(e)); data.pipe(inf); return inf;
  }
  throw new Error('.zip neobsahuje XMLTV súbor');
}
async function decode(raw, depth = 0) {
  const { head, rest } = await peek(raw, 4096); if (!head.length) throw new Error('prázdna odpoveď');
  const src = () => Readable.from(rest(), { objectMode: false });
  let out = null;
  if (head[0] === 0x1f && head[1] === 0x8b) { const s = src(), g = zlib.createGunzip(); s.on('error', (e) => g.destroy(e)); out = s.pipe(g); }
  else if (head.length > 5 && head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) { const x = unxz(src()); out = x.out; x.errP.catch((e) => out.destroy(e)); }
  else if (head.readUInt32LE(0) === 0x04034b50) out = await unzip(src());
  else if (head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) throw new Error('formát .bz2 nie je podporovaný (použite .gz, .xz alebo .zip)');
  else if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) throw new Error('formát .zst nie je podporovaný (použite .gz, .xz alebo .zip)');
  if (out) { if (depth < 1) return decode(out, depth + 1); raw = out; return sniffed(raw); }
  return sniffed(src());
}
async function sniffed(stream) {
  const { head, rest } = await peek(stream, 256 * 1024); if (!head.length) throw new Error('prázdny súbor');
  const bad = sniffText(head); if (bad) { stream.destroy && stream.destroy(); throw (bad === NOT_EPG_M3U || bad === NOT_EPG_STREAM) ? notEpg(bad) : new Error(bad); }
  return Readable.from(rest(), { objectMode: false });
}

/** Download an M3U playlist (SSRF-safe). Returns UTF-8 text; caller must parse metadata and drop stream URLs. */
async function openPlaylist(url, { signal, maxBytes = 8 * 1024 * 1024 } = {}) {
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
  const type = String(res.headers['content-type'] || '').toLowerCase();
  if (/^(video|audio)\/|dash\+xml/.test(type)) { res.destroy(); throw new Error('Odkaz vracia video/audio stream, nie M3U zoznam kanálov.'); }
  const len = +res.headers['content-length'] || 0; if (len > maxBytes) { res.destroy(); throw new Error('súbor je príliš veľký'); }
  let total = 0; const chunks = [];
  try { for await (const c of res) { total += c.length; if (total > maxBytes) throw new Error('súbor je príliš veľký'); chunks.push(c); } } finally { res.destroy(); }
  let buf = Buffer.concat(chunks);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
  const text = buf.toString('utf8');
  if (/<(tv|channel|programme)[\s>]/i.test(text.slice(0, 8192))) throw new Error('Odkaz vracia XMLTV, nie M3U. Zadajte ho ako URL TV programu.');
  if (!/#EXTM3U|#EXTINF[:\s]/i.test(text.slice(0, 8192))) throw new Error('Obsah nie je M3U zoznam kanálov.');
  return { text, url: x.href };
}
module.exports = { open, openPlaylist, checkUrl, publicIp, sniffText, _decode: decode };
