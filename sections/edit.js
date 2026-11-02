'use strict';
// /admin/sekcie/:id – edit any section: texts, per-kind options, colours, visibility, anchor, images/gallery.
const { sanitize, parseVideo } = require('../sanitize');
const { KINDS, cleanCfg, epochToZoned, str } = require('./types');

module.exports = function edit(ctx, { SEC_V, videoHtml }) {
  const { admin: r, pool, page, esc, hid, csrf, needAuth, wrap, getSettings, setSettings, sniff } = ctx;
  const audit = (req, a, d) => (ctx.audit ? ctx.audit(req, a, d) : null);
  const XM = { big: 'Obrázok je príliš veľký (max 2 MB).', badimg: 'Povolené len PNG, JPEG, WebP.', vid: 'Niektoré odkazy na video boli odmietnuté – povolené sú YouTube, Vimeo a priame https odkazy na .mp4/.webm.', many: 'Galéria môže mať najviac 24 obrázkov.', cd: 'Zadajte platný dátum a čas odpočítavania.' };
  const msg = (q, n) => (XM[q] ? `<div class="msg err">${esc(XM[q])}${n ? ` (${Number(n) || 0}×)` : ''}</div>` : ctx.secMsg(q));
  const ck = (n, on, l) => `<label class="ck"><input type="checkbox" name="${n}" value="1"${on ? ' checked' : ''}> ${l}</label>`;
  const sel = (n, v, o, id) => `<select name="${n}"${id ? ` id="${id}"` : ''}>${o.map(([k, l]) => `<option value="${esc(k)}"${String(v) === String(k) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const TB = (id) => `<div class="tb" data-for="${id}" role="toolbar" aria-label="Formátovanie"><button type="button" class="g" data-tag="b"><b>B</b></button><button type="button" class="g" data-tag="i"><i>I</i></button><button type="button" class="g" data-tag="u"><u>U</u></button><button type="button" class="g" data-tag="h2">H2</button><button type="button" class="g" data-tag="h3">H3</button><button type="button" class="g" data-tag="ul">• Zoznam</button><button type="button" class="g" data-tag="blockquote">❝ Citát</button><button type="button" class="g" data-tag="a">🔗 Odkaz</button></div>`;
  const BODY = (x) => `<label for="sb_sk">Text (SK) – obyčajný text (prázdny riadok = nový odsek) alebo HTML: &lt;b&gt; &lt;i&gt; &lt;u&gt; &lt;h2&gt; &lt;h3&gt; &lt;ul&gt;&lt;li&gt; &lt;a href&gt; &lt;blockquote&gt; (iné značky a skripty sa odstránia)</label>${TB('sb_sk')}
<textarea id="sb_sk" name="body" rows="9" maxlength="20000">${esc(x.body_raw)}</textarea><label>Text (EN, voliteľné)</label><textarea name="body_en" rows="4" maxlength="20000">${esc(x.body_en_raw)}</textarea>`;

  async function kindFields(x) {
    const c = x.cfg || {};
    switch (x.kind) {
      case 'text': return BODY(x) + `${x.img_ver ? `<img class="gprev" src="/sekcia-img/${x.id}?v=${esc(x.img_ver)}" alt="" width="320" height="180">${ck('img_del', 0, 'Odstrániť obrázok')}` : ''}<label>Obrázok (voliteľné, PNG/JPEG/WebP, max 2 MB)</label><input type="file" name="image" accept="image/png,image/jpeg,image/webp">`;
      case 'video': return BODY(x) + `<label>Videá – jeden odkaz na riadok, voliteľne s názvom: <code>https://youtu.be/xxxx | Názov videa</code> (YouTube, Vimeo, priamy https .mp4/.webm)</label><textarea name="videos" rows="5" maxlength="12000">${esc((x.videos || []).map((v) => (v.src || '') + (v.title ? ' | ' + v.title : '')).join('\n'))}</textarea>`;
      case 'gallery': return `<label>Stĺpce na počítači</label>${sel('cols', c.cols || 3, [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']])}<div class="galed">${(x.gal || []).map((g) => `<div class="gale"><img src="/sekcia-gal/${g.id}?v=${esc(g.ver)}" alt="" width="120" height="90"><label>Popis</label><input name="alt_${g.id}" value="${esc(g.alt)}" maxlength="120">${ck('gdel_' + g.id, 0, 'Odstrániť')}</div>`).join('') || '<p class="hint">Zatiaľ žiadne obrázky.</p>'}</div><label>Pridať obrázky (až 12 naraz, PNG/JPEG/WebP, max 2 MB každý)</label><input type="file" name="gal" multiple accept="image/png,image/jpeg,image/webp">`;
      case 'links': return `<label>Odkazy – jeden na riadok: <code>Text | URL | emoji</code> (URL: https://…, /tv/cennik, mailto:, tel: alebo #kotva)</label><textarea name="links" rows="6" maxlength="6000" placeholder="Napíšte nám | https://t.me/… | 💬">${esc(c.links || '')}</textarea><label>Vzhľad</label>${sel('style', c.style || 'buttons', [['buttons', 'Veľké tlačidlá'], ['list', 'Zoznam odkazov']])}`;
      case 'faq': return `<label>Zdroj otázok</label>${sel('src', c.src || 'own', [['own', 'Vlastné otázky (nižšie)'], ['list', 'Všetky otázky z admin › FAQ']])}<label>Vlastné otázky – prvý riadok otázka, pod ním odpoveď, bloky oddeľte prázdnym riadkom</label><textarea name="faq" rows="10" maxlength="30000" placeholder="Ako dlho trvá aktivácia?\nZvyčajne do 15 minút.\n\nFunguje to na Smart TV?\nÁno.">${esc(c.faq || '')}</textarea>`;
      case 'countdown': return `<label for="cdat">Odpočítavať do (čas Slovensko)</label><input id="cdat" type="datetime-local" name="at" value="${esc(c.at || (c.t ? epochToZoned(c.t) : ''))}" required><label>Text po skončení</label><input name="done" maxlength="200" value="${esc(c.done || '')}" placeholder="Už je to tu!">`;
      case 'pricing': {
        const ps = await ctx.getList('plans');
        return `<p class="hint">Vyberte balíky z Cenníka. Nič nezaškrtnuté = všetky aktívne balíky (aj budúce).</p><div class="ckg">${ps.map((p) => ck('plans', (c.plans || []).includes(String(p.id)), esc(p.name) + (p.active ? '' : ' <span class="tag off">neaktívny</span>')).replace('value="1"', `value="${esc(String(p.id))}"`)).join('')}</div>${ck('intro', c.intro, 'Úvodný text Cenníka')}${ck('why', c.why, '„Prečo sa zaregistrovať“ pod balíkmi (neprihláseným)')}${ck('notes', c.notes, 'Poznámka pod Cenníkom (podmienky)')}`;
      }
      case 'payments': {
        const it = await ctx.secPayItems();
        return `<p class="hint">Zobrazia sa len zapnuté metódy (admin › Platobné metódy), bez poplatkov. Nič nezaškrtnuté = všetky zapnuté (aj budúce).</p><div class="ckg">${it.map((m) => ck('methods', (c.methods || []).includes(m.id), esc(m.name)).replace('value="1"', `value="${esc(m.id)}"`)).join('') || '<p class="hint">Platobný modul momentálne nevrátil žiadne zapnuté metódy.</p>'}</div>${ck('btn', c.btn, 'Tlačidlo „Všetky spôsoby platby“')}`;
      }
      case 'channels': return `<label>Počet kanálov (prázdne = všetky)</label><input name="limit" type="number" min="1" max="500" value="${esc(c.limit || '')}">${ck('status', c.status, 'Zobraziť stav (funguje / výpadok)')}${ck('epg', c.epg, 'Zobraziť TV program (Teraz / Potom)')}`;
      case 'social': return `<label>Ktoré kontakty</label>${sel('grp', c.grp || 'all', [['all', 'Všetky'], ['g', 'Len Skupiny'], ['p', 'Len Priame kontakty']])}<label>Vzhľad</label>${sel('style', c.style || 'icons', [['icons', 'Malé ikony (ako na hlavnej stránke)'], ['buttons', 'Veľké tlačidlá'], ['groups', 'Skupiny / Priame kontakty (ako stránka Kontakt)']])}`;
      case 'auth': case 'affiliate': case 'subcheck': return `<label>Krátky text nad blokom (voliteľné)</label><textarea name="note" rows="3" maxlength="500">${esc(c.note || '')}</textarea>`;
      case 'chat': return '<p class="hint">Zobrazí/skryje AI chat podpory na všetkých stránkach (rovnaké ako admin › Texty › AI chatbot).</p>';
      default: return `<p class="hint">Tento blok zobrazuje existujúcu časť webu – obsah upravíte na pôvodnom mieste v admin (Texty, Tlačidlá, Top udalosti, EPG…). Tu meníte poradie, viditeľnosť, farby a kotvu.</p>`;
    }
  }

  r.get('/sekcie/:id(\\d+)', needAuth, wrap(async (req, res, next) => {
    const x = (await ctx.secAll()).find((y) => y.id === Number(req.params.id)); if (!x) return next();
    const q = await pool.query(`SELECT body_raw,body_en_raw FROM site_sections WHERE id=$1`, [x.id]); Object.assign(x, q.rows[0]);
    const s = await getSettings(), c = x.cfg || {}, K = KINDS[x.kind] || { l: x.kind }, isPage = x.place !== 'home';
    const prev = x.kind === 'video' && (x.videos || []).length ? `<div class="card"><h2>Náhľad videí</h2><div class="vids">${x.videos.map((v, i) => videoHtml(v, i, (k) => k)).join('')}</div><script src="/static/sec.js?v=${SEC_V}" defer></script></div>` : '';
    const where = isPage ? `<a href="/${esc(s.slug)}/${esc(x.slug)}" target="_blank" rel="noopener">/${esc(s.slug)}/${esc(x.slug)}</a>` : `<a href="/${esc(s.slug)}${c.anchor ? '#' + esc(c.anchor) : ''}" target="_blank" rel="noopener">hlavná stránka</a>`;
    res.send(page('Sekcia – ' + x.title, `<h1>${esc(x.icon || K.i || '📄')} ${esc(x.title)}</h1>${ctx.secAnav}${msg(req.query.m, req.query.n)}
<p class="hint">Typ: <b>${esc(K.l)}</b> · ${where}${x.visible ? '' : ' – <b>skryté</b>'}</p>
<form method="post" action="/admin/sekcie/${x.id}" enctype="multipart/form-data" class="card secedit">${hid(req)}
<div class="g2"><div><label>Názov (SK)</label><input name="title" value="${esc(x.title)}" maxlength="60" required></div><div><label>Názov (EN, voliteľné)</label><input name="title_en" value="${esc(x.title_en)}" maxlength="60"></div>
<div><label>Ikona (emoji)</label><input name="icon" value="${esc(x.icon)}" maxlength="8"></div>${isPage ? `<div><label>Adresa (slug)</label><input name="slug" value="${esc(x.slug)}" maxlength="40" pattern="[a-z0-9\\-]+" required></div>` : ''}</div>
${isPage && (x.kind === 'text' || x.kind === 'video') ? `<label>Typ</label>${sel('kind', x.kind, [['text', KINDS.text.l], ['video', KINDS.video.l]])}` : ''}
<h2 class="sech2">Obsah</h2>${await kindFields(x)}
<h2 class="sech2">Vzhľad a viditeľnosť</h2>
${ck('visible', x.visible, 'Zobraziť verejne')}${isPage ? ck('in_nav', x.in_nav, 'Zobraziť v ľavom menu') : ''}${!isPage && x.kind !== 'hero' && x.kind !== 'chat' ? ck('showTitle', c.showTitle, 'Zobraziť nadpis bloku (názov + ikona)') : ''}
${x.kind !== 'chat' ? `<div class="g2"><div><label>Kto blok uvidí</label>${sel('vis', c.vis || 'all', [['all', 'Všetci'], ['in', 'Len prihlásení zákazníci'], ['out', 'Len neprihlásení'], ['mobile', 'Len mobil'], ['desktop', 'Len počítač']])}</div>
<div><label>Kotva – odkaz #… (a-z, 0-9, -)</label><input name="anchor" value="${esc(c.anchor || '')}" maxlength="40" pattern="[a-z][a-z0-9\\-]*" placeholder="napr. akcia"></div>
<div>${ck('bg_on', !!c.bg, 'Vlastná farba pozadia')}<input type="color" name="bg" value="${esc(c.bg || '#141a2e')}" aria-label="Farba pozadia"></div>
<div>${ck('fg_on', !!c.fg, 'Vlastná farba textu')}<input type="color" name="fg" value="${esc(c.fg || '#e6e9f5')}" aria-label="Farba textu"></div></div>${ck('box', c.box, 'Orámovať blok (karta)')}` : ''}
<button>💾 Uložiť</button></form>${prev}
<form method="post" action="/admin/sekcie/${x.id}/delete" class="card">${hid(req)}<label class="ck"><input type="checkbox" name="confirm" value="1" required> Áno, natrvalo zmazať túto sekciu${K.b ? ' (vstavaný blok môžete neskôr znova pridať cez „➕ Vytvoriť sekciu“)' : ''}</label><button class="d">🗑️ Zmazať</button></form>
<script src="/static/secadm.js?v=${SEC_V}" defer></script>`, 'a adm'));
  }));
  return ctx;
};
