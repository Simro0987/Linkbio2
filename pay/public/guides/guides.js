/**
 * Unique per-method guides from REAL payment UI screenshots (PC + mobile).
 * Captures: Banxa email/OTP/Identity · Revolut SSO/email (OTP may hit captcha) · Switchere buy REAL ·
 * Paysafe herne-kupony (login/register) · G2A pay-page · Skrill · SEPA manuál · Stripe · Ramp · BTCPay.
 * PC/Mobil: stepsForDevice(guide, 'pc'|'mobile') + detectDevice().
 * No identity autofill — customers enter their own details at the provider.
 */
(function (global) {
  'use strict';

  const PC = '/guides/pc/';
  const MO = '/guides/mobile/';

  /** file = basename under pc/ + mobile/; opts.pcOnly → reuse PC shot on mobile */
  function step(file, captionPc, captionMobile, opts) {
    opts = opts || {};
    const pcBase = opts.pcFile || file;
    const moBase = opts.mobileFile || file;
    const imgPc = opts.imgPc || PC + pcBase + '.png';
    const imgMobile = opts.pcOnly ? imgPc : (opts.imgMobile || MO + moBase + '.png');
    return {
      imgPc,
      imgMobile,
      fallback: opts.fallback || imgPc,
      caption: captionPc,
      captionMobile: captionMobile || captionPc,
    };
  }

  /** Universal last step: wait for confirmation (no external messaging). */
  function shotStep() {
    return step(
      'checkout',
      'Po platbe: vráťte sa na stránku objednávky — stav sa aktualizuje automaticky. Potvrdenie od providera si uschovajte.',
      'Mobil: po platbe sa vráťte na stránku objednávky; potvrdenie si uschovajte.',
      { pcOnly: true }
    );
  }
  /** Text-only step (no screenshot). */
  function txt(captionPc, captionMobile) {
    return { imgPc: '', imgMobile: '', fallback: '', caption: captionPc, captionMobile: captionMobile || captionPc };
  }
  const WALLET_NOTE = 'Adresa peňaženky (wallet / „You get“ cieľ) je už predvyplnená — NEMEŇTE ju.';
  const OWN_DATA = 'Všetky osobné údaje zadávate VY SAMI priamo u providera: vaše meno ako v doklade, váš email, vaša adresa, vaša karta. Nikto ich za vás nevypĺňa.';

  const BY_ID = {
    banxa: {
      title: 'Banxa · karta',
      video: '/guides/video/banxa.mp4',
      tipSK: 'SK: EUR Visa/MC. Express do ~500 € často bez dokladu — email kód + adresa.',
      tipCZ: 'CZ: CZK karta. Express do limitu často bez dokladu — ľahšie než Stripe (vždy L2 KYC).',
      note: 'Checkout → Banxa Sign in / Register → email → OTP z inboxu → Identity / karta. OTP snímky z reálneho Banxa flow.',
      steps: [
        step('checkout', 'Checkout (PC): suma EUR, email, krajina SK → Pokračovať.', 'Checkout (mobil): suma, email, SK → Pokračovať.'),
        step(
          'banxa-email',
          '1 · Banxa „Sign in“ / Register — email (alebo Google/Apple ak ponúka) → „Send me my code“.',
          '1 · Banxa (mobil): email → „Send me my code“.'
        ),
        step(
          'banxa-otp',
          '2 · Po emaile: otvorte inbox → 4-miestny OTP kód → „Verify Me“ (snímka OTP potrebuje reálny kód).',
          '2 · Po emaile: kód z doručenej pošty → Verify Me.'
        ),
        step(
          'banxa-after-otp',
          '3 · Po OTP: Identity / billing (meno, adresa, telefón) podľa výzvy.',
          '3 · Po OTP: overenie údajov na mobile.'
        ),
        step(
          'banxa-card',
          '4 · Potom karta/platba: Visa/MC (Express často bez dokladu) — dokončite platbu.',
          '4 · Potom karta alebo wallet na mobile.'
        ),
        shotStep()
      ],
    },

    is_banxa: { aliasOf: 'banxa', title: 'Banxa (alt.)' },
    is_banxa2: { aliasOf: 'banxa', title: 'Banxa 2' },

    stripe: {
      title: 'Stripe Link · karta',
      tipSK: 'EÚ Stripe Link = vždy doklad + selfie. Pre rýchlosť radšej Banxa.',
      tipCZ: 'EÚ Stripe = ťažké KYC. Banxa CZK je jednoduchšia.',
      note: 'Skutočná crypto.link.com (MetaMask + Link by Stripe).',
      steps: [
        step('checkout', 'Checkout: suma + email → Stripe.', 'Mobil: suma + email → Stripe.'),
        step('stripe', 'PC: Pay/Receive vľavo + info sidebar vpravo → Continue.', 'Mobil: Pay/Receive stacked → Continue (bez sidebaru).'),
        step('stripe', 'Po Continue: karta/banka + EÚ overenie.', 'Na mobile dokončite Link sheet.'),
        shotStep()
      ],
    },
    is_stripe: { aliasOf: 'stripe', title: 'Stripe (alt.)' },

    switchere: {
      title: 'Switchere · karta',
      tipSK: 'SK: Visa/MC. Údaje zadávate sami u Switchere. Adresa peňaženky je predvyplnená — nemeňte ju.',
      tipCZ: 'CZ: karta alebo SEPA. Údaje zadáváte sami. Adresu peněženky neměňte.',
      note: OWN_DATA,
      steps: [
        step('checkout', 'Krok 1 – náš checkout: zadajte sumu v EUR a VÁŠ email → zvoľte Switchere.', 'Krok 1 – checkout: suma + váš email → Switchere.'),
        step('switchere', 'Krok 2 – súhrn objednávky: skontrolujte sumu; adresa peňaženky je predvyplnená (nemeňte) → „Otvoriť platobnú stránku“.', 'Krok 2 – súhrn → Otvoriť platobnú stránku.'),
        step('switchere-buy', 'Krok 3 – Switchere widget: „You send“ = EUR suma (nemeňte), „You get“ = mena je už nastavená. V „Payment method“ zvoľte Visa/Mastercard → „Buy“.', 'Krok 3 – widget: Payment method → karta → Buy.'),
        step('switchere-otp', 'Krok 4 – Switchere prihlásenie/registrácia: zadajte VÁŠ email a heslo, potom kód, ktorý vám príde emailom.', 'Krok 4 – váš email + heslo → kód z emailu.'),
        txt('Krok 5 – overenie totožnosti (ak Switchere vyžiada): vaše meno a priezvisko ako v doklade, dátum narodenia, vaša adresa trvalého bydliska, foto vášho dokladu / selfie podľa pokynov na obrazovke.', 'Krok 5 – overenie: vaše meno ako v doklade, dátum narodenia, adresa, doklad.'),
        step('switchere-pay', 'Krok 6 – platba kartou: číslo karty, dátum platnosti (MM/RR), CVV a meno držiteľa karty (vaše meno ako na karte) → potvrďte 3D Secure v aplikácii vašej banky. Adresa peňaženky je už predvyplnená — nemeňte ju.', 'Krok 6 – karta: číslo, platnosť, CVV, meno na karte → 3DS. Adresu peňaženky nemeňte.'),
        shotStep()
      ],
    },

    is_multihosted: {
      title: 'Rýchla platba (auto)',
      tipSK: 'Jeden klik — brána vyberie metódu.',
      tipCZ: 'Jeden klik — brána vyberie metódu.',
      steps: [
        step('checkout', 'Suma + email → auto.', 'Mobil: suma + email → auto.'),
        step('ramp', 'Dokončite podľa ponuky brány.', 'Na mobile podľa ponuky brány.'),
        shotStep()
      ],
    },

    guardarian_card: { aliasOf: 'btcpay_onramp', title: 'Karta · Guardarian → BTC' },
    btcpay_onramp: {
      title: 'Karta/banka widget (Guardarian → BTC)',
      tipSK: 'Guardarian: karta alebo banka. Všetky údaje zadávate sami. BTC adresa je predvyplnená — nemeňte ju.',
      tipCZ: 'Guardarian: karta nebo banka. Údaje zadáváte sami. BTC adresu neměňte.',
      note: OWN_DATA,
      steps: [
        step('checkout', 'Krok 1 – náš checkout: zadajte sumu v EUR a VÁŠ email → zvoľte Karta/banka widget.', 'Krok 1 – suma + váš email → widget.'),
        txt('Krok 2 – Guardarian: suma v EUR a mena BTC sú nastavené; skontrolujte ich. BTC adresa príjemcu je už predvyplnená — NEMEŇTE ju.', 'Krok 2 – skontrolujte sumu; BTC adresu nemeňte.'),
        txt('Krok 3 – zadajte VÁŠ email (na potvrdenie objednávky) a zvoľte spôsob platby: karta alebo bankový prevod (SEPA).', 'Krok 3 – váš email → karta alebo SEPA.'),
        txt('Krok 4 – overenie totožnosti (ak Guardarian vyžiada): vaše meno a priezvisko ako v doklade, dátum narodenia, krajina, foto vášho dokladu (OP / pas / vodičský preukaz) podľa pokynov.', 'Krok 4 – overenie: vaše meno ako v doklade, dátum narodenia, doklad.'),
        txt('Krok 5 – karta: číslo karty, platnosť, CVV, meno držiteľa (vaše) → 3D Secure v appke banky. SEPA: pošlite z VAŠEHO účtu presne sumu a referenciu, ktorú Guardarian zobrazí.', 'Krok 5 – karta + 3DS, alebo SEPA s referenciou z Guardarian.'),
        shotStep()
      ],
    },

    bank_sepa_manual: {
      title: 'SEPA manuál (IBAN)',
      tipSK: 'Požiadajte o bankové údaje — Ryan pošle IBAN. Referencia SEP-… · presne EUR · 50 min.',
      tipCZ: 'EUR SEPA rovnako. Požiadajte IBAN; referenciu skopírujte jedným ťukom.',
      note: 'Skutočná /bank-sepa-pay stránka (timer · referencia SEP-… · screenshot).',
      steps: [
        step('checkout', 'Vyberte SEPA manuál → Pokračovať.', 'Mobil: SEPA manuál.'),
        step(
          'sepa-manual',
          'PC: 50 min · IBAN od podpory · referencia · po prevode si uschovajte potvrdenie.',
          'Mobil: IBAN od podpory → referencia → uschovajte si potvrdenie.'
        ),
        shotStep()
      ],
    },

    banxa_bank: {
      title: 'Banxa SEPA',
      tipSK: 'SK: SEPA EUR cez Banxa áno.',
      tipCZ: 'CZ: Banxa SEPA často nie — EUR IBAN (Revolut/Wise), CZK karta, alebo Switchere SEPA.',
      note: 'Banxa: email → OTP z inboxu → SEPA. OTP snímky vyžadujú reálny kód.',
      steps: [
        step('checkout', 'Suma → Banxa SEPA.', 'Mobil: Banxa SEPA.'),
        step('banxa-email', '1 · Banxa: email → „Send me my code“.', '1 · Banxa (mobil): email → Send me my code.'),
        step('banxa-otp', '2 · Po emaile: kód z inboxu → Verify Me (OTP = reálny kód).', '2 · Po emaile: kód z doručenej pošty.'),
        step('banxa-bank', '3 · Potom platba: bank transfer / SEPA podľa IBAN na obrazovke.', '3 · Mobil: dokončite SEPA v bankovej appke.'),
        shotStep()
      ],
    },

    sepa_instant: {
      title: 'SEPA Instant / QR',
      tipSK: 'SK banky väčšinou Instant/QR OK.',
      tipCZ: 'Overte Instant; inak CZK karta alebo Switchere.',
      note: 'Banxa email → OTP z inboxu → Instant/QR. OTP snímky vyžadujú reálny kód.',
      steps: [
        step('checkout', 'Suma → SEPA Instant / QR.', 'Mobil: Instant / QR.'),
        step('banxa-email', '1 · Banxa: email → „Send me my code“.', '1 · Banxa mobil: email → Send me my code.'),
        step('banxa-otp', '2 · Po emaile: kód z inboxu → Verify Me.', '2 · Po emaile: kód z doručenej pošty.'),
        step('banxa-sepa', '3 · Potom platba: QR / Instant v bankovej appke.', '3 · Mobil: naskenujte QR alebo potvrďte Instant.'),
        shotStep()
      ],
    },

    switchere_bank: {
      title: 'Switchere SEPA',
      tipSK: 'SEPA / Instant EUR z VÁŠHO účtu. Adresa peňaženky je predvyplnená — nemeňte ju.',
      tipCZ: 'SEPA EUR z vašeho účtu. Adresu peněženky neměňte.',
      note: OWN_DATA,
      steps: [
        step('checkout', 'Krok 1 – náš checkout: suma v EUR + VÁŠ email → Switchere SEPA.', 'Krok 1 – suma + váš email → Switchere SEPA.'),
        step('switchere-bank', 'Krok 2 – súhrn: adresa peňaženky je predvyplnená (nemeňte) → otvorte Switchere.', 'Krok 2 – súhrn → Switchere.'),
        step('switchere-buy', 'Krok 3 – Switchere widget: „You send“ = EUR suma, „You get“ nastavené. V „Payment method“ zvoľte SEPA → „Buy“.', 'Krok 3 – Payment method → SEPA → Buy.'),
        step('switchere-otp', 'Krok 4 – prihlásenie/registrácia: VÁŠ email + heslo → kód z emailu.', 'Krok 4 – váš email + heslo → kód.'),
        txt('Krok 5 – overenie totožnosti (ak vyžiada): vaše meno ako v doklade, dátum narodenia, adresa, doklad / selfie podľa pokynov.', 'Krok 5 – overenie vašej totožnosti.'),
        step('switchere-pay', 'Krok 6 – Switchere zobrazí IBAN príjemcu, sumu a referenciu: v internetbankingu VÁŠHO účtu (na vaše meno) zadajte presne tento IBAN, sumu a referenciu. Adresu peňaženky nemeňte.', 'Krok 6 – v bankovej appke: IBAN, suma, referencia zo Switchere.'),
        shotStep()
      ],
    },

    is_ramp: {
      title: 'Ramp Network',
      tipSK: 'Ramp vždy doklad. SK/CZ oficiálne podporované.',
      tipCZ: 'Vždy doklad.',
      note: 'Skutočná Ramp / chain2pay.is auth.',
      steps: [
        step('checkout', 'Suma → Ramp.', 'Mobil: Ramp.'),
        step('ramp', 'PC: Continue with email / Google / Apple.', 'Mobil: CTA stacked na karte.'),
        step('ramp', 'Doklad + karta/banka.', 'Mobil: KYC podľa výzvy.'),
        shotStep()
      ],
    },

    revolut: {
      title: 'Revolut (1–4)',
      video: '/guides/video/revolut.mp4',
      tipSK: 'Krajina SK. Po SSO na Ramp: My wallet → MetaMask/Trust → vložte BTC adresu (Kopírovať) + nickname.',
      tipCZ: 'Krajina CZ. My wallet: MetaMask/Trust, BTC adresa z checkoutu, nickname (nie totožnosť).',
      note: 'Revolut Ramp: SSO → My wallet (MetaMask alebo Trust Wallet) → vložte čerstvú BTC adresu z našej stránky + navrhnutý nickname (napr. „Moja BTC peňaženka 7“). Nickname nie je meno ani KYC.',
      steps: [
        step('checkout', 'Checkout: suma EUR, email, SK/CZ → zvoľte Revolut 1 / 2 / 3 / 4.', 'Mobil: suma → Revolut 1–4.'),
        step(
          'revolut-phone-login',
          '1 · SSO „Welcome back“: telefón (+421) / Continue with email / QR z Revolut appky.',
          '1 · Mobil SSO: telefón / email / QR.'
        ),
        step(
          'revolut-email',
          '2 · Email Revolut účtu → Continue → OTP z inboxu/SMS.',
          '2 · Email → OTP z pošty / SMS.'
        ),
        step(
          'revolut-ramp',
          '3 · My wallet: zvoľte MetaMask alebo Trust Wallet (nie burzu).',
          '3 · My wallet: MetaMask alebo Trust Wallet.'
        ),
        step(
          'revolut-pay',
          '4 · Do wallet poľa vložte BTC adresu (tlačidlo Kopírovať na našej stránke). Nickname: použite navrhovaný text (napr. „Moja BTC peňaženka 7“) — je to len popis, nie totožnosť. Potom potvrďte platbu.',
          '4 · Vložte BTC (Kopírovať) + nickname → potvrďte platbu v appke.'
        ),
        shotStep()
      ],
    },

    revolut_1: { aliasOf: 'revolut', title: 'Revolut 1' },
    revolut_2: { aliasOf: 'revolut', title: 'Revolut 2' },
    revolut_3: { aliasOf: 'revolut', title: 'Revolut 3' },
    revolut_4: { aliasOf: 'revolut', title: 'Revolut 4' },
    is_revolut: { aliasOf: 'revolut', title: 'Revolut 2' },
    revolut_cee: { aliasOf: 'revolut', title: 'Revolut 3' },

    apple_google_revolut: {
      title: 'Revolut 4',
      tipSK: 'Rovnaký Revolut tok + My wallet (MetaMask/Trust) a BTC adresa z checkoutu.',
      tipCZ: 'My wallet → MetaMask/Trust → BTC + nickname.',
      note: 'Revolut 4 = Apple/Google cesta cez Revolut Ramp. Adresu peňaženky vždy vložte z našej stránky (BTC).',
      steps: [
        step('checkout', 'Checkout: suma → Revolut 4.', 'Mobil: suma → Revolut 4.'),
        step('revolut-phone-login', '1 · SSO: telefón / QR / Continue with email.', '1 · Mobil SSO.'),
        step('revolut-email', '2 · Email → OTP.', '2 · Email → OTP.'),
        step('revolut-ramp', '3 · My wallet: MetaMask alebo Trust Wallet.', '3 · My wallet: MetaMask / Trust.'),
        step('revolut-pay', '4 · Vložte BTC adresu (Kopírovať) + nickname (napr. „Moja BTC peňaženka 7“) → potvrďte platbu.', '4 · BTC + nickname → platba.'),
        shotStep()
      ],
    },

    onramper: {
      title: 'Onramper (agregátor)',
      tipSK: 'Widget buy.onramper.com — EUR→BTC, adresa predvyplnená ak wallets= funguje.',
      tipCZ: 'Onramper widget · karta/SEPA → BTC.',
      note: 'Žiadne scrapovanie. Server zloží oficiálnu widget URL (defaultFiat=EUR, defaultCrypto=btc, wallets=btc:…).',
      steps: [
        step('checkout', 'Checkout: suma → Onramper.', 'Mobil: suma → Onramper.'),
        step('switchere-checkout', '1 · Na našej stránke: tlačidlo „Otvoriť Onramper widget“.', '1 · Otvorte widget.'),
        step('switchere-buy', '2 · Vo widgete dokončite kartu/SEPA. Ak peňaženka chýba, vložte BTC (Kopírovať).', '2 · Platba + BTC ak treba.'),
        shotStep()
      ],
    },
    onramper_bank: { aliasOf: 'onramper', title: 'Onramper SEPA' },
    apple_google_onramper: { aliasOf: 'onramper', title: 'Onramper Apple/Google' },

    apple_google_banxa: {
      title: 'Apple / Google · Banxa',
      tipSK: 'SK EUR — Banxa oficiálne Apple/Google.',
      tipCZ: 'CZ CZK — podľa zariadenia.',
      note: 'Banxa email → OTP z inboxu → Apple/Google. OTP snímky vyžadujú reálny kód.',
      steps: [
        step('checkout', 'Suma → Apple/Google (Banxa).', 'Mobil: Banxa wallet.'),
        step('banxa-email', '1 · Banxa: email → „Send me my code“.', '1 · Banxa mobil: email → Send me my code.'),
        step('banxa-otp', '2 · Po emaile: kód z inboxu → Verify Me.', '2 · Po emaile: kód z doručenej pošty.'),
        step('banxa-apple', '3 · Potom platba: Apple/Google (nie kartu).', '3 · Potvrďte wallet biometrikou.'),
        shotStep()
      ],
    },

    apple_google_stripe: {
      title: 'Apple / Google · Stripe',
      tipSK: 'EÚ Stripe — ťažšie KYC.',
      tipCZ: 'EÚ Stripe — ťažšie KYC.',
      steps: [
        step('checkout', 'Suma → Apple/Google (Stripe).', 'Mobil: Stripe wallet.'),
        step('stripe-apple', 'PC Link: Continue → Apple/Google.', 'Mobil: Continue → wallet sheet.'),
        shotStep()
      ],
    },

    apple_google_switchere: {
      title: 'Apple / Google · Switchere',
      tipSK: 'Apple Pay / Google Pay v Switchere. Adresa peňaženky je predvyplnená — nemeňte ju.',
      tipCZ: 'Apple/Google Pay podle zařízení. Adresu peněženky neměňte.',
      note: OWN_DATA,
      steps: [
        step('checkout', 'Krok 1 – náš checkout: zadajte sumu v EUR a VÁŠ email → zvoľte Switchere.', 'Krok 1 – checkout: suma + váš email → Switchere.'),
        step('switchere', 'Krok 2 – súhrn objednávky: skontrolujte sumu; adresa peňaženky je predvyplnená (nemeňte) → „Otvoriť platobnú stránku“.', 'Krok 2 – súhrn → Otvoriť platobnú stránku.'),
        step('switchere-buy', 'Krok 3 – Switchere widget: „You send“ = EUR suma (nemeňte), „You get“ = mena je už nastavená. V „Payment method“ zvoľte Apple Pay alebo Google Pay → „Buy“.', 'Krok 3 – widget: Payment method → Apple/Google Pay → Buy.'),
        step('switchere-otp', 'Krok 4 – Switchere prihlásenie/registrácia: zadajte VÁŠ email a heslo, potom kód, ktorý vám príde emailom.', 'Krok 4 – váš email + heslo → kód z emailu.'),
        txt('Krok 5 – overenie totožnosti (ak Switchere vyžiada): vaše meno a priezvisko ako v doklade, dátum narodenia, vaša adresa trvalého bydliska, foto vášho dokladu / selfie podľa pokynov na obrazovke.', 'Krok 5 – overenie: vaše meno ako v doklade, dátum narodenia, adresa, doklad.'),
        step('switchere-pay', 'Krok 6 – potvrďte platbu v okne Apple Pay / Google Pay na vašom zariadení (Face ID / odtlačok / PIN zariadenia). Adresa peňaženky je už predvyplnená — nemeňte ju.', 'Krok 6 – potvrďte v Apple/Google Pay okne. Adresu peňaženky nemeňte.'),
        shotStep()
      ],
    },

    apple_google_onramper: {
      title: 'Apple / Google · agregátor',
      soon: true,
      steps: [step('checkout', 'Vyžaduje ONRAMPER_API_KEY.', 'Vyžaduje ONRAMPER_API_KEY.')],
    },



    g2a_azteco_ln_10: { aliasOf: 'g2a_azteco', title: 'Azteco Lightning 10 €' },
    g2a_azteco_ln_50: { aliasOf: 'g2a_azteco', title: 'Azteco Lightning 50 €' },
    g2a_azteco_ln_200: { aliasOf: 'g2a_azteco', title: 'Azteco Lightning 200 €' },
    g2a_azteco_onchain_100: { aliasOf: 'g2a_azteco', title: 'Azteco on-chain 100 €' },
    g2a_amazon_de_10: { aliasOf: 'g2a_amazon', title: 'Amazon DE 10 €' },
    g2a_amazon_de_25: { aliasOf: 'g2a_amazon', title: 'Amazon DE 25 €' },
    g2a_amazon_de_45: { aliasOf: 'g2a_amazon', title: 'Amazon DE 45 €' },
    g2a_amazon_de_50: { aliasOf: 'g2a_amazon', title: 'Amazon DE 50 €' },
    g2a_amazon_de_85: { aliasOf: 'g2a_amazon', title: 'Amazon DE 85 €' },
    g2a_amazon_de_100: { aliasOf: 'g2a_amazon', title: 'Amazon DE 100 €' },
    g2a_amazon_de_200: { aliasOf: 'g2a_amazon', title: 'Amazon DE 200 €' },

    g2a: {
      title: 'G2A kupón (návod)',
      info: true,
      tipSK: 'Len informačný návod. Kód kupónu NIKOMU neposielajte — ani nám, ani cez chat. Uplatnite ho len sami na stránke vydavateľa.',
      tipCZ: 'Jen informační návod. Kód nikomu neposílejte; uplatněte jej sami u vydavatele.',
      note: 'Informačný návod: ako funguje kúpa kupónu na G2A. Kód kupónu je ako hotovosť — nikdy ho nikomu neposielajte.',
      steps: [
        step('g2a-buy', 'G2A: produkt (Azteco / Amazon) kúpite na g2a.com pod VAŠÍM účtom.', 'G2A: nákup pod vaším účtom.'),
        step('g2a-email', 'Po nákupe: email od G2A → „Get order“ / „Display item“.', 'Inbox → Get order / Display item.'),
        txt('Kód uplatnite SAMI priamo u vydavateľa (azte.co / amazon.de). Kód nikomu neposielajte.', 'Kód uplatnite sami u vydavateľa; nikomu ho neposielajte.'),
      ],
    },

    g2a_azteco: {
      title: 'Azteco darčeková karta cez G2A (návod)',
      info: true,
      tipSK: 'Len informačný návod. Kód kupónu je ako hotovosť — NIKOMU ho neposielajte (ani nám, ani do chatu). Cez našu stránku sa kód nezadáva.',
      tipCZ: 'Jen informační návod. Kód nikomu neposílejte; přes naši stránku se nezadává.',
      note: 'Informačný návod: Azteco kartu kúpite na g2a.com pod VAŠÍM účtom (stránka G2A je v nemčine). Kód kupónu je ako hotovosť — nikdy ho nikomu neposielajte.',
      steps: [
        step('g2a-azteco-1', "Klikni „In den Warenkorb“ (= Do košíka).", "Klikni „In den Warenkorb“ (= Do košíka).", { imgPc: '/guide-img/g2a-azteco-1.jpg', imgMobile: '/guide-img/g2a-azteco-1.jpg' }),
        step('g2a-azteco-2', "Do políčka „Gib deine E-Mail-Adresse ein“ napíš svoj e-mail – sem príde kód. Políčko „Ein Konto für diese E-Mail-Adresse erstellen“ (vytvoriť účet) nemusíš zaškrtnúť. „Plus Premium“ nechaj vypnuté. Klikni „Weiter zur Zahlung“ (= Pokračovať k platbe).", "Do políčka „Gib deine E-Mail-Adresse ein“ napíš svoj e-mail – sem príde kód. Políčko „Ein Konto für diese E-Mail-Adresse erstellen“ (vytvoriť účet) nemusíš zaškrtnúť. „Plus Premium“ nechaj vypnuté. Klikni „Weiter zur Zahlung“ (= Pokračovať k platbe).", { imgPc: '/guide-img/g2a-azteco-2.jpg', imgMobile: '/guide-img/g2a-azteco-2.jpg' }),
        step('g2a-azteco-3', "Vyber „Kredit- oder Debitkarte“ (kreditná/debetná karta) a klikni „Bezahlen mit Kredit- oder Debitkarte“ (= Zaplatiť kartou). Dole skontroluj „Gesamtbetrag“ = celková suma na zaplatenie (na obrázku napr. 53,41 EUR; presnú sumu ukáže G2A).", "Vyber „Kredit- oder Debitkarte“ (kreditná/debetná karta) a klikni „Bezahlen mit Kredit- oder Debitkarte“ (= Zaplatiť kartou). Dole skontroluj „Gesamtbetrag“ = celková suma na zaplatenie (na obrázku napr. 53,41 EUR; presnú sumu ukáže G2A).", { imgPc: '/guide-img/g2a-azteco-3.jpg', imgMobile: '/guide-img/g2a-azteco-3.jpg' }),
        step('g2a-azteco-4', "Vyplň údaje SVOJEJ karty priamo na G2A: „Kartennummer“ = číslo karty, „Ablaufdatum“ = platnosť MM/RR, „CVV/CVC“ = 3 číslice zo zadnej strany, „Name des Karteninhabers“ = meno ako na karte. Klikni „Bestätigen“ (= Potvrdiť) a potvrď platbu v appke banky. Údaje karty nikdy nikomu inému nedávaj.", "Vyplň údaje SVOJEJ karty priamo na G2A: „Kartennummer“ = číslo karty, „Ablaufdatum“ = platnosť MM/RR, „CVV/CVC“ = 3 číslice zo zadnej strany, „Name des Karteninhabers“ = meno ako na karte. Klikni „Bestätigen“ (= Potvrdiť) a potvrď platbu v appke banky. Údaje karty nikdy nikomu inému nedávaj.", { imgPc: '/guide-img/g2a-azteco-4.jpg', imgMobile: '/guide-img/g2a-azteco-4.jpg' }),
        txt('Po platbe príde email od G2A → „Get order“ / „Display item“ – tam nájdete kód. Kód si uschovajte a nikomu ho neposielajte. Cez našu stránku sa kód nezadáva.', 'Email od G2A → „Get order“ / „Display item“ → kód. Nikomu ho neposielajte.'),
      ],
    },
    g2a_amazon: {
      title: 'Amazon darčeková karta cez G2A (návod)',
      info: true,
      tipSK: 'Len informačný návod. Kód kupónu je ako hotovosť — NIKOMU ho neposielajte (ani nám, ani do chatu). Cez našu stránku sa kód nezadáva.',
      tipCZ: 'Jen informační návod. Kód nikomu neposílejte; přes naši stránku se nezadává.',
      note: 'Informačný návod: Amazon darčekovú kartu kúpite na g2a.com pod VAŠÍM účtom (stránka G2A je v nemčine). Kód kupónu je ako hotovosť — nikdy ho nikomu neposielajte.',
      steps: [
        step('g2a-amazon-1', "Skontroluj „Region“ = GERMANY (Nemecko) a klikni „Add to cart“ / „In den Warenkorb“ (= Do košíka).", "Skontroluj „Region“ = GERMANY (Nemecko) a klikni „Add to cart“ / „In den Warenkorb“ (= Do košíka).", { imgPc: '/guide-img/g2a-amazon-1.jpg', imgMobile: '/guide-img/g2a-amazon-1.jpg' }),
        step('g2a-amazon-2', "Do políčka „Gib deine E-Mail-Adresse ein“ napíš svoj e-mail – sem príde kód. Políčko „Ein Konto für diese E-Mail-Adresse erstellen“ (vytvoriť účet) nemusíš zaškrtnúť. „Plus Premium“ nechaj vypnuté. Klikni „Weiter zur Zahlung“ (= Pokračovať k platbe).", "Do políčka „Gib deine E-Mail-Adresse ein“ napíš svoj e-mail – sem príde kód. Políčko „Ein Konto für diese E-Mail-Adresse erstellen“ (vytvoriť účet) nemusíš zaškrtnúť. „Plus Premium“ nechaj vypnuté. Klikni „Weiter zur Zahlung“ (= Pokračovať k platbe).", { imgPc: '/guide-img/g2a-amazon-2.jpg', imgMobile: '/guide-img/g2a-amazon-2.jpg' }),
        step('g2a-amazon-3', "Vyber „Kredit- oder Debitkarte“ (kreditná/debetná karta) a klikni „Bezahlen mit Kredit- oder Debitkarte“ (= Zaplatiť kartou). Dole skontroluj „Gesamtbetrag“ = celková suma na zaplatenie (na obrázku napr. 53,41 EUR; presnú sumu ukáže G2A).", "Vyber „Kredit- oder Debitkarte“ (kreditná/debetná karta) a klikni „Bezahlen mit Kredit- oder Debitkarte“ (= Zaplatiť kartou). Dole skontroluj „Gesamtbetrag“ = celková suma na zaplatenie (na obrázku napr. 53,41 EUR; presnú sumu ukáže G2A).", { imgPc: '/guide-img/g2a-amazon-3.jpg', imgMobile: '/guide-img/g2a-amazon-3.jpg' }),
        step('g2a-amazon-4', "Vyplň údaje SVOJEJ karty priamo na G2A: „Kartennummer“ = číslo karty, „Ablaufdatum“ = platnosť MM/RR, „CVV/CVC“ = 3 číslice zo zadnej strany, „Name des Karteninhabers“ = meno ako na karte. Klikni „Bestätigen“ (= Potvrdiť) a potvrď platbu v appke banky. Údaje karty nikdy nikomu inému nedávaj.", "Vyplň údaje SVOJEJ karty priamo na G2A: „Kartennummer“ = číslo karty, „Ablaufdatum“ = platnosť MM/RR, „CVV/CVC“ = 3 číslice zo zadnej strany, „Name des Karteninhabers“ = meno ako na karte. Klikni „Bestätigen“ (= Potvrdiť) a potvrď platbu v appke banky. Údaje karty nikdy nikomu inému nedávaj.", { imgPc: '/guide-img/g2a-amazon-4.jpg', imgMobile: '/guide-img/g2a-amazon-4.jpg' }),
        txt('Po platbe príde email od G2A → „Get order“ / „Display item“ – tam nájdete kód. Kód si uschovajte a nikomu ho neposielajte. Cez našu stránku sa kód nezadáva.', 'Email od G2A → „Get order“ / „Display item“ → kód. Nikomu ho neposielajte.'),
      ],
    },

    paysafecard: {
      title: 'PaysafeCard (návod)',
      info: true,
      tipSK: 'Len informačný návod. PIN je ako hotovosť — NIKOMU ho neposielajte (ani nám, ani cez chat). Viac na paysafecard.com.',
      tipCZ: 'Jen informační návod. PIN nikomu neposílejte. Více na paysafecard.com.',
      note: 'Informačný návod: PaysafeCard kúpite u autorizovaného predajcu alebo na paysafecard.com. PIN používajte len sami u obchodníka, ktorý PaysafeCard priamo akceptuje. Oficiálne info: https://www.paysafecard.com/sk/',
      steps: [
        step('herne-paysafe-1', 'Predajca: zvoľte nominál (10 / 25 / 50 / 100 €) → Kúpiť.', 'Predajca: nominál → Kúpiť.'),
        txt('Pri nákupe zadávate VAŠE vlastné údaje (meno, email). PIN príde na váš email.', 'Vaše údaje → PIN príde na váš email.'),
        txt('PIN zadávajte len sami v platobnom okne obchodníka, ktorý PaysafeCard akceptuje. PIN nikomu neposielajte.', 'PIN zadávajte len sami; nikomu ho neposielajte.'),
      ],
    },

    switchere_skrill: {
      title: 'Skrill',
      tipSK: 'Skrill cez Switchere. Prihlasujete sa do VLASTNÉHO Skrill účtu. Adresu peňaženky nemeňte.',
      tipCZ: 'Skrill přes Switchere — vlastní Skrill účet. Adresu peněženky neměňte.',
      note: OWN_DATA,
      steps: [
        step('checkout', 'Krok 1 – náš checkout: zadajte sumu v EUR a VÁŠ email → zvoľte Switchere.', 'Krok 1 – checkout: suma + váš email → Switchere.'),
        step('switchere', 'Krok 2 – súhrn objednávky: skontrolujte sumu; adresa peňaženky je predvyplnená (nemeňte) → „Otvoriť platobnú stránku“.', 'Krok 2 – súhrn → Otvoriť platobnú stránku.'),
        step('switchere-buy', 'Krok 3 – Switchere widget: „You send“ = EUR suma (nemeňte), „You get“ = mena je už nastavená. V „Payment method“ zvoľte Skrill → „Buy“.', 'Krok 3 – widget: Payment method → Skrill → Buy.'),
        step('switchere-otp', 'Krok 4 – Switchere prihlásenie/registrácia: zadajte VÁŠ email a heslo, potom kód, ktorý vám príde emailom.', 'Krok 4 – váš email + heslo → kód z emailu.'),
        txt('Krok 5 – overenie totožnosti (ak Switchere vyžiada): vaše meno a priezvisko ako v doklade, dátum narodenia, vaša adresa trvalého bydliska, foto vášho dokladu / selfie podľa pokynov na obrazovke.', 'Krok 5 – overenie: vaše meno ako v doklade, dátum narodenia, adresa, doklad.'),
        step('skrill', 'Krok 6 – Skrill okno: prihláste sa VAŠÍM Skrill emailom a heslom (2FA kód ak príde) → potvrďte platbu. Adresa peňaženky je už predvyplnená — nemeňte ju.', 'Krok 6 – Skrill: váš email + heslo → 2FA → potvrdiť. Adresu peňaženky nemeňte.'),
        shotStep()
      ],
    },

    btcpay: {
      title: 'Krypto (BTC / Lightning)',
      tipSK: 'Platba z vašej BTC/Lightning peňaženky na BTCPay faktúru.',
      tipCZ: 'Platba z vaší BTC/Lightning peněženky.',
      note: 'BTCPay Lite faktúra — žiadne osobné údaje sa nezadávajú.',
      steps: [
        step('checkout', 'Krok 1 – náš checkout: suma v EUR → Krypto.', 'Krok 1 – suma → Krypto.'),
        step('btcpay', 'Krok 2 – BTCPay faktúra: zvoľte „Bitcoin“ (on-chain) alebo „Lightning“. Naskenujte QR kód alebo skopírujte adresu a PRESNÚ sumu BTC do vašej peňaženky. Adresu ani sumu nemeňte.', 'Krok 2 – naskenujte QR (BTC alebo Lightning) vo vašej peňaženke.'),
        txt('Krok 3 – odošlite platbu pred vypršaním časovača na faktúre; faktúra sa po prijatí sama označí ako zaplatená.', 'Krok 3 – zaplaťte pred vypršaním časovača.'),
        shotStep()
      ],
    },

    is_transak: {
      title: 'Transak · karta',
      tipSK: 'Transak cez C2P.is — karta.',
      tipCZ: 'Transak přes C2P.is — karta.',
      note: 'Checkout → provider-pay (cieľová adresa + Kopírovať) → checkout.chain2pay.is / Transak.',
      steps: [
        step('checkout', 'Suma + email → Transak.', 'Mobil: suma + email → Transak.'),
        step('ramp', 'Skopírujte peňaženku ak treba → dokončite Transak checkout.', 'Mobil: Kopírovať adresu → Transak.'),
        shotStep()
      ],
    },
    is_transak_sepa: { aliasOf: 'is_transak', title: 'SEPA Transak' },
    is_alchemy: {
      title: 'Alchemy Pay',
      tipSK: 'Alchemy Pay cez C2P.is.',
      tipCZ: 'Alchemy Pay přes C2P.is.',
      note: 'Checkout → provider-pay → checkout.chain2pay.is / Alchemy Pay.',
      steps: [
        step('checkout', 'Suma + email → Alchemy Pay.', 'Mobil: suma + email → Alchemy.'),
        step('ramp', 'Skopírujte peňaženku ak treba → dokončite Alchemy checkout.', 'Mobil: Kopírovať adresu → Alchemy.'),
        shotStep()
      ],
    },
    kryptonim: {
      title: 'Kryptonim · karta',
      tipSK: 'Public buy.kryptonim.com (EUR→USDC Polygon). Skopírujte adresu z provider-pay.',
      tipCZ: 'Public buy.kryptonim.com. Zkopírujte adresu z provider-pay.',
      note: 'Lokálna stránka ukáže cieľovú USDC adresu + Kopírovať → Otvoriť buy.kryptonim.com/redirect-form.',
      steps: [
        step('checkout', 'Suma + email → Kryptonim.', 'Mobil: suma + email → Kryptonim.'),
        step('switchere', 'PC: skopírujte USDC adresu → „Pokračovať na platbu“ (buy.kryptonim.com).', 'Mobil: Kopírovať adresu → otvoriť Kryptonim.'),
        shotStep()
      ],
    },

  };

  const GROUP_FALLBACK = {
    cards: 'banxa',
    sepa: 'bank_sepa_manual',
    revolut: 'revolut',
    skrill: 'switchere_skrill',
    paysafecard: 'paysafecard',
    g2a_azteco: 'g2a_azteco',
    g2a_amazon: 'g2a_amazon',
    wallets: 'apple_google_banxa',
    crypto_btcpay: 'btcpay',
  };

  /** Short MP4 slideshow under /guides/video/ when PNG flow was captured. */
  function videoFor(providerId, guide) {
    if (guide && guide.video) return guide.video;
    const id = String(providerId || '').toLowerCase();
    if (/revolut/.test(id)) return '/guides/video/revolut.mp4';
    if (/banxa|sepa_instant/.test(id)) return '/guides/video/banxa.mp4';
    return null;
  }

  function resolveGuide(providerId, group) {
    if (!providerId) return null;
    let g = BY_ID[providerId];
    if (g && g.aliasOf) {
      const base = BY_ID[g.aliasOf] || {};
      const merged = {
        ...base,
        ...g,
        steps: base.steps,
        tipSK: g.tipSK || base.tipSK,
        tipCZ: g.tipCZ || base.tipCZ,
        video: g.video || base.video || null,
      };
      merged.video = videoFor(providerId, merged);
      return merged;
    }
    if (g) {
      return { ...g, video: videoFor(providerId, g) };
    }
    const fb = GROUP_FALLBACK[group];
    return fb ? resolveGuide(fb) : null;
  }

  function detectDevice() {
    try {
      if (global.matchMedia && global.matchMedia('(max-width: 640px)').matches) return 'mobile';
      if (/Android|iPhone|iPad|iPod|Mobile/i.test((global.navigator && global.navigator.userAgent) || '')) return 'mobile';
    } catch (_) {}
    return 'pc';
  }

  function modeDir() {
    return detectDevice() === 'mobile' ? 'mobile' : 'pc';
  }

  function stepsForDevice(guide, device) {
    if (!guide || !guide.steps) return [];
    const mobile = device === 'mobile';
    return guide.steps.map((s) => ({
      img: mobile ? s.imgMobile || s.imgPc || s.img : s.imgPc || s.imgMobile || s.img,
      fallback: s.fallback,
      caption: mobile ? s.captionMobile || s.caption : s.caption,
    }));
  }

  function tipFor(guide, country) {
    if (!guide) return '';
    return String(country || 'SK').toUpperCase() === 'CZ'
      ? guide.tipCZ || guide.tipSK || ''
      : guide.tipSK || guide.tipCZ || '';
  }

  // No identity autofill: customers type their OWN details at the provider.
  function needsAddressHelper() { return false; }
  function wantsAutofill() { return false; }

  global.PaymentGuides = {
    resolveGuide,
    stepsForDevice,
    detectDevice,
    modeDir,
    tipFor,
    needsAddressHelper,
    wantsAutofill,
    videoFor,
    BY_ID,
  };
})(typeof window !== 'undefined' ? window : global);
