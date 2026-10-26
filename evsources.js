'use strict';
// ============================================================================================================
//  evsources.js – editable source guide for the "Top udalosť týždňa" hero (images + short descriptions).
//  Everything here is plain data: change the order, domains or prompts without touching the resolver code.
//  Rules that the resolver (evimg.js) always enforces, whatever is written here:
//   • images/text are fetched only server-side, only over https, only from public hosts, with size caps;
//   • images are downloaded once, re-encoded to small webp and stored in Postgres – never hotlinked;
//   • official pages are fetched ONLY from the whitelisted domains below (Gemini may suggest a URL, the whitelist
//     decides); IMDb, ČSFD and any streaming / IPTV sites are never used;
//   • Gemini must confirm that a found image/text belongs to this exact event (title, date/season, participants)
//     with confidence ≥ VERIFY_MIN – otherwise the next source is tried, finally the bundled fallback background;
//   • descriptions are written by Gemini strictly from the gathered facts – no facts → no description.
// ============================================================================================================

// genres the research step can return; `cat` = bundled fallback background family (static/ev/<cat>-<n>.webp)
const GENRES = {
  sport: { cat: 'stadium', label: 'šport' },
  film: { cat: 'film', label: 'film' },
  series: { cat: 'series', label: 'seriál' },
  reality: { cat: 'reality', label: 'reality show' },
  show: { cat: 'show', label: 'zábavná šou' },
  concert: { cat: 'show', label: 'koncert' },
  awards: { cat: 'awards', label: 'udeľovanie cien' },
  news: { cat: 'news', label: 'spravodajstvo / voľby' },
  documentary: { cat: 'documentary', label: 'dokument' },
  newyear: { cat: 'newyear', label: 'Silvester' },
  royal: { cat: 'awards', label: 'kráľovská udalosť' },
};

// image source order per genre (first verified + good-quality image wins; `admin` upload always wins)
//  official    – og:image / twitter:image of an official page on the whitelist (league, federation, organiser)
//  broadcaster – og:image of the SK/CZ broadcaster's programme page (whitelist BROADCASTER)
//  thesportsdb – TheSportsDB team fanart (A vs B → split background of both teams), banners, badges
//  tmdb        – TMDB backdrop (only when TMDB_API_KEY env or the admin setting is present)
//  wikipedia   – the article's lead image when it is a freely licensed Commons file
//  commons     – Wikimedia Commons search, free licences only (CC0 / PD / CC BY / CC BY-SA), credit stored + shown
const IMG_ORDER = {
  sport: ['official', 'thesportsdb', 'wikipedia', 'commons', 'broadcaster'],
  film: ['tmdb', 'wikipedia', 'broadcaster', 'commons'],
  series: ['tmdb', 'wikipedia', 'broadcaster', 'commons'],
  reality: ['broadcaster', 'wikipedia', 'tmdb', 'commons'],
  show: ['broadcaster', 'official', 'wikipedia', 'tmdb', 'commons'],
  concert: ['official', 'wikipedia', 'broadcaster', 'commons'],
  awards: ['official', 'wikipedia', 'commons', 'broadcaster'],
  news: ['broadcaster', 'wikipedia', 'commons'],
  documentary: ['tmdb', 'wikipedia', 'broadcaster', 'commons'],
  newyear: ['broadcaster', 'wikipedia', 'commons'],
  royal: ['official', 'wikipedia', 'commons', 'broadcaster'],
};
// description fact order (EPG text first; Gemini then writes a short Slovak teaser only from these facts)
const DESC_ORDER = {
  sport: ['epg', 'oktagon', 'official', 'thesportsdb', 'wikipedia'],
  film: ['epg', 'tmdb', 'wikipedia', 'broadcaster'],
  series: ['epg', 'tmdb', 'wikipedia', 'broadcaster'],
  documentary: ['epg', 'tmdb', 'wikipedia', 'broadcaster'],
  _: ['epg', 'official', 'broadcaster', 'wikipedia', 'tmdb'],
};

