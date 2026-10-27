'use strict';
// Admin: watch-only xpub per coin → a fresh receive address per order (public keys only; private keys/seeds are rejected).
const xpub = require('./pay/src/xpub');

module.exports = function install(ctx) {
  const { admin, pool, page, esc, hid, csrf, needAuth, wrap, audit } = ctx;
  const XB = '/admin/xpub';
  const MS = { ok: 'Uložené.', del: 'Kľúč bol odstránený – platby používajú opäť pevnú adresu.', bad: 'Neplatné údaje.' };
  const lastErr = new Map(); // coin -> { msg, at } (message never contains the pasted key)
  ctx.xpubInit = () => xpub.init(pool);

  admin.get('/xpub', needAuth, wrap(async (req, res) => {
    const m = MS[req.query.m] ? `<div class="msg${req.query.m === 'bad' ? ' err' : ''}">${esc(MS[req.query.m])}</div>` : '';
    const cards = [];
    for (const coin of ['ltc', 'btc']) {
      const C = xpub.COINS[coin], st = await xpub.status(coin).catch(() => null), e = lastErr.get(coin);
      let prev = '';
      if (st) { try { prev = `<ol class="mono" start="0">${xpub.preview(st.xpub, coin, st.script, 3).map((a) => `<li>${esc(a.path)} → <b>${esc(a.address)}</b></li>`).join('')}</ol><p class="hint">Over si v peňaženke, že prvé adresy sa zhodujú s adresami na prijímanie (záložka „Prijať“ / „Receive“). Ak nie, zvoľ iný typ adries nižšie.</p>`; } catch { prev = '<p class="msg err">Uložený kľúč sa nepodarilo načítať.</p>'; } }
      cards.push(`<section class="card" id="x-${coin}"><h2>${esc(C.label)}</h2>
${e && Date.now() - e.at < 600e3 ? `<div class="msg err">${esc(e.msg)}</div>` : ''}
${st ? `<p>Stav: ${st.enabled ? '✅ zapnuté – každá objednávka dostane novú adresu' : '⏸ vypnuté – používa sa pevná adresa'} · kľúč <code>${esc(xpub.mask(st.xpub))}</code> · ďalší index: <b>${st.next_index}</b> · vydaných ${st.issued}, zaplatených ${st.used}</p><h3>Prvé 3 adresy</h3>${prev}`
    : '<p class="hint">Nenastavené – platby používajú pevnú adresu z „Adresy peňaženiek“ (správanie bez zmeny).</p>'}
<form method="post" action="${XB}/${coin}">${hid(req)}
<label for="k-${coin}">Rozšírený verejný kľúč (${coin === 'ltc' ? 'zpub / Ltub / Mtub / xpub' : 'zpub / ypub / xpub'}) ${st ? '<b>(uložený)</b>' : '<span class="hint">(nenastavený)</span>'}</label>
<input id="k-${coin}" name="key" maxlength="200" autocomplete="off" spellcheck="false" placeholder="${st ? 'prázdne = ponechať uložený' : (coin === 'ltc' ? 'zpub… alebo Ltub…' : 'zpub…')}">
<label for="s-${coin}">Typ adries</label><select id="s-${coin}" name="script">${Object.entries(xpub.SCRIPTS).map(([v, l]) => `<option value="${v}"${(st ? st.script : 'auto') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
<label for="g-${coin}">Gap limit (koľko nezaplatených adries môže byť za sebou; Electrum = 20)</label><input id="g-${coin}" name="gap" type="number" min="5" max="1000" value="${st ? st.gap_limit : 20}">
<label class="ck"><input type="checkbox" name="enabled" value="1"${!st || st.enabled ? ' checked' : ''}> Zapnuté</label>
<p class="row"><button>💾 Uložiť</button></p></form>
${st ? `<form method="post" action="${XB}/${coin}/delete">${hid(req)}<button class="d">Odstrániť kľúč</button></form>` : ''}</section>`);
    }
    res.send(page('xpub – automatické adresy', `<h1>🔑 xpub – nová adresa pre každú objednávku</h1>${m}
<p class="row"><a class="btnl sm" href="/admin">← Admin</a><a class="btnl sm" href="/admin/penazenky">👛 Adresy peňaženiek</a></p>
<div class="msg">Vkladajte iba <b>verejný</b> rozšírený kľúč (xpub / ypub / zpub, pre LTC aj Ltub / Mtub). Súkromný kľúč (xprv, Ltpv…), WIF ani slová seedu sem nikdy nepatria – systém ich odmietne. Z verejného kľúča sa dajú len vytvárať adresy na prijímanie, nie míňať peniaze.</div>
${cards.join('\n')}
<section class="card"><h2>Kde nájdem xpub?</h2><ul>
<li><b>Electrum / Electrum-LTC:</b> Peňaženka → Informácie (Wallet → Information) → „Master Public Key“ (zpub… pri SegWit peňaženke).</li>
<li><b>Trezor Suite:</b> účet → Podrobnosti (Details) → „Zobraziť verejný kľúč (xpub)“ – potvrdiť na zariadení.</li>
<li><b>Ledger Live:</b> účet → ⋯ / kľúč → Upraviť účet → Rozšírené (Advanced) → xpub. Ledger zobrazuje vždy „xpub…“ aj pre Native SegWit účty – vtedy zvoľte typ „Native SegWit – BIP84“.</li>
<li><b>Exodus (desktop):</b> otvorte peňaženku BTC / LTC → ⋮ (vpravo hore) → „Export XPub“ → na ploche vznikne priečinok <code>exodus-exports</code> so súborom .txt. Pre BTC vložte <b>zpub</b> (adresy bc1q…), pre LTC vložte uvedený xpub (adresy L…). Exodus Mobile treba najprv zosynchronizovať s desktopom. Súkromný kľúč nikdy nevkladajte.</li></ul></section>`, 'a adm'));
  }));

  admin.post('/xpub/:coin', needAuth, csrf, wrap(async (req, res) => {
    const coin = req.params.coin; if (!xpub.COINS[coin]) return res.redirect(303, XB + '?m=bad');
    const key = String(req.body.key || '').trim(); const cur = xpub.getCfg(coin);
    try {
      await xpub.save(coin, key || (cur && cur.xpub) || '', req.body.script, req.body.gap, req.body.enabled === '1');
      lastErr.delete(coin); await audit(req, 'xpub_save', coin);
      res.redirect(303, XB + '?m=ok#x-' + coin);
    } catch (e) {
      lastErr.set(coin, { msg: e instanceof xpub.XpubError ? e.message : 'Uloženie zlyhalo.', at: Date.now() });
      if (e && e.code && /private|wif|seed/.test(e.code)) await audit(req, 'xpub_reject_private', coin);
      res.redirect(303, XB + '#x-' + coin);
    }
  }));
  admin.post('/xpub/:coin/delete', needAuth, csrf, wrap(async (req, res) => {
    const coin = req.params.coin; if (!xpub.COINS[coin]) return res.redirect(303, XB + '?m=bad');
    await xpub.remove(coin); await audit(req, 'xpub_delete', coin); res.redirect(303, XB + '?m=del');
  }));
  return ctx;
};
