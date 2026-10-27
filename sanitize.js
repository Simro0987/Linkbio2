'use strict';
// Minimal whitelist HTML sanitizer + video URL parser for custom sections (no dependencies, XSS-safe by construction):
// every text node is re-escaped, only whitelisted tags are re-emitted (without attributes except a safe <a href>), tags are balanced.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"'`=\/]/g, (c) => '&#' + c.charCodeAt(0) + ';');
const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'hr', 'code', 'pre', 'small', 'mark']);
const VOID = new Set(['br', 'hr']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'textarea', 'svg', 'math', 'title', 'head', 'select', 'xmp', 'noembed', 'noframes', 'plaintext']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…', euro: '€', copy: '©' };
function decode(t) {
  return String(t).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : ''; }
    return NAMED[e.toLowerCase()] != null ? NAMED[e.toLowerCase()] : m;
  });
}
function safeHref(v) {
  v = decode(String(v || '')).replace(/[\u0000-\u0020\u007f]/g, '');
  if (!v || v.length > 1000) return null;
  if (/^\/(?!\/)[^\\]*$/.test(v)) return v; // site-relative
  try { const u = new URL(v); return ['https:', 'http:', 'mailto:', 'tel:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const hasHtml = (s) => /<\/?(b|strong|i|em|u|s|p|br|ul|ol|li|h[234]|blockquote|a|hr|code|pre|small|mark)\b[^>]*>/i.test(String(s || ''));
const para = (t) => esc(t).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
function sanitize(input, max = 20000) {
  const src = String(input || '').replace(/\r/g, '').slice(0, max);
  if (!hasHtml(src)) return para(src);
  const out = [], stack = [], re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m, drop = null;
  const text = (t) => { if (drop || !t) return; const top = stack[stack.length - 1]; const e = esc(decode(t)); out.push(top === 'ul' || top === 'ol' || !/\S/.test(t) ? e.replace(/\n/g, ' ') : e.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>')); };
  while ((m = re.exec(src))) {
    text(src.slice(last, m.index)); last = re.lastIndex;
    if (!m[2]) continue; // comment
    const close = !!m[1], tag = m[2].toLowerCase();
    if (drop) { if (close && tag === drop) drop = null; continue; }
    if (DROP.has(tag)) { if (!close && !/\/\s*$/.test(m[3])) drop = tag; continue; }
    if (!ALLOWED.has(tag)) continue;
    if (VOID.has(tag)) { if (!close) out.push(`<${tag}>`); continue; }
    if (!close) {
      if (stack.length >= 20) continue;
      if (tag === 'a') {
        const h = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[3] || '');
        const href = h && safeHref(h[1] != null ? h[1] : h[2] != null ? h[2] : h[3]);
        out.push(href ? `<a href="${esc(href)}" rel="noopener noreferrer nofollow"${/^\//.test(href) ? '' : ' target="_blank"'}>` : '<a>');
      } else out.push(`<${tag}>`);
      stack.push(tag);
    } else {
      const i = stack.lastIndexOf(tag); if (i < 0) continue;
      while (stack.length > i) out.push(`</${stack.pop()}>`);
    }
  }
  text(src.slice(last));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('').replace(/^(<br>)+|(<br>)+$/g, '');
}

// ---- videos: YouTube (youtube-nocookie embed), Vimeo, direct https .mp4/.webm ----
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);
const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
function tsec(v) {
  v = String(v || '').trim(); if (!v) return 0;
  if (/^\d{1,6}s?$/.test(v)) return parseInt(v, 10);
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s)?$/.exec(v); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
function badHost(h) {
  return !h || h === 'localhost' || /\.(local|localhost|internal|lan|home|onion)$/.test(h) || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[') || !/\.[a-z]{2,24}$/.test(h);
}
function parseVideo(raw) {
  const s = String(raw || '').trim(); if (!s || s.length > 1000) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  const h = u.hostname.toLowerCase(), p = u.pathname;
  if (YT_HOSTS.has(h)) {
    let id = null;
    if (h === 'youtu.be') id = p.split('/')[1];
    else if (p === '/watch') id = u.searchParams.get('v');
    else { const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(p); if (m) id = m[1]; }
    if (!id || !YT_ID.test(id)) return null;
    const start = tsec(u.searchParams.get('t') || u.searchParams.get('start'));
    return { t: 'yt', id, start: Math.min(start, 86400) };
  }
  if (VIMEO_HOSTS.has(h)) {
    const parts = p.split('/').filter(Boolean); let id = null, hash = null;
    if (h === 'player.vimeo.com') { if (parts[0] === 'video' && /^\d{1,12}$/.test(parts[1] || '')) id = parts[1]; hash = u.searchParams.get('h'); }
    else { const i = parts.findIndex((x) => /^\d{1,12}$/.test(x)); if (i >= 0) { id = parts[i]; if (parts[i + 1] && /^[0-9a-f]{6,20}$/.test(parts[i + 1])) hash = parts[i + 1]; } }
    if (!id) return null;
    if (hash && !/^[0-9a-f]{6,20}$/.test(hash)) hash = null;
    return { t: 'vimeo', id, h: hash || '' };
  }
  if (u.protocol !== 'https:' || badHost(h) || u.port) return null;
  const ext = /\.(mp4|webm)$/i.exec(p); if (!ext) return null;
  return { t: 'file', url: u.href, type: 'video/' + ext[1].toLowerCase() };
}
const embedSrc = (v) => v.t === 'yt' ? `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0&modestbranding=1&playsinline=1${v.start ? '&start=' + v.start : ''}`
  : v.t === 'vimeo' ? `https://player.vimeo.com/video/${v.id}?autoplay=1&dnt=1${v.h ? '&h=' + v.h : ''}` : '';
module.exports = { sanitize, safeHref, hasHtml, decode, parseVideo, embedSrc, esc, para };
