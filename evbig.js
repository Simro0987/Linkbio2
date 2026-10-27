'use strict';
// "Veľký zápas" detector for Top udalosti – all sports on equal footing. Config is plain text (admin: /admin/udalosti → evh_big),
// default = evsources BIG_DEFAULT. Only scores candidates that already passed the SK/CZ channel allowlist.
//   tim <id>: alias / alias …            team or club (aliases matched on whole words, longest first, diacritics ignored)
//   rivalita <name> = <pts>: id + id     the two teams in one title (or the rivalry name itself, e.g. „El Clásico“)
//   skupina <name> = <pts>: id, id, …    clash of two teams from the group (big clubs, Original Six, Extraliga top…)
//   hviezdy <name> = <pts>: id, id, …    one team is enough (NHL teams with SK/CZ stars)
//   mena <name> = <pts>: Name / Name …   athlete names (SK/CZ players, top players)
//   pravidlo <name> = <pts>: regex       regex on title + subtitle + EPG category, lower-case without diacritics
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/ł/g, 'l').toLowerCase().replace(/[^a-z0-9+&]+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// club names are shared across sports (VK Slovan, HC DAC handball, futsal FC Barcelona…) – in these sports a club clash is not a „big match“
const MINOR = /\b(volejbal|volleyball|hadzana|hazena|handball|futsal|florbal|floorball|vodne polo|vodni polo|water polo|vizilabda|plazovy|beach|basketbal zeny|zeny basketbal)\b/;
const NAT = new Set(['sk', 'cz']); // national teams keep their rivalry in every sport
const pts = (s, d) => { const n = parseInt(s, 10); return Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : d; };

function parse(txt) {
  const cfg = { teams: [], rival: [], groups: [], stars: [], names: [], rules: [], errors: [] };
  for (let raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const m = /^(tim|tím|rivalita|skupina|hviezdy|mena|mená|pravidlo)\s+([^:=]+?)\s*(?:=\s*(\d{1,2}))?\s*:\s*(.+)$/i.exec(line);
    if (!m) { cfg.errors.push(line.slice(0, 60)); continue; }
    const kind = norm(m[1]), name = m[2].trim(), w = m[3], rest = m[4].trim();
    if (kind === 'tim') { const al = rest.split('/').map(norm).filter((a) => a.length >= 2); if (al.length) cfg.teams.push({ id: norm(name), al }); }
    else if (kind === 'rivalita') { const ids = rest.split('+').map(norm).filter(Boolean); if (ids.length === 2) cfg.rival.push({ name, a: ids[0], b: ids[1], w: pts(w, 40), nk: norm(name) }); }
    else if (kind === 'skupina') cfg.groups.push({ name, ids: new Set(rest.split(',').map(norm).filter(Boolean)), w: pts(w, 20) });
    else if (kind === 'hviezdy') cfg.stars.push({ name, ids: new Set(rest.split(',').map(norm).filter(Boolean)), w: pts(w, 12) });
    else if (kind === 'mena') { const al = rest.split('/').map(norm).filter((a) => a.length >= 3); if (al.length) cfg.names.push({ name, re: new RegExp('\\b(' + al.map(esc).join('|') + ')\\b'), w: pts(w, 12) }); }
    else if (kind === 'pravidlo') { try { cfg.rules.push({ name, re: new RegExp(rest, 'i'), w: pts(w, 15) }); } catch { cfg.errors.push(line.slice(0, 60)); } }
  }
  // longest alias first so „Real Sociedad“ / „New York Rangers“ win over „Real“ / „Rangers“
  cfg.alias = cfg.teams.flatMap((t) => t.al.map((a) => ({ a, id: t.id }))).sort((x, y) => y.a.length - x.a.length);
  return cfg;
}

// teams present in a text (each span consumed once)
function teamsIn(cfg, text) {
  let t = ' ' + norm(text) + ' '; const out = [];
  for (const { a, id } of cfg.alias) {
    const k = ' ' + a + ' '; let i = t.indexOf(k);
    while (i >= 0) { if (!out.includes(id)) out.push(id); t = t.slice(0, i + 1) + '#'.repeat(a.length) + t.slice(i + 1 + a.length); i = t.indexOf(k); }
  }
  return out;
}

// ctx: { cfg, top: [{league, teams:Set<normName>}] }  → { pts, why[] }
function detect(ctx, p) {
  if (!ctx || !ctx.cfg) return { pts: 0, why: [], strong: false };
  const cfg = ctx.cfg, title = p.title + ' ' + (p.sub || ''), head = norm(title + ' ' + (p.cat || '')), why = []; let sc = 0;
  const add = (w, label) => { sc += w; why.push(label + ' +' + w); };
  const minor = MINOR.test(head);
  const tm = teamsIn(cfg, title);
  let rv = cfg.rival.find((r) => (tm.includes(r.a) && tm.includes(r.b) && (!minor || (NAT.has(r.a) && NAT.has(r.b)))) || (r.nk.length > 5 && (' ' + head + ' ').includes(' ' + r.nk + ' ')));
  if (rv) add(rv.w, rv.name);
  let strong = !!rv; // a specific match/athlete (not just „a world championship“) – exempts a minor sport from its penalty
  const g = !minor && cfg.groups.filter((x) => tm.filter((id) => x.ids.has(id)).length >= 2).sort((a, b) => b.w - a.w)[0]; if (g && !rv) { add(g.w, g.name); strong = true; }
  else if (g && rv) add(Math.round(g.w / 3), g.name);
  // one team is enough, but only in a match title („A – B“, „A vs. B“) – not „Slovensko má talent“
  const vs = /\s[-–—]\s|\svs?\.?\s|\s:\s/i.test(title);
  const st = vs && cfg.stars.filter((x) => tm.some((id) => x.ids.has(id) && (!minor || NAT.has(id)))).sort((a, b) => b.w - a.w)[0]; if (st) { add(st.w, st.name); strong = true; }
  // top-of-table clash (TheSportsDB standings, top 4 of the same league)
  if (ctx.top && ctx.top.length) {
    const t = ' ' + norm(title) + ' ';
    for (const L of ctx.top) { const hit = L.teams.filter((n, i) => ((L.tids && L.tids[i]) || []).some((id) => tm.includes(id)) || (n.length >= 4 && t.includes(' ' + n + ' '))); if (hit.length >= 2) { strong = true; add(15, 'špička tabuľky (' + L.league + ')'); break; } }
  }
  const nm = cfg.names.filter((x) => x.re.test(head + ' ' + norm(String(p.descr || '').slice(0, 200)))).sort((a, b) => b.w - a.w);
  if (nm[0]) { add(nm[0].w, nm[0].name); strong = true; } if (nm[1]) add(Math.round(nm[1].w / 2), nm[1].name);
  // rules: best two count fully/half (several rules may describe the same thing)
  const rl = cfg.rules.filter((r) => r.re.test(head)).sort((a, b) => b.w - a.w);
  if (rl[0]) add(rl[0].w, rl[0].name); if (rl[1]) add(Math.round(rl[1].w / 2), rl[1].name); if (rl[2]) add(Math.round(rl[2].w / 3), rl[2].name);
  // women's / youth team competitions (WSL, „ženy“, U21…) count half – except when a named SK/CZ or star athlete is in it (Vlhová…)
  if (sc && !nm[0] && /\b(zeny|zien|zenske|women|womens|wsl|u1[6-9]|u2[01]|junior|juniori|dorast)\b/.test(head)) { sc = Math.round(sc / 2); why.push('ženy/mládež ½'); }
  return { pts: Math.min(sc, 60), why, teams: tm, strong };
}

module.exports = { parse, detect, teamsIn, norm, MINOR };
