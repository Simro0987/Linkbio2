'use strict';

/**
 * Admin dashboard chrome: grouped tiles, sidebar, settings search.
 * Contact details live at /admin/kontakt (used by the public Kontakt page).
 */
const GROUPS = [
  { id: 'platby', title: 'Platby', tiles: [
    { href: '/admin/platobne-metody', icon: '💳', title: 'Platobné metódy', hint: 'Zapnúť, vypnúť a upraviť spôsoby platby', k: 'platby platobné metódy checkout karta sepa revolut crypto blink oxapay' },
    { href: '/admin/platby/sepa', icon: '🏦', title: 'SEPA objednávky', hint: 'Bankové prevody na potvrdenie', k: 'sepa bank prevod iban objednávky' },
    { href: '/admin/platby/sepa-chain', icon: '🤖', title: 'Reťaz SEPA botov', hint: 'Automatické spracovanie SEPA', k: 'sepa bot reťaz telegram' },
    { href: '/admin/platby/guides', icon: '📖', title: 'Návody platieb', hint: 'Texty a snímky krokov pre zákazníka', k: 'návody platby screenshot revolut' },
    { href: '/admin/platby/kategorie', icon: '🗂️', title: 'Kategórie platieb', hint: 'Zoskupenie spôsobov platby', k: 'kategórie skupiny' },
    { href: '/admin/platby/sumy', icon: '💶', title: 'Podľa sumy', hint: 'Metódy pre jednotlivé balíky', k: 'sumy balík cenník 10 25 45' },
    { href: '/admin/penazenky', icon: '👛', title: 'Adresy peňaženiek', hint: 'Krypto adresy na prijímanie platieb', k: 'peňaženky wallet btc ltc adresa' },
    { href: '/admin/odkazy-podla-sumy', icon: '🔗', title: 'Odkazy podľa sumy', hint: 'Hotové platobné odkazy pre konkrétnu sumu', k: 'odkazy suma revolut skrill' },
    { href: '/admin/platby/azteco', icon: '₿', title: 'Azteco (ručné)', hint: 'Záložné spracovanie Azteco kódov', k: 'azteco bitcoin voucher' },
    { href: '/admin/objednavky', icon: '📦', title: 'Objednávky a prihlásenie', hint: 'Poslať prihlasovacie údaje zákazníkovi do okna', k: 'objednávky username údaje chat heslo prihlásenie credentials' },
  ]},
  { id: 'predplatne', title: 'Predplatné / Zákazníci', tiles: [
    { href: '/admin/zakaznici', icon: '👥', title: 'Zákazníci', hint: 'Účty, predplatné a prehľad', k: 'zákazníci účty predplatné username expirácia' },
    { href: '/admin/cennik', icon: '🏷️', title: 'Cenník', hint: 'Balíky a ceny predplatného', k: 'cenník plány cena balík mesiace' },
    { href: '/admin/predplatne-server', icon: '🖥️', title: 'Server predplatného', hint: 'Panel (adresa + admin meno a heslo), player_api synchronizácia kanálov, záložné M3U/XMLTV, overenie predplatného', k: 'server predplatného panel http https overenie m3u xmltv player_api get_live_streams get_short_epg synchronizácia kanály účty username' },
    { href: '/admin/xpub', icon: '🔑', title: 'xpub adresy', hint: 'Automatické adresy pre každú objednávku', k: 'xpub derivácia adresa' },
  ]},
  { id: 'sekcie', title: 'Sekcie', tiles: [
    { href: '/admin/sekcie', icon: '🧩', title: 'Sekcie a menu', hint: 'Poradie, skrytie, typy blokov na stránke', k: 'sekcie menu poradie bloky drag' },
    { href: '/admin/stranka', icon: '🏠', title: 'Stránka a vzhľad', hint: 'Titulok, logo, farby, bio, pätička', k: 'stránka vzhľad logo farby téma bio slug titulok footer' },
    { href: '/admin/texty', icon: '✏️', title: 'Texty stránky', hint: 'Nadpisy a tlačidlá (SK/EN)', k: 'texty preklady nadpisy tlačidlá' },
    { href: '/admin/tlacidla', icon: '🔘', title: 'Tlačidlá a odkazy', hint: 'Tlačidlá na stránke, krátke odkazy, menu', k: 'tlačidlá short link qr menu navigácia' },
    { href: '/admin/stav', icon: '📡', title: 'Stav služieb', hint: 'Kanály a ich dostupnosť', k: 'stav služieb kanály up down' },
  ]},
  { id: 'tv', title: 'TV / EPG', tiles: [
    { href: '/admin/kanaly-katalog', icon: '📺', title: 'Katalóg kanálov', hint: 'Pridať, upraviť, import, logá', k: 'kanály katalóg logo csv import' },
    { href: '/admin/epg', icon: '🗓', title: 'TV program (EPG)', hint: 'Zdroje programu a párovanie', k: 'epg tv program rozpis xmltv' },
    { href: '/admin/kanaly-text', icon: '📝', title: 'Text sekcie Kanály', hint: 'Úvodný text a zobrazenie stavu', k: 'kanály úvod text sekcia' },
  ]},
  { id: 'top', title: 'Top udalosti', tiles: [
    { href: '/admin/udalosti', icon: '🔥', title: 'Top udalosti v TV', hint: 'Pripnúť, skryť, kľúčové slová, počet', k: 'top udalosti týždňa zápas film pin' },
  ]},
  { id: 'affiliate', title: 'Affiliate', tiles: [
    { href: '/admin/zakaznici/nastavenia', icon: '🤝', title: 'Affiliate stupne', hint: 'Prah, bonusové mesiace, 2. zariadenie', k: 'affiliate bonus mesiace odporučenie tier' },
    { href: '/admin/zakaznici/ledger', icon: '📒', title: 'Affiliate bonusy', hint: 'História pripísaných mesiacov', k: 'ledger bonus história' },
  ]},
  { id: 'gift', title: 'Darčekové karty', tiles: [
    { href: '/admin/platobne-metody/darcekove-karty', icon: '🎁', title: 'Darčekové karty', hint: 'Azteco / Amazon – inteligentný výber a prah', k: 'darčekové karty azteco amazon dundle g2a prah 0.70' },
  ]},
  { id: 'kontakt', title: 'Kontakt a nastavenia', tiles: [
    { href: '/admin/kontakt', icon: '☎️', title: 'Kontaktné údaje', hint: 'E-mail, Telegram, Facebook, WhatsApp a ďalšie – zobrazia sa na stránke Kontakt', k: 'kontaktné údaje email e-mail telegram facebook whatsapp instagram youtube signal kontakt sociálne siete podpora' },
    { href: '/admin/email', icon: '📧', title: 'Odosielanie e-mailov', hint: 'Brevo / Resend / Mailjet (HTTPS)', k: 'e-mail brevo resend mailjet smtp odosielanie' },
    { href: '/admin/navody', icon: '📚', title: 'Návody (aplikácie)', hint: 'Inštalačné návody pre zariadenia', k: 'návody inštalácia android tv' },
    { href: '/admin/azteco', icon: '🧾', title: 'Azteco parser', hint: 'Načítanie dokladu Azteco', k: 'azteco parse doklad' },
    { href: '/admin/agent', icon: '🤖', title: 'AI asistent', hint: 'Nastavenie znalostí bota', k: 'ai agent chat asistent' },
  ]},
  { id: 'security', title: 'Bezpečnosť', tiles: [
    { href: '/admin/2fa', icon: '🔐', title: 'Dvojfaktorové overenie', hint: 'TOTP kľúč a záložné kódy', k: '2fa totp bezpečnosť overenie' },
    { href: '/admin/heslo', icon: '🔑', title: 'Zmena hesla', hint: 'Heslo administrátora (min. 12 znakov)', k: 'heslo password zmena' },
    { href: '/admin/kluce', icon: '🗝️', title: 'API kľúče', hint: 'Uložené kľúče služieb (šifrované)', k: 'api kľúče tokeny secrets' },
    { href: '/admin/zaloha', icon: '💾', title: 'Záloha a obnova', hint: 'Stiahnuť alebo obnoviť zálohu', k: 'záloha backup restore json' },
    { href: '/admin/kos', icon: '🗑️', title: 'Kôš', hint: 'Obnoviť alebo natrvalo zmazať', k: 'kôš trash zmazané' },
  ]},
];

