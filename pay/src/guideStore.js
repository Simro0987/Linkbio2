'use strict';
/**
 * Payment guides (SK + EN, one image per step) — defaults in code, every text and image editable in /admin/platby/guides.
 * Images: only real screenshots of public pages (cropped / red-box annotated) or of our own checkout pages.
 * Steps behind a login / captcha have no default image; they carry a `slot` text telling the admin which
 * screenshot to upload. Customers never see empty slots (text only).
 * Storage: Neon (guide_overrides, guide_images) with a local file fallback — no box / no external runtime deps.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const orderDb = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'guide-overrides.json');
const IMG_DIR = path.join(DATA_DIR, 'guide-img');
const V = '?v=20261109a';
const R = (n) => `/guide-img/real/${n}.jpg${V}`;
const MAX_IMG = 3 * 1024 * 1024;

const S = (sk, en, img = '', imgPc = '', slot = '') => ({ sk, en, img: img || '', imgPc: imgPc || '', slot: slot || '' });
const back = () => S('Vráťte sa na túto stránku – platbu uvidíme automaticky a stav sa sám aktualizuje.',
  'Come back to this page – we detect the payment automatically and the status updates by itself.');

function changellySteps(sepa) {
  const p = sepa ? 'chg-sepa' : 'chg-card';
  return [
    S('Na tejto stránke stlačte „📋 Kopírovať adresu“. Adresa platí len pre túto objednávku.',
      'On this page tap “📋 Copy address”. The address is for this order only.', R(sepa ? 'our-chg-sepa-copy-m' : 'our-chg-copy-m'), R(sepa ? 'our-chg-sepa-copy-d' : 'our-chg-copy-d')),
    S('Stlačte „Pokračovať na Changelly →“. Na mobile sa objaví okno „Go mobile for even better rates!“ – stlačte „Stay in browser“ (cookies: „Ok“).',
      'Tap “Continue to Changelly →”. On mobile a “Go mobile for even better rates!” window appears – tap “Stay in browser” (cookies: “Ok”).', R(p + '-01-popup-m')),
    S('„You send“ a „You get“ sú už vyplnené ({amt} EUR → {coin}) – nemeňte ich. Stlačte „View All Offers“.',
      '“You send” and “You get” are already filled in ({amt} EUR → {coin}) – don’t change them. Tap “View All Offers”.', R(p + '-02-pair-m'), R(p + '-02-pair-d')),
    sepa
      ? S('Hore zvoľte filter „SEPA“ a vyberte prvú ponuku v zozname (napr. Topper).',
        'At the top choose the “SEPA” filter and pick the first offer in the list (e.g. Topper).', R(p + '-03-offers-m'), R(p + '-03-offers-d'))
      : S('Hore zvoľte filter „Visa / Mastercard“ a vyberte prvú ponuku (označenú „OPTIMAL“).',
        'At the top choose the “Visa / Mastercard” filter and pick the first offer (marked “OPTIMAL”).', R(p + '-03-offers-m'), R(p + '-03-offers-d')),
    S('Stlačte zelené tlačidlo „Next step“.', 'Tap the green “Next step” button.', R(p + '-04-next-m'), R(p + '-04-next-d')),
    S('Do poľa „Destination address ({coin})“ vložte skopírovanú adresu (podržať → Vložiť). Zaškrtnite „I’m not a robot“ a stlačte „Next step“.',
      'Paste the copied address into “Destination address ({coin})” (long-press → Paste). Tick “I’m not a robot” and tap “Next step”.', R(p + '-05-address-m'), R(p + '-05-address-d')),
    sepa
      ? S('Poskytovateľ (napr. Topper) si vypýta e-mail a pri prvej platbe overenie totožnosti. Potom zobrazí bankové údaje (IBAN + referencia) – pošlite presne túto sumu so správnou referenciou zo svojej banky.',
        'The provider (e.g. Topper) asks for your e-mail and, the first time, an ID check. Then it shows bank details (IBAN + reference) – send exactly this amount with that reference from your bank.', '', '',
        'Stránka poskytovateľa po „Next step“ (Topper/Moonpay): bankové údaje IBAN + referencia pre SEPA prevod')
      : S('Na stránke poskytovateľa (napr. Topper) zadajte e-mail, pri prvej platbe overenie totožnosti, a zaplaťte kartou / Apple Pay / Google Pay.',
        'On the provider page (e.g. Topper) enter your e-mail, the first time an ID check, and pay by card / Apple Pay / Google Pay.', '', '',
        'Stránka poskytovateľa po „Next step“ (Topper/Paybis): e-mail + platba kartou'),
    back(),
  ];
}

const DEFAULTS = {
  revolut_ramp: { title: 'Revolut (Revolut Ramp)', steps: [
    S('Na tejto stránke stlačte „📋 Kopírovať adresu“. Adresa platí len pre túto objednávku.',
      'On this page tap “📋 Copy address”. The address is for this order only.', R('our-ramp-copy-m'), R('our-ramp-copy-d')),
    S('Stlačte „Pokračovať do Revolut →“. Suma a mena sú už vyplnené ({amt} €, {coin}) – nemeňte ich. Ťuknite na „To – Select address“.',
      'Tap “Continue to Revolut →”. Amount and coin are already filled in ({amt} €, {coin}) – don’t change them. Tap “To – Select address”.', R('ramp-01-start-m'), R('ramp-01-start-d')),
    S('Prihláste sa do Revolutu: zadajte telefónne číslo → „Continue“ (alebo „Continue with email“) a potvrďte kódom alebo v appke Revolut.',
      'Log in to Revolut: enter your phone number → “Continue” (or “Continue with email”) and confirm with the code or in the Revolut app.', R('ramp-02-login-m'), R('ramp-02-login-d')),
    S('Kúpte kryptomenu (napr. {coin}) – vyberte tú, ktorú ste zvolili pri platbe. Sumu nemeňte. Potom ťuknite na „To – Select address“.',
      'Buy the cryptocurrency (e.g. {coin}) – pick the one you chose at payment. Don’t change the amount. Then tap “To – Select address”.',
      R('ramp-buy-crypto-m')),
    S('Vložte adresu, ktorá je na našej stránke zobrazená pri zvolenej kryptomene (podržať → Vložiť). Ak vidíte „No addresses“, ťuknite na „Add wallet address“.',
      'Paste the address shown on our page for the chosen crypto (long-press → Paste). If you see “No addresses”, tap “Add wallet address”.',
      R('ramp-select-address-m')),
    S('V „Wallet details“ zvoľte „My address“, vložte tú istú adresu peňaženky, vyberte typ Wallet / exchange, doplňte Label a ťuknite „Save“.',
      'In “Wallet details” choose “My address”, paste the same wallet address, pick Wallet / exchange, add a Label and tap “Save”.',
      R('ramp-wallet-details-m')),
    S('Vráťte sa na nákup a stlačte „Buy {coin} with EUR“. Sumu nemeňte.', 'Go back to the buy screen and tap “Buy {coin} with EUR”. Don’t change the amount.', R('ramp-05-buy-m'), R('ramp-05-buy-d')),
    S('Potvrďte platbu v appke Revolut.', 'Confirm the payment in the Revolut app.', '', '',
      'Revolut: potvrdenie platby (súhrn / potvrdenie v appke)'),
    back(),
  ] },
  changelly_card: { title: 'Karta cez Changelly', steps: changellySteps(false) },
  changelly_sepa: { title: 'SEPA cez Changelly', steps: changellySteps(true) },
  revolut_manual: { title: 'Revolut (Revtag)', steps: [
    S('Počkajte pár minút, kým sa zobrazí Revtag príjemcu – stránku nechajte otvorenú, obnovuje sa sama.',
      'Wait a few minutes until the recipient Revtag appears – keep the page open, it refreshes by itself.'),
    S('Stlačte „📋 Kopírovať Revtag“ alebo rovno „Otvoriť v Revolut“.', 'Tap “📋 Copy Revtag” or directly “Open in Revolut”.', R('our-revtag-m'), R('our-revtag-d')),
    S('V appke Revolut: Platby (Payments) → Nová platba → vyhľadajte Revtag.', 'In the Revolut app: Payments → New → search for the Revtag.', '', '',
      'Revolut appka: Payments → New → vyhľadanie @revtag'),
    S('Zadajte presne sumu objednávky ({amt} €) a platbu odošlite.', 'Enter exactly the order amount ({amt} €) and send the payment.', '', '',
      'Revolut appka: zadaná suma a tlačidlo Send / Odoslať'),
    S('Vráťte sa sem a stlačte „Zaplatil som“.', 'Come back here and tap “Zaplatil som” (I have paid).'),
  ] },
  btcpay: { title: 'Krypto (BTC / Lightning)', steps: [
    S('Na faktúre BTCPay zvoľte „Bitcoin“ (on-chain) alebo „Lightning“.', 'On the BTCPay invoice choose “Bitcoin” (on-chain) or “Lightning”.', '/guides/mobile/btcpay.png', '/guides/pc/btcpay.png'),
    S('Naskenujte QR kód vo svojej peňaženke (alebo „Pay in wallet“) a zaplaťte presnú sumu. Adresu ani sumu nemeňte.',
      'Scan the QR code in your wallet (or “Pay in wallet”) and pay the exact amount. Don’t change the address or the amount.'),
    S('Zaplaťte pred vypršaním časovača na faktúre; faktúra sa po prijatí sama označí ako zaplatená.',
      'Pay before the invoice timer runs out; the invoice marks itself as paid when received.'),
  ] },
  mtpelerin: { title: 'Karta / banka (Mt Pelerin)', steps: [
    S('Stlačte „📋 Kopírovať adresu“ (pre istotu, ak by sa Mt Pelerin pýtal).', 'Tap “📋 Copy address” (just in case Mt Pelerin asks for it).'),
    S('Stlačte „Pokračovať na Mt Pelerin“ – „You send“ ({amt} EUR), mena a adresa sú už vyplnené. Nič nemeňte a stlačte zelené „Buy … {coin}“.',
      'Tap “Continue to Mt Pelerin” – “You send” ({amt} EUR), coin and address are already filled in. Change nothing and tap the green “Buy … {coin}”.', R('mtp-01-m'), R('mtp-01-d')),
    S('Pokračujte podľa Mt Pelerin: e-mail / telefón, pri prvej platbe overenie, potom platba kartou alebo bankovým prevodom.',
      'Continue on Mt Pelerin: e-mail / phone, the first time an ID check, then pay by card or bank transfer.', '', '',
      'Mt Pelerin po pokračovaní: overenie telefónu / e-mailu a výber platby'),
    back(),
  ] },
  crypto_direct: { title: 'Krypto priamo z peňaženky', steps: [
    S('Skopírujte adresu (📋) alebo naskenujte QR kód vo svojej peňaženke.', 'Copy the address (📋) or scan the QR code in your wallet.', R('our-crypto-m'), R('our-crypto-d')),
    S('Pošlite presne zobrazenú sumu v zobrazenej mene a sieti. Iná mena alebo sieť sa stratí.',
      'Send exactly the amount shown in the coin and network shown. Another coin or network will be lost.'),
    back(),
  ] },
  switchere_skrill: { title: 'Skrill (cez Switchere)', steps: [
    S('Stlačte „Pokračovať na platbu →“ – suma a adresa peňaženky sú už vyplnené (nemeňte ich).',
      'Tap “Pokračovať na platbu →” (Continue to payment) – amount and wallet address are already filled in (don’t change them).', '/guides/mobile/switchere.png', '/guides/pc/switchere.png'),
    S('V Switchere: „You send“ = EUR suma (nemeňte). V „Payment method“ zvoľte „Skrill“ → „Buy“.',
      'In Switchere: “You send” = EUR amount (don’t change). Under “Payment method” choose “Skrill” → “Buy”.', '/guides/mobile/switchere-buy.png', '/guides/pc/switchere-buy.png'),
    S('Prihláste sa / zaregistrujte v Switchere svojím e-mailom a heslom, potom zadajte kód z e-mailu.',
      'Log in / sign up at Switchere with your e-mail and password, then enter the code from the e-mail.', '/guides/mobile/switchere-otp.png', '/guides/pc/switchere-otp.png'),
    S('Ak Switchere vyžiada overenie totožnosti: meno ako v doklade, dátum narodenia, adresa, foto dokladu / selfie.',
      'If Switchere asks for an ID check: name as on your ID, date of birth, address, photo of ID / selfie.'),
    S('V okne Skrill sa prihláste svojím Skrill účtom (2FA kód, ak príde) a potvrďte platbu.',
      'In the Skrill window log in with your Skrill account (2FA code if asked) and confirm the payment.', '/guides/mobile/skrill.png', '/guides/pc/skrill.png'),
    back(),
  ] },
  paysafecard: { title: 'PaysafeCard', steps: [
    S('U predajcu zvoľte nominál (10 / 25 / 50 / 100 €) → Kúpiť.', 'At the shop choose the value (10 / 25 / 50 / 100 €) → Buy.', '/guides/mobile/herne-paysafe-1.png', '/guides/pc/herne-paysafe-1.png'),
    S('Pri nákupe zadávate svoje vlastné údaje (meno, e-mail). PIN príde na váš e-mail.', 'You enter your own details (name, e-mail). The PIN arrives by e-mail.'),
    S('PIN je ako hotovosť – nikomu ho neposielajte (ani do chatu). Pošlite ho len cez formulár na tejto stránke.',
      'The PIN is like cash – never send it to anyone (not even in chat). Submit it only via the form on this page.'),
  ] },
};
const g2a = (img) => [
  S('Klikni „In den Warenkorb“ / „Add to cart“ (= Do košíka). Pri Amazon skontroluj „Region“ = GERMANY.',
    'Click “In den Warenkorb” / “Add to cart”. For Amazon check “Region” = GERMANY.', `/guide-img/${img}-1.jpg`),
  S('Do „Gib deine E-Mail-Adresse ein“ napíš svoj e-mail – sem príde kód. „Ein Konto … erstellen“ nemusíš zaškrtnúť, „Plus Premium“ nechaj vypnuté. Klikni „Weiter zur Zahlung“ (= Pokračovať k platbe).',
    'Type your e-mail into “Gib deine E-Mail-Adresse ein” – the code is sent there. No need to tick “Ein Konto … erstellen”; leave “Plus Premium” off. Click “Weiter zur Zahlung” (= Continue to payment).', `/guide-img/${img}-2.jpg`),
  S('Vyber „Kredit- oder Debitkarte“ a klikni „Bezahlen mit Kredit- oder Debitkarte“. Dole skontroluj „Gesamtbetrag“ (celková suma).',
    'Choose “Kredit- oder Debitkarte” and click “Bezahlen mit Kredit- oder Debitkarte”. Check “Gesamtbetrag” (total) at the bottom.', `/guide-img/${img}-3.jpg`),
  S('Vyplň údaje svojej karty: „Kartennummer“, „Ablaufdatum“ (MM/RR), „CVV/CVC“, „Name des Karteninhabers“. Klikni „Bestätigen“ a potvrď v appke banky.',
    'Enter your card: “Kartennummer” (number), “Ablaufdatum” (MM/YY), “CVV/CVC”, “Name des Karteninhabers” (name). Click “Bestätigen” and confirm in your bank app.', `/guide-img/${img}-4.jpg`),
  S('Po platbe príde e-mail od G2A → „Get order“ / „Display item“ – tam je kód. Kód pošli iba cez formulár na tejto stránke, nikomu inému.',
    'After paying G2A e-mails you → “Get order” / “Display item” shows the code. Submit the code only via the form on this page, to nobody else.'),
];
DEFAULTS.g2a_amazon = { title: 'Amazon darčeková karta (G2A)', steps: g2a('g2a-amazon') };
DEFAULTS.g2a_azteco = { title: 'Azteco (G2A)', steps: g2a('g2a-azteco') };

const KEYS = Object.keys(DEFAULTS);
function keyFor(id, variant) {
  const s = String(id || '').toLowerCase();
  if (s === 'changelly' || s.startsWith('changelly_')) return (variant === 'sepa' || s === 'changelly_sepa') ? 'changelly_sepa' : 'changelly_card';
  if (s.startsWith('g2a_amazon')) return 'g2a_amazon';
  if (s.startsWith('g2a_azteco') || s === 'g2a') return 'g2a_azteco';
  if (s === 'crypto_btcpay' || s.startsWith('btcpay')) return 'btcpay';
  if (s.startsWith('paysafe')) return 'paysafecard';
  if (s === 'skrill' || s.startsWith('switchere')) return 'switchere_skrill';
  if (s === 'revolut') return 'revolut_manual';
  return DEFAULTS[s] ? s : null;
}

/* ---------- storage ---------- */
const ST = { over: new Map(), img: new Map() };
let log = () => {};
let ready = null;
const pool = () => { try { return orderDb.pool(); } catch { return null; } };
async function tables() {
  const p = pool(); if (!p) return null;
  if (!ready) ready = p.query('CREATE TABLE IF NOT EXISTS guide_overrides (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())')
    .then(() => p.query('CREATE TABLE IF NOT EXISTS guide_images (id text PRIMARY KEY, type text NOT NULL, data bytea NOT NULL, created_at timestamptz DEFAULT now())'))
    .catch((x) => { ready = null; throw x; });
  await ready; return p;
}
function persistLocal() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(ST.over), null, 1)); } catch { /* read-only fs */ }
}
async function init(appendLog) {
  if (appendLog) log = appendLog;
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) ST.over.set(k, v); } catch { /* none */ }
  const p = await tables().catch((x) => { log('GUIDES_DB_FAIL ' + x.message); return null; });
  if (!p) return;
  const { rows } = await p.query('SELECT key, data FROM guide_overrides');
  for (const r of rows) ST.over.set(r.key, r.data);
}
async function saveOverride(key, data) {
  if (data) ST.over.set(key, data); else ST.over.delete(key);
  persistLocal();
  const p = await tables().catch((x) => { log('GUIDES_DB_FAIL ' + x.message); return null; });
  if (!p) return;
  if (data) await p.query('INSERT INTO guide_overrides(key, data, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', [key, data]);
  else await p.query('DELETE FROM guide_overrides WHERE key=$1', [key]);
}
function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.length > 6 && /^GIF8[79]a/.test(b.subarray(0, 6).toString())) return 'image/gif';
  return null;
}
async function storeImage(buf) {
  if (!buf || !buf.length) throw new Error('Prázdny súbor');
  if (buf.length > MAX_IMG) throw new Error('Obrázok je príliš veľký (max 3 MB)');
  const type = sniff(buf); if (!type) throw new Error('Nepodporovaný formát (PNG, JPG, WebP, GIF)');
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
  ST.img.set(id, { type, data: buf });
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); fs.writeFileSync(path.join(IMG_DIR, id), buf); fs.writeFileSync(path.join(IMG_DIR, id + '.type'), type); } catch { /* read-only */ }
  const p = await tables().catch(() => null);
  if (p) await p.query('INSERT INTO guide_images(id, type, data) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, type, buf]);
  return `/gimg/${id}`;
}
async function loadImage(id) {
  if (ST.img.has(id)) return ST.img.get(id);
  try { const r = { type: fs.readFileSync(path.join(IMG_DIR, id + '.type'), 'utf8'), data: fs.readFileSync(path.join(IMG_DIR, id)) }; ST.img.set(id, r); return r; } catch { /* not local */ }
  const p = await tables().catch(() => null); if (!p) return null;
  const { rows } = await p.query('SELECT type, data FROM guide_images WHERE id=$1', [id]);
  if (!rows[0]) return null;
  const r = { type: rows[0].type, data: Buffer.from(rows[0].data) }; ST.img.set(id, r); return r;
}