// official domains (sub-domains included). Gemini may propose URLs; only these hosts are ever fetched.
const OFFICIAL = {
  sport: ['uefa.com', 'fifa.com', 'nhl.com', 'iihf.com', 'formula1.com', 'fia.com', 'motogp.com', 'atptour.com', 'wtatennis.com', 'itftennis.com',
    'daviscup.com', 'billiejeankingcup.com', 'wimbledon.com', 'rolandgarros.com', 'usopen.org', 'ausopen.com', 'olympics.com', 'oktagonmma.com', 'ufc.com',
    'francefootball.fr', 'ballondor.com', 'tipsportliga.cz', 'hokej.cz', 'hockeyslovakia.sk', 'nikeliga.sk', 'futbalsfz.sk', 'fortunaliga.cz', 'chanceliga.cz',
    'fotbal.cz', 'nba.com', 'euroleaguebasketball.net', 'fiba.basketball', 'aba-liga.com', 'nbl.cz', 'cbf.cz', 'championsleague.com', 'premierleague.com',
    'laliga.com', 'bundesliga.com', 'legaseriea.it', 'ligue1.com', 'worldathletics.org', 'european-athletics.com', 'letour.fr', 'uci.org', 'tourdeski.com',
    'fis-ski.com', 'biathlonworld.com', 'ehf.eu', 'ihf.info', 'cev.eu', 'volleyballworld.com', 'pdc.tv', 'wst.tv', 'superbowl.com', 'nfl.com',
    'novasport.sk', 'novasport.cz', 'premiersport.sk', 'premiersport.cz', 'sport.ceskatelevize.cz', 'sport.stvr.sk', 'joj.sk'],
  awards: ['oscars.org', 'goldenglobes.com', 'grammy.com', 'emmys.com', 'eurovision.tv', 'festival-cannes.com', 'kviff.com', 'ceskylev.cz', 'slnkovsieti.sk',
    'ballondor.com', 'francefootball.fr', 'nobelprize.org', 'zlatyslavik.sk'],
  concert: ['eurovision.tv', 'grammy.com', 'livenation.com', 'o2arena.cz', 'tipsportarena.sk'],
  royal: ['royal.uk', 'kongehuset.dk', 'kungahuset.se', 'monarchie.lu'],
};
// SK/CZ channels of the "Kanály" list → official channel/broadcaster domains (only SK/CZ broadcasters – foreign feeds are never
// used for selection nor as a source). pattern = case-insensitive regex on the channel name in the Kanály catalogue (tv_channels);
// channels added later in admin are matched automatically. Admin can add/deny more names in /admin/udalosti (evh_ch).
const CHANNELS = [
  ['STVR (Jednotka, Dvojka, :24, Šport)', '^(jednotka|dvojka|trojka|stvr|rtvs|:24)', ['stvr.sk', 'rtvs.sk']],
  ['Markíza (Markíza, Doma, Dajto, Krimi, Klasik)', '^(mark[ií]za|doma\\b|dajto)', ['markiza.sk', 'tvnoviny.sk', 'voyo.markiza.sk', 'voyo.sk']],
  ['JOJ (JOJ, Plus, Wau, Cinema, Family, 24, Svet, Krimi, Šport, Jojko, CS)', '^(joj|wau\\b)|^cs (film|horror|history|mystery)', ['joj.sk', 'joj.cz']],
  ['TA3', '^ta3\\b', ['ta3.com']],
  ['Prima (CZ + SK)', '^prima\\b|^cnn prima', ['iprima.cz', 'prima.cz', 'cnn.iprima.cz']],
  ['Česká televize (ČT1, ČT2, ČT24, ČT sport, ČT :D / art)', '^(čt|ct)\\s?(1|2|24|sport|:d|art|déčko)\\b|^čt\\b', ['ceskatelevize.cz', 'ct24.ceskatelevize.cz', 'sport.ceskatelevize.cz', 'decko.ceskatelevize.cz']],
  ['Nova (Nova, Action, Cinema, Fun, Krimi, Lady, International)', '^nova (fhd|hd|action|cinema|fun|krimi|lady|international|gold|\\+1)|^nova$', ['nova.cz', 'tn.nova.cz', 'voyo.nova.cz']],
  ['Nova Sport', '^nova sport', ['novasport.sk', 'novasport.cz']],
  ['Oneplay Sport', '^oneplay sport', ['oneplay.cz']],
  ['Premier Sport', '^premier sport', ['premiersport.sk', 'premiersport.cz']],
  ['Arena Sport SK/CZ', '^arena sport', ['arenasport.sk', 'arenasport.cz', 'tvarena.sk']],
  ['Eurosport (SK/CZ feed)', '^eurosport', ['eurosport.sk', 'eurosport.cz']],
  ['Sport1 / Sport2', '^sport ?[12]\\b', ['sport1tv.cz', 'sport2.cz']],
  ['Canal+ Sport / Action (CZ/SK)', '^canal\\+', ['canalplus.cz', 'canalplus.sk']],
  ['Barrandov', 'barrandov', ['barrandov.tv']],
  ['Televize Seznam', 'seznam', ['seznam.cz', 'televizeseznam.cz']],
  ['TV Noe', '^tv noe', ['tvnoe.cz', 'noe.cz']], ['TV Lux', '^tv lux', ['tvlux.sk']], ['ZAK TV', '^zak\\b', ['zaktv.cz']], ['A11', '^a11\\b', ['a11.cz']],
  ['Polar', '^polar', ['polar.cz']], ['TV Mňam', 'mňam', ['mnamtv.cz']], ['TV Paprika', 'paprika', ['tvpaprika.cz']], ['Óčko', '^óčko|^ocko', ['ocko.tv']],
  ['Šláger', '^šláger|^slager', ['slagr.cz']], ['Rebel / Retro Music / Senzi / Folklorika / Premium', '^(rebel|retro music|senzi|folklorika|premium)\\b', []],
  ['Skvelé TV / TV Doktor', '^(skvel|tv doktor)', []], ['Kanal 1', '^kanal ?1', []], ['Strike TV / FightBox / Fast&Funbox / Gametoon', '^(strike tv|fightbox|fast&funbox|gametoon)', []],
  ['HBO / Cinemax (CZ/SK)', '^(hbo|cinemax)\\b', ['hbo.cz', 'hbo.sk']], ['AMC (CZ)', '^amc\\b', ['amctv.cz']], ['AXN (CZ/SK)', '^axn\\b', ['axn.cz', 'axn.sk']],
  ['Film+', '^film\\+', ['filmplus.cz', 'filmplus.sk']], ['FilmBox+ / DocuBox / Fast&FunBox', '^(filmbox|docubox)', ['filmbox.cz']], ['Film Europe', '^film europe', ['filmeurope.cz']],
  ['Starmax', '^starmax', ['starmax.cz']], ['Warner TV (CZ)', '^warner tv', ['warnertv.cz']], ['KVIFF TV', '^kviff', ['kviff.tv']], ['Epic Drama', '^epic drama', []],
  ['Discovery / TLC / ID / Animal Planet / Travel / Food Network (CZ/SK feed)', '^(discovery|animal planet|investigation discovery|travel channel|food network)', []],
  ['National Geographic (CZ feed)', '^national geographic', []], ['History / Crime and Investigation / Viasat / Spektrum / Love Nature / BBC Earth (CZ/SK feed)', '^(history channel|crime and investigation|viasat|spektrum|love nature|bbc earth)', ['spektrumtv.cz']],
  ['Deti – Disney / Minimax / Nickelodeon / Cartoon (CZ/SK feed)', '^(disney|minimax|nick|cartoon|duck ?tv|jimjam|baby tv|lala tv|rik tv|tinyteen|turbo tv)', ['disney.cz', 'minimax.cz', 'nickelodeon.cz']],
  ['Voyo Sport / Voyo Special / Nike liga (zápasy, Voyo)', '^(voyo (sport|special)|nike liga)', ['voyo.sk', 'voyo.nova.cz', 'voyo.markiza.sk']],
    ['Lokálne SK/CZ (TV Bratislava, Košice, Praha, Brno 1, rtm+, ÚTV, Romana…)', '^(tv |mestská|ktv|rtm|útv|čsrtv|jihočeská)', ['tvbrno1.cz']],
];
// foreign channels sitting in SK/CZ categories of the catalogue (never selected)
const CHANNEL_DENY = [/^story ?4\b/i, /^fashion ?box/i, /international$/i, /^markíza international/i];
// SK/CZ broadcaster domains (programme / show pages – og:image of the show or the episode) = union of CHANNELS domains
const BROADCASTER = [...new Set([...CHANNELS.flatMap((c) => c[2]), 'skylink.sk'])];
// domains of the channel (for Gemini: where to look for the programme page)
const chanSites = (name) => { const n = String(name || '').trim(); for (const c of CHANNELS) if (new RegExp(c[1], 'i').test(n)) return c[2]; return []; };
const chanOf = (name) => { const n = String(name || '').trim(); return CHANNELS.find((c) => new RegExp(c[1], 'i').test(n)) || null; };
// never used for anything (scraping forbidden / streams)
const BLOCKED = ['imdb.com', 'csfd.cz', 'csfd.sk', 'filmweb.pl', 'youtube.com', 'youtu.be', 'twitch.tv', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com'];

// per-genre guide that is handed to Gemini in the research step (where to look, what is "official")
const GUIDE = {
  film: 'Films: TMDB (if available) → Wikipedia sk/cs/en article of the film (title, year, director, main cast) → broadcaster programme page (markiza.sk, joj.sk, nova.cz, prima.cz, ceskatelevize.cz, stvr.sk, voyo). Never IMDb or ČSFD.',
  series: 'Series: TMDB → Wikipedia sk/cs/en article of the series (season number matters) → broadcaster page. Never IMDb or ČSFD.',
  sport: 'Sport: TheSportsDB teams (exact English team names as used by TheSportsDB, e.g. "Slavia Prague", "KK Igokea") → official league/federation/organiser sites (uefa.com, fifa.com, nhl.com, iihf.com, formula1.com, atptour.com, wtatennis.com, olympics.com, ballondor.com / francefootball.fr, oktagonmma.com, aba-liga.com, tipsportliga.cz, nikeliga.sk, fortunaliga.cz) → broadcaster sport pages (novasport.sk/cz, premiersport.sk, sport.ceskatelevize.cz, joj šport).',
  reality: 'Reality / entertainment shows (Farma, Survivor, SuperStar, Let\'s Dance, Hlas, Tvoja tvár znie povedome, MasterChef): the broadcaster show page (markiza.sk, joj.sk, stvr.sk, nova.cz, prima.cz, ceskatelevize.cz, voyo) → Wikipedia sk/cs (season!).',
  show: 'Shows / galas: broadcaster page (markiza.sk, joj.sk, stvr.sk, nova.cz, prima.cz, ceskatelevize.cz) → official organiser → Wikipedia.',
  news: 'News, elections, debates: broadcaster news pages (tvnoviny.sk, joj.sk, stvr.sk, ct24.ceskatelevize.cz, nova.cz, cnn.iprima.cz) → Wikipedia article about the election (year!).',
  awards: 'Awards: official sites (oscars.org, goldenglobes.com, grammy.com, emmys.com, eurovision.tv, ballondor.com/francefootball.fr, ceskylev.cz, slnkovsieti.sk) → Wikipedia article of THIS year\'s ceremony.',
  concert: 'Concerts: official organiser/artist site, eurovision.tv, grammy.com → Wikipedia (artist / tour / concert).',
  documentary: 'Documentaries: TMDB → Wikipedia → broadcaster page.',
  newyear: 'New Year\'s Eve: broadcaster programme page → Wikipedia.',
  royal: 'Royal events: official royal household site → Wikipedia article of the event.',
};

const VERIFY_MIN = 0.7;          // Gemini confidence needed to accept a found image/text for the event
const MIN_W = 1000;              // reject smaller source images (TheSportsDB badges are only used inside the composite)
const MIN_RATIO = 1.15;          // landscape only (16:9 preferred)
const MAX_BYTES = 150e3;         // max webp size per variant
const VARIANTS = { w: [1600, 1000], m: [800, 800] };   // desktop 2× (hero ≈ 704×480) and mobile (≈ 358×360 @2x)
const GROUND = { maxPerRefresh: 4, offAfterError: 6 * 3600e3 };  // Google Search grounding budget (free tier) + back-off

// bundled fallback backgrounds: static/ev/<cat>-<n>.webp + <cat>-<n>-m.webp (AI-generated, no faces/logos/text)
const FALLBACK = { football: 2, mma: 2, hockey: 2, tennis: 2, f1: 2, basketball: 2, awards: 2, boxing: 2, athletics: 2, show: 2, film: 2,
  stadium: 2, series: 2, reality: 2, news: 2, documentary: 2, newyear: 2 };

// event keywords that always count for the hero (merged with the admin keyword list) – non-sport too
const EXTRA_KW = `Farma = 35
SuperStar = 40
Let's Dance = 35
Survivor = 35
Hlas Česko Slovenska = 30
Tvoja tvár znie povedome = 30
Tvoje tvář má známý hlas = 30
MasterChef = 22
Big Brother = 25
Eurovízia = 50
Eurovision Song Contest = 50
Oscary = 50
Oscarov = 50
Oscarů = 50
Academy Awards = 50
Grammy = 40
Emmy = 35
Zlatý glóbus = 40
Český lev = 35
Slnko v sieti = 30
Zlatý slávik = 35
Český slavík = 35
voľby = 40
volby = 40
prezidentské voľby = 50
prezidentské volby = 50
parlamentné voľby = 50
superdebata = 35
debata = 22
Silvester = 40
Silvestr = 40
silvestrovský = 40
Novoročný koncert = 30
Novoroční koncert = 30
korunovácia = 45
korunovace = 45
kráľovská svadba = 40
královská svatba = 40
koncert = 18
premiéra = 15
finále = 35`;

const PROMPTS = {
  research: 'You help a Slovak/Czech TV guide find SOURCES for one TV broadcast. Do not describe the event, only identify it. Return JSON only:\n' +
    '{"genre":"sport|film|series|reality|show|concert|awards|news|documentary|newyear|royal","sport":"football|ice hockey|basketball|tennis|mma|boxing|motorsport|athletics|cycling|volleyball|handball|other|",' +
    '"teams_en":["exact team names as used by TheSportsDB (max 2)"],"people":["main fighters/artists if any"],"event_en":"English name of the event incl. year/season",' +
    '"official_urls":["max 3 https URLs of the official event/organiser/broadcaster page"],"wiki":{"sk":"article title","cs":"article title","en":"article title"},' +
    '"commons_query":"short English search query for a fitting freely licensed photo (venue, trophy, ceremony – no people needed)",' +
    '"tmdb":{"type":"movie|tv|","query":"original title","year":""}}\nchannel_sites are the official domains of the SK/CZ channel that airs it – prefer its programme/show page there for official_urls. Leave a field empty when unsure – never guess URLs or titles.',
  verify: 'You verify sources for a TV guide hero banner. Score each candidate 0.0-1.0. Two different standards:\n' +
    '- TEXT candidates (id t*): facts that will be used to write a description. Score high when the text is about THIS event or about the ' +
    'competition/ceremony/show/film/team/fighter it features (general background about the same award, league, show or film is fine). Score low when it ' +
    'is about a different film/person/team with a similar name, or reports results of a different year/season as if they were this one.\n' +
    '- IMAGE candidates (id i*): a background photo. Score high when it clearly fits the event visually: the event itself, its participants (either team / ' +
    'fighter / artist), its trophy, its venue/arena, or the same competition/ceremony/show (an older edition is fine for a trophy, venue or stage). Score low ' +
    'when it shows unrelated people/places/things, a different film or show, a portrait of someone not taking part, or something misleading.\n' +
    'Return JSON only, one key per candidate id: {"i1":0.0-1.0,"t1":0.0-1.0, ...}.',
  teaser: 'Napíš krátky pútavý slovenský popis (1–2 vety, max 190 znakov) ku každej TV udalosti pod jej názov – štýl Netflix. ' +
    'POUŽI VÝHRADNE uvedené fakty (facts). Nič si nevymýšľaj: žiadne mená, výsledky, čísla, miesta ani tvrdenia, ktoré vo faktoch nie sú. ' +
    'Neopakuj názov, kanál ani čas (tie sa zobrazujú zvlášť). Žiadne odkazy. Ak fakty o udalosti nič nehovoria, vráť prázdny reťazec. ' +
    'Odpovedz iba JSON: {"id":"popis", ...}.',
  rank: 'You are the editor of a Slovak/Czech TV guide homepage. From the candidate TV broadcasts of the next 7 days below, choose the 3 BIGGEST events ' +
    '(fewer only if there are fewer real top events) that the most viewers in Slovakia and Czechia will want to watch – across ALL genres: big sport (finals, ' +
    'national teams, Champions League top games, numbered OKTAGON cards, Olympics, F1 deciders), blockbuster film TV premieres, premieres and finales of ' +
    'popular series, finales/premieres of big reality and entertainment shows (Farma, SuperStar, Let\'s Dance, Survivor…), big concerts, Eurovision, Oscars, ' +
    'Grammys and other award galas, elections and big debates, New Year\'s Eve, big documentaries, royal events. Prefer live / first-run broadcasts; avoid reruns, ' +
    'magazines, studio talk and minor matches. Use ONLY ids from the list. Answer with JSON only: {"top":["id1","id2","id3"],"why":{"id1":"short reason in Slovak, max 12 words"}}',
};

module.exports = { GENRES, IMG_ORDER, DESC_ORDER, OFFICIAL, CHANNELS, CHANNEL_DENY, chanSites, chanOf, BROADCASTER, BLOCKED, GUIDE, VERIFY_MIN, MIN_W, MIN_RATIO, MAX_BYTES, VARIANTS, GROUND, FALLBACK, EXTRA_KW, PROMPTS };