const searchIndex = () => GROUPS.flatMap((g) => g.tiles.map((t) => ({
  group: g.title, href: t.href, title: t.title, hint: t.hint, icon: t.icon,
  q: (g.title + ' ' + t.title + ' ' + t.hint + ' ' + (t.k || '')).toLowerCase(),
})));

function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function tilesHtml() {
  return GROUPS.map((g) => `<section class="adg" data-group="${esc(g.id)}"><h2>${esc(g.title)}</h2><div class="tiles">${g.tiles.map((t) =>
    `<a class="tile adt" href="${esc(t.href)}" data-q="${esc((t.title + ' ' + t.hint + ' ' + (t.k || '')).toLowerCase())}"><span class="tt">${t.icon} ${esc(t.title)}</span><span class="tm">${esc(t.hint)}</span></a>`
  ).join('')}</div></section>`).join('');
}

function sideNav() {
  const items = [
    ['/admin', '🏠 Prehľad'],
    ['/admin/kontakt', '☎️ Kontaktné údaje'],
    ['/admin/objednavky', '📦 Objednávky'],
    ['/admin/platobne-metody', '💳 Platby'],
    ['/admin/zakaznici', '👥 Zákazníci'],
    ['/admin/cennik', '🏷️ Cenník'],
    ['/admin/sekcie', '🧩 Sekcie'],
    ['/admin/kanaly-katalog', '📺 Kanály'],
    ['/admin/epg', '🗓 TV program'],
    ['/admin/udalosti', '🔥 Top udalosti'],
    ['/admin/zakaznici/nastavenia', '🤝 Affiliate'],
    ['/admin/platobne-metody/darcekove-karty', '🎁 Darčekové karty'],
    ['/admin/stranka', '🏠 Stránka'],
    ['/admin/2fa', '🔐 Bezpečnosť'],
  ];
  return `<nav class="adside" aria-label="Admin menu"><a class="adlogo" href="/admin"><span class="bl">▶</span> <b>TV Software</b></a><ul>${items.map(([h, l]) => `<li><a href="${h}">${l}</a></li>`).join('')}</ul><p class="adside-foot"><a href="/" target="_blank" rel="noopener">↗ Verejná stránka</a></p></nav>`;
}

