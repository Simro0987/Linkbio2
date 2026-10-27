// big-match detector (evbig.js + default config in evsources.js): top-club league clashes, SK/CZ spellings, other sports, false positives
const assert = require('assert');
const B = require('../evbig'), S = require('../evsources');
const cfg = B.parse(S.BIG_DEFAULT), ctx = { cfg, top: [] };
let n = 0, bad = 0; const t = (name, fn) => { n++; try { fn(); console.log('  ✓', name); } catch (e) { bad++; console.log('  ✗', name, e.message); } };
const d = (title, sub, cat) => B.detect(ctx, { title, sub: sub || '', cat: cat || 'Šport', descr: '' });
const big = (title, sub, min = 25) => { const r = d(title, sub); assert.ok(r.pts >= min && r.strong, `${title} ${sub || ''} → ${r.pts} ${r.why.join(', ')}`); return r; };
const small = (title, sub, max = 10) => { const r = d(title, sub); assert.ok(r.pts <= max, `${title} ${sub || ''} → ${r.pts} ${r.why.join(', ')}`); return r; };

t('default config parses without errors and fits the admin limit', () => { assert.deepStrictEqual(cfg.errors, []); assert.ok(S.BIG_DEFAULT.length < 20000); assert.ok(cfg.teams.length >= 100 && cfg.groups.length >= 15); });
t('Juventus – Neapol / SSC Napoli (SK/CZ spelling)', () => { big('Juventus Turín - SSC Neapol'); big('Futbal - Serie A', 'Juventus - Neapol (9. kolo)'); big('Napoli – Juventus'); });
t('Liverpool – Arsenal', () => big('Liverpool FC - Arsenal FC'));
t('Chelsea – Man United (all spellings)', () => { big('Chelsea FC - Man United'); big('Chelsea - Manchester Utd.'); big('Man. Utd - Chelsea Londýn'); });
t('Bayern – Dortmund = Der Klassiker', () => { const r = big('Bayern Mníchov - Borussia Dortmund', '', 40); assert.ok(r.why.some((w) => /Klassiker/.test(w))); });
t('AC Miláno – Inter = Milan derby (Inter Miláno not counted as Milan)', () => { const r = big('AC Miláno - Inter Miláno', '', 40); assert.ok(r.why.some((w) => /Milánske/.test(w))); assert.deepStrictEqual(B.teamsIn(cfg, 'Inter Milán - Lecce'), ['inter']); });
t('LaLiga: Real / Barça / Atlético', () => { big('FC Barcelona - Real Madrid', '', 50); big('Atlético Madrid - FC Barcelona'); big('Real Madrid - Atl. Madrid'); });
t('Ligue 1 / Eredivisie / Portugal top clubs', () => { big('PSG - Olympique Marseille'); big('PSG - Olympique Lyon'); big('Ajax Amsterdam - PSV Eindhoven'); big('Feyenoord - Ajax'); big('Benfica Lisabon - Sporting CP'); });
t('Chance liga / Niké liga top clubs', () => { big('Sparta Praha - Slavia Praha', '', 45); big('Viktoria Plzeň - Baník Ostrava'); big('Slovan Bratislava - Spartak Trnava', '', 40); big('DAC Dunajská Streda - MŠK Žilina'); });
t('hockey: SK/CZ extraliga top, NHL, KHL', () => { big('Hokej - Tipsport liga', '16. kolo: HC Slovan Bratislava - HC Košice', 35); big('Kometa Brno - Oceláři Třinec'); big('Boston Bruins - Montreal Canadiens', '', 20); big('Edmonton Oilers - Florida Panthers', '', 15); });
t('basketball: NBA top teams, Euroleague', () => { big('Los Angeles Lakers - Boston Celtics', '', 30); big('Denver Nuggets - Golden State Warriors', '', 20); big('Basketbal - Euroliga', 'Olympiacos Pireus - Panathinaikos', 30); big('Žalgiris Kaunas - Fenerbahce', '', 20); });
t('tennis: two top-10 players, late rounds', () => { const r = d('Tenis - ATP Masters 1000 Paríž', 'Semifinále: Sinner - Alcaraz'); assert.ok(r.pts >= 25 && r.strong, r.why.join(', ')); });
t('F1 race (CZ „Formule 1“) yes, studio no', () => { assert.ok(d('Formule 1 - Velká cena Mexika 2026').pts >= 30); assert.ok(d('Formule 1 - úvodní studio 2026').pts < 30); assert.ok(d('F1 Academy - Velká cena USA 2026').pts < 30); });
t('UFC / OKTAGON main card yes, countdown/preview no', () => { assert.ok(d('UFC 333: Volkanovski vs. Jevlojev').pts >= 25); assert.ok(d('UFC 333 Countdown: Volkanovski vs. Jevlojev').pts < 25); assert.ok(d('OKTAGON 80: Vémola vs. Bukovinský').pts >= 30); });
t('one top club vs a smaller one is not a big match', () => { small('Bayern Mnichov - 1. FC Magdeburg'); small('Atlético Madrid - Deportivo A Coruña'); small('Le Havre AC - PSG'); small('Sevilla FC - CA Osasuna'); });
t('club names in minor sports do not trigger club clashes', () => { small('Volejbal - Niké Extraliga muži', '2. kolo: VK Slávia SPU Nitra - VK Slovan Bratislava', 6); small('Futsal - Liga majstrov', 'Futsal Club Semey - FC Barcelona', 12); small('Basketbal - Tipos SBL', '14. kolo: BC Slovan Bratislava - Inter Basket'); });
t('national team keeps its weight in every sport', () => { assert.ok(d('Hádzaná - reprezentácia', 'Slovensko - Česko').pts >= 50); });
t('no false positive on non-sport titles', () => { small('Slovensko má talent', '', 0); small('Milano - mesto módy', '', 0); });
t('documentary / studio titles are penalised (unicode boundaries: štúdio, magazín, Osobný príbeh)', () => {
  const E = require('../epgevents');
  for (const x of ["Ballon d'Or – Osobný príbeh", 'Messi: dokument', 'Dokumentárny film o Ronaldovi', 'Osobní příběh: Jágr']) assert.ok(E.DOCSTORY.test(x), x);
  for (const x of ['Štúdio Šport', 'Futbal magazín', 'Liga majstrov – štúdio']) assert.ok(E.MAG.test(x), x);
  for (const x of ['Juventus - Neapol', 'Ballon d\'Or 2026 – slávnostné odovzdávanie', 'Liverpool FC - Arsenal FC']) assert.ok(!E.DOCSTORY.test(x) && !E.MAG.test(x), x);
});
console.log(`${n} evbig tests, ${bad} failed`); if (bad) process.exit(1);
