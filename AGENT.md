# AGENT.md – lnkbio (TV Software)

Notes for automation agents (OpenHands, n8n, …) that will later run on a VPS. Nothing here needs a VPS today.

## Services
| | URL | Render service | Repo |
|---|---|---|---|
| lnkbio | https://lnkbio.onrender.com/tv | srv-db6q9k8u01pc73b5mjl0 | gitlab.com/Simro0987/linkbio |
| checkout | https://chain2pay-checkout-gl.onrender.com | srv-db6i44jrjlhs73eslvrg | gitlab.com/Simro0987/chain2pay-checkout (mirror github.com/Simro0987/Chain2pay-checkout) |

Health: `GET https://lnkbio.onrender.com/healthz` → `ok`, `GET https://chain2pay-checkout-gl.onrender.com/health` → 200.

## Agent hook  `POST /api/agent/hook`
Auth: HMAC-SHA256 with `AGENT_HOOK_SECRET` (Render env on lnkbio; never commit it).
Headers:
- `X-Agent-Timestamp`: unix seconds (±300 s)
- `X-Agent-Signature`: `sha256=` + hex(HMAC_SHA256(secret, timestamp + "." + rawBody))
- `Content-Type: application/json`
Replays (same signature) are rejected (409); 60 req/min/IP.

Body actions:
- `{"action":"status"}` → `{ok, lnkbio:{up,commit}, checkout:{up,ms}, monitors:[{name,status,ms,checked_at}], bots:{payments|support|ideas|admin: own|fallback|off}}`
- `{"action":"event","source":"n8n","text":"…"}` → audit log + Telegram message via **Admin bot**
- `{"action":"ping"}`

Example (bash):
```bash
ts=$(date +%s); body='{"action":"status"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$AGENT_HOOK_SECRET" -hex | sed 's/^.* //')
curl -s https://lnkbio.onrender.com/api/agent/hook -H "content-type: application/json" \
  -H "X-Agent-Timestamp: $ts" -H "X-Agent-Signature: sha256=$sig" -d "$body"
```

## Uptime (cron-job.org, free)
1. Job „lnkbio healthz“: `https://lnkbio.onrender.com/healthz`, every 5 min, enable *Notify on failure* (e-mail).
2. Job „checkout health“: `https://chain2pay-checkout-gl.onrender.com/health`, every 5 min, notify on failure.
3. Job „Telegram alert“: `https://lnkbio.onrender.com/api/status-alert?token=<TOKEN>` every 5 min.
   The full URL with token is shown in **/admin/agent** (token = HMAC of AGENT_HOOK_SECRET; rotate the secret in /admin/kluce to change it).
   The endpoint probes both services (retry after 15 s) and sends 🔴/🟢 via the **Admin bot** (max 1 alert / 30 min per service).
   If lnkbio itself is down, job 1's e-mail is the alert (the alert endpoint lives on lnkbio).

## Telegram bots (all optional, fallback → Platby bot)
| env | purpose | where |
|---|---|---|
| TELEGRAM_PAYMENTS_BOT_TOKEN (alias TELEGRAM_BOT_TOKEN) | orders, proofs, ✅/❌, Azteco | checkout + lnkbio |
| TELEGRAM_SUPPORT_BOT_TOKEN | chat escalations, customer DMs, owner replies → widget | checkout, webhook `/api/telegram/support/webhook` |
| TELEGRAM_IDEAS_BOT_TOKEN | public suggestions bot + „Návrhy“ form | lnkbio, webhook `/api/telegram/ideas/webhook` |
| TELEGRAM_ADMIN_BOT_TOKEN | downtime, monitor, backups, security, key changes, agent events | lnkbio |
Owner chat: TELEGRAM_ADMIN_CHAT_ID (send /start to every bot once). Each webhook has its own secret (derived via HMAC, never the bot token).

## Rules for agents
- Never print or commit secrets; change keys only via /admin/kluce (password-confirmed, audited).
- Keep CSP (no inline scripts), CSRF on admin forms, rate limits, admin auth + 2FA.
- Commit as `Simro0987 <Simro0987@users.noreply.gitlab.com>`; Render auto-deploys `main`.
- Azteco: destination is Ryan's first enabled BTC address from 👛 Adresy peňaženiek (baseline balance is recorded, the voucher is confirmed by the balance increase). BTCPay is used ONLY for the „BTCPay“ checkout option.
- Never generate wallets/keys/seeds; only store public addresses typed by the admin.

## Wallet addresses + amount links (checkout = source of truth, Neon)
- Checkout admin: `/admin/wallets` (👛 Adresy peňaženiek) and `/admin/amount-links` (🔗 Odkazy podľa sumy).
- lnkbio admin: `/admin/penazenky` and `/admin/odkazy-podla-sumy` → signed bridge `POST /api/admin-bridge/wallets` and `/api/admin-bridge/amount-links` (same HMAC as `/api/admin-bridge/pay-methods`, env `PAY_ADMIN_BRIDGE_SECRET` on BOTH services, ±300 s, replay 409, 120/min).
- Wallets: network, label, address, memo/tag, enabled, order; checksum-validated (Slovak errors), full-address confirm step before save (`confirm:true`), audit table `wallet_address_audit` + Telegram on every change. Checkout uses the first enabled address per network; networks without one are hidden on `/crypto-pay`.
- Amount links: method + exact EUR amount + https link (tables `pay_amount_links`, `pay_amount_links_audit`). Exact match on checkout → `/link-pay` with only a „Zaplatiť“ button (link never sent to the browser, redirect via POST `/link-pay/go/:id`); no match → normal flow and guides.