/* ---------- read / render ---------- */
const clone = (x) => JSON.parse(JSON.stringify(x));
function get(key) {
  const k = keyFor(key) || key; if (!DEFAULTS[k]) return null;
  const o = ST.over.get(k);
  return { key: k, custom: !!o, ...clone(o && Array.isArray(o.steps) ? o : DEFAULTS[k]) };
}
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^\/(?!\/)[\w\-./?=&%]*$/.test(String(u || '')) ? String(u) : '');
function fill(t, ctx) {
  let x = String(t || '');
  if (!(ctx && ctx.amount != null && ctx.amount !== '')) x = x.replace(/\s*\(\{amt\}[^()]*\)/g, '').replace(/\{amt\}\s*(€|EUR)?/g, '');
  return x.replace(/\{amt\}/g, String(ctx.amount)).replace(/\{coin\}/g, (ctx && ctx.coin) || 'LTC');
}
/** Public, customer-safe JSON (no slots, no admin data). */
function publicGuide(key, ctx = {}) {
  const g = get(key); if (!g) return null;
  return { key: g.key, title: g.title, steps: g.steps.filter((s) => s.sk || s.en).map((s, i) => ({ n: i + 1, sk: fill(s.sk, ctx), en: fill(s.en, ctx), img: safeUrl(s.img) || safeUrl(s.imgPc), imgPc: safeUrl(s.imgPc) })) };
}
const CSS = `<style>.gd{border:1px solid rgba(128,128,128,.35);border-radius:12px;margin:12px 0;overflow:hidden}
.gd>summary{cursor:pointer;padding:14px;font-weight:700;font-size:1.02rem;list-style:none;display:flex;align-items:center;gap:8px;min-height:48px}
.gd>summary::-webkit-details-marker{display:none}.gd>summary:after{content:"▾";margin-left:auto;transition:transform .2s}.gd[open]>summary:after{transform:rotate(180deg)}
.gd ol{list-style:none;margin:0;padding:0 12px 12px;counter-reset:g}.gd li{counter-increment:g;margin:0 0 16px;padding-top:10px;border-top:1px solid rgba(128,128,128,.2)}
.gd .t{display:flex;gap:10px;align-items:flex-start;line-height:1.45}.gd .t:before{content:counter(g);flex:none;width:28px;height:28px;border-radius:50%;background:#2563eb;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:.9rem}
.gd .en{display:block;opacity:.72;font-size:.88em;margin-top:3px}.gd picture,.gd img{display:block;max-width:100%}
.gd img{margin:8px auto 0;border-radius:10px;border:1px solid rgba(128,128,128,.3);height:auto;width:auto;max-height:78vh}
@media(min-width:700px){.gd img{max-width:min(100%,560px);max-height:640px}}</style>`;
/** Server-rendered collapsible guide. opts: {amount, coin, open, title} */
function html(key, opts = {}) {
  const g = publicGuide(key, opts); if (!g || !g.steps.length) return '';
  const li = g.steps.map((s) => `<li><div class="t"><div>${esc(s.sk)}<span class="en">${esc(s.en)}</span></div></div>${s.img ? `<a href="${esc(s.imgPc || s.img)}" target="_blank" rel="noopener"><picture>${s.imgPc && s.imgPc !== s.img ? `<source media="(min-width:700px)" srcset="${esc(s.imgPc)}">` : ''}<img src="${esc(s.img)}" alt="Krok ${s.n}" loading="lazy" decoding="async"></picture></a>` : ''}</li>`).join('');
  return `${CSS}<details class="gd"${opts.open ? ' open' : ''}><summary>📖 ${esc(opts.title || 'Návod krok za krokom')} <small style="font-weight:500;opacity:.7">· Step-by-step guide</small></summary><ol>${li}</ol></details>`;
}
const missing = (g) => g.steps.filter((s) => !s.img && !s.imgPc && s.slot).length;

