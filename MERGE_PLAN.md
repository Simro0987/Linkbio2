# Fáza B – zlúčenie lnkbio + chain2pay-checkout do jednej aplikácie (plán)

Stav: **pripravené, nenasadené.** Fáza A (správa platobných metód z lnkbio adminu cez HMAC most) je live.

## Cieľ
Jeden repozitár/proces, jedno prihlásenie (lnkbio: bcrypt + TOTP, cookie `__Host-sid`), jeden dashboard,
nasadené na jednu existujúcu Render službu. Staré URL musia fungovať.

## Cieľová služba
`chain2pay-checkout-gl` (srv-db6i44jrjlhs73eslvrg) – drží externé callbacky, ktoré sa nesmú zmeniť:
- `GET /callback`, `/callback/` (CALLBACK_BASE_URL – Chain2Pay/Guardarian návrat)
- `POST /api/telegram/webhook`, `POST /api/telegram/support/webhook`
- BTCPay: checkout nemá BTCPay webhook endpoint (iba `/api/btcpay/address-status`, polling) → nič na prepojenie.
lnkbio externé endpointy: `POST /api/telegram/ideas/webhook`, `POST /api/agent/hook`, `/healthz`.

## Konflikty ciest (zistené)
| cesta | lnkbio | checkout | riešenie |
|---|---|---|---|
| `/admin`, `/admin/login`, `/admin/logout` | admin | admin | lnkbio admin = jediný; checkout admin presunúť pod `/admin/checkout/*`, staré `/admin/methods`, `/admin/sepa`, `/admin/azteco/*` → 301 |
| `/admin/azteco*` | lnkbio Azteco nástroj | checkout Azteco dôkazy | checkout → `/admin/checkout/azteco*` |
| `/api/backup/run` | lnkbio záloha | checkout záloha | `/api/backup/run` (checkout) + `/api/backup/lnkbio` |
| `/robots.txt` | áno | áno | zlúčiť |
| `/:slug/*` catch-all | TV stránky | – | registrovať až po všetkých checkout cestách (`/order`, `/status`, `/callback`, `/*-pay`, `/sepa-guided`, `/pm-logo`, …) a rezervovať tieto slugy |
| `/health` vs `/healthz` | `/healthz` | `/health` | obe ponechať |
| `/static` | lnkbio assety | checkout `public/` | lnkbio pod `/static`, checkout `public` na koreň – kontrola kolízií názvov |

## Postup
1. Vetva `merge` v checkout repo: `apps/lnkbio/` (kód lnkbio), `src/server.js` exportuje `app` namiesto `listen`; lnkbio `server.js` exportuje `{ app, init }` (dnes volá `process.exit` pri chýbajúcich env → zmeniť na throw).
2. Nový `index.js`: spoločný `express()`; poradie: checkout webhooky/API → checkout verejné stránky → lnkbio `/admin` → lnkbio verejné (`/:slug`). Helmet CSP sa líši (lnkbio striktné, checkout inline) → helmet per sub-app, nie globálne.
3. Jedno prihlásenie: checkout `requireAdmin` nahradiť kontrolou lnkbio session (zdieľaný `SESSION_SECRET` + tabuľka sessions v lnkbio DB). Checkout heslo zrušiť.
4. Env na checkout službe doplniť (kopírovať cez Render API, nevypisovať): `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `DATA_ENC_KEY`, `AGENT_HOOK_SECRET`, `RENDER_API_KEY`, lnkbio DB ako `LNKBIO_DATABASE_URL`, TG tokeny pre ideas bot.
5. Stará URL `lnkbio.onrender.com`: ponechať službu, nasadiť na nej malý proxy/redirect (301 na novú doménu pre GET, reverse-proxy pre `POST /api/telegram/ideas/webhook` a `/api/agent/hook`) – alebo prepnúť tieto webhooky cez setWebhook na novú URL.
6. Lokálny test na voľných portoch (nie 3847): všetky verejné cesty 200, admin → login, `/callback` odpovedá, telegram webhook s neplatným secretom 401, 390px bez horizontálneho scrollu.
7. Nasadenie mimo špičky, rollback = redeploy predchádzajúceho commitu (Render „Rollback“).

## Blokery / riziká
- Free tier pamäť: checkout má Playwright + sharp z lnkbio → riziko OOM (512 MB). Overiť pamäť pred nasadením.
- Dve odlišné prihlasovacie a session vrstvy, ~15 500 riadkov checkout kódu – nedá sa bezpečne prepísať bez testovacieho okna; ide o live platby.
- Zdieľaný `TELEGRAM_BOT_TOKEN` – jeden webhook na token; zlúčenie musí zachovať, ktorý proces drží webhook.
