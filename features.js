'use strict';
const { tx } = require('./uitext');
// lnkbio add-ons: TOTP 2FA, API keys panel (Render env), service status monitor, daily encrypted Telegram backup.
const crypto = require('crypto');
const zlib = require('zlib');
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const totp = require('./totp');

module.exports = function install(ctx) {
  const { app, admin, pool, getSettings, setSettings, page, esc, hid, csrf, needAuth, lockedFor, recordFail, fails, currentHash, encV, decV, wrap, writeSess, dropCache, buildExport, safeUrl, chTree, PROD } = ctx;
  const TZ = 'Europe/Zurich';
  const fmtT = (d, lang) => d ? new Date(d).toLocaleString(lang === 'en' ? 'en-GB' : 'sk-SK', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '—';
  const setRaw = async (k, v) => { await pool.query(`INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, encV(k, v)]); dropCache(); };
  const ipOf = (req) => req.ip;
  async function audit(req, action, detail = '') {
    try { await pool.query(`INSERT INTO audit_log (ip, action, detail) VALUES ($1,$2,$3)`, [String(ipOf(req) || '').slice(0, 64), action, String(detail).slice(0, 300)]); } catch (e) { console.error('audit', e.message); }
  }
  const nav = `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="/admin/2fa">🔐 2FA</a><a class="btnl" href="/admin/kluce">🔑 API kľúče</a><a class="btnl" href="/admin/stav">📡 Stav služieb</a></p>`;

  // ================= TOTP 2FA =================
  const MFA_TTL = 5 * 60e3;
  admin.get('/login/2fa', (req, res) => {
    if (req.sess.auth) return res.redirect(303, '/admin');
    if (!req.sess.mfa || Date.now() - req.sess.mfaAt > MFA_TTL) return res.redirect(303, '/admin/login');
    const e = req.query.e === '1' ? '<div class="msg err">Nesprávny kód.</div>' : req.query.e === 'l' ? '<div class="msg err">Príliš veľa pokusov. Skúste neskôr.</div>' : '';
    res.send(page('Overenie 2FA', `<h1>Overenie</h1>${e}<form method="post" action="/admin/login/2fa" class="card">${hid(req)}<label for="c">6-miestny kód z aplikácie (alebo záložný kód)</label><input id="c" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="20" autofocus><button>Overiť</button></form><p class="hint"><a href="/admin/login">← Späť</a></p>`, 'adm login'));
  });
  admin.post('/login/2fa', csrf, wrap(async (req, res) => {
    const ip = ipOf(req);
    if (!req.sess.mfa || Date.now() - req.sess.mfaAt > MFA_TTL) return res.redirect(303, '/admin/login');
    if (lockedFor(ip)) return res.redirect(303, '/admin/login/2fa?e=l');
    const s = await getSettings();
    if (s.totp_on !== '1') return res.redirect(303, '/admin/login');
    const code = String(req.body.code || '').trim().slice(0, 20);
    let good = false, how = 'totp';
    if (/^\d{6}$/.test(code)) {
      const st = totp.verify(s.totp_secret, code);
      if (st > 0 && st > Number(s.totp_last || 0)) { good = true; await setRaw('totp_last', String(st)); }
    } else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code)) {
      const norm = code.toLowerCase().replace('-', '');
      const list = JSON.parse(s.totp_rc || '[]');
      for (let i = 0; i < list.length; i++) if (await bcrypt.compare(norm, list[i])) { list.splice(i, 1); await setRaw('totp_rc', JSON.stringify(list)); good = true; how = 'recovery'; break; }
    }
    if (!good) {
      recordFail(ip);
      const n = (req.sess.mfaN || 0) + 1;
      if (n >= 5) { writeSess(res, { auth: false, csrf: crypto.randomBytes(24).toString('base64url') }); return res.redirect(303, '/admin/login?e=l'); }
      writeSess(res, { ...req.sess, mfaN: n });
      return res.redirect(303, '/admin/login/2fa?e=1');
    }
    fails.delete(ip);
    writeSess(res, { auth: true, pv: req.sess.pv, csrf: crypto.randomBytes(24).toString('base64url') });
    await audit(req, 'login_2fa', how);
    res.redirect(303, '/admin');
  }));

  const genCodes = () => Array.from({ length: 10 }, () => { const r = crypto.randomBytes(8); let o = ''; for (const b of r) o += 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]; return o; });
  const codesHtml = (codes) => `<div class="card"><h2>Záložné kódy (zobrazené iba raz!)</h2><p class="hint">Uložte si ich bezpečne. Každý kód funguje len raz, ak stratíte telefón.</p><div class="codes">${codes.map((c) => `<div>${esc(c.slice(0, 4) + '-' + c.slice(4))}</div>`).join('')}</div></div>`;
  async function pwOk(req) {
    const ip = ipOf(req);
    if (lockedFor(ip)) return 'lock';
    if (!(await bcrypt.compare(String(req.body.password || '').slice(0, 200), await currentHash()))) { recordFail(ip); return 'bad'; }
    return 'ok';
  }
  const M2 = { started: 'Naskenujte QR kód a zadajte kód na potvrdenie.', bad: 'Nesprávny kód.', badpw: 'Nesprávne heslo.', lock: 'Príliš veľa pokusov. Skúste neskôr.', off: '2FA bolo vypnuté.' };
  admin.get('/2fa', needAuth, wrap(async (req, res) => {
    const s = await getSettings();
    const m = M2[req.query.m] ? `<div class="msg${/^(bad|badpw|lock)$/.test(req.query.m) ? ' err' : ''}">${esc(M2[req.query.m])}</div>` : '';
    let body;
    if (s.totp_on === '1') {
      const left = JSON.parse(s.totp_rc || '[]').length;
      body = `<div class="card"><h2>✅ 2FA je zapnuté</h2><p>Zostávajúce záložné kódy: <b>${left}</b> / 10</p></div>
<form method="post" action="/admin/2fa/recovery" class="card">${hid(req)}<h2>Nové záložné kódy</h2><p class="hint">Staré kódy prestanú platiť.</p><label>Heslo</label><input type="password" name="password" required maxlength="200" autocomplete="current-password"><label>Kód z aplikácie</label><input name="code" inputmode="numeric" required maxlength="6"><button>Vygenerovať</button></form>
<form method="post" action="/admin/2fa/disable" class="card">${hid(req)}<h2>Vypnúť 2FA</h2><label>Heslo</label><input type="password" name="password" required maxlength="200" autocomplete="current-password"><label>Kód z aplikácie</label><input name="code" inputmode="numeric" required maxlength="6"><button class="d">Vypnúť 2FA</button></form>`;
    } else if (s.totp_pending) {
      const svg = await QRCode.toString(totp.uri(s.totp_pending, 'admin', 'TV Software lnkbio'), { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
      body = `<div class="card"><h2>1. Naskenujte QR kód</h2><p class="hint">Google Authenticator, Aegis, 1Password, Authy…</p><div class="qrbox">${svg}</div><p>Alebo zadajte kľúč ručne:</p><p class="mono">${esc(s.totp_pending.replace(/(.{4})/g, '$1 ').trim())}</p></div>
<form method="post" action="/admin/2fa/enable" class="card">${hid(req)}<h2>2. Potvrďte kód</h2><label>6-miestny kód</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6"><button>Zapnúť 2FA</button></form>
<form method="post" action="/admin/2fa/cancel">${hid(req)}<button class="g">Zrušiť nastavenie</button></form>`;
    } else {
      body = `<div class="card"><h2>2FA je vypnuté</h2><p>Po zapnutí bude prihlásenie vyžadovať heslo + 6-miestny kód z aplikácie (TOTP).</p><form method="post" action="/admin/2fa/start">${hid(req)}<button>Nastaviť 2FA</button></form></div>`;
    }
    res.send(page('2FA', `<h1>Dvojfaktorové overenie</h1>${nav}${m}${body}`, 'a adm'));
  }));
  admin.post('/2fa/start', needAuth, csrf, wrap(async (req, res) => {
    const s = await getSettings(); if (s.totp_on === '1') return res.redirect(303, '/admin/2fa');
    await setRaw('totp_pending', totp.generateSecret()); res.redirect(303, '/admin/2fa?m=started');
  }));
  admin.post('/2fa/cancel', needAuth, csrf, wrap(async (req, res) => { await setRaw('totp_pending', ''); res.redirect(303, '/admin/2fa'); }));
  admin.post('/2fa/enable', needAuth, csrf, wrap(async (req, res) => {
    const ip = ipOf(req); if (lockedFor(ip)) return res.redirect(303, '/admin/2fa?m=lock');
    const s = await getSettings(); if (s.totp_on === '1' || !s.totp_pending) return res.redirect(303, '/admin/2fa');
    const st = totp.verify(s.totp_pending, req.body.code);
    if (st < 0) { recordFail(ip); return res.redirect(303, '/admin/2fa?m=bad'); }
    const codes = genCodes();
    const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
    for (const [k, v] of Object.entries({ totp_secret: s.totp_pending, totp_pending: '', totp_rc: JSON.stringify(hashes), totp_last: String(st), totp_on: '1' })) await setRaw(k, v);
    await audit(req, '2fa_enable');
    res.send(page('2FA zapnuté', `<h1>2FA je zapnuté ✅</h1>${codesHtml(codes)}<p><a class="btnl" href="/admin/2fa">Pokračovať</a></p>`, 'a adm'));
  }));
  async function pwAndCode(req) {
    const p = await pwOk(req); if (p !== 'ok') return p === 'lock' ? 'lock' : 'badpw';
    const s = await getSettings(); const st = totp.verify(s.totp_secret, req.body.code);
    if (st < 0 || st <= Number(s.totp_last || 0)) { recordFail(ipOf(req)); return 'bad'; }
    await setRaw('totp_last', String(st)); return 'ok';
  }
  admin.post('/2fa/disable', needAuth, csrf, wrap(async (req, res) => {
    const r = await pwAndCode(req); if (r !== 'ok') return res.redirect(303, '/admin/2fa?m=' + r);
    for (const k of ['totp_on', 'totp_secret', 'totp_rc', 'totp_pending']) await setRaw(k, '');
    await audit(req, '2fa_disable'); res.redirect(303, '/admin/2fa?m=off');
  }));
  admin.post('/2fa/recovery', needAuth, csrf, wrap(async (req, res) => {
    const r = await pwAndCode(req); if (r !== 'ok') return res.redirect(303, '/admin/2fa?m=' + r);
    const codes = genCodes(); await setRaw('totp_rc', JSON.stringify(await Promise.all(codes.map((c) => bcrypt.hash(c, 10)))));
    await audit(req, '2fa_recovery_regen');
    res.send(page('Záložné kódy', `<h1>Nové záložné kódy</h1>${codesHtml(codes)}<p><a class="btnl" href="/admin/2fa">Pokračovať</a></p>`, 'a adm'));
  }));

  // ================= API keys panel (write-only, Render env) =================
  const SVC = { checkout: process.env.CHECKOUT_SERVICE_ID || 'srv-db6i44jrjlhs73eslvrg', lnkbio: process.env.LNKBIO_SERVICE_ID || 'srv-db6q9k8u01pc73b5mjl0' };
  async function renderApi(method, p, body, key = process.env.RENDER_API_KEY) {
    if (!key) throw new Error('RENDER_API_KEY nie je nastavený na lnkbio');
    const r = await fetch('https://api.render.com/v1' + p, { method, headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Render API ${method} ${p.split('/').slice(0, 3).join('/')} → HTTP ${r.status}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }
  const TG = true;
  const tgJson = async (u) => (await fetch(u, { signal: AbortSignal.timeout(10000) })).json();
  const SECRETS = {
    TELEGRAM_PAYMENTS_BOT_TOKEN: { name: '💳 Platby bot', desc: 'Nové objednávky, dôkazy o platbe, tlačidlá ✅/❌, výsledky Azteco. Záložný bot pre všetky ostatné (ak ich token chýba).', svc: ['checkout', 'lnkbio'], re: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/, hint: 'formát 123456789:AA…', TG,
      test: async (v) => { const j = await tgJson(`https://api.telegram.org/bot${v}/getMe`); if (!j.ok) throw new Error('Telegram getMe zlyhalo – token je neplatný'); return '@' + j.result.username; } },
    TELEGRAM_SUPPORT_BOT_TOKEN: { name: '🛟 Support bot', desc: 'Eskalácie z chatbota, správy zákazníkov; vaše odpovede (Reply) sa vrátia do chat widgetu. Webhook /api/telegram/support/webhook na checkoute (vlastné tajomstvo).', svc: ['checkout'], re: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/, hint: 'formát 123456789:AA…', TG,
      test: async (v) => { const j = await tgJson(`https://api.telegram.org/bot${v}/getMe`); if (!j.ok) throw new Error('Telegram getMe zlyhalo – token je neplatný'); return '@' + j.result.username; } },
    TELEGRAM_IDEAS_BOT_TOKEN: { name: '💡 Návrhy bot', desc: 'Verejný bot – ľudia posielajú návrhy, bot poďakuje a prepošle vám; aj formulár „Návrhy“ na webe. Webhook /api/telegram/ideas/webhook na lnkbio.', svc: ['lnkbio'], re: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/, hint: 'formát 123456789:AA…', TG, ideas: true,
      test: async (v) => { const j = await tgJson(`https://api.telegram.org/bot${v}/getMe`); if (!j.ok) throw new Error('Telegram getMe zlyhalo – token je neplatný'); return '@' + j.result.username; } },
    TELEGRAM_ADMIN_BOT_TOKEN: { name: '🛡 Admin bot', desc: 'Výpadky webu, monitor služieb, denné zálohy, bezpečnostné udalosti (zlyhané prihlásenia, blokovanie), zmeny kľúčov, udalosti agenta.', svc: ['lnkbio'], re: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/, hint: 'formát 123456789:AA…', TG,
      test: async (v) => { const j = await tgJson(`https://api.telegram.org/bot${v}/getMe`); if (!j.ok) throw new Error('Telegram getMe zlyhalo – token je neplatný'); return '@' + j.result.username; } },
    PAY_ADMIN_BRIDGE_SECRET: { name: '💳 Most pre platobné metódy', desc: 'HMAC tajomstvo, cez ktoré lnkbio admin spravuje spôsoby platby checkoutu (sekcia 💳 Platobné metódy). Musí byť rovnaké na oboch službách.', svc: ['checkout', 'lnkbio'], re: /^[A-Za-z0-9_-]{32,128}$/, hint: '32–128 znakov A-Z a-z 0-9 _ -' },
    AGENT_HOOK_SECRET: { name: '🤖 Agent hook secret', desc: 'HMAC tajomstvo pre /api/agent/hook a token pre /api/status-alert.', svc: ['lnkbio'], re: /^[A-Za-z0-9_-]{32,128}$/, hint: '32–128 znakov' },
    TELEGRAM_BOT_TOKEN: { name: 'Telegram bot token (starý alias Platby bota)', desc: 'Pôvodný kľúč – používa sa, ak TELEGRAM_PAYMENTS_BOT_TOKEN nie je nastavený.', svc: ['checkout', 'lnkbio'], re: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/, hint: 'formát 123456789:AA…',
      test: async (v) => { const j = await tgJson(`https://api.telegram.org/bot${v}/getMe`); if (!j.ok) throw new Error('Telegram getMe zlyhalo – token je neplatný'); return '@' + j.result.username; } },
    TELEGRAM_ADMIN_CHAT_ID: { name: 'Telegram owner chat ID', svc: ['checkout', 'lnkbio'], re: /^-?\d{3,20}$/, hint: 'číselné ID chatu',
      test: async (v) => { const t = process.env.TELEGRAM_BOT_TOKEN; if (!t) return 'bez overenia (chýba token)'; const j = await tgJson(`https://api.telegram.org/bot${t}/getChat?chat_id=${encodeURIComponent(v)}`); if (!j.ok) throw new Error('Bot tento chat nevidí (getChat). Najprv pošlite botovi /start.'); return 'chat ok'; } },
    GEMINI_API_KEY: { name: 'Gemini API kľúč (chatbot)', svc: ['checkout'], re: /^[A-Za-z0-9_-]{30,64}$/,
      test: async (v) => { const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': v }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('Gemini models.list zlyhalo (HTTP ' + r.status + ')'); return 'models ok'; } },
    TELEGRAM_WEBHOOK_SECRET: { name: 'Telegram webhook secret', svc: ['checkout'], re: /^[A-Za-z0-9_-]{16,256}$/, hint: '16–256 znakov A-Z a-z 0-9 _ -' },
    BTCPAY_API_KEY: { name: 'BTCPay API kľúč', svc: ['checkout'], re: /^[A-Za-z0-9_-]{20,128}$/ },
    RENDER_API_KEY: { name: 'Render API kľúč (pre tento panel)', svc: ['lnkbio'], re: /^rnd_[A-Za-z0-9]{20,80}$/,
      test: async (v) => { await renderApi('GET', '/services?limit=1', null, v); return 'Render ok'; } },
  };
  const KM = { ok: 'Uložené. Prebieha redeploy dotknutých služieb (1–3 min).', badpw: 'Nesprávne heslo.', lock: 'Príliš veľa pokusov. Skúste neskôr.', badfmt: 'Neplatný formát hodnoty.', test: 'Test hodnoty zlyhal.', render: 'Zápis do Render zlyhal.', nokey: 'Neznámy kľúč.' };
  admin.get('/kluce', needAuth, wrap(async (req, res) => {
    const s = await getSettings(); const meta = JSON.parse(s.sec_meta || '{}');
    const m = KM[req.query.m] ? `<div class="msg${req.query.m === 'ok' ? '' : ' err'}">${esc(KM[req.query.m])}${req.query.d ? ' ' + esc(String(req.query.d).slice(0, 200)) : ''}</div>` : '';
    const aud = (await pool.query(`SELECT at,ip,action,detail FROM audit_log ORDER BY id DESC LIMIT 25`)).rows;
    const rows = Object.entries(SECRETS).map(([k, d]) => `<form method="post" action="/admin/kluce/${k}" class="card" autocomplete="off">${hid(req)}<h2>${esc(d.name)}</h2>
${d.desc ? `<p>${esc(d.desc)}</p>` : ''}<p class="hint"><code>${k}</code> → ${d.svc.join(' + ')}${d.TG ? ` · ${process.env[k] ? 'vlastný token aktívny' : 'nenastavený → používa sa Platby bot'}` : ''} · ${meta[k] ? `aktuálne …${esc(meta[k].last4)} · zmenené ${esc(fmtT(meta[k].at))}` : 'nezmenené cez panel'}</p>
<label>Nová hodnota${d.hint ? ' (' + esc(d.hint) + ')' : ''}</label><input type="password" name="value" required maxlength="300" autocomplete="new-password" spellcheck="false">
<label>Vaše admin heslo (potvrdenie)</label><input type="password" name="password" required maxlength="200" autocomplete="current-password"><button>Overiť a uložiť</button></form>`).join('');
    res.send(page('API kľúče', `<h1>API kľúče</h1>${nav}${m}<p class="hint">Hodnoty sa nikdy nezobrazujú späť (len posledné 4 znaky). Pred uložením sa overí formát a funkčnosť, potom sa zapíšu do Render env a služby sa redeployujú. Po zmene Telegram tokenu checkout pri štarte znova zaregistruje webhook.</p>${process.env.RENDER_API_KEY ? '' : '<div class="msg err">RENDER_API_KEY nie je nastavený – ukladanie nebude fungovať.</div>'}${rows}
<div class="card"><h2>Audit log</h2><table class="aud">${aud.map((a) => `<tr><td>${esc(fmtT(a.at))}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td><td>${esc(a.ip)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</table></div>`, 'a adm'));
  }));
  admin.post('/kluce/:key', needAuth, csrf, wrap(async (req, res) => {
    const k = String(req.params.key), d = SECRETS[k];
    const back = (m, x = '') => res.redirect(303, '/admin/kluce?m=' + m + (x ? '&d=' + encodeURIComponent(x) : ''));
    if (!d) return back('nokey');
    const p = await pwOk(req); if (p !== 'ok') { await audit(req, 'secret_update_denied', k); return back(p === 'lock' ? 'lock' : 'badpw'); }
    const v = String(req.body.value || '').trim();
    if (!d.re.test(v)) { await audit(req, 'secret_update_badformat', k); return back('badfmt'); }
    let info = 'formát ok';
    if (d.test) { try { info = await d.test(v); } catch (e) { await audit(req, 'secret_update_testfail', k); return back('test', e.message); } }
    try {
      for (const svc of d.svc) await renderApi('PUT', `/services/${SVC[svc]}/env-vars/${k}`, { value: v });
    } catch (e) { await audit(req, 'secret_update_renderfail', k); return back('render', e.message); }
    const s = await getSettings(); const meta = JSON.parse(s.sec_meta || '{}');
    meta[k] = { last4: v.slice(-4), at: new Date().toISOString() };
    await setRaw('sec_meta', JSON.stringify(meta));
    await audit(req, 'secret_updated', `${k} → ${d.svc.join('+')} (${info})`);
    // deploy other services first, self last (this process will be replaced)
    const order = d.svc.slice().sort((a) => (a === 'lnkbio' ? 1 : -1));
    const errs = [];
    for (const svc of order) { try { await renderApi('POST', `/services/${SVC[svc]}/deploys`, { clearCache: 'do_not_clear' }); } catch (e) { errs.push(e.message); } }
    if (d.svc.includes('lnkbio')) process.env[k] = v;
    if (d.ideas && ctx.registerIdeasWebhook) { try { await ctx.registerIdeasWebhook(v); info += ' · webhook ok'; } catch (e) { errs.push('webhook: ' + e.message); } }
    if (ctx.notify) ctx.notify('admin', `🔑 Kľúč ${k} zmenený cez admin (…${v.slice(-4)}) z IP ${String(ipOf(req)).slice(0, 45)}`).catch(() => {});
    await audit(req, 'redeploy', order.join('+') + (errs.length ? ' ERR ' + errs.join('; ') : ''));
    back('ok', info + (errs.length ? ' · redeploy chyba: ' + errs.join('; ') : ''));
  }));

  // ================= service status monitor =================
  function privateIp(ip) {
    if (net.isIPv4(ip)) {
      const [a, b] = ip.split('.').map(Number);
      return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    const x = String(ip).toLowerCase();
    if (x === '::' || x === '::1') return true;
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return privateIp(m[1]);
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || /^64:ff9b:/.test(x) || /^2001:db8/.test(x) || /^::ffff:/.test(x) || /^::[0-9a-f]/.test(x) || /^2002:/.test(x) || /^100::/.test(x);
  }
  async function safeLookup(host) {
    host = host.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) { if (privateIp(host)) throw new Error('blocked'); return { address: host, family: net.isIP(host) }; }
    if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('blocked');
    const all = await dns.lookup(host, { all: true });
    if (!all.length || all.some((a) => privateIp(a.address))) throw new Error('blocked');
    return all[0];
  }
  function probe(url) {
    return new Promise((resolve) => {
      const t0 = Date.now(); let u;
      try { u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return resolve({ ok: false, ms: 0, err: 'url' }); }
      safeLookup(u.hostname).then((addr) => {
        const mod = u.protocol === 'https:' ? https : http;
        // DNS pinned to the validated address (no rebinding); redirects are NOT followed
        const rq = mod.request(u, { method: 'GET', timeout: 8000, servername: net.isIP(u.hostname) ? undefined : u.hostname, headers: { 'user-agent': 'lnkbio-status/1.0', accept: '*/*' },
          lookup: (h, o, cb) => (o && o.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)) }, (r) => { const ms = Date.now() - t0; r.destroy(); resolve({ ok: r.statusCode < 400, code: r.statusCode, ms }); });
        rq.on('timeout', () => rq.destroy(new Error('timeout')));
        rq.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, err: e.message }));
        rq.end();
      }).catch(() => resolve({ ok: false, ms: 0, err: 'blocked' }));
    });
  }
  let mcache = null;
  const getMon = async () => mcache || (mcache = (await pool.query(`SELECT id,pos,name,url,channel,show_home,msg_up,msg_slow,msg_down,status,ms,checked_at,hist FROM monitors ORDER BY pos,id`)).rows);
  async function checkOne(m) {
    const r = await probe(m.url);
    const status = !r.ok ? 'down' : r.ms > 3000 ? 'slow' : 'up';
    const cutoff = Date.now() - 24 * 3600e3;
    const hist = (Array.isArray(m.hist) ? m.hist : []).filter((h) => h[0] > cutoff).slice(-299);
    hist.push([Date.now(), status === 'up' ? 1 : status === 'slow' ? 2 : 0, r.ms]);
    if (m.status && m.status !== status && (status === 'down' || m.status === 'down') && ctx.notify) ctx.notify('admin', status === 'down' ? `🔴 Monitor: ${m.name} má výpadok (${r.code || r.err || 'chyba'})` : `🟢 Monitor: ${m.name} opäť funguje (${status})`).catch(() => {});
    await pool.query(`UPDATE monitors SET status=$1, ms=$2, checked_at=now(), hist=$3::jsonb WHERE id=$4`, [status, r.ms, JSON.stringify(hist), m.id]);
    return { status, ms: r.ms, err: r.err };
  }
  async function checkAll() {
    const list = await getMon(); let i = 0;
    const worker = async () => { while (i < list.length) { const m = list[i++]; try { await checkOne(m); } catch (e) { console.error('monitor', m.id, e.message); } } };
    await Promise.all([worker(), worker(), worker()]);
    mcache = null;
  }
  const STXT = {
    sk: { up: (n) => `✅ ${n} funguje`, slow: (n) => `⚠️ ${n} je pomalé`, down: (n) => `❌ ${n} má výpadok`, '': (n) => `⏳ ${n}: prebieha kontrola` },
    en: { up: (n) => `✅ ${n} is up`, slow: (n) => `⚠️ ${n} is slow`, down: (n) => `❌ ${n} is down`, '': (n) => `⏳ ${n}: checking` },
  };
  function msgFor(m, lang) {
    const st = m.status || '';
    const custom = st === 'up' ? m.msg_up : st === 'slow' ? m.msg_slow : st === 'down' ? m.msg_down : '';
    return custom || (STXT[lang] || STXT.sk)[st](m.name);
  }
  const pubItem = (m, lang) => ({ cls: m.status || '', msg: msgFor(m, lang), at: m.checked_at });
  ctx.monitorBanner = async (lang) => {
    const ms = (await getMon()).filter((m) => m.show_home);
    if (!ms.length) return '';
    return `<div class="sbanner" role="status">${ms.map((m) => { const p = pubItem(m, lang); return `<div class="${esc(p.cls)}"><span class="dot ${esc(p.cls)}"></span>${esc(p.msg)}</div>`; }).join('')}</div>`;
  };
  ctx.monitorBadge = async (ref, lang) => {
    const ms = (await getMon()).filter((m) => m.channel && m.channel === ref);
    return ms.map((m) => { const p = pubItem(m, lang); return `<span class="tbadge"><span class="dot ${esc(p.cls)}"></span>${esc(p.msg)}</span>`; }).join('');
  };
  ctx.dropMon = () => { mcache = null; };
  // channel list for the public 'Kanály' section – single source of truth = monitors (Stav služieb)
  ctx.monitorChannels = async (lang) => {
    const L = { up: 'Funguje', slow: 'Pomalé', down: 'Výpadok', '': 'Kontroluje sa' };
    return (await getMon()).map((m) => ({ name: m.name, cls: m.status || '', label: L[m.status || ''] || L[''] }));
  };
  ctx.monitorPage = async (lang) => {
    const ms = await getMon();
    return `<ul class="stl">${ms.map((m) => { const p = pubItem(m, lang); return `<li><span class="dot ${esc(p.cls)}"></span><span class="sm">${esc(p.msg)}</span><span class="st">${tx(lang === 'en', 'Posledná kontrola', 'Last check')}: ${esc(fmtT(p.at, lang))}</span></li>`; }).join('') || `<li>${tx(lang === 'en', 'Zatiaľ nie sú sledované žiadne služby.', 'No services are monitored yet.')}</li>`}</ul>`;
  };

  const MM = { ok: 'Uložené.', badurl: 'Neplatná URL (len http/https, verejná adresa – súkromné/lokálne IP sú zakázané).', badname: 'Chýba názov.', checked: 'Kontrola dokončená.', needconfirm: 'Zmazanie treba potvrdiť zaškrtnutím.' };
  async function monInput(req) {
    const name = String(req.body.name || '').trim().slice(0, 60); if (!name) return { err: 'badname' };
    const url = safeUrl(req.body.url); if (!url) return { err: 'badurl' };
    try { await safeLookup(new URL(url).hostname); } catch { return { err: 'badurl' }; }
    const t = (k) => String(req.body[k] || '').trim().slice(0, 120);
    return { name, url, channel: String(req.body.channel || '').slice(0, 120), show_home: req.body.show_home === '1', msg_up: t('msg_up'), msg_slow: t('msg_slow'), msg_down: t('msg_down') };
  }
  admin.get('/stav', needAuth, wrap(async (req, res) => {
    const s = await getSettings(); const ms = await getMon(); const tree = await chTree();
    const opts = [['', '— bez prepojenia —']];
    for (const [r, m] of tree) { opts.push([r, r]); for (const c of m.keys()) opts.push([r + ' › ' + c, r + ' › ' + c]); }
    const selCh = (cur) => `<select name="channel">${opts.map(([v, n]) => `<option value="${esc(v)}"${v === (cur || '') ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    const form = (m = {}) => `<label>Názov (napr. TV)</label><input name="name" value="${esc(m.name || '')}" maxlength="60" required>
<label>URL na kontrolu (nezobrazí sa verejne)</label><input name="url" type="url" value="${esc(m.url || '')}" maxlength="2000" required placeholder="https://">
<label>Prepojiť s kanálom / kategóriou (voliteľné)</label>${selCh(m.channel)}
<label class="ck"><input type="checkbox" name="show_home" value="1"${m.show_home ? ' checked' : ''}> Zobraziť na hlavnej stránke</label>
<label>Text – funguje (prázdne = „✅ ${esc(m.name || 'Názov')} funguje“)</label><input name="msg_up" value="${esc(m.msg_up || '')}" maxlength="120">
<label>Text – pomalé (prázdne = „⚠️ … je pomalé“)</label><input name="msg_slow" value="${esc(m.msg_slow || '')}" maxlength="120">
<label>Text – výpadok (prázdne = „❌ … má výpadok“)</label><input name="msg_down" value="${esc(m.msg_down || '')}" maxlength="120">`;
    const m0 = MM[req.query.m] ? `<div class="msg${/^(ok|checked)$/.test(req.query.m) ? '' : ' err'}">${esc(MM[req.query.m])}</div>` : '';
    const rows = ms.map((m) => `<details class="card"><summary><span class="dot ${esc(m.status || '')}"></span>${esc(msgFor(m, 'sk'))} <span class="hint">${m.ms != null ? m.ms + ' ms · ' : ''}${esc(fmtT(m.checked_at))}</span></summary>
<form method="post" action="/admin/stav/${m.id}/edit">${hid(req)}${form(m)}<button>Uložiť</button></form><div class="row"><form method="post" action="/admin/stav/${m.id}/delete">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> Potvrdiť zmazanie</label><button class="d">Zmazať (do koša)</button></form></div></details>`).join('');
    res.send(page('Stav služieb', `<h1>Stav služieb</h1>${nav}${m0}<p class="hint">📺 Tento zoznam je zdrojom pre verejnú sekciu „Kanály“ (zobrazí sa každá služba s jej stavom). Zmazané položky idú do <a href="/admin#trash">koša</a>.</p>
<form method="post" action="/admin/stav/nav" class="card">${hid(req)}<label class="ck"><input type="checkbox" name="on" value="1"${s.stav_nav === '1' ? ' checked' : ''}> Zobraziť stránku „Stav služieb“ v menu</label><p class="hint">Verejná stránka: <a href="/${esc(s.slug)}/stav" target="_blank" rel="noopener">/${esc(s.slug)}/stav</a> (bez URL adries)</p><button>Uložiť</button></form>
<form method="post" action="/admin/stav/check">${hid(req)}<button class="g">↻ Skontrolovať teraz</button></form>
${rows || '<p class="hint">Žiadne sledované služby.</p>'}<details class="card"><summary>➕ Pridať službu</summary><form method="post" action="/admin/stav">${hid(req)}${form()}<button>Pridať</button></form></details>
<p class="hint">Kontrola každých 5 min (GET, timeout 8 s, presmerovania sa nesledujú). Pomalé = odpoveď nad 3 s. História len 24 h.</p>`, 'a adm'));
  }));
  admin.post('/stav', needAuth, csrf, wrap(async (req, res) => {
    const m = await monInput(req); if (m.err) return res.redirect(303, '/admin/stav?m=' + m.err);
    const r = await pool.query(`INSERT INTO monitors (name,url,channel,show_home,msg_up,msg_slow,msg_down,pos) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(pos),0)+1 FROM monitors)) RETURNING *`, [m.name, m.url, m.channel, m.show_home, m.msg_up, m.msg_slow, m.msg_down]);
    mcache = null; await audit(req, 'monitor_add', m.name);
    await checkOne(r.rows[0]).catch(() => {}); mcache = null;
    res.redirect(303, '/admin/stav?m=ok');
  }));
  admin.post('/stav/:id(\\d+)/edit', needAuth, csrf, wrap(async (req, res) => {
    const m = await monInput(req); if (m.err) return res.redirect(303, '/admin/stav?m=' + m.err);
    await pool.query(`UPDATE monitors SET name=$1,url=$2,channel=$3,show_home=$4,msg_up=$5,msg_slow=$6,msg_down=$7 WHERE id=$8`, [m.name, m.url, m.channel, m.show_home, m.msg_up, m.msg_slow, m.msg_down, Number(req.params.id)]);
    mcache = null; res.redirect(303, '/admin/stav?m=ok');
  }));
  admin.post('/stav/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => {
    if (req.body.confirm !== '1') return res.redirect(303, '/admin/stav?m=needconfirm');
    const r = (await pool.query(`DELETE FROM monitors WHERE id=$1 RETURNING *`, [Number(req.params.id)])).rows[0]; mcache = null;
    if (r) await pool.query(`INSERT INTO l_trash (t,data,label) VALUES ('monitors',$1::jsonb,$2)`, [JSON.stringify(r), r.name]).catch((e) => console.error('trash', e.message)); await audit(req, 'monitor_delete', req.params.id); res.redirect(303, '/admin/stav?m=ok');
  }));
  admin.post('/stav/nav', needAuth, csrf, wrap(async (req, res) => { await setSettings({ stav_nav: req.body.on === '1' ? '1' : '0' }); res.redirect(303, '/admin/stav?m=ok'); }));
  admin.post('/stav/check', needAuth, csrf, wrap(async (req, res) => { await checkAll(); res.redirect(303, '/admin/stav?m=checked'); }));

  // ================= daily encrypted Telegram backup =================
  const MAGIC = Buffer.from('C2PBK1');
  const bkey = () => (/^[0-9a-f]{64}$/i.test(String(process.env.BACKUP_ENC_KEY || '').trim()) ? Buffer.from(process.env.BACKUP_ENC_KEY.trim(), 'hex') : null);
  function zp(d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute };
  }
  async function runBackup(slot) {
    const k = bkey(); if (!k) throw new Error('BACKUP_ENC_KEY missing');
    const tok = String(process.env.TELEGRAM_ADMIN_BOT_TOKEN || process.env.TELEGRAM_PAYMENTS_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(), chat = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
    if (!tok || !chat) throw new Error('telegram not configured');
    const c = await pool.query(`INSERT INTO backup_runs (slot) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot`, [slot]);
    if (!c.rowCount) return { ok: true, skipped: true, slot };
    try {
      const data = { format: 'lnkbio-telegram-backup', version: 1, exported_at: new Date().toISOString(), export: await buildExport(),
        monitors: (await pool.query(`SELECT name,url,channel,show_home,msg_up,msg_slow,msg_down,pos FROM monitors ORDER BY pos,id`)).rows,
        audit_log: (await pool.query(`SELECT at,ip,action,detail FROM audit_log ORDER BY id DESC LIMIT 500`)).rows };
      const iv = crypto.randomBytes(12), ci = crypto.createCipheriv('aes-256-gcm', k, iv); ci.setAAD(MAGIC);
      const ct = Buffer.concat([ci.update(zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 })), ci.final()]);
      const file = Buffer.concat([MAGIC, iv, ci.getAuthTag(), ct]);
      const fd = new FormData();
      fd.append('chat_id', chat);
      fd.append('caption', `🗄 Záloha lnkbio · ${new Date().toLocaleString('sk-SK', { timeZone: TZ })}\nnastavenia, tlačidlá (${data.export.buttons.length}), krátke odkazy (${data.export.short_links.length}), zoznamy, obrázky, monitory (${data.monitors.length})\n${file.length} B · AES-256-GCM (BACKUP_ENC_KEY)\nDešifrovanie: node scripts/decrypt-backup.js <súbor>`);
      fd.append('document', new Blob([file], { type: 'application/octet-stream' }), `lnkbio-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json.gz.enc`);
      const j = await (await fetch(`https://api.telegram.org/bot${tok}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) })).json();
      if (!j.ok) throw new Error('telegram: ' + (j.description || 'send failed'));
      await pool.query(`UPDATE backup_runs SET result=$2 WHERE slot=$1`, [slot, 'ok ' + j.result.message_id]);
      console.log(`BACKUP_OK ${slot} msg=${j.result.message_id} bytes=${file.length}`);
      return { ok: true, slot, message_id: j.result.message_id, bytes: file.length };
    } catch (e) {
      await pool.query(`UPDATE backup_runs SET result=$2 WHERE slot=$1`, [slot, 'fail ' + e.message]).catch(() => {});
      console.error('BACKUP_FAIL', slot, e.message); throw e;
    }
  }
  app.post('/api/backup/run', express_json_guard, wrap(async (req, res) => {
    const k = bkey(); if (!k) return res.status(503).json({ ok: false });
    const want = Buffer.from(crypto.createHmac('sha256', k).update('run-backup').digest('hex'));
    const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(401).json({ ok: false });
    try { res.json(await runBackup(`lnkbio:manual:${new Date().toISOString().slice(0, 16)}`)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  }));
  function express_json_guard(req, res, next) { res.setHeader('Cache-Control', 'no-store'); next(); }

  ctx.initFeatures = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), ip TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS backup_runs (slot TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), result TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS monitors (id SERIAL PRIMARY KEY, pos INT NOT NULL DEFAULT 0, name TEXT NOT NULL, url TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', show_home BOOLEAN NOT NULL DEFAULT FALSE,
      msg_up TEXT NOT NULL DEFAULT '', msg_slow TEXT NOT NULL DEFAULT '', msg_down TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', ms INT, checked_at TIMESTAMPTZ, hist JSONB NOT NULL DEFAULT '[]')`);
    await pool.query(`DELETE FROM audit_log WHERE at < now() - interval '180 days'`);
    setInterval(() => checkAll().catch((e) => console.error('monitor', e.message)), 5 * 60e3).unref();
    setTimeout(() => checkAll().catch(() => {}), 20e3).unref();
    const tick = () => { const z = zp(); if (z.mins >= 3 * 60 + 17) runBackup(`lnkbio:${z.day}`).catch(() => {}); };
    setInterval(tick, 60e3).unref(); setTimeout(tick, 90e3).unref();
  };
  ctx.privateIp = privateIp; ctx.probe = probe; ctx.audit = audit;
  return ctx;
};
