'use strict';
// Generates own lightweight illustrative TV-style mockups (SVG) for the Návody steps. No third-party screenshots.
const fs = require('fs'); const path = require('path');
const X = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const W = 640, H = 360;
function frame(app, sub, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,Segoe UI,Roboto,sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d1226"/><stop offset="1" stop-color="#1a1036"/></linearGradient>
<marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#ffcc00"/></marker></defs>
<rect width="${W}" height="${H}" rx="14" fill="#05060c"/><rect x="10" y="10" width="${W - 20}" height="${H - 40}" rx="8" fill="url(#g)"/>
<rect x="270" y="${H - 26}" width="100" height="10" rx="3" fill="#222"/>
<rect x="10" y="10" width="${W - 20}" height="34" rx="8" fill="#141a2e"/><text x="26" y="33" fill="#7aa2ff" font-size="15" font-weight="700">▶ ${X(app)}</text><text x="${W - 26}" y="33" fill="#9aa3c7" font-size="12" text-anchor="end">${X(sub)}</text>
${inner}</svg>`;
}
const field = (x, y, w, label, val, hl) => `<text x="${x}" y="${y - 6}" fill="#c9d1f0" font-size="12">${X(label)}</text><rect x="${x}" y="${y}" width="${w}" height="28" rx="5" fill="#0b0f1f" stroke="${hl ? '#ffcc00' : '#3a4470'}" stroke-width="${hl ? 2.5 : 1}"/><text x="${x + 10}" y="${y + 19}" fill="${val.startsWith('•') ? '#e6e9f5' : '#8b93b8'}" font-size="13">${X(val)}</text>`;
const btn = (x, y, w, t, hl) => `<rect x="${x}" y="${y}" width="${w}" height="30" rx="6" fill="${hl ? '#2f6bff' : '#232b4a'}" stroke="${hl ? '#ffcc00' : 'none'}" stroke-width="2.5"/><text x="${x + w / 2}" y="${y + 20}" fill="#fff" font-size="13" font-weight="600" text-anchor="middle">${X(t)}</text>`;
const arrow = (x1, y1, x2, y2, t) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffcc00" stroke-width="3" marker-end="url(#a)"/>${t ? `<text x="${x1}" y="${y1 + (y1 > y2 ? 18 : -8)}" fill="#ffcc00" font-size="13" font-weight="700" text-anchor="middle">${X(t)}</text>` : ''}`;
const K = {
  store: (app) => frame('Google Play / App Store / Amazon Appstore', 'Inštalácia · Install', `<rect x="40" y="62" width="560" height="34" rx="17" fill="#0b0f1f" stroke="#ffcc00" stroke-width="2.5"/><text x="60" y="84" fill="#e6e9f5" font-size="14">🔍 ${X(app)}</text>
<rect x="40" y="116" width="90" height="90" rx="18" fill="#2f6bff"/><text x="85" y="170" fill="#fff" font-size="34" text-anchor="middle">▶</text><text x="150" y="146" fill="#fff" font-size="18" font-weight="700">${X(app)}</text><text x="150" y="170" fill="#9aa3c7" font-size="12">Oficiálny vydavateľ · Official publisher</text>
${btn(150, 186, 170, 'Inštalovať · Install', true)}${arrow(420, 260, 330, 205, '1× klik / click')}<text x="40" y="300" fill="#9aa3c7" font-size="12">Android TV · Google TV · Fire TV · telefón / phone</text>`),
  firetv: () => frame('Fire TV', 'Nastavenia · Settings', `${['Môj Fire TV · My Fire TV', 'Možnosti pre vývojárov · Developer options', 'Aplikácie z neznámych zdrojov · Apps from unknown sources: ZAP / ON'].map((t, i) => `<rect x="${60 + i * 30}" y="${70 + i * 62}" width="${500 - i * 30}" height="40" rx="6" fill="${i === 2 ? '#2f6bff' : '#232b4a'}" stroke="${i === 2 ? '#ffcc00' : 'none'}" stroke-width="2.5"/><text x="${76 + i * 30}" y="${96 + i * 62}" fill="#fff" font-size="14">${X(t)}</text>`).join('')}
${arrow(120, 120, 120, 132)}${arrow(150, 182, 150, 194)}<text x="60" y="290" fill="#9aa3c7" font-size="12">Potom: aplikácia Downloader → zadajte „URL od nás“ · Then: Downloader app → enter “URL from us”</text>`),
  xtream: (app) => frame(app, 'Xtream Codes API', `${field(40, 80, 270, 'Názov · Name', 'Moja TV / My TV')}${field(330, 80, 270, 'Server URL', 'URL od nás · URL from us', true)}
${field(40, 150, 270, 'Používateľ · Username', 'meno od nás · from us', true)}${field(330, 150, 270, 'Heslo · Password', '••••••••', true)}${btn(40, 215, 200, 'Pridať · Add user', true)}${arrow(380, 270, 245, 232, 'Uložiť / Save')}`),
  m3u: (app) => frame(app, 'Playlist (M3U)', `${field(40, 80, 560, 'Názov playlistu · Playlist name', 'Moja TV / My TV')}${field(40, 150, 560, 'M3U URL', 'URL od nás · URL from us (http://…)', true)}${btn(40, 215, 200, 'Ďalej · Next', true)}${arrow(380, 275, 245, 232, 'Potvrdiť / Confirm')}`),
  epg: (app) => frame(app, 'EPG / TV program', `<text x="40" y="78" fill="#c9d1f0" font-size="13">Nastavenia → EPG → Pridať zdroj · Settings → EPG → Add source</text>${field(40, 110, 560, 'EPG URL (XMLTV)', 'EPG URL od nás · from us', true)}${btn(40, 175, 200, 'Uložiť · Save', true)}${arrow(380, 240, 245, 192, 'Aktualizovať / Update EPG')}`),
  done: (app) => frame(app, 'Hotovo · Done', `${['Spravodajstvo · News', 'Šport · Sport', 'Filmy · Movies', 'Deti · Kids'].map((t, i) => `<rect x="40" y="${62 + i * 46}" width="200" height="38" rx="6" fill="${i === 0 ? '#2f6bff' : '#232b4a'}"/><text x="54" y="${86 + i * 46}" fill="#fff" font-size="13">${X(t)}</text>`).join('')}
${[0, 1, 2, 3].map((i) => `<rect x="260" y="${62 + i * 46}" width="340" height="38" rx="6" fill="#141a2e"/><text x="274" y="${86 + i * 46}" fill="#c9d1f0" font-size="13">${i + 1}  Kanál · Channel ${i + 1}</text><rect x="470" y="${76 + i * 46}" width="${40 + i * 20}" height="8" rx="4" fill="#3ddc84"/>`).join('')}<text x="40" y="300" fill="#3ddc84" font-size="13" font-weight="700">✅ Zoznam kanálov + EPG načítané · Channel list + EPG loaded</text>`),
  vlc: () => frame('VLC', 'Médiá → Otvoriť sieťový stream · Media → Open Network Stream', `${field(40, 100, 560, 'Sieťová URL · Network URL', 'M3U URL od nás · from us', true)}${btn(400, 160, 200, 'Prehrať · Play', true)}${arrow(260, 240, 395, 178, 'Spustiť / Play')}<text x="40" y="290" fill="#9aa3c7" font-size="12">Android: Viac / More → Nový stream / New stream</text>`),
  kodi: () => frame('Kodi', 'Doplnky → Moje doplnky → PVR klienti · Add-ons → My add-ons → PVR clients', `${['PVR IPTV Simple Client', 'Konfigurovať · Configure', 'Povoliť · Enable'].map((t, i) => btn(40, 70 + i * 50, 260, t, i === 0)).join('')}
${field(330, 90, 270, 'M3U playlist URL', 'URL od nás · from us', true)}${field(330, 160, 270, 'XMLTV (EPG) URL', 'EPG URL od nás', true)}${arrow(305, 85, 325, 100)}<text x="40" y="290" fill="#9aa3c7" font-size="12">Umiestnenie · Location: Vzdialená cesta · Remote path (Internet)</text>`),
};
const out = path.join(__dirname, '..', 'static', 'guide');
const apps = { smarters: 'IPTV Smarters Pro', tivimate: 'TiviMate', implayer: 'IMPlayer', ott: 'OTT Navigator', vlc: 'VLC', kodi: 'Kodi' };
const plan = { smarters: ['store', 'firetv', 'xtream', 'm3u', 'epg', 'done'], tivimate: ['store', 'firetv', 'm3u', 'xtream', 'epg', 'done'], implayer: ['store', 'firetv', 'm3u', 'xtream', 'epg', 'done'], ott: ['store', 'firetv', 'xtream', 'm3u', 'epg', 'done'], vlc: ['store', 'vlc', 'done'], kodi: ['store', 'kodi', 'epg', 'done'] };
for (const [k, kinds] of Object.entries(plan)) for (const kind of kinds) fs.writeFileSync(path.join(out, `${k}-${kind}.svg`), K[kind](apps[k]).replace(/\n/g, ''));
console.log('ok');
