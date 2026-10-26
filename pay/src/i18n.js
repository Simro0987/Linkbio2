'use strict';
// Simple server-side SK/EN switch: ?lang=en|sk sets a cookie; HTML responses are translated
// with a phrase dictionary (text outside <script>/<style> only) and get a header toggle link.
const LANGS = ['sk', 'en'];
// SK -> EN UI phrases (longest first at runtime). Admin/customer-entered data is never in here.
const DICT = {
  // payment methods (admin-managed custom links / logos)
  'Pokyny': 'Instructions',
  'Platba cez': 'Payment via',
  'Postup:': 'Steps:',
  '1) zadajte sumu': '1) enter the amount',
  '2) ak sa pýta adresa, vložte skopírovanú BTC adresu, 3) dokončite platbu podľa pokynov poskytovateľa.': '2) if an address is requested, paste the copied BTC address, 3) complete the payment following the provider\'s instructions.',
  'Pokračovať na': 'Continue to',
  'Kopírovať sumu': 'Copy amount',
  'Kopírovať adresu': 'Copy address',
  'Poukážky / darčekové karty': 'Vouchers / gift cards',
  'Platba cez externý odkaz.': 'Payment via an external link.',
  'Platba · SK / CZ': 'Payment · SK / CZ',
  '← Späť na TV Software': '← Back to TV Software',
  '← Späť na výber platby': '← Back to payment methods',
  '← Späť': '← Back',
  'Späť na platby': 'Back to payment',
  'Pokračovať →': 'Continue →',
  'Pokračovať ↓': 'Continue ↓',
  '📖 Návod': '📖 Guide',
  '📖 Návod krok za krokom': '📖 Step-by-step guide',
  'Suma': 'Amount',
  'Meno': 'First name',
  'Priezvisko': 'Last name',
  'Vaša krajina': 'Your country',
  'Spôsob platby': 'Payment method',
  'Mobil': 'Mobile',
  'Objednávka nenájdená': 'Order not found',
  'Nenájdené': 'Not found',
  'Chyba': 'Error',
  'Objednávka': 'Order',
  'Stav objednávky': 'Order status',
  'Stav platby': 'Payment status',
  'Čaká na platbu': 'Awaiting payment',
  'Doklad prijatý': 'Proof received',
  'Potvrdené': 'Confirmed',
  'Zamietnuté': 'Rejected',
  'Metóda': 'Method',
  'Vytvorené': 'Created',
  'Aktualizované': 'Updated',
  'Stránka sa obnovuje automaticky.': 'This page refreshes automatically.',
  'Uložte si tento súkromný odkaz – stav platby uvidíte kedykoľvek:': 'Save this private link – you can check your payment status any time:',
  'Sledovať stav objednávky': 'Track order status',
  'Odkaz neexistuje alebo vypršal.': 'This link does not exist or has expired.',
  'Odkaz neexistuje.': 'This link does not exist.',
  'Kód pošli iba cez formulár nižšie na tejto stránke – nikomu inému (ani do chatu).': 'Send the code only through the form below on this page – to nobody else (not even the chat).',
  'Len informačný návod': 'Information guide only',
  'Zaplatil som': 'I have paid',
  'Poslať doklad': 'Send proof',
  'Kopírovať': 'Copy',
  'Skopírované': 'Copied',
  'Príjemca': 'Beneficiary',
  'Meno príjemcu': 'Beneficiary name',
  'Poznámka': 'Note',
  'Odoslať': 'Send',
};
const PAIRS = Object.entries(DICT).sort((a, b) => b[0].length - a[0].length);

function getLang(req) {
  const q = String((req.query && req.query.lang) || '').toLowerCase();
  if (LANGS.includes(q)) return q;
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)lang=(sk|en)\b/);
  return m ? m[1] : 'sk';
}
function t(lang, sk) { return lang === 'en' && DICT[sk] ? DICT[sk] : sk; }

const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RX = PAIRS.map(([sk, en]) => [new RegExp('(?<!\\p{L})' + reEsc(sk) + '(?!\\p{L})', 'gu'), en, sk]);
function trText(txt) {
  if (!/\S/.test(txt)) return txt;
  let out = txt;
  for (const [rx, en, sk] of RX) if (out.includes(sk)) out = out.replace(rx, en);
  return out;
}
function translateHtml(html) {
  // split out <script>/<style> blocks; translate only text/attribute content in between
  return html.split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/i).map((part, i) => {
    if (i % 2) return part;
    // text nodes only (attribute values may be read by page scripts)
    return part.replace(/>([^<]+)</g, (m, txt) => '>' + trText(txt) + '<');
  }).join('');
}

function toggleHref(req, lang) {
  const u = new URL(req.originalUrl || req.url, 'http://x');
  u.searchParams.set('lang', lang === 'en' ? 'sk' : 'en');
  return u.pathname.replace(/^[/\\]+/, '/') + u.search; // never protocol-relative (open redirect)
}
function toggleLink(req, lang) {
  const other = lang === 'en' ? 'SK' : 'EN';
  return `<a class="langsw" href="${toggleHref(req, lang).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" hreflang="${other.toLowerCase()}" style="margin-left:auto;padding:4px 10px;border:1px solid #334155;border-radius:999px;color:#93c5fd;text-decoration:none;font:600 .85rem system-ui">🌐 ${other}</a>`;
}

function middleware(req, res, next) {
  const lang = getLang(req);
  req.lang = lang;
  const q = String((req.query && req.query.lang) || '').toLowerCase();
  if (LANGS.includes(q)) res.append('Set-Cookie', `lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax${process.env.RENDER ? '; Secure' : ''}`);
  const send = res.send.bind(res);
  res.send = (body) => {
    try {
      const ct = String(res.getHeader('Content-Type') || '');
      if (typeof body === 'string' && req.method === 'GET' && (/html/.test(ct) || (!ct && /^\s*<!doctype html/i.test(body))) && /<\/body>/i.test(body) && !req.path.startsWith('/admin') && !/class="langsw"/.test(body)) {
        if (lang === 'en') body = translateHtml(body).replace(/<html lang="sk"/i, '<html lang="en"');
        const link = toggleLink(req, lang);
        if (/<nav class="tvtop">/.test(body)) body = body.replace(/(<nav class="tvtop">[\s\S]*?)(<\/nav>)/, `$1${link}$2`);
        else body = body.replace(/<body([^>]*)>/i, `<body$1><div class="langbar" style="display:flex;justify-content:flex-end;padding:6px 10px;align-self:stretch;width:100%">${link}</div>`);
        res.vary('Cookie');
      }
    } catch { /* never break a page because of i18n */ }
    return send(body);
  };
  next();
}

module.exports = { middleware, getLang, t, translateHtml, trText, DICT };
