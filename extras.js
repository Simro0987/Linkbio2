'use strict';
// lnkbio extras: multi-bot Telegram routing, Návrhy (ideas bot + form), Návody (guides), Azteco redeem prep (BTCPay fresh address),
// agent HMAC hook + status alert endpoint. Security: CSRF on all admin POSTs, password re-entry for Azteco, rate limits, CSP-safe (no inline JS).
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const SEED = require('./guides-seed');

module.exports = function install(ctx) {
  const { app, admin, pool, getSettings, page, esc, hid, csrf, needAuth, lockedFor, recordFail, currentHash, wrap, sniff, shell, slugOk, T, clean, audit } = ctx;
  const SECRET = process.env.SESSION_SECRET;
  const PUBLIC = (process.env.RENDER_EXTERNAL_URL || 'https://lnkbio.onrender.com').replace(/\/$/, '');

  // ================= Telegram bots (payments | support | ideas | admin), fallback → payments bot =================
  const mainTok = () => String(process.env.TELEGRAM_PAYMENTS_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const BOTENV = { payments: 'TELEGRAM_PAYMENTS_BOT_TOKEN', support: 'TELEGRAM_SUPPORT_BOT_TOKEN', ideas: 'TELEGRAM_IDEAS_BOT_TOKEN', admin: 'TELEGRAM_ADMIN_BOT_TOKEN' };
  const ownTok = (b) => String(process.env[BOTENV[b]] || '').trim();
  const tokFor = (b) => ownTok(b) || mainTok();
  const ownerChat = () => String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  async function tgCall(tok, method, body) {
    const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({})); if (!j.ok) throw new Error('telegram ' + method + ': ' + (j.description || r.status)); return j.result;
  }
  async function notify(bot, text) {
    const chat = ownerChat(); let tok = tokFor(bot); if (!tok || !chat) return false;
    const body = { chat_id: chat, text: String(text).slice(0, 3900), disable_web_page_preview: true };
    try { await tgCall(tok, 'sendMessage', body); return true; }
    catch (e) { if (tok !== mainTok() && mainTok()) { try { await tgCall(mainTok(), 'sendMessage', { ...body, text: `[${bot}→fallback] ` + body.text }); return true; } catch {} } console.error('notify', bot, e.message); return false; }
  }
  ctx.notify = notify; global.__notifyAdmin = (t) => notify('admin', t).catch(() => {});
  ctx.tokFor = tokFor; ctx.BOTENV = BOTENV;

  // ================= Návrhy: ideas bot (public) + site form =================
  const ideasSecret = () => crypto.createHmac('sha256', SECRET).update('ideas-webhook').digest('base64url');
  const ideaHits = new Map();
  const limited = (k, n, ms) => { const now = Date.now(), a = (ideaHits.get(k) || []).filter((t) => now - t < ms); a.push(now); ideaHits.set(k, a); return a.length > n; };
  setInterval(() => { const now = Date.now(); for (const [k, a] of ideaHits) if (!a.some((t) => now - t < 3600e3)) ideaHits.delete(k); }, 600e3).unref();
  async function forwardIdea(src, text, who) {
    return notify('ideas', `💡 Nový návrh (${src})${who ? ' – ' + who : ''}\n\n${String(text).slice(0, 2000)}`);
  }
  app.post('/api/telegram/ideas/webhook', express.json({ limit: '64kb' }), wrap(async (req, res) => {
    if (!ownTok('ideas')) return res.status(503).json({ ok: false });
    const a = crypto.createHash('sha256').update(String(req.get('x-telegram-bot-api-secret-token') || '')).digest(), b = crypto.createHash('sha256').update(ideasSecret()).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false });
    res.json({ ok: true });
    const m = (req.body || {}).message; if (!m || !m.chat || m.chat.type !== 'private') return;
    const tok = ownTok('ideas'), say = (t) => tgCall(tok, 'sendMessage', { chat_id: m.chat.id, text: t }).catch(() => {});
    if (String(m.chat.id) === ownerChat()) { if (/^\/start/.test(m.text || '')) say('💡 Návrhy bot aktívny – návrhy od ľudí prídu sem.'); return; }
    if (/^\/start/.test(m.text || '')) return say('Ahoj 👋 Pošlite nám svoj návrh alebo nápad na zlepšenie. / Hi, send us your suggestion.');
    if (limited('tg:' + m.chat.id, 5, 3600e3)) return say('Ďakujeme, dosiahli ste limit návrhov na hodinu. / Rate limit reached, try later.');
    const txt = clean(m.text || m.caption || '', 2000); if (!txt) return say('Pošlite návrh ako text, prosím. / Please send text.');
    const who = [m.from && m.from.first_name, m.from && m.from.username ? '@' + m.from.username : ''].filter(Boolean).join(' ');
    await forwardIdea('Telegram', txt, who);
    say('Ďakujeme za návrh! 🙏 Odovzdali sme ho tímu. / Thank you for your suggestion!');
  }));
  const formTok = () => { const t = Date.now().toString(36); return t + '.' + crypto.createHmac('sha256', SECRET).update('idea:' + t).digest('base64url').slice(0, 22); };
  const formTokOk = (v) => { const [t, sig] = String(v || '').split('.'); if (!t || !sig) return false; const want = crypto.createHmac('sha256', SECRET).update('idea:' + t).digest('base64url').slice(0, 22); const age = Date.now() - parseInt(t, 36);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) && age > 3000 && age < 3600e3; };
  app.get('/:slug/navrhy', wrap(async (req, res, next) => {
    const s = await slugOk(req); if (!s) return next();
    const en = req.lang === 'en', m = req.query.m;
    const msg = m === 'ok' ? `<div class="msg">${en ? 'Thank you! Your suggestion was sent.' : 'Ďakujeme! Návrh bol odoslaný.'}</div>` : m === 'err' ? `<div class="msg err">${en ? 'Could not send – check the text and try again later.' : 'Nepodarilo sa odoslať – skontrolujte text a skúste neskôr.'}</div>` : '';
    res.setHeader('Cache-Control', 'no-store');
    await shell(req, res, s, 'navrhy', T(req, 'Návrhy') + ' – ' + s.title, `<h1 class="ph">${T(req, 'Návrhy')}</h1>${msg}<p class="lead">${en ? 'Have an idea how to improve our service? Write to us.' : 'Máte nápad, ako zlepšiť naše služby? Napíšte nám.'}</p>
<form method="post" action="/${esc(s.slug)}/navrhy" class="card idea"><input type="hidden" name="t" value="${esc(formTok())}"><div class="hp" aria-hidden="true"><label>Web</label><input name="web" tabindex="-1" autocomplete="off"></div>
<label for="it">${en ? 'Your suggestion' : 'Váš návrh'}</label><textarea id="it" name="text" required minlength="5" maxlength="2000" rows="6"></textarea>
<label for="ic">${en ? 'Contact (optional – e-mail or Telegram)' : 'Kontakt (voliteľné – e-mail alebo Telegram)'}</label><input id="ic" name="contact" maxlength="120">
<button class="b">${en ? 'Send suggestion' : 'Odoslať návrh'}</button></form>`);
  }));
  app.post('/:slug/navrhy', express.urlencoded({ extended: false, limit: '8kb' }), wrap(async (req, res, next) => {
    const s = await slugOk(req); if (!s) return next();
    const back = (m) => res.redirect(303, `/${s.slug}/navrhy?m=${m}`);
    if (req.body.web || !formTokOk(req.body.t)) return back('err');
    if (limited('ip:' + req.ip, 5, 3600e3) || limited('global', 60, 3600e3)) return back('err');
    const text = clean(String(req.body.text || '').replace(/\r/g, ''), 2000); if (text.length < 5) return back('err');
    const ok = await forwardIdea('web', text + (req.body.contact ? '\n\nKontakt: ' + clean(req.body.contact, 120) : ''));
    back(ok ? 'ok' : 'err');
  }));

  // ================= Návody (guides) =================
  let gcache = null;
  const getGuides = async () => gcache || (gcache = await (async () => {
    const g = (await pool.query(`SELECT id,pos,slug,title,title_en,intro,intro_en,visible,platforms,mkey FROM guides ORDER BY pos,id`)).rows;
    const st = (await pool.query(`SELECT id,guide_id,pos,text,text_en,def_img,img_ver FROM guide_steps ORDER BY pos,id`)).rows;
    for (const x of g) x.steps = st.filter((y) => y.guide_id === x.id);
    return g;
  })());
  const stepImg = (st) => (st.img_ver ? `/navody-img/${st.id}?v=${esc(st.img_ver)}` : st.def_img ? `/static/guide/${esc(st.def_img)}.svg` : '');
  app.get('/navody-img/:id(\\d+)', wrap(async (req, res) => {
    const r = await pool.query(`SELECT img_mime,img_data,img_ver FROM guide_steps WHERE id=$1 AND img_data IS NOT NULL`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).end();
    const im = r.rows[0];
    res.setHeader('Content-Type', im.img_mime); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', req.query.v === im.img_ver ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    res.end(im.img_data);
  }));
  const MX = SEED.MATRIX;
  app.get('/:slug/navody', wrap(async (req, res, next) => {
    const s = await slugOk(req); if (!s) return next();
    const en = req.lang === 'en', gs = (await getGuides()).filter((g) => g.visible);
    const rows = gs.filter((g) => MX.rows[g.mkey]).map((g) => `<tr><th><a href="/${esc(s.slug)}/navody/${esc(g.slug)}">${esc(en && g.title_en ? g.title_en : g.title)}</a></th>${MX.rows[g.mkey].map((v) => `<td class="${v ? 'y' : 'n'}">${v ? '✅' : '—'}</td>`).join('')}</tr>`).join('');
    await shell(req, res, s, 'navody', T(req, 'Návody') + ' – ' + s.title, `<h1 class="ph">${T(req, 'Návody')}</h1><p class="lead">${en ? 'Step-by-step setup of popular players. Use the details you received from us (“URL from us”, username, password).' : 'Nastavenie obľúbených prehrávačov krok za krokom. Použite údaje, ktoré ste dostali od nás („URL od nás“, meno, heslo).'}</p>
<div class="tiles">${gs.map((g) => `<a class="tile" href="/${esc(s.slug)}/navody/${esc(g.slug)}"><span class="tt">${esc(en && g.title_en ? g.title_en : g.title)}</span><span class="tm">${esc(en && g.intro_en ? g.intro_en : g.intro)}</span></a>`).join('') || `<p class="hint">${en ? 'No guides yet.' : 'Zatiaľ žiadne návody.'}</p>`}</div>
${rows ? `<h2>${en ? 'Which player for which device' : 'Ktorý prehrávač na aké zariadenie'}</h2><div class="tblw"><table class="cmp"><thead><tr><th>${en ? 'Player' : 'Prehrávač'}</th>${MX.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="hint">${en ? 'Samsung / LG TV without a supported app: use IMPlayer from the TV store, or connect an Android TV / Google TV / Fire TV stick via HDMI.' : 'Samsung / LG TV bez podporovanej aplikácie: použite IMPlayer z obchodu v TV, alebo pripojte Android TV / Google TV / Fire TV stick cez HDMI.'}</p>` : ''}`);
  }));
  app.get('/:slug/navody/:g', wrap(async (req, res, next) => {
    const s = await slugOk(req); if (!s) return next();
    const g = (await getGuides()).find((x) => x.visible && x.slug === req.params.g); if (!g) return next();
    const en = req.lang === 'en', title = en && g.title_en ? g.title_en : g.title;
    const plats = (Array.isArray(g.platforms) ? g.platforms : []).map((p) => `<li><a href="${esc(p.url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(p.name)}</a></li>`).join('');
    const steps = g.steps.map((st, i) => { const im = stepImg(st); return `<li class="gstep"><div class="gtx"><span class="gnum">${i + 1}</span><p>${esc(en && st.text_en ? st.text_en : st.text).replace(/\n/g, '<br>')}</p></div>${im ? `<img src="${im}" alt="${esc((en ? 'Step ' : 'Krok ') + (i + 1))}" loading="lazy" width="640" height="360">` : ''}</li>`; }).join('');
    await shell(req, res, s, 'navody', title + ' – ' + T(req, 'Návody'), `<nav class="crumbs"><a href="/${esc(s.slug)}/navody">${T(req, 'Návody')}</a><span class="chev">›</span><span>${esc(title)}</span></nav><h1 class="ph">${esc(title)}</h1><p class="lead">${esc(en && g.intro_en ? g.intro_en : g.intro)}</p>
${plats ? `<div class="card"><h2>${en ? 'Where to install' : 'Kde nainštalovať'}</h2><ul class="plats">${plats}</ul><p class="hint">${en ? 'Official stores / developer sites only.' : 'Len oficiálne obchody / stránky vývojára.'}</p></div>` : ''}<ol class="gsteps">${steps}</ol>
<p class="hint">${en ? 'We do not provide any content through these apps – they are only players for the details you received from us.' : 'Prostredníctvom týchto aplikácií neposkytujeme žiadny obsah – sú to len prehrávače pre údaje, ktoré ste dostali od nás.'}</p>`);
  }));
  // admin
  const gUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 8, fieldSize: 4096 } }).single('image');
  const anav = `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="/admin/navody">📘 Návody</a><a class="btnl" href="/admin/azteco">₿ Azteco</a><a class="btnl" href="/admin/agent">🤖 Agent / uptime</a><a class="btnl" href="/admin/kluce">🔑 API kľúče</a></p>`;
  const GM = { ok: 'Uložené.', bad: 'Neplatné údaje.', big: 'Obrázok je príliš veľký (max 2 MB).', badimg: 'Povolené len PNG, JPEG, WebP.' };
  const gmsg = (q) => (GM[q] ? `<div class="msg${q === 'ok' ? '' : ' err'}">${esc(GM[q])}</div>` : '');
  admin.get('/navody', needAuth, wrap(async (req, res) => {
    const gs = await getGuides(); const s = await getSettings();
    res.send(page('Návody', `<h1>Návody</h1>${anav}${gmsg(req.query.m)}<p class="hint">Verejne: <a href="/${esc(s.slug)}/navody" target="_blank" rel="noopener">/${esc(s.slug)}/navody</a></p>
${gs.map((g) => `<div class="card"><h2>${esc(g.title)} ${g.visible ? '' : '<span class="hint">(skryté)</span>'}</h2><p class="hint">${g.steps.length} krokov · /${esc(g.slug)}</p><a class="btnl" href="/admin/navody/${g.id}">Upraviť</a></div>`).join('')}
<details class="card"><summary>➕ Nový návod</summary><form method="post" action="/admin/navody">${hid(req)}<label>Názov</label><input name="title" required maxlength="80"><label>Slug (a-z, 0-9, -)</label><input name="slug" required maxlength="40" pattern="[a-z0-9-]+"><button>Vytvoriť</button></form></details>`, 'a adm'));
  }));
  const slugRe = /^[a-z0-9-]{1,40}$/;
  admin.post('/navody', needAuth, csrf, wrap(async (req, res) => {
    const t = clean(req.body.title, 80), sl = String(req.body.slug || ''); if (!t || !slugRe.test(sl)) return res.redirect(303, '/admin/navody?m=bad');
    const r = await pool.query(`INSERT INTO guides (slug,title,pos) VALUES ($1,$2,(SELECT COALESCE(MAX(pos),0)+1 FROM guides)) ON CONFLICT (slug) DO NOTHING RETURNING id`, [sl, t]);
    gcache = null; res.redirect(303, r.rowCount ? '/admin/navody/' + r.rows[0].id : '/admin/navody?m=bad');
  }));
  admin.get('/navody/:id(\\d+)', needAuth, wrap(async (req, res, next) => {
    const g = (await getGuides()).find((x) => x.id === Number(req.params.id)); if (!g) return next();
    const steps = g.steps.map((st, i) => `<div class="card"><h2>Krok ${i + 1}</h2>${stepImg(st) ? `<img class="gprev" src="${stepImg(st)}" alt="" width="320" height="180">` : ''}
<form method="post" action="/admin/navody/step/${st.id}" enctype="multipart/form-data">${hid(req)}<label>Text (SK)</label><textarea name="text" rows="3" maxlength="1500" required>${esc(st.text)}</textarea><label>Text (EN)</label><textarea name="text_en" rows="3" maxlength="1500">${esc(st.text_en)}</textarea>
<label>Nahradiť obrázok vlastným screenshotom (PNG/JPEG/WebP, max 2 MB)</label><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><button>Uložiť krok</button></form>
<div class="row">${st.img_ver ? `<form method="post" action="/admin/navody/step/${st.id}/resetimg">${hid(req)}<button class="g">↺ Pôvodný obrázok</button></form>` : ''}<form method="post" action="/admin/navody/step/${st.id}/move">${hid(req)}<input type="hidden" name="dir" value="up"><button class="g">↑</button></form><form method="post" action="/admin/navody/step/${st.id}/move">${hid(req)}<input type="hidden" name="dir" value="down"><button class="g">↓</button></form><form method="post" action="/admin/navody/step/${st.id}/delete">${hid(req)}<button class="d">Zmazať krok</button></form></div></div>`).join('');
    res.send(page('Návod – ' + g.title, `<h1>${esc(g.title)}</h1>${anav}${gmsg(req.query.m)}
<form method="post" action="/admin/navody/${g.id}" class="card">${hid(req)}<label>Názov (SK)</label><input name="title" value="${esc(g.title)}" maxlength="80" required><label>Názov (EN)</label><input name="title_en" value="${esc(g.title_en)}" maxlength="80">
<label>Úvod (SK)</label><textarea name="intro" rows="2" maxlength="400">${esc(g.intro)}</textarea><label>Úvod (EN)</label><textarea name="intro_en" rows="2" maxlength="400">${esc(g.intro_en)}</textarea>
<label>Kde nainštalovať – jeden riadok na platformu: Názov | https://oficiálny-odkaz</label><textarea name="platforms" rows="5" maxlength="3000">${esc((g.platforms || []).map((p) => p.name + ' | ' + p.url).join('\n'))}</textarea>
<label class="ck"><input type="checkbox" name="visible" value="1"${g.visible ? ' checked' : ''}> Zobraziť verejne</label><button>Uložiť</button></form>
${steps}<details class="card"><summary>➕ Pridať krok</summary><form method="post" action="/admin/navody/${g.id}/step" enctype="multipart/form-data">${hid(req)}<label>Text (SK)</label><textarea name="text" rows="3" maxlength="1500" required></textarea><label>Text (EN)</label><textarea name="text_en" rows="3" maxlength="1500"></textarea><label>Obrázok (voliteľné)</label><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><button>Pridať</button></form></details>
<form method="post" action="/admin/navody/${g.id}/delete" class="card">${hid(req)}<button class="d">Zmazať celý návod</button></form>`, 'a adm'));
  }));
  admin.post('/navody/:id(\\d+)', needAuth, csrf, wrap(async (req, res) => {
    const id = Number(req.params.id), t = clean(req.body.title, 80); if (!t) return res.redirect(303, `/admin/navody/${id}?m=bad`);
    const plats = String(req.body.platforms || '').split(/\r?\n/).map((l) => l.split('|')).filter((p) => p.length >= 2).map(([n, ...u]) => ({ name: clean(n, 100), url: ctx.safeUrl(u.join('|').trim()) })).filter((p) => p.name && p.url).slice(0, 15);
    await pool.query(`UPDATE guides SET title=$1,title_en=$2,intro=$3,intro_en=$4,platforms=$5::jsonb,visible=$6 WHERE id=$7`, [t, clean(req.body.title_en, 80), clean(req.body.intro, 400), clean(req.body.intro_en, 400), JSON.stringify(plats), req.body.visible === '1', id]);
    gcache = null; res.redirect(303, `/admin/navody/${id}?m=ok`);
  }));
  admin.post('/navody/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => { await pool.query(`DELETE FROM guides WHERE id=$1`, [Number(req.params.id)]); gcache = null; await audit(req, 'guide_delete', req.params.id); res.redirect(303, '/admin/navody?m=ok'); }));
  const withImg = (h) => [needAuth, (req, res, next) => gUpload(req, res, (e) => (e ? res.redirect(303, '/admin/navody?m=' + (e.code === 'LIMIT_FILE_SIZE' ? 'big' : 'badimg')) : next())), csrf, wrap(h)];
  const imgOf = (req) => { if (!req.file || !req.file.buffer.length) return null; const mime = sniff(req.file.buffer); if (!mime) return false; return { mime, buf: req.file.buffer, ver: crypto.createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 12) }; };
  admin.post('/navody/:id(\\d+)/step', ...withImg(async (req, res) => {
    const id = Number(req.params.id), im = imgOf(req), t = clean(String(req.body.text || '').replace(/\r/g, ''), 1500);
    if (im === false) return res.redirect(303, `/admin/navody/${id}?m=badimg`); if (!t) return res.redirect(303, `/admin/navody/${id}?m=bad`);
    await pool.query(`INSERT INTO guide_steps (guide_id,pos,text,text_en,img_mime,img_data,img_ver) VALUES ($1,(SELECT COALESCE(MAX(pos),0)+1 FROM guide_steps WHERE guide_id=$1),$2,$3,$4,$5,$6)`, [id, t, clean(String(req.body.text_en || '').replace(/\r/g, ''), 1500), im ? im.mime : null, im ? im.buf : null, im ? im.ver : null]);
    gcache = null; res.redirect(303, `/admin/navody/${id}?m=ok`);
  }));
  const gidOf = async (sid) => { const r = await pool.query(`SELECT guide_id FROM guide_steps WHERE id=$1`, [sid]); return r.rowCount ? r.rows[0].guide_id : null; };
  admin.post('/navody/step/:sid(\\d+)', ...withImg(async (req, res) => {
    const sid = Number(req.params.sid), gid = await gidOf(sid); if (!gid) return res.redirect(303, '/admin/navody?m=bad');
    const im = imgOf(req), t = clean(String(req.body.text || '').replace(/\r/g, ''), 1500);
    if (im === false) return res.redirect(303, `/admin/navody/${gid}?m=badimg`); if (!t) return res.redirect(303, `/admin/navody/${gid}?m=bad`);
    await pool.query(`UPDATE guide_steps SET text=$1,text_en=$2 WHERE id=$3`, [t, clean(String(req.body.text_en || '').replace(/\r/g, ''), 1500), sid]);
    if (im) await pool.query(`UPDATE guide_steps SET img_mime=$1,img_data=$2,img_ver=$3 WHERE id=$4`, [im.mime, im.buf, im.ver, sid]);
    gcache = null; res.redirect(303, `/admin/navody/${gid}?m=ok`);
  }));
  admin.post('/navody/step/:sid(\\d+)/resetimg', needAuth, csrf, wrap(async (req, res) => { const sid = Number(req.params.sid), gid = await gidOf(sid); await pool.query(`UPDATE guide_steps SET img_mime=NULL,img_data=NULL,img_ver=NULL WHERE id=$1`, [sid]); gcache = null; res.redirect(303, `/admin/navody/${gid || ''}?m=ok`); }));
  admin.post('/navody/step/:sid(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => { const sid = Number(req.params.sid), gid = await gidOf(sid); await pool.query(`DELETE FROM guide_steps WHERE id=$1`, [sid]); gcache = null; res.redirect(303, `/admin/navody/${gid || ''}?m=ok`); }));
  admin.post('/navody/step/:sid(\\d+)/move', needAuth, csrf, wrap(async (req, res) => {
    const sid = Number(req.params.sid), gid = await gidOf(sid); if (!gid) return res.redirect(303, '/admin/navody');
    const l = (await pool.query(`SELECT id FROM guide_steps WHERE guide_id=$1 ORDER BY pos,id`, [gid])).rows.map((r) => r.id);
    const i = l.indexOf(sid), j = req.body.dir === 'up' ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < l.length) { [l[i], l[j]] = [l[j], l[i]]; for (let k = 0; k < l.length; k++) await pool.query(`UPDATE guide_steps SET pos=$1 WHERE id=$2`, [k + 1, l[k]]); }
    gcache = null; res.redirect(303, `/admin/navody/${gid}?m=ok`);
  }));

  // ================= Azteco redeem prep (fresh BTCPay address) =================
  const btc = () => { const url = String(process.env.BTCPAY_URL || '').trim().replace(/\/$/, ''), storeId = String(process.env.BTCPAY_STORE_ID || '').trim(), key = String(process.env.BTCPAY_API_KEY || '').trim(); return url && storeId && key ? { url, storeId, key } : null; };
  async function freshAddress() {
    const c = btc(); if (!c) throw new Error('BTCPay nie je nastavený (BTCPAY_URL / BTCPAY_STORE_ID / BTCPAY_API_KEY)');
    const r = await fetch(`${c.url}/api/v1/stores/${encodeURIComponent(c.storeId)}/payment-methods/BTC-CHAIN/wallet/address?forceGenerate=true`, { headers: { Authorization: 'token ' + c.key, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,90}$/.test(j.address || '')) throw new Error('BTCPay nevrátil adresu (HTTP ' + r.status + ')');
    return { address: j.address, keyPath: j.keyPath || '' };
  }
  function parseCode(v) {
    v = String(v || '').trim().slice(0, 500);
    try { const u = new URL(v); if (/(^|\.)azte\.co$/i.test(u.hostname)) { const p = ['c1', 'c2', 'c3', 'c4'].map((k) => u.searchParams.get(k) || '').join(''); if (/^\d{16}$/.test(p)) return p; const c = (u.searchParams.get('code') || u.pathname).replace(/\D/g, ''); if (c.length === 16) return c; } } catch {}
    const d = v.replace(/[\s-]/g, ''); return /^\d{16}$/.test(d) ? d : null;
  }
  const mask = (c) => '••••-••••-••••-' + c.slice(-4);
  const grp = (c) => c.replace(/(\d{4})(?=\d)/g, '$1 ');
  async function ocr(buf, mime) {
    const key = String(process.env.GEMINI_API_KEY || '').trim(); if (!key) throw new Error('GEMINI_API_KEY nie je nastavený na lnkbio');
    const models = (process.env.GEMINI_MODELS || 'gemini-2.5-flash,gemini-2.0-flash').split(',').map((x) => x.trim()).filter(Boolean);
    let last = '';
    for (const m of models) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ contents: [{ parts: [{ text: 'This is a photo of an Azteco bitcoin voucher. Extract ONLY the 16-digit voucher/redeem code (digits only, no spaces). If not clearly readable, answer NONE.' }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }], generationConfig: { temperature: 0, maxOutputTokens: 40 } }) });
        const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        const d = (t.match(/\d[\d\s-]{14,30}\d/) || [''])[0].replace(/\D/g, '');
        if (d.length === 16) return d; last = r.ok ? 'kód nerozpoznaný' : 'HTTP ' + r.status;
      } catch (e) { last = e.name; }
    }
    throw new Error('OCR: ' + last);
  }
  const AM = { bad: 'Neplatný kód – očakáva sa 16 číslic alebo azte.co odkaz.', badpw: 'Nesprávne heslo.', lock: 'Príliš veľa pokusov. Skúste neskôr.', badimg: 'Povolené len PNG, JPEG, WebP do 2 MB.' };
  const azForm = (req, err = '') => `<h1>₿ Azteco – uplatnenie voucheru</h1>${anav}${err ? `<div class="msg err">${esc(err)}</div>` : ''}
<div class="card"><p>BTCPay: ${btc() ? '✅ nastavený (adresa sa vždy vygeneruje nová v BTCPay obchode)' : '❌ <b>nie je nastavený</b> – uplatnenie nie je možné'}</p><p class="hint">Bitcoin pôjde výhradne na novú on-chain adresu z vášho BTCPay. Azteco nemá verejné API na uplatnenie – samotné potvrdenie urobíte jedným klikom na stránke azte.co (kód a adresu pripravíme).</p></div>
<form method="post" action="/admin/azteco/parse" enctype="multipart/form-data" class="card">${hid(req)}<label>16-miestny kód alebo azte.co odkaz</label><input name="code" maxlength="300" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="1234 5678 9012 3456">
<label>…alebo fotka voucheru (OCR cez Gemini, kód potom potvrdíte)</label><input type="file" name="image" accept="image/png,image/jpeg,image/webp"><button>Pokračovať</button></form>`;
  const azUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, fieldSize: 1024 } }).single('image');
  const azLim = new Map();
  admin.get('/azteco', needAuth, (req, res) => res.send(page('Azteco', azForm(req, AM[req.query.m] || ''), 'a adm')));
  admin.post('/azteco/parse', needAuth, (req, res, next) => azUp(req, res, (e) => (e ? res.redirect(303, '/admin/azteco?m=badimg') : next())), csrf, wrap(async (req, res) => {
    let code = parseCode(req.body.code), src = 'text', err = '';
    if (!code && req.file && req.file.buffer.length) {
      const mime = sniff(req.file.buffer); if (!mime) return res.redirect(303, '/admin/azteco?m=badimg');
      const n = (azLim.get('ocr') || []).filter((t) => Date.now() - t < 3600e3); if (n.length >= 20) return res.send(page('Azteco', azForm(req, 'Limit OCR (20/h) dosiahnutý.'), 'a adm')); n.push(Date.now()); azLim.set('ocr', n);
      try { code = await ocr(req.file.buffer, mime); src = 'ocr'; } catch (e) { err = e.message; }
    }
    if (!code) return res.send(page('Azteco', azForm(req, err ? 'Z fotky sa nepodarilo prečítať kód (' + err + '). Zadajte ho ručne.' : AM.bad), 'a adm'));
    res.send(page('Azteco – potvrdenie', `<h1>Potvrďte kód</h1>${anav}<form method="post" action="/admin/azteco/prepare" class="card" autocomplete="off">${hid(req)}
${src === 'ocr' ? '<div class="msg">Kód rozpoznaný z fotky – <b>skontrolujte ho s voucherom</b> a prípadne opravte.</div>' : ''}<label>Kód voucheru (16 číslic)</label><input name="code" value="${esc(grp(code))}" maxlength="25" required inputmode="numeric" class="mono" spellcheck="false">
<p class="hint">Cieľ: nová on-chain adresa z BTCPay (BTC-CHAIN). Lightning: Azteco Lightning vouchery majú vlastný LNURL-withdraw QR – BTCPay obchod tu má len receive-only Lightning Address, takže sa používa on-chain.</p>
<label>Vaše admin heslo (potvrdenie)</label><input type="password" name="password" required maxlength="200" autocomplete="current-password"><button>Vygenerovať adresu a pripraviť uplatnenie</button></form>`, 'a adm'));
  }));
  admin.post('/azteco/prepare', needAuth, csrf, wrap(async (req, res) => {
    const ip = req.ip; if (lockedFor(ip)) return res.redirect(303, '/admin/azteco?m=lock');
    if (!(await bcrypt.compare(String(req.body.password || '').slice(0, 200), await currentHash()))) { recordFail(ip); await audit(req, 'azteco_denied', 'bad password'); return res.redirect(303, '/admin/azteco?m=badpw'); }
    const code = parseCode(req.body.code); if (!code) return res.redirect(303, '/admin/azteco?m=bad');
    let a;
    try { a = await freshAddress(); } catch (e) {
      await audit(req, 'azteco_abort', 'BTCPay: ' + e.message.slice(0, 100)); notify('payments', `₿ Azteco (admin) · ❌ Zlyhalo: BTCPay nedostupný – žiadna iná adresa sa nepoužije\n\nPôvodne zadané: ${String(req.body.code || '').slice(0, 300)}`).catch(() => {});
      return res.send(page('Azteco', azForm(req, 'Prerušené: ' + e.message + '. Žiadna iná adresa sa nepoužije.'), 'a adm'));
    }
    await audit(req, 'azteco_prepared', `${mask(code)} → ${a.address.slice(0, 8)}…${a.address.slice(-6)} (${a.keyPath})`);
    notify('payments', `₿ Azteco (admin) · ⏳ Neodoslané / čaká sa – dokončite na azte.co\n\nPôvodne zadané: ${String(req.body.code || '').slice(0, 300)}\nKód: ${grp(code)}\nNová BTCPay adresa: ${a.address} (keyPath ${a.keyPath})\n👉 https://azte.co/?c1=${code.slice(0, 4)}&c2=${code.slice(4, 8)}&c3=${code.slice(8, 12)}&c4=${code.slice(12)}`).catch(() => {});
    const qr = await QRCode.toString('bitcoin:' + a.address, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const link = `https://azte.co/?c1=${code.slice(0, 4)}&c2=${code.slice(4, 8)}&c3=${code.slice(8, 12)}&c4=${code.slice(12)}`;
    res.send(page('Azteco – uplatniť', `<h1>Pripravené ✅</h1>${anav}<div class="card"><h2>1. Nová BTCPay adresa</h2><p class="mono">${esc(a.address)}</p><div class="qrbox">${qr}</div><p class="hint">Vygenerované práve teraz v BTCPay (keyPath ${esc(a.keyPath)}). Prijatie uvidíte v BTCPay peňaženke.</p></div>
<div class="card"><h2>2. Kód</h2><p class="mono">${esc(grp(code))}</p></div>
<div class="card"><h2>3. Uplatniť na azte.co (1 klik)</h2><p><a class="btnl" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Otvoriť azte.co s kódom ↗</a> <a class="btnl" href="https://azte.co/redeem" target="_blank" rel="noopener noreferrer">azte.co/redeem ↗</a></p>
<ol><li>Na azte.co skontrolujte/vložte kód vyššie.</li><li>Zvoľte bitcoin (on-chain) a vložte <b>len</b> adresu z kroku 1.</li><li>Potvrďte. Výsledok uvidíte v BTCPay.</li></ol></div>`, 'a adm'));
  }));

  // ================= Agent hook (HMAC) + status alert =================
  const agentKey = () => String(process.env.AGENT_HOOK_SECRET || '').trim();
  const seen = new Map();
  setInterval(() => { const c = Date.now() - 600e3; for (const [k, t] of seen) if (t < c) seen.delete(k); }, 300e3).unref();
  async function statusSnapshot() {
    const mons = (await pool.query(`SELECT name,status,ms,checked_at FROM monitors ORDER BY pos,id`)).rows;
    const peer = await ctx.probe('https://chain2pay-checkout-gl.onrender.com/health').catch(() => ({ ok: false }));
    return { ok: true, at: new Date().toISOString(), lnkbio: { up: true, commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) }, checkout: { up: !!peer.ok, ms: peer.ms }, monitors: mons,
      bots: Object.fromEntries(Object.keys(BOTENV).map((b) => [b, ownTok(b) ? 'own' : mainTok() ? 'fallback' : 'off'])) };
  }
  app.post('/api/agent/hook', express.raw({ type: '*/*', limit: '32kb' }), wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const key = agentKey(); if (key.length < 32) return res.status(503).json({ ok: false });
    if (limited('agent:' + req.ip, 60, 60e3)) return res.status(429).json({ ok: false });
    const ts = String(req.get('x-agent-timestamp') || ''), sig = String(req.get('x-agent-signature') || '').replace(/^sha256=/, '');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!/^\d{10}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return res.status(401).json({ ok: false, error: 'timestamp' });
    const want = crypto.createHmac('sha256', key).update(ts + '.').update(body).digest('hex');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.status(401).json({ ok: false, error: 'signature' });
    if (seen.has(sig)) return res.status(409).json({ ok: false, error: 'replay' }); seen.set(sig, Date.now());
    let j; try { j = JSON.parse(body.toString('utf8') || '{}'); } catch { return res.status(400).json({ ok: false }); }
    const action = String(j.action || 'status');
    if (action === 'status') return res.json(await statusSnapshot());
    if (action === 'event') { const t = clean(j.text || '', 1500); if (!t) return res.status(400).json({ ok: false }); await pool.query(`INSERT INTO audit_log (ip,action,detail) VALUES ($1,'agent_event',$2)`, [String(req.ip).slice(0, 64), t.slice(0, 300)]); const sent = await notify('admin', `🤖 Agent ${clean(j.source || '', 40) || ''}: ${t}`); return res.json({ ok: true, notified: sent }); }
    if (action === 'ping') return res.json({ ok: true, pong: Date.now() });
    res.status(400).json({ ok: false, error: 'unknown action' });
  }));
  const alertTok = () => (agentKey() ? crypto.createHmac('sha256', agentKey()).update('status-alert').digest('base64url').slice(0, 32) : '');
  let lastAlert = {};
  app.all('/api/status-alert', express.json({ limit: '16kb' }), wrap(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const t = alertTok(), got = String(req.query.token || '');
    if (!t || got.length !== t.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(t))) return res.status(401).json({ ok: false });
    if (limited('alert', 30, 3600e3)) return res.status(429).json({ ok: false });
    const targets = { checkout: 'https://chain2pay-checkout-gl.onrender.com/health', lnkbio: PUBLIC + '/healthz' };
    const out = {};
    for (const [k, u] of Object.entries(targets)) {
      let r = await ctx.probe(u); if (!r.ok) { await new Promise((z) => setTimeout(z, 15000)); r = await ctx.probe(u); }
      out[k] = !!r.ok;
      if (!r.ok && Date.now() - (lastAlert[k] || 0) > 30 * 60e3) { lastAlert[k] = Date.now(); await notify('admin', `🔴 ${k} nedostupný (${u}) – ${r.code || r.err || 'chyba'}`); }
      if (r.ok && lastAlert[k]) { lastAlert[k] = 0; await notify('admin', `🟢 ${k} opäť funguje`); }
    }
    if (req.query.src === 'cronjob' && req.method === 'POST') await notify('admin', '⚠️ cron-job.org hlási zlyhanie úlohy: ' + clean(JSON.stringify(req.body || {}), 300));
    res.json({ ok: true, up: out });
  }));
  admin.get('/agent', needAuth, wrap(async (req, res) => {
    const k = agentKey();
    res.send(page('Agent / uptime', `<h1>🤖 Agent hook & uptime</h1>${anav}<div class="card"><h2>Agent hook</h2><p>Endpoint: <code>POST ${esc(PUBLIC)}/api/agent/hook</code> · tajomstvo <code>AGENT_HOOK_SECRET</code> ${k ? '✅ nastavené (…' + esc(k.slice(-4)) + ')' : '❌ chýba'}</p><p class="hint">Hlavičky: X-Agent-Timestamp (unix s), X-Agent-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body). Akcie: status, event, ping. Detaily v AGENT.md.</p></div>
<div class="card"><h2>cron-job.org</h2><ol><li>Úloha 1 (uptime lnkbio): <code>${esc(PUBLIC)}/healthz</code> každých 5 min, notifikácie pri zlyhaní (e-mail).</li><li>Úloha 2 (uptime checkout): <code>https://chain2pay-checkout-gl.onrender.com/health</code> každých 5 min.</li><li>Úloha 3 (Telegram alert cez Admin bota): <code class="mono">${k ? esc(PUBLIC + '/api/status-alert?token=' + alertTok()) : '— najprv nastavte AGENT_HOOK_SECRET —'}</code> každých 5 min (GET). Pri výpadku príde správa „🔴 … nedostupný“, po obnove „🟢“.</li></ol><p class="hint">URL s tokenom je tajná – nezdieľajte ju.</p></div>`, 'a adm'));
  }));

  // ================= tables + seed + webhook registration =================
  ctx.initExtras = async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS guides (id SERIAL PRIMARY KEY, pos INT NOT NULL DEFAULT 0, slug TEXT UNIQUE NOT NULL, mkey TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, title_en TEXT NOT NULL DEFAULT '', intro TEXT NOT NULL DEFAULT '', intro_en TEXT NOT NULL DEFAULT '', platforms JSONB NOT NULL DEFAULT '[]', visible BOOLEAN NOT NULL DEFAULT TRUE)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS guide_steps (id SERIAL PRIMARY KEY, guide_id INT NOT NULL REFERENCES guides(id) ON DELETE CASCADE, pos INT NOT NULL DEFAULT 0, text TEXT NOT NULL, text_en TEXT NOT NULL DEFAULT '', def_img TEXT NOT NULL DEFAULT '', img_mime TEXT, img_data BYTEA, img_ver TEXT)`);
    const m = await pool.query(`INSERT INTO settings (k,v) VALUES ('migr_guides','1') ON CONFLICT (k) DO NOTHING RETURNING k`);
    if (m.rowCount) {
      let p = 1;
      for (const g of SEED) {
        const r = await pool.query(`INSERT INTO guides (pos,slug,mkey,title,title_en,intro,intro_en,platforms) VALUES ($1,$2,$3,$4,$4,$5,$6,$7::jsonb) ON CONFLICT (slug) DO NOTHING RETURNING id`, [p++, g.slug, g.key, g.title, g.intro, g.intro_en, JSON.stringify(g.platforms)]);
        if (!r.rowCount) continue;
        let i = 1; for (const [kind, sk, en] of g.steps) await pool.query(`INSERT INTO guide_steps (guide_id,pos,text,text_en,def_img) VALUES ($1,$2,$3,$4,$5)`, [r.rows[0].id, i++, sk, en, `${g.key}-${kind}`]);
      }
    }
    if (ownTok('ideas')) tgCall(ownTok('ideas'), 'setWebhook', { url: PUBLIC + '/api/telegram/ideas/webhook', secret_token: ideasSecret(), allowed_updates: ['message'] }).then(() => console.log('IDEAS_WEBHOOK ok')).catch((e) => console.error('IDEAS_WEBHOOK', e.message));
  };
  ctx.registerIdeasWebhook = async (tok) => tgCall(tok, 'setWebhook', { url: PUBLIC + '/api/telegram/ideas/webhook', secret_token: ideasSecret(), allowed_updates: ['message'] });
  return ctx;
};
