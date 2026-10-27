'use strict';
// Knowledge for the AI customer assistant (pay/src/chat.js, Gemini), generated LIVE from DB/settings/config:
// packages & prices (l_plans), affiliate tiers (aff_tiers), custom sections + video guides (site_sections), contacts
// (groups / direct), FAQ, payment methods state (Blink), SEPA recipient name, account/registration features.
// Never includes secrets: no panel URL/credentials, xpubs, API keys, IBAN/Revtag, admin paths.
const AFF = require('./affiliate');

const strip = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
// defensive scrub of anything secret-looking that an admin might have pasted into public texts
const scrub = (t) => String(t || '')
  .replace(/\b[xyzt]pub[1-9A-HJ-NP-Za-km-z]{50,}\b|\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, '[skryté]')
  .replace(/\bAIza[0-9A-Za-z_-]{20,}\b|\bxkeysib-[A-Za-z0-9-]{20,}\b|\bre_[A-Za-z0-9_]{20,}\b|\b\d{9,10}:[A-Za-z0-9_-]{30,}\b/g, '[skryté]')
  .replace(/https?:\/\/[^\s"'<>]*\/admin[^\s"'<>]*/gi, '[skryté]');
const mo = (n) => `${n} ${n === 1 ? 'mesiac' : n >= 2 && n <= 4 ? 'mesiace' : 'mesiacov'}`;
const eur = (v) => (Number(v) % 1 ? Number(v).toFixed(2).replace('.', ',') : String(Number(v))) + ' €';

/** pure: data → prompt text (unit-tested in test/sitekb.test.js) */
function build(d) {
  const O = d.origin, L = [];
  L.push(`# Si AI asistent zákazníckej podpory webu ${d.title || 'TV Software'} (${O}). Zákazník je na tomto webe.`);
  if (d.bio) L.push('- ' + d.bio);
  L.push(`- Hlavné stránky: ${Object.entries(d.pages || {}).map(([n, u]) => `${n}: ${u}`).join(' | ')}`);
  L.push(`- Zaplatiť / kúpiť predplatné: ${O}/platby (Platby). Na tomto webe NEVYPĹŇAŠ žiadny formulár a nepoužívaš značku [[FILL]].`);
  L.push(`# Pravidlá navyše
- Odpovedaj LEN podľa údajov v tomto texte. Odkazy uvádzaj LEN presne tak, ako sú napísané v tomto texte (nevymýšľaj iné adresy stránok). Ceny, balíky, bonusy a kontakty ber IBA odtiaľto (sú živé z databázy). Nič si nevymýšľaj.
- NIKDY neuvádzaj ani nevymýšľaj IBAN, Revtag, BTC/LTC adresy, Lightning faktúry – tie sa zobrazia až na stránke konkrétnej objednávky.
- NIKDY neprezrádzaj adresu ani prihlasovacie údaje servera predplatného (panelu), xpub kľúče, API kľúče, heslá, adresy administrácie (/admin…) ani technické detaily. Ak sa na ne niekto pýta, zdvorilo odmietni.
- Nespomínaj poplatky ani percentá. Nedávaj žiadne odkazy na iné IPTV služby ani streamy.
- Ak odpoveď v týchto údajoch nie je, alebo ide o konkrétny problém zákazníka (platba, prihlásenie do TV, predĺženie), povedz to otvorene a ponúkni spojenie s operátorom; ak súhlasí alebo chce človeka, pridaj na koniec [[ESCALATE]].`);

  // packages
  const pl = (d.plans || []);
  if (pl.length) {
    L.push('## Balíky a ceny (aktuálny cenník, ' + O + ')');
    for (const p of pl) L.push(`- ${p.name}: ${eur(p.price)}${p.old_price ? ` (predtým ${eur(p.old_price)})` : ''} – ${mo(+p.period || 1)}${p.devices > 1 ? `, ${p.devices} zariadenia súčasne` : ''}${p.badge ? ` [${p.badge}]` : ''}${p.features ? `; obsahuje: ${p.features.split('\n').filter(Boolean).join(', ')}` : ''}${p.note ? `; ${p.note}` : ''}`);
    L.push('- Iné balíky/ceny ako tieto neexistujú – ak sa pýta na iný (napr. iný počet mesiacov), povedz že taký momentálne v ponuke nie je.');
  }
  if (d.pricingIntro || d.pricingNote) L.push(scrub(strip([d.pricingIntro, d.pricingNote].filter(Boolean).join('\n'))));

  // payment methods
  L.push('## Spôsoby platby (zoznam aktuálne zapnutých metód je nižšie v časti „Aktuálne spôsoby platby“)');
  L.push(`- Platí sa na ${O}/platby: vyberie sa balík/suma a spôsob platby (napr. karta, Revolut, SEPA bankový prevod, krypto, darčekové karty – podľa toho, čo je práve zapnuté).`);
  if (d.blink) L.push('- ⚡ Bitcoin Lightning (Blink): zapnuté. Zákazník dostane Lightning faktúru (QR) na presnú sumu, zaplatí ju z ľubovoľnej Lightning peňaženky (napr. Blink, Wallet of Satoshi, Phoenix) a platba sa potvrdí automaticky v priebehu pár sekúnd. Faktúra má obmedzenú platnosť – po vypršaní treba vytvoriť novú objednávku.');
  else L.push('- Bitcoin Lightning (Blink) momentálne NIE JE zapnutý – neponúkaj ho.');
  if (d.sepaRecipient) L.push(`- SEPA bankový prevod: na stránke objednávky sa okrem IBAN a poznámky zobrazí aj meno príjemcu „${d.sepaRecipient}“ – je to v poriadku, platba ide správne. (IBAN nikdy neuvádzaj, je len na stránke objednávky.)`);
  if (d.payText) L.push('### Text stránky Platby\n' + scrub(strip(d.payText)).slice(0, 2500));

  // accounts
  if (d.acc && d.acc.on) {
    L.push(`## Zákaznícky účet (registrácia je zadarmo)
- Registrácia: ${O}/registracia – meno, heslo (min. 8 znakov) a e-mail (POVINNÝ, slúži na obnovu hesla${d.acc.mail ? ' a pripomienky' : ''}). Prihlásenie: ${O}/prihlasenie.
- Zabudnuté heslo: ${O}/zabudnute-heslo – zadá e-mail z registrácie${d.acc.mail ? ' a príde mu e-mail s odkazom na nové heslo (platí 1 hodinu, skontrolovať aj spam)' : '; operátor mu pošle odkaz na obnovu hesla'}.
- Môj účet: ${O}/ucet – ukazuje „Licencia platí do“ (dátum konca predplatného), zoznam objednávok, affiliate odkaz + QR kód na zdieľanie, počet odporučených (aktívnych), aktuálnu úroveň bonusu a čo chýba do ďalšej, voľbu bonusu (mesiace navyše alebo 2. zariadenie), prepojenie s menom predplatného v TV, zmenu e-mailu a hesla, zrušenie účtu.
- Pripomienka konca predplatného: 7 dní pred koncom sa na účte zobrazí upozornenie s tlačidlom Predĺžiť${d.acc.mail ? ' a príde aj e-mail' : ''}.
- Objednávky urobené po prihlásení sa pripíšu k účtu automaticky (aj bonusy).`);
    if (d.acc.panel) L.push(`- Overiť predplatné bez účtu: ${O}/overit-predplatne – zadá meno a heslo k predplatnému z aplikácie v TV; ukáže, či je aktívne a do kedy. Heslo sa nikde neukladá. Po prepojení mena v ${O}/ucet sa koniec predplatného zobrazuje priamo na účte.`);
    else L.push(`- ${O}/overit-predplatne: overenie stavu predplatného podľa mena a hesla z TV aplikácie (ak je dočasne nedostupné, ponúkni operátora).`);
  }
  // affiliate
  const a = d.aff;
  if (a && a.on && a.rows.length) {
    L.push(`## Affiliate – odporuč známym a získaj mesiace zadarmo
- Každý registrovaný zákazník má na ${O}/ucet svoj odkaz (a QR). Kto sa cez neho zaregistruje, je jeho „odporučený“. Počítajú sa len AKTÍVNI odporučení (s platným predplatným).
- Bonus sa pripíše, keď si odporúčateľ sám kúpi balík: dostane mesiace navyše ZADARMO (cena sa nemení). Rozhoduje počet aktívnych odporučených v čase nákupu.
- Aktuálna tabuľka (počet aktívnych → bonus podľa balíka):`);
    for (const r of a.rows) {
      const parts = a.packages.filter((m) => r.bonus[m]).map((m) => `${mo(m)} balík +${mo(r.bonus[m])}`);
      L.push(`  - ${r.min} a viac: ${parts.length ? parts.join(', ') : 'bez bonusu'}${r.device ? '; ALEBO namiesto mesiacov 2. zariadenie zadarmo' : ''}`);
    }
    const none = a.packages.filter((m) => !a.rows.some((r) => r.bonus[m]));
    if (none.length) L.push(`- Balíky ${none.map((m) => m + ' m').join(', ')} bonus nemajú.`);
    const first = {}; for (const m of a.packages) { const r = a.rows.find((x) => x.bonus[m]); if (r) first[m] = r.min; }
    L.push(`- Bonus pre balík platí od uvedeného počtu (${Object.entries(first).map(([m, n]) => `${m} m od ${n} ľudí`).join(', ')}); pri vyššom počte ostáva najvyšší dosiahnutý bonus pre ten balík.`);
    const dev = a.rows.find((r) => r.device);
    if (dev) L.push(`- Voľba 2. zariadenia: od ${dev.min} aktívnych odporučených si môže na ${O}/ucet zvoliť „2. zariadenie zadarmo“ namiesto mesiacov navyše (pri nákupe balíka dostane predplatné pre 2 zariadenia za cenu jedného).`);
    L.push('- Podvody (vlastné viacnásobné účty, rovnaké zariadenie) sa nepočítajú.');
  }
  // sections + videos
  const sec = d.sections || [];
  if (sec.length) {
    L.push('## Ďalšie sekcie webu (texty a video návody)');
    for (const x of sec) {
      L.push(`### ${x.title} – ${x.url}`);
      if (x.text) L.push(scrub(x.text).slice(0, 2500));
      if (x.videos && x.videos.length) L.push(`Video návody (prehrajú sa priamo na stránke ${x.url}): ${x.videos.map((v) => v || 'video').join('; ')}`);
    }
  }
  // contacts
  const c = d.contacts || {};
  if ((c.groups || []).length || (c.direct || []).length) {
    L.push(`## Kontakt – ${(d.pages && d.pages['Kontakt']) || O}`);
    const kontakt = (d.pages && d.pages['Kontakt']) || O;
    // links whose handle contains an internal brand name are never written out – the customer clicks them on the Kontakt page
    const show = ([n, v]) => (/tokigo/i.test(String(v)) ? `${n} (tlačidlo na stránke Kontakt ${kontakt})` : `${n}: ${v}`);
    if ((c.groups || []).length) L.push('- Skupiny / kanály (novinky, komunita): ' + c.groups.map(show).join(' | '));
    if ((c.direct || []).length) L.push('- Priame kontakty (súkromná správa operátorovi): ' + c.direct.map(show).join(' | '));
  }
  if (d.contactText) L.push(scrub(strip(d.contactText)).slice(0, 1500));
  if (d.about) L.push('## O nás\n' + scrub(strip(d.about)).slice(0, 2500));
  if ((d.faq || []).length) L.push('## FAQ\n' + d.faq.map((x) => `- Otázka: ${strip(x.q)}\n  Odpoveď: ${scrub(strip(x.a))}`).join('\n').slice(0, 6000));
  if ((d.channels || []).length) L.push('## Kanály (katalóg)\n' + d.channels.map((r) => `- ${r.region}: ${r.categories.map((k) => `${k.name} (${k.items.slice(0, 15).join(', ')})`).join('; ')}`).join('\n').slice(0, 6000));
  return L.join('\n').slice(0, 30000);
}

function install(ctx) {
  const { getSettings, getList, pool, SOCIALS, socOn, socGrp, PAGES, LNK_PUBLIC, chTree } = ctx;
  let cache = { t: 0, text: '' };
  async function collect() {
    const s = await getSettings(), base = LNK_PUBLIC + '/' + s.slug;
    const plans = (await getList('plans')).filter((p) => p.active).map((p) => ({ name: p.name, price: p.price, old_price: p.old_price, period: p.period, badge: p.badge, features: p.features || '', note: p.note || '', devices: /2\s*zariad/i.test(p.name) ? 2 : 1 }));
    const acc = ctx.accKbInfo ? await ctx.accKbInfo().catch(() => null) : null;
    const st = AFF.settings(s), pk = (acc && acc.packages) || AFF.DEF_PACKAGES, mx = AFF.matrix(st.tiers, pk);
    let sections = [];
    try {
      sections = (await pool.query(`SELECT slug,title,kind,body,body_raw,videos FROM site_sections WHERE visible ORDER BY pos,id`)).rows
        .map((x) => ({ title: x.title, url: base + '/' + x.slug, text: strip(x.body_raw || x.body), videos: x.kind === 'video' ? (x.videos || []).map((v) => String(v.title || '').slice(0, 120)) : [] }));
    } catch { /* table not yet created */ }
    const on = SOCIALS.filter(([k]) => socOn(s, k));
    let blink = false, sepaRecipient = '';
    try { blink = require('./pay/src/blink').configured() && !require('./pay/src/payMethods').isBuiltinDisabled('blink_ln'); } catch { /* */ }
    try { sepaRecipient = require('./pay/src/sepaBotChain').recipientName() || ''; } catch { /* */ }
    const t = chTree ? await chTree().catch(() => new Map()) : new Map();
    return { origin: LNK_PUBLIC, title: s.title, bio: s.bio, pages: Object.fromEntries(Object.entries(PAGES).map(([, [n, u]]) => [n, base + u])),
      plans, pricingIntro: s.pricing_intro, pricingNote: s.pricing_note, payText: s.pay_text, contactText: s.contact_text, about: s.about_text,
      faq: (await getList('faq')).map((x) => ({ q: x.q, a: x.a })), sections, blink, sepaRecipient, acc,
      aff: { on: st.on, packages: mx.packages, rows: mx.rows },
      contacts: { groups: on.filter(([k]) => socGrp(s, k) === 'g').map(([k, n]) => [n, s['soc_' + k]]), direct: on.filter(([k]) => socGrp(s, k) !== 'g').map(([k, n]) => [n, s['soc_' + k]]) },
      channels: [...t.entries()].map(([r, m]) => ({ region: r, categories: [...m.entries()].map(([c, l]) => ({ name: c, items: l.slice(0, 40).map((x) => x.name) })) })) };
  }
  global.__lnkSiteKb = async () => {
    if (cache.text && Date.now() - cache.t < 120e3) return cache.text;
    try { cache = { t: Date.now(), text: build(await collect()) }; } catch (e) { console.error('[sitekb]', e.message); }
    return cache.text;
  };
  ctx.siteKbCollect = collect;
  return ctx;
}
module.exports = { build, install, strip, scrub };