/* ---------- admin ---------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', (c) => { n += c.length; if (n > limit) over = true; else chunks.push(c); });
    req.on('end', () => (over ? reject(new Error('Príliš veľké (max ~3 MB na obrázok)')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readMultipart(req) {
  const ct = String(req.headers['content-type'] || ''); const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!/^multipart\/form-data/i.test(ct) || !bm) return { fields: { ...(req.body || {}) }, files: [] };
  const buf = await readBody(req, 16 * 1024 * 1024), sep = Buffer.from('--' + (bm[1] || bm[2])); const fields = {}, files = [];
  let i = buf.indexOf(sep);
  while (i >= 0) {
    const j = buf.indexOf(sep, i + sep.length); if (j < 0) break;
    const part = buf.subarray(i + sep.length + 2, j - 2), h = part.indexOf('\r\n\r\n');
    if (h > 0) {
      const head = part.subarray(0, h).toString('utf8'), body = part.subarray(h + 4), name = (head.match(/name="([^"]*)"/) || [])[1], fn = (head.match(/filename="([^"]*)"/) || [])[1];
      if (fn !== undefined) { if (body.length) files.push({ field: name, name: fn, buf: body }); } else if (name) fields[name] = body.toString('utf8');
    }
    i = j;
  }
  return { fields, files };
}

function mount(app, { appendLog } = {}) {
  if (appendLog) log = appendLog;
  const { layout } = require('./adminSepa');
  const { sameOrigin, nostore } = require('./payMethods');
  const css = `<style>.gl td,.gl th{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}.miss{color:#b45309;font-weight:700}
.stp{border:1px solid #ccc;border-radius:10px;padding:12px;margin:12px 0}.stp textarea{width:100%;min-height:64px;box-sizing:border-box}
.stp .imgs{display:flex;gap:12px;flex-wrap:wrap}.stp .imgs>div{flex:1 1 220px}.stp img{max-width:220px;max-height:260px;border:1px solid #ccc;border-radius:8px;display:block}
.slot{background:#fff7ed;border:2px dashed #f59e0b;border-radius:8px;padding:8px;color:#7c2d12}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}</style>`;
  const page = (req, title, body, msg = '', err = '') => layout({ title, userEmail: req.adminSession && req.adminSession.email,
    body: `${css}${msg ? `<div class="ok">${esc(msg)}</div>` : ''}${err ? `<div class="err">${esc(err)}</div>` : ''}${body}` });

  app.get('/admin/platby/guides', (req, res) => {
    nostore(res);
    const rows = KEYS.map((k) => { const g = get(k); const m = missing(g); return `<tr><td><a href="/admin/platby/guides/${k}">${esc(g.title)}</a><br><small>${k}</small></td><td>${g.steps.length}</td><td>${m ? `<span class="miss">📷 ${m} chýba</span>` : '✅'}</td><td>${g.custom ? 'upravený' : 'predvolený'}</td></tr>`; }).join('');
    res.type('html').send(page(req, 'Návody k platbám', `<h1>📖 Návody k platbám</h1>
<p>Každý krok má text SK + EN a obrázok (mobil, voliteľne PC). Kroky s <span class="miss">📷 chýba</span> čakajú na váš screenshot (za prihlásením / captchou) – zákazník vidí zatiaľ len text.
Vo všetkých textoch môžete použiť <code>{amt}</code> (suma objednávky) a <code>{coin}</code> (mena, napr. LTC).</p>
<table class="gl"><tr><th>Návod</th><th>Kroky</th><th>Obrázky</th><th>Stav</th></tr>${rows}</table>`, req.query.ok ? 'Uložené.' : ''));
  });

  app.get('/admin/platby/guides/:key', (req, res) => {
    nostore(res);
    const g = get(req.params.key); if (!g || g.key !== req.params.key) return res.status(404).send('Nenájdené');
    const st = g.steps.map((s, i) => `<div class="stp"><div class="row"><b>Krok ${i + 1}</b> <label>poradie <input name="ord_${i}" value="${i + 1}" size="2" inputmode="numeric"></label> <label><input type="checkbox" name="del_${i}"> zmazať krok</label></div>
${s.slot ? `<div class="slot">📷 Slot: ${esc(s.slot)}${s.img || s.imgPc ? ' (vyplnené)' : ' — <b>chýba obrázok</b>'}</div>` : ''}
<label>SK<textarea name="sk_${i}">${esc(s.sk)}</textarea></label><label>EN<textarea name="en_${i}">${esc(s.en)}</textarea></label>
<label>Popis slotu (čo má byť na obrázku, zákazník ho nevidí)<input name="slot_${i}" value="${esc(s.slot)}" style="width:100%"></label>
<div class="imgs"><div><b>Obrázok – mobil</b>${s.img ? `<img src="${esc(s.img)}" alt=""><label><input type="checkbox" name="rmimg_${i}"> odstrániť</label>` : '<p class="miss">žiadny</p>'}<input type="file" name="img_${i}" accept="image/png,image/jpeg,image/webp,image/gif"></div>
<div><b>Obrázok – PC (voliteľný)</b>${s.imgPc ? `<img src="${esc(s.imgPc)}" alt=""><label><input type="checkbox" name="rmpc_${i}"> odstrániť</label>` : '<p>žiadny (použije sa mobilný)</p>'}<input type="file" name="pc_${i}" accept="image/png,image/jpeg,image/webp,image/gif"></div></div>
<input type="hidden" name="oimg_${i}" value="${esc(s.img)}"><input type="hidden" name="opc_${i}" value="${esc(s.imgPc)}"></div>`).join('');
    res.type('html').send(page(req, 'Návod: ' + g.title, `<p><a href="/admin/platby/guides">← Všetky návody</a></p><h1>📖 ${esc(g.title)}</h1>
<form method="post" action="/admin/platby/guides/${g.key}" enctype="multipart/form-data"><input type="hidden" name="n" value="${g.steps.length}">
<label>Nadpis <input name="title" value="${esc(g.title)}" style="width:100%"></label>${st}
<label><input type="checkbox" name="add"> pridať nový prázdny krok na koniec</label>
<p><button type="submit">💾 Uložiť</button></p></form>
${g.custom ? `<form method="post" action="/admin/platby/guides/${g.key}/reset" onsubmit="return confirm('Vrátiť predvolený návod? Vaše úpravy sa zmažú.')"><button type="submit">↺ Vrátiť predvolený</button></form>` : ''}
<p><a href="/admin/platby/guides/${g.key}/preview" target="_blank">👁 Náhľad pre zákazníka</a></p>`, req.query.ok ? 'Uložené.' : '', req.query.err || ''));
  });

  app.get('/admin/platby/guides/:key/preview', (req, res) => {
    nostore(res);
    if (!DEFAULTS[req.params.key]) return res.status(404).send('Nenájdené');
    res.type('html').send(`<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Náhľad</title><link rel="stylesheet" href="/tv-theme.css?v=20261026"/></head><body style="max-width:720px;margin:20px auto;padding:0 14px;font-family:system-ui,sans-serif">${html(req.params.key, { amount: 25, coin: 'LTC', open: true })}</body></html>`);
  });

  app.post('/admin/platby/guides/:key', async (req, res) => {
    nostore(res);
    if (!sameOrigin(req)) return res.status(403).send('Forbidden');
    const g = get(req.params.key); if (!g || g.key !== req.params.key) return res.status(404).send('Nenájdené');
    try {
      const { fields: f, files } = await readMultipart(req);
      const file = (name) => files.find((x) => x.field === name);
      const n = Math.min(40, Math.max(0, parseInt(f.n, 10) || 0));
      const out = [];
      for (let i = 0; i < n; i++) {
        if (f['del_' + i]) continue;
        const s = { sk: String(f['sk_' + i] || '').slice(0, 2000), en: String(f['en_' + i] || '').slice(0, 2000), slot: String(f['slot_' + i] || '').slice(0, 300),
          img: f['rmimg_' + i] ? '' : safeUrl(f['oimg_' + i]), imgPc: f['rmpc_' + i] ? '' : safeUrl(f['opc_' + i]), _o: Number(f['ord_' + i]) || i + 1 };
        const a = file('img_' + i); if (a) s.img = await storeImage(a.buf);
        const b = file('pc_' + i); if (b) s.imgPc = await storeImage(b.buf);
        out.push(s);
      }
      out.sort((a, b) => a._o - b._o); out.forEach((s) => delete s._o);
      if (f.add) out.push(S('', '', '', '', ''));
      await saveOverride(g.key, { title: String(f.title || g.title).slice(0, 120), steps: out });
      log(`ADMIN_GUIDE_SAVE ${g.key} steps=${out.length} by=${req.adminSession && req.adminSession.email}`);
      res.redirect(303, `/admin/platby/guides/${g.key}?ok=1`);
    } catch (x) { res.redirect(303, `/admin/platby/guides/${g.key}?err=${encodeURIComponent(x.message)}`); }
  });
  app.post('/admin/platby/guides/:key/reset', async (req, res) => {
    nostore(res);
    if (!sameOrigin(req)) return res.status(403).send('Forbidden');
    if (!DEFAULTS[req.params.key]) return res.status(404).send('Nenájdené');
    await saveOverride(req.params.key, null).catch(() => {});
    log(`ADMIN_GUIDE_RESET ${req.params.key}`);
    res.redirect(303, `/admin/platby/guides/${req.params.key}?ok=1`);
  });
}

function mountPublic(app) {
  app.get('/gimg/:id', async (req, res) => {
    const id = String(req.params.id || ''); if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    const r = await loadImage(id).catch(() => null); if (!r) return res.status(404).end();
    res.set({ 'Content-Type': r.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).send(r.data);
  });
  app.get('/api/guides/:key', (req, res) => {
    const amt = Number(req.query.amount); const coin = String(req.query.coin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const g = publicGuide(keyFor(req.params.key, req.query.variant) || '', { amount: Number.isFinite(amt) && amt > 0 ? amt : null, coin: coin || null });
    if (!g) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'no-cache').json(g);
  });
}

module.exports = { DEFAULTS, KEYS, keyFor, get, publicGuide, html, init, mount, mountPublic, missing };
