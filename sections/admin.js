'use strict';
// /admin/sekcie – overview: home blocks (drag & drop + ↑↓ + show/hide), menu order, own pages, "create section".
// Every POST: needAuth (+2FA) + CSRF; parameterised SQL; ids validated against existing rows.
const { KINDS, GROUPS, orderKeys, move, slugify, str } = require('./types');

module.exports = function admin(ctx, { SEC_V, TAKEN, SLUG }) {
  const { admin: r, pool, page, esc, hid, csrf, needAuth, wrap, getSettings, setSettings } = ctx;
  const audit = (req, a, d) => (ctx.audit ? ctx.audit(req, a, d) : null);
  const M = { ok: 'Uložené.', shown: 'Vstavaný blok bol skrytý – teraz je znova zobrazený na zvolenom mieste.', bad: 'Neplatné údaje.', slug: 'Adresa (slug) je obsadená alebo neplatná – použite a-z, 0-9 a pomlčky.', one: 'Tento typ môže byť na mieste len raz – existujúci blok stačí zobraziť (👁).', del: 'Sekcia zmazaná.', conf: 'Na zmazanie zaškrtnite potvrdenie.', dup: 'Kópia vytvorená.' };
  const msg = (q) => (M[q] ? `<div class="msg${['ok', 'del', 'dup'].includes(q) ? '' : ' err'}">${esc(M[q])}</div>` : '');
  ctx.secMsg = msg;
  const anav = `<p class="row"><a class="btnl" href="/admin">← Admin</a><a class="btnl" href="/admin/sekcie">🧩 Sekcie a menu</a><a class="btnl" href="/admin#l-nav">🧭 Položky menu</a><a class="btnl" href="/admin/zakaznici/nastavenia">🤝 Affiliate</a></p>`;
  ctx.secAnav = anav;
  const placeOf = (x) => (x.place === 'home' ? 'home' : 'page');
  const kl = (k) => (KINDS[k] ? KINDS[k].l : k);
  const jparse = (v, d) => { try { const o = JSON.parse(v || ''); return o && typeof o === 'object' ? o : d; } catch { return d; } };

  // ---- menu (nav) model: keys n<id> (menu items), s<id> (own pages), stav, acc ----
  const navMeta = (s) => jparse(s.nav_meta, {});
  ctx.navArrange = (s, items) => {
    const meta = navMeta(s), ord = orderKeys(items.map((i) => i.k), jparse(s.nav_order, []));
    const by = new Map(items.map((i) => [i.k, i]));
    return ord.map((k) => by.get(k)).filter((i) => i && !(meta[i.k] && meta[i.k].h)).map((i) => {
      const m = meta[i.k] || {}; return Object.assign({}, i, m.i ? { icon: m.i } : {}, m.l ? { label: m.l, label2: m.l2 || '' } : {});
    });
  };
  async function navCatalog(s) {
    const nav = await ctx.getList('nav'), PAGES = ctx.PAGES || {}, NI = ctx.NAV_ICONS || {};
    const items = nav.map((n) => ({ k: 'n' + n.id, label: n.label, icon: n.url ? '🔗' : NI[n.page] || '📄', off: !n.visible, note: n.url ? 'externý odkaz' : (PAGES[n.page] ? 'stránka ' + (PAGES[n.page][1] || '/') : '') }))
      .concat((await ctx.secPages()).filter((x) => x.visible && x.in_nav).map((x) => ({ k: 's' + x.id, label: x.title, icon: x.icon || '📄', note: 'vlastná sekcia' })))
      .concat([{ k: 'stav', label: 'Stav služieb', icon: '📡', off: s.stav_nav !== '1', note: 'stránka /stav' }, { k: 'acc', label: 'Prihlásenie / Môj účet', icon: '🔑', note: 'zákaznícky účet' }]);
    return items;
  }

  const mvBtn = (act, dir, dis, extra = '') => `<form method="post" action="${act}">${extra}<input type="hidden" name="dir" value="${dir}"><button class="g sm"${dis ? ' disabled' : ''} aria-label="${dir === 'up' ? 'Posunúť vyššie' : 'Posunúť nižšie'}">${dir === 'up' ? '↑' : '↓'}</button></form>`;
  const tog = (req, act, on, extra = '') => `<form method="post" action="${act}">${hid(req)}${extra}<button class="g sm">${on ? '🙈 Skryť' : '👁 Zobraziť'}</button></form>`;
  const dndList = (req, place, rows, s) => `<form method="post" action="/admin/sekcie/order" class="dndf" id="dnd-${place}">${hid(req)}<input type="hidden" name="place" value="${place}"><input type="hidden" name="order" value=""></form>
<ol class="dnd" data-form="dnd-${place}">${rows.map((x, i) => `<li class="dli${x.visible ? '' : ' off'}" data-id="${x.id}"><span class="dh" aria-hidden="true" title="Potiahnite">⠿</span><span class="seci">${esc(x.icon || (KINDS[x.kind] || {}).i || '📄')}</span><span class="dt"><b>${esc(x.title)}</b>${x.visible ? '' : ' <span class="tag off">skryté</span>'}${(x.cfg || {}).vis && x.cfg.vis !== 'all' ? ` <span class="tag">${esc({ in: 'len prihlásení', out: 'len neprihlásení', mobile: 'len mobil', desktop: 'len počítač' }[x.cfg.vis] || '')}</span>` : ''}<br><span class="hint">${esc(kl(x.kind))}${place === 'page' ? ` · <a href="/${esc(s.slug)}/${esc(x.slug)}" target="_blank" rel="noopener">/${esc(s.slug)}/${esc(x.slug)}</a>${x.in_nav ? '' : ' · mimo menu'}` : (x.cfg || {}).anchor ? ` · #${esc(x.cfg.anchor)}` : ''}</span></span>
<span class="row dact">${mvBtn(`/admin/sekcie/${x.id}/move`, 'up', i === 0, hid(req))}${mvBtn(`/admin/sekcie/${x.id}/move`, 'down', i === rows.length - 1, hid(req))}${tog(req, `/admin/sekcie/${x.id}/visible`, x.visible)}<a class="btnl sm" href="/admin/sekcie/${x.id}">✏️ Upraviť</a>${KINDS[x.kind] && !KINDS[x.kind].one ? `<form method="post" action="/admin/sekcie/${x.id}/dup">${hid(req)}<button class="g sm" aria-label="Duplikovať">⧉</button></form>` : ''}</span></li>`).join('')}</ol>`;

  function createForm(req, rows) {
    const home = rows.filter((x) => x.place === 'home'), pg = rows.filter((x) => x.place !== 'home');
    const has = (k) => home.some((x) => x.kind === k);
    const opts = GROUPS.map(([g, ks]) => `<optgroup label="${esc(g)}">${ks.map((k) => `<option value="${k}"${k === 'text' ? ' selected' : ''}>${esc(KINDS[k].i + ' ' + KINDS[k].l)}${KINDS[k].one && has(k) ? ' (už je na hlavnej stránke)' : ''}${KINDS[k].home ? ' – len hlavná stránka' : ''}</option>`).join('')}</optgroup>`).join('');
    const after = `<optgroup label="Hlavná stránka – za blokom">${home.map((x) => `<option value="${x.id}">za: ${esc(x.title)}</option>`).join('')}</optgroup><optgroup label="Vlastné stránky – za sekciou">${pg.map((x) => `<option value="${x.id}">za: ${esc(x.title)}</option>`).join('')}</optgroup>`;
    return `<details class="card" id="new"${req.query.new ? ' open' : ''}><summary><b>➕ Vytvoriť sekciu</b></summary><form method="post" action="/admin/sekcie" class="secnew">${hid(req)}
<div class="g2"><div><label for="nk">Typ sekcie</label><select id="nk" name="kind">${opts}</select></div>
<div><label for="np">Kde</label><select id="np" name="place"><option value="home">Blok na hlavnej stránke</option><option value="page">Samostatná stránka v menu</option></select></div>
<div><label for="nt2">Názov (voliteľné – inak podľa typu)</label><input id="nt2" name="title" maxlength="60" placeholder="napr. Akcia na Vianoce"></div>
<div><label for="ni">Ikona (emoji)</label><input id="ni" name="icon" maxlength="8" placeholder="🎄"></div>
<div><label for="npos">Pozícia</label><select id="npos" name="after"><option value="end">na koniec</option><option value="start">na začiatok</option>${after}</select></div>
<div><label for="nsl">Adresa stránky (len pre „Samostatná stránka“, voliteľné)</label><input id="nsl" name="slug" maxlength="40" pattern="[a-z0-9\\-]*"></div></div>
<p class="hint">Po vytvorení sa otvorí úprava: obsah, farby, viditeľnosť (všetci / prihlásení / neprihlásení / mobil / počítač) a kotva (#odkaz). Vstavané typy (Cenník, Platobné metódy, Kanály…) môžete pridať aj viackrát, napr. Cenník s inými balíkmi.</p>
<button>➕ Vytvoriť</button></form></details>`;
  }

  r.get('/sekcie', needAuth, wrap(async (req, res) => {
    const rows = await ctx.secAll(), s = await getSettings();
    const home = rows.filter((x) => x.place === 'home'), pg = rows.filter((x) => x.place !== 'home');
    const cat = await navCatalog(s), meta = navMeta(s), ord = orderKeys(cat.map((i) => i.k), jparse(s.nav_order, [])), by = new Map(cat.map((i) => [i.k, i]));
    const navRows = ord.map((k) => by.get(k)).filter(Boolean);
    const navHtml = `<form method="post" action="/admin/sekcie/nav/order" class="dndf" id="dnd-nav">${hid(req)}<input type="hidden" name="order" value=""></form><ol class="dnd" data-form="dnd-nav">${navRows.map((i, n) => {
      const m = meta[i.k] || {}, hidden = !!m.h || i.off;
      return `<li class="dli${hidden ? ' off' : ''}" data-id="${esc(i.k)}"><span class="dh" aria-hidden="true">⠿</span><span class="seci">${esc(m.i || i.icon)}</span><span class="dt"><b>${esc(m.l || i.label)}</b>${hidden ? ' <span class="tag off">skryté</span>' : ''}<br><span class="hint">${esc(i.note || '')}${i.off && i.k[0] === 'n' ? ' · vypnuté v Položkách menu' : ''}</span></span>
<span class="row dact">${mvBtn('/admin/sekcie/nav/move', 'up', n === 0, hid(req) + `<input type="hidden" name="k" value="${esc(i.k)}">`)}${mvBtn('/admin/sekcie/nav/move', 'down', n === navRows.length - 1, hid(req) + `<input type="hidden" name="k" value="${esc(i.k)}">`)}${tog(req, '/admin/sekcie/nav/toggle', !hidden, `<input type="hidden" name="k" value="${esc(i.k)}">`)}
<details class="nren"><summary class="btnl sm">✏️ Premenovať</summary><form method="post" action="/admin/sekcie/nav/meta">${hid(req)}<input type="hidden" name="k" value="${esc(i.k)}"><label>Názov (SK)</label><input name="l" maxlength="40" value="${esc(m.l || '')}" placeholder="${esc(i.label)}"><label>Názov (EN)</label><input name="l2" maxlength="40" value="${esc(m.l2 || '')}"><label>Ikona</label><input name="i" maxlength="8" value="${esc(m.i || '')}" placeholder="${esc(i.icon)}"><button class="sm">💾 Uložiť</button></form></details></span></li>`;
    }).join('')}</ol>`;
    res.send(page('Sekcie a menu', `<h1>🧩 Sekcie a menu</h1>${anav}${msg(req.query.m)}
<p class="hint">Poradie meníte potiahnutím za ⠿ (myšou aj prstom) alebo šípkami ↑ ↓. 🙈 skryje sekciu bez zmazania, ✏️ upraví názov, ikonu, obsah, farby a viditeľnosť.</p>
${createForm(req, rows)}
<div class="card"><h2>🏠 Hlavná stránka – bloky</h2>${dndList(req, 'home', home, s)}</div>
<div class="card"><h2>🧭 Ľavé menu – poradie</h2><p class="hint">Platí pre všetky stránky webu. Skryté položky zmiznú len z menu.</p>${navHtml}</div>
<div class="card"><h2>📄 Vlastné stránky</h2>${pg.length ? dndList(req, 'page', pg, s) : '<p class="hint">Zatiaľ žiadne – vytvorte cez „➕ Vytvoriť sekciu“ › Samostatná stránka.</p>'}</div>
<script src="/static/secadm.js?v=${SEC_V}" defer></script>`, 'a adm'));
  }));

  const okSlug = async (sl, id) => SLUG.test(sl) && !TAKEN.has(sl) && !(await pool.query(`SELECT 1 FROM site_sections WHERE slug=$1 AND id<>$2`, [sl, id || 0])).rowCount;
  ctx.secOkSlug = okSlug;
  const icon = (v) => str(v, 8).replace(/[<>&"'`]/g, '');
  ctx.secIcon = icon;
  const DEF_CFG = { text: { showTitle: 1 }, gallery: { showTitle: 1, cols: 3 }, video: { showTitle: 1 }, links: { style: 'buttons' }, faq: { showTitle: 1, src: 'own' }, countdown: { showTitle: 1 }, pricing: { why: 1, notes: 0, plans: [] }, payments: { showTitle: 1, btn: 1, methods: [] }, channels: { showTitle: 1, status: 1, limit: 20 }, social: { grp: 'all', style: 'groups' }, auth: { showTitle: 1 }, affiliate: { showTitle: 1 }, subcheck: { showTitle: 1 } };

  r.post('/sekcie', needAuth, csrf, wrap(async (req, res) => {
    const kind = KINDS[req.body.kind] ? req.body.kind : 'text', K = KINDS[kind];
    const place = req.body.place === 'page' && !K.home ? 'page' : 'home';
    const rows = await ctx.secAll();
    const ex = K.one && rows.find((x) => placeOf(x) === place && x.kind === kind);
    if (ex && ex.visible) return res.redirect(303, '/admin/sekcie?m=one');
    if (ex) { // built-in that is only hidden → show it again at the chosen position
      await pool.query(`UPDATE site_sections SET visible=true,updated_at=now() WHERE id=$1`, [ex.id]); ctx.secDrop();
      const l = rows.filter((y) => placeOf(y) === place).map((y) => y.id).filter((y) => y !== ex.id), af = String(req.body.after || 'end');
      if (af === 'start') l.unshift(ex.id); else if (af !== 'end' && l.includes(Number(af))) l.splice(l.indexOf(Number(af)) + 1, 0, ex.id); else l.push(ex.id);
      await ctx.secSetOrder(place, l); if (kind === 'chat') await setSettings({ chat_enabled: '1' });
      await audit(req, 'section_show', kind); return res.redirect(303, `/admin/sekcie/${ex.id}?m=shown`);
    }
    const title = str(req.body.title, 60) || K.l;
    let slug;
    if (place === 'page') { slug = str(req.body.slug, 40) || slugify(title); if (!(await okSlug(slug))) return res.redirect(303, '/admin/sekcie?m=slug&new=1'); }
    const af = String(req.body.after || 'end'), after = af === 'start' || af === 'end' ? af : rows.some((x) => x.id === Number(af) && placeOf(x) === place) ? Number(af) : 'end';
    const id = await ctx.secInsert({ slug, title, icon: icon(req.body.icon) || K.i, kind, place, cfg: DEF_CFG[kind] || {}, visible: true, in_nav: place === 'page', after });
    if (!id) return res.redirect(303, '/admin/sekcie?m=slug&new=1');
    if (kind === 'chat') await setSettings({ chat_enabled: '1' });
    await audit(req, 'section_add', kind + ':' + (slug || id)); res.redirect(303, `/admin/sekcie/${id}?m=ok`);
  }));
  r.post('/sekcie/order', needAuth, csrf, wrap(async (req, res) => {
    const ord = String(req.body.order || '').split(',').filter((x) => /^\d{1,9}$/.test(x)).slice(0, 500);
    if (ord.length) { await ctx.secSetOrder(req.body.place === 'page' ? 'page' : 'home', ord); await audit(req, 'section_order', req.body.place === 'page' ? 'page' : 'home'); }
    res.redirect(303, '/admin/sekcie?m=ok');
  }));
  r.post('/sekcie/:id(\\d+)/move', needAuth, csrf, wrap(async (req, res) => {
    const rows = await ctx.secAll(), x = rows.find((y) => y.id === Number(req.params.id));
    if (x) { const l = rows.filter((y) => placeOf(y) === placeOf(x)).map((y) => String(y.id)); await ctx.secSetOrder(placeOf(x), move(l, String(x.id), req.body.dir)); }
    res.redirect(303, '/admin/sekcie');
  }));
  r.post('/sekcie/:id(\\d+)/visible', needAuth, csrf, wrap(async (req, res) => {
    const q = await pool.query(`UPDATE site_sections SET visible=NOT visible,updated_at=now() WHERE id=$1 RETURNING kind,visible,place`, [Number(req.params.id)]); ctx.secDrop();
    if (q.rowCount && q.rows[0].kind === 'chat') await setSettings({ chat_enabled: q.rows[0].visible ? '1' : '0' });
    if (q.rowCount) await audit(req, 'section_visible', req.params.id + ':' + q.rows[0].visible);
    res.redirect(303, '/admin/sekcie?m=ok');
  }));
  r.post('/sekcie/:id(\\d+)/dup', needAuth, csrf, wrap(async (req, res) => {
    const q = await pool.query(`SELECT * FROM site_sections WHERE id=$1`, [Number(req.params.id)]); const x = q.rows[0];
    if (!x || !KINDS[x.kind] || KINDS[x.kind].one) return res.redirect(303, '/admin/sekcie?m=one');
    let slug; if (placeOf(x) === 'page') { let n = 2; do { slug = (x.slug.slice(0, 36) + '-' + n++); } while (!(await okSlug(slug)) && n < 50); }
    const cfg = Object.assign({}, x.cfg); delete cfg.seed; delete cfg.anchor;
    const ins = await pool.query(`INSERT INTO site_sections (slug,title,title_en,icon,kind,body,body_en,body_raw,body_en_raw,videos,visible,in_nav,img_mime,img_data,img_ver,place,cfg,pos)
      SELECT $2,title||' (kópia)',title_en,icon,kind,body,body_en,body_raw,body_en_raw,videos,false,in_nav,img_mime,img_data,img_ver,place,$3::jsonb,pos FROM site_sections WHERE id=$1 RETURNING id`, [x.id, slug || ctx.secAutoSlug(x.kind), JSON.stringify(cfg)]);
    const nid = ins.rows[0].id;
    await pool.query(`INSERT INTO site_section_imgs (sec_id,pos,alt,mime,data,ver) SELECT $2,pos,alt,mime,data,ver FROM site_section_imgs WHERE sec_id=$1`, [x.id, nid]);
    ctx.secDrop(); const l = (await ctx.secAll()).filter((y) => placeOf(y) === placeOf(x)).map((y) => y.id).filter((y) => y !== nid);
    l.splice(l.indexOf(x.id) + 1, 0, nid); await ctx.secSetOrder(placeOf(x), l);
    await audit(req, 'section_dup', x.id + '>' + nid); res.redirect(303, `/admin/sekcie/${nid}?m=dup`);
  }));
  r.post('/sekcie/:id(\\d+)/delete', needAuth, csrf, wrap(async (req, res) => {
    const id = Number(req.params.id); if (req.body.confirm !== '1') return res.redirect(303, `/admin/sekcie/${id}?m=conf`);
    const q = await pool.query(`DELETE FROM site_sections WHERE id=$1 RETURNING slug,kind`, [id]); ctx.secDrop();
    if (q.rowCount && q.rows[0].kind === 'chat') await setSettings({ chat_enabled: '0' });
    if (q.rowCount) await audit(req, 'section_delete', q.rows[0].slug);
    res.redirect(303, '/admin/sekcie?m=del');
  }));

  // ---- menu ----
  const navKey = async (s, k) => (await navCatalog(s)).some((i) => i.k === k) ? k : null;
  const curOrder = async (s) => orderKeys((await navCatalog(s)).map((i) => i.k), jparse(s.nav_order, []));
  r.post('/sekcie/nav/order', needAuth, csrf, wrap(async (req, res) => {
    const s = await getSettings(), cat = (await navCatalog(s)).map((i) => i.k);
    const want = String(req.body.order || '').split(',').filter((k) => cat.includes(k));
    if (want.length) await setSettings({ nav_order: JSON.stringify(orderKeys(cat, want)) });
    await audit(req, 'nav_order', ''); res.redirect(303, '/admin/sekcie?m=ok#dnd-nav');
  }));
  r.post('/sekcie/nav/move', needAuth, csrf, wrap(async (req, res) => {
    const s = await getSettings(), k = await navKey(s, String(req.body.k || ''));
    if (k) await setSettings({ nav_order: JSON.stringify(move(await curOrder(s), k, req.body.dir)) });
    res.redirect(303, '/admin/sekcie#dnd-nav');
  }));
  r.post('/sekcie/nav/toggle', needAuth, csrf, wrap(async (req, res) => {
    const s = await getSettings(), k = await navKey(s, String(req.body.k || '')); if (!k) return res.redirect(303, '/admin/sekcie?m=bad');
    const meta = navMeta(s), m = meta[k] || {};
    if (k === 'stav') await setSettings({ stav_nav: s.stav_nav === '1' ? '0' : '1' });
    else if (k[0] === 's') { await pool.query(`UPDATE site_sections SET in_nav=NOT in_nav WHERE id=$1`, [Number(k.slice(1))]); ctx.secDrop(); }
    else { m.h = m.h ? 0 : 1; meta[k] = m; await setSettings({ nav_meta: JSON.stringify(meta) }); }
    await audit(req, 'nav_toggle', k); res.redirect(303, '/admin/sekcie?m=ok#dnd-nav');
  }));
  r.post('/sekcie/nav/meta', needAuth, csrf, wrap(async (req, res) => {
    const s = await getSettings(), k = await navKey(s, String(req.body.k || '')); if (!k) return res.redirect(303, '/admin/sekcie?m=bad');
    const meta = navMeta(s), m = Object.assign({}, meta[k]);
    m.l = str(req.body.l, 40); m.l2 = str(req.body.l2, 40); m.i = icon(req.body.i);
    for (const f of ['l', 'l2', 'i', 'h']) if (!m[f]) delete m[f];
    if (Object.keys(m).length) meta[k] = m; else delete meta[k];
    await setSettings({ nav_meta: JSON.stringify(meta) }); await audit(req, 'nav_meta', k); res.redirect(303, '/admin/sekcie?m=ok#dnd-nav');
  }));
  return ctx;
};
