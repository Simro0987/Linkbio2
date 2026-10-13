'use strict';
// Seed content for "Návody" (generic player setup guides). No streams, no provider names. Placeholders: "URL od nás".
// Store links verified 2026-10-13 (official stores / developer sites only).
const FT_SK = 'Fire TV: Nastavenia → Môj Fire TV → Možnosti pre vývojárov → Aplikácie z neznámych zdrojov → ZAP. Z Amazon Appstore nainštalujte aplikáciu „Downloader“ a do nej zadajte oficiálny odkaz/kód (pozri „Kde nainštalovať“).';
const FT_EN = 'Fire TV: Settings → My Fire TV → Developer options → Apps from unknown sources → ON. Install “Downloader” from the Amazon Appstore and enter the official link/code (see “Where to install”).';
const EPG_SK = 'EPG (TV program): ak ste dostali samostatnú „EPG URL od nás“, vložte ju v nastaveniach EPG a spustite aktualizáciu. Pri Xtream prihlásení sa EPG väčšinou načíta automaticky.';
const EPG_EN = 'EPG (TV guide): if you received a separate “EPG URL from us”, paste it in the EPG settings and run an update. With an Xtream login the EPG usually loads automatically.';
const DONE_SK = 'Hotovo – počkajte, kým sa načíta zoznam kanálov a program. Ak sa nič nenačíta, skontrolujte preklepy v URL, mene a hesle (veľké/malé písmená) a napíšte nám.';
const DONE_EN = 'Done – wait until the channel list and guide load. If nothing loads, check the URL, username and password for typos (case-sensitive) and contact us.';
const P = (name, url) => ({ name, url });
module.exports = [
  { slug: 'iptv-smarters-pro', key: 'smarters', title: 'IPTV Smarters Pro', intro: 'Prehrávač s prihlásením cez Xtream Codes alebo M3U playlist.', intro_en: 'Player with Xtream Codes login or M3U playlist.',
    platforms: [P('Android / Android TV / Google TV (oficiálny APK)', 'https://www.iptvsmarters.com/'), P('Fire TV (Downloader → oficiálny APK z iptvsmarters.com)', 'https://www.iptvsmarters.com/'), P('Windows', 'https://www.iptvsmarters.com/'), P('macOS', 'https://www.iptvsmarters.com/')],
    steps: [
      ['store', 'Inštalácia: aplikácia sa už nenachádza v Google Play. Stiahnite oficiálny APK zo stránky iptvsmarters.com (sekcia Downloads); na počítači Windows/macOS inštalátor z tej istej stránky.', 'Install: the app is no longer on Google Play. Download the official APK from iptvsmarters.com (Downloads section); for Windows/macOS use the installer from the same site.'],
      ['firetv', FT_SK, FT_EN],
      ['xtream', 'Otvorte aplikáciu → „Login with Xtream Codes API“. Názov: ľubovoľný. Používateľ a Heslo: údaje od nás. URL: „URL od nás“ (vrátane http:// a portu). Kliknite „Add user“.', 'Open the app → “Login with Xtream Codes API”. Name: anything. Username and Password: from us. URL: “URL from us” (including http:// and port). Click “Add user”.'],
      ['m3u', 'Alternatíva: „Load Your Playlist or File/URL“ → typ M3U URL → vložte „M3U URL od nás“.', 'Alternative: “Load Your Playlist or File/URL” → M3U URL → paste the “M3U URL from us”.'],
      ['epg', EPG_SK, EPG_EN], ['done', DONE_SK, DONE_EN]] },
  { slug: 'tivimate', key: 'tivimate', title: 'TiviMate', intro: 'Populárny prehrávač pre Android TV s prehľadným TV programom.', intro_en: 'Popular Android TV player with a clear TV guide.',
    platforms: [P('Android TV / Google TV (Google Play)', 'https://play.google.com/store/apps/details?id=ar.tvplayer.tv'), P('Fire TV (Downloader / oficiálny web)', 'https://tivimate.com/')],
    steps: [
      ['store', 'Na Android TV / Google TV otvorte Google Play, vyhľadajte „TiviMate IPTV Player“ a nainštalujte. TiviMate je určený pre TV (nie pre telefón).', 'On Android TV / Google TV open Google Play, search “TiviMate IPTV Player” and install. TiviMate is made for TVs (not phones).'],
      ['firetv', FT_SK, FT_EN],
      ['m3u', 'Spustite aplikáciu → „Pridať playlist / Add playlist“ → „Zadať URL / Enter URL“ → vložte „M3U URL od nás“ → Ďalej.', 'Start the app → “Add playlist” → “Enter URL” → paste the “M3U URL from us” → Next.'],
      ['xtream', 'Alebo zvoľte „Xtream Codes“: Server = „URL od nás“, Používateľ, Heslo → Ďalej → pomenujte playlist → Hotovo.', 'Or choose “Xtream Codes”: Server = “URL from us”, Username, Password → Next → name the playlist → Done.'],
      ['epg', 'EPG: Nastavenia → EPG → Pridať zdroj EPG → vložte „EPG URL od nás“ → Aktualizovať EPG.', 'EPG: Settings → EPG → Add EPG source → paste “EPG URL from us” → Update EPG.'], ['done', DONE_SK, DONE_EN]] },
  { slug: 'implayer', key: 'implayer', title: 'IMPlayer', intro: 'Prehrávač pre Android TV, iPhone/iPad/Apple TV aj Samsung/LG televízory.', intro_en: 'Player for Android TV, iPhone/iPad/Apple TV and Samsung/LG TVs.',
    platforms: [P('Android TV / Google TV (Google Play)', 'https://play.google.com/store/apps/details?id=com.myiptvonline.implayer'), P('Fire TV (Downloader kód 82375, oficiálny APK)', 'https://implayer.tv/'), P('iPhone / iPad / Apple TV (App Store)', 'https://apps.apple.com/app/id6695725513'), P('Samsung Tizen / LG webOS (obchod v TV, hľadajte „iMPlayer“)', 'https://implayer.tv/')],
    steps: [
      ['store', 'Android TV: Google Play → „iMPlayer“. iPhone/iPad/Apple TV: App Store → „iMPlayer IPTV Player“. Samsung/LG: obchod s aplikáciami v TV → „iMPlayer“.', 'Android TV: Google Play → “iMPlayer”. iPhone/iPad/Apple TV: App Store → “iMPlayer IPTV Player”. Samsung/LG: TV app store → “iMPlayer”.'],
      ['firetv', FT_SK + ' Oficiálny kód pre Downloader: 82375.', FT_EN + ' Official Downloader code: 82375.'],
      ['m3u', 'Otvorte aplikáciu → Pridať playlist → M3U → vložte „M3U URL od nás“. Na Samsung/LG sa playlist pridáva cez QR kód / kód zariadenia na webe implayer.tv.', 'Open the app → Add playlist → M3U → paste the “M3U URL from us”. On Samsung/LG add it via the QR code / device code on implayer.tv.'],
      ['xtream', 'Alebo Xtream Codes: Server = „URL od nás“, Používateľ, Heslo → Uložiť.', 'Or Xtream Codes: Server = “URL from us”, Username, Password → Save.'],
      ['epg', EPG_SK, EPG_EN], ['done', DONE_SK, DONE_EN]] },
  { slug: 'ott-navigator', key: 'ott', title: 'OTT Navigator', intro: 'Detailne nastaviteľný prehrávač pre Android. Pôvodná aplikácia sa distribuuje priamo z webu vývojára.', intro_en: 'Highly configurable Android player. The original app is distributed directly from the developer site.',
    platforms: [P('Android / Android TV / Google TV (oficiálny APK)', 'https://ottnav.github.io/faq.html'), P('Fire TV (Downloader kód 982469)', 'https://ottnav.github.io/faq.html')],
    steps: [
      ['store', 'Pozor: v Google Play existuje iná aplikácia s rovnakým názvom od iného vývojára. Pôvodný OTT Navigator stiahnite z oficiálnej stránky ottnav.github.io (priamy APK).', 'Note: Google Play has a different app with the same name from another developer. Get the original OTT Navigator from the official site ottnav.github.io (direct APK).'],
      ['firetv', FT_SK + ' Oficiálny kód pre Downloader: 982469.', FT_EN + ' Official Downloader code: 982469.'],
      ['xtream', 'Nastavenia → Poskytovateľ → Pridať poskytovateľa → „Xtream Codes“ → Server = „URL od nás“, Používateľ, Heslo.', 'Settings → Provider → Add provider → “Xtream Codes” → Server = “URL from us”, Username, Password.'],
      ['m3u', 'Alebo „Playlist / odkaz“ → vložte „M3U URL od nás“.', 'Or “Playlist / link” → paste the “M3U URL from us”.'],
      ['epg', 'Pri pridávaní poskytovateľa je pole pre EPG – vložte „EPG URL od nás“ (alebo neskôr Nastavenia → Poskytovateľ → EPG).', 'When adding the provider there is an EPG field – paste the “EPG URL from us” (or later Settings → Provider → EPG).'], ['done', DONE_SK, DONE_EN]] },
  { slug: 'vlc', key: 'vlc', title: 'VLC', intro: 'Univerzálny bezplatný prehrávač – na rýchle otvorenie M3U playlistu (bez TV programu).', intro_en: 'Universal free player – quick way to open an M3U playlist (no TV guide).',
    platforms: [P('Android / Android TV (Google Play)', 'https://play.google.com/store/apps/details?id=org.videolan.vlc'), P('iPhone / iPad / Apple TV (App Store)', 'https://apps.apple.com/app/id650377962'), P('Windows / macOS / Linux', 'https://www.videolan.org/vlc/'), P('Fire TV (Amazon Appstore / videolan.org)', 'https://www.videolan.org/vlc/')],
    steps: [
      ['store', 'Nainštalujte VLC z Google Play, App Store alebo z oficiálnej stránky videolan.org (Windows/macOS/Linux).', 'Install VLC from Google Play, the App Store or the official site videolan.org (Windows/macOS/Linux).'],
      ['vlc', 'Počítač: Médiá → Otvoriť sieťový stream → vložte „M3U URL od nás“ → Prehrať. Android/iOS: Viac → Nový stream → vložte URL.', 'Computer: Media → Open Network Stream → paste the “M3U URL from us” → Play. Android/iOS: More → New stream → paste the URL.'],
      ['done', 'Kanály sa zobrazia v zozname skladieb (Zobraziť → Zoznam skladieb). VLC nepodporuje Xtream prihlásenie ani EPG – na TV odporúčame iný prehrávač z tohto zoznamu.', 'Channels appear in the playlist (View → Playlist). VLC does not support Xtream login or EPG – for TV use another player from this list.']] },
  { slug: 'kodi', key: 'kodi', title: 'Kodi (PVR IPTV Simple Client)', intro: 'Bezplatné multimediálne centrum; IPTV cez oficiálny doplnok PVR IPTV Simple Client.', intro_en: 'Free media center; IPTV via the official PVR IPTV Simple Client add-on.',
    platforms: [P('Android / Android TV / Google TV (Google Play)', 'https://play.google.com/store/apps/details?id=org.xbmc.kodi'), P('Windows / macOS / Linux / Fire TV (oficiálne kodi.tv)', 'https://kodi.tv/download/')],
    steps: [
      ['store', 'Nainštalujte Kodi z Google Play alebo z oficiálnej stránky kodi.tv/download (Windows, macOS, Linux; Fire TV cez Downloader a odkaz z kodi.tv).', 'Install Kodi from Google Play or the official site kodi.tv/download (Windows, macOS, Linux; Fire TV via Downloader and the link from kodi.tv).'],
      ['kodi', 'Doplnky → Moje doplnky → PVR klienti → PVR IPTV Simple Client → Nainštalovať/Konfigurovať. Všeobecné: Umiestnenie = Vzdialená cesta (Internet), M3U playlist URL = „M3U URL od nás“.', 'Add-ons → My add-ons → PVR clients → PVR IPTV Simple Client → Install/Configure. General: Location = Remote path (Internet), M3U playlist URL = “M3U URL from us”.'],
      ['epg', 'Záložka EPG: Umiestnenie = Vzdialená cesta, XMLTV URL = „EPG URL od nás“ → OK → Povoliť doplnok → reštartujte Kodi.', 'EPG tab: Location = Remote path, XMLTV URL = “EPG URL from us” → OK → Enable the add-on → restart Kodi.'],
      ['done', 'Kanály nájdete v hlavnom menu → TV. ' + DONE_SK, 'Channels are in the main menu → TV. ' + DONE_EN]] },
];
// player × platform comparison (verified support)
module.exports.MATRIX = { cols: ['Android', 'Android TV / Google TV', 'Fire TV', 'iOS / iPadOS', 'Apple TV', 'Windows / macOS', 'Samsung / LG'],
  rows: { smarters: [1, 1, 1, 0, 0, 1, 0], tivimate: [0, 1, 1, 0, 0, 0, 0], implayer: [1, 1, 1, 1, 1, 0, 1], ott: [1, 1, 1, 0, 0, 0, 0], vlc: [1, 1, 1, 1, 1, 1, 0], kodi: [1, 1, 1, 0, 0, 1, 0] } };