function headerBar() {
  return `<header class="ah adtop"><button type="button" class="adburger" id="adBurger" aria-label="Menu">☰</button><span class="bl">▶</span><b>TV Software</b><label class="adsearch"><span class="visually-hidden">Hľadať v nastaveniach</span><input type="search" id="adSearch" placeholder="Hľadať v nastaveniach… (email, Telegram, EPG…)" autocomplete="off" enterkeyhint="search"></label><span class="at">Admin</span></header>
<div class="adhits" id="adHits" hidden></div>`;
}

function shell({ title, body, cls = 'a adm', desc = '', extra = '', cssV = '' }) {
  const login = /\blogin\b/.test(cls);
  const chrome = login ? `<header class="ah"><span class="bl">▶</span><b>TV Software</b><span class="at">Admin</span></header>`
    : `${sideNav()}${headerBar()}`;
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="description" content="${esc(desc || title)}"><meta property="og:title" content="${esc(title)}"><title>${esc(title)}</title><link rel="stylesheet" href="/static/s.css?v=${esc(cssV)}">${extra}${login ? '' : '<script src="/static/admdash.js" defer></script>'}</head><body class="adm${login ? ' login' : ' adapp'}">${chrome}<main class="w ${esc(cls)}">${body}</main></body></html>`;
}

function dashboard({ msg = '', slug = '', extras = '' }) {
  return `<h1>Prehľad</h1>${msg}
<p class="hint">Všetky nastavenia sú zoradené do skupín. Kontaktné údaje (e-mail, Telegram, Facebook…) nájdete v <a href="/admin/kontakt"><b>Kontaktné údaje</b></a>. Hľadať môžete aj v hornom poli.</p>
<p class="row">Verejná stránka: <a href="/${esc(slug)}" rel="noopener noreferrer" target="_blank">/${esc(slug)}</a></p>
${extras}
${tilesHtml()}`;
}

module.exports = { GROUPS, searchIndex, tilesHtml, sideNav, shell, dashboard, esc };
