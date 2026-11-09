'use strict';
/**
 * Extract Software username, password and expiry from a panel screenshot (Gemini vision)
 * or from free text. If Gemini is unavailable, fall back to text heuristics only.
 */
const { parseCredsFromText, parseDate } = require('./softUser');

function sniff(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}

async function compress(buf, mime) {
  try {
    const sharp = require('sharp');
    const out = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize({ width: 1200, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    if (out && out.length) return { buf: out, mime: 'image/jpeg' };
  } catch { /* keep original */ }
  return { buf, mime: mime || sniff(buf) || 'image/jpeg' };
}

function geminiReady() { return !!String(process.env.GEMINI_API_KEY || '').trim(); }

function models() {
  return [...new Set((process.env.GEMINI_MODELS || 'gemini-2.5-flash,gemini-2.0-flash,gemini-3.5-flash-lite,gemini-flash-lite-latest')
    .split(',').map((x) => x.trim()).filter((x) => /^[\w.-]{3,60}$/.test(x)))].slice(0, 5);
}

function parseModelJson(text) {
  const t = String(text || '').trim();
  const slice = (t.match(/\{[\s\S]*\}/) || [t])[0];
  try {
    const j = JSON.parse(slice);
    return {
      username: String(j.username || j.user || j.meno || '').trim(),
      password: String(j.password || j.heslo || j.pass || '').trim(),
      until: parseDate(j.expiry || j.until || j.platne_do || j.expires || j.date || '') || parseDate(t),
      raw: t,
    };
  } catch {
    const c = parseCredsFromText(t);
    return { ...c, raw: t };
  }
}

async function extractFromImage(buf, mime, caption) {
  const hint = parseCredsFromText(caption || '');
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) return { ...hint, source: 'text', error: 'GEMINI_API_KEY nie je nastavený – vyplňte údaje ručne alebo doplňte kľúč v Admin → API kľúče.' };
  const { buf: img, mime: im } = await compress(buf, mime || sniff(buf));
  const prompt = 'This is a screenshot of an IPTV / TV software / panel account (username, password, expiry date). Extract JSON only, no markdown, with keys: username, password, expiry (YYYY-MM-DD if a date is visible). Use empty strings if a field is unreadable. Look for labels like username, user, meno, login, password, heslo, pass, expiry, expire, platné do, valid until.';
  let last = '';
  for (const m of models()) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: im, data: img.toString('base64') } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 300 },
        }),
      });
      const j = await r.json().catch(() => ({}));
      const t = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map((p) => p.text || '').join('');
      if (!r.ok) { last = 'HTTP ' + r.status; continue; }
      if (!t) { last = 'prázdna odpoveď'; continue; }
      const got = parseModelJson(t);
      if (got.username || got.password || got.until) {
        return {
          username: got.username || hint.username,
          password: got.password || hint.password,
          until: got.until || hint.until,
          raw: got.raw,
          source: 'gemini:' + m,
        };
      }
      last = 'polia nerozpoznané';
    } catch (e) { last = e.name || e.message; }
  }
  return { ...hint, source: 'text', error: 'Gemini: ' + (last || 'neúspech') + '. Údaje doplňte ručne, snímka sa aj tak uloží.' };
}

module.exports = { sniff, compress, geminiReady, extractFromImage, parseCredsFromText: require('./softUser').parseCredsFromText };
