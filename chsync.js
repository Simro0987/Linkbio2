'use strict';
// Channel-catalog sync from an M3U playlist or Xtream live lists.
// Only name, tvg-id, tvg-logo and group-title are kept. Stream URLs, tokens,
// usernames and passwords are discarded immediately and never stored or returned.

const MAX_CH = 5000;
const ANYURL = /^\s*[a-z][a-z0-9+.-]{1,10}:\/\//i;
const STREAMISH = /(^|\b)(rtmp|rtsp|rtp|udp|mms|srt|hls)s?:\/\/|\.m3u8?\b|\.ts(\?|$|\b)|\.mpd\b|get\.php|player_api|xmltv\.php|[?&](username|password|user|pass|token)=|^https?:\/\/[^/\s]*:\d{2,5}(\/|$)|^https?:\/\/[^/\s]*@/i;
const isStream = (v) => STREAMISH.test(String(v || '').trim());
const cleanTxt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const txtOk = (s) => s && !ANYURL.test(s) && !isStream(s);

function httpsLogo(v) {
  v = String(v || '').trim();
  if (/^http:\/\//i.test(v)) {
    try { const x = new URL(v); x.protocol = 'https:'; if (x.port === '80') x.port = ''; v = x.href; } catch { return ''; }
  }
  return v;
}
function safeLogo(v) {
  v = httpsLogo(v); if (!v) return '';
  if (v.length > 500 || isStream(v)) return '';
  let u; try { u = new URL(v); } catch { return ''; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return '';
  return u.href;
}

function normalize(meta) {
  const name = cleanTxt(meta.name, 120);
  const category = cleanTxt(meta.category, 80) || 'Ostatné';
  if (!txtOk(name) || !txtOk(category)) return null;
  const tvgId = cleanTxt(meta.tvgId, 120);
  if (tvgId && (ANYURL.test(tvgId) || isStream(tvgId))) return null;
  return { name, category, logo: safeLogo(meta.logo), tvgId: tvgId && !ANYURL.test(tvgId) ? tvgId : '' };
}

function parseExtinf(line) {
  if (!/^#EXTINF:/i.test(line)) return null;
  const rest = line.slice(line.toLowerCase().indexOf('#extinf:') + 8);
  let i = 0;
  while (i < rest.length && rest[i] !== ' ' && rest[i] !== ',') i++;
  const attrs = {};
  while (i < rest.length && rest[i] !== ',') {
    while (rest[i] === ' ') i++;
    if (i >= rest.length || rest[i] === ',') break;
    let key = '';
    while (i < rest.length && rest[i] !== '=' && rest[i] !== ' ' && rest[i] !== ',') key += rest[i++];
    if (rest[i] === '=') {
      i++;
      let val = '';
      if (rest[i] === '"') {
        i++;
        while (i < rest.length && rest[i] !== '"') val += rest[i++];
        if (rest[i] === '"') i++;
      } else {
        while (i < rest.length && rest[i] !== ' ' && rest[i] !== ',') val += rest[i++];
      }
      attrs[key.toLowerCase()] = val;
    }
  }
  const title = rest[i] === ',' ? rest.slice(i + 1).trim() : '';
  return { name: title || attrs['tvg-name'] || '', tvgId: attrs['tvg-id'] || '', logo: attrs['tvg-logo'] || '', category: attrs['group-title'] || '' };
}

async function parseM3u(text, { max = MAX_CH, yieldEvery = 250 } = {}) {
  const items = [], seen = new Set();
  let skipped = 0, droppedUrls = 0, pending = null;
  const lines = String(text || '').split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    if (yieldEvery && n && n % yieldEvery === 0) await new Promise((r) => setImmediate(r));
    const line = lines[n].trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) { pending = parseExtinf(line); continue; }
    if (line[0] === '#') continue;
    droppedUrls++;
    const meta = pending; pending = null;
    if (!meta) { skipped++; continue; }
    const ch = normalize(meta);
    if (!ch) { skipped++; continue; }
    const k = (ch.name + '|' + ch.category).toLowerCase();
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    items.push(ch);
    if (items.length >= max) break;
  }
  return { items, skipped, droppedUrls, truncated: items.length >= max };
}

function fromXtream(categories, streams, { max = MAX_CH } = {}) {
  const cat = new Map();
  for (const c of Array.isArray(categories) ? categories : []) {
    const id = String(c && (c.category_id != null ? c.category_id : c.id) != null ? (c.category_id != null ? c.category_id : c.id) : '');
    const name = cleanTxt(c && (c.category_name || c.name), 80);
    if (id) cat.set(id, name || 'Ostatné');
  }
  const items = [], seen = new Set();
  let skipped = 0;
  for (const s of Array.isArray(streams) ? streams : []) {
    if (items.length >= max) break;
    if (!s || typeof s !== 'object') { skipped++; continue; }
    const name = s.name || s.stream_display_name || '';
    const category = cat.get(String(s.category_id != null ? s.category_id : '')) || 'Ostatné';
    const logo = s.stream_icon || '';
    const tvgId = s.epg_channel_id || s.tvg_id || '';
    const ch = normalize({ name, category, logo, tvgId });
    if (!ch) { skipped++; continue; }
    const k = (ch.name + '|' + ch.category).toLowerCase();
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    items.push(ch);
  }
  return { items, skipped, truncated: items.length >= max };
}

function looksLikeM3u(text) {
  const s = String(text || '').slice(0, 8192);
  return /#EXTM3U|#EXTINF[:\s]/i.test(s);
}

module.exports = { parseM3u, parseExtinf, fromXtream, normalize, safeLogo, looksLikeM3u, MAX_CH };
