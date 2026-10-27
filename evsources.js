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
// „Veľký zápas“ detector defaults (evbig.js format) – admin can edit/override in /admin/udalosti (evh_big). All sports, equal footing.
const BIG_DEFAULT = String.raw`# ── Futbal: kluby (alias / alias; diakritika sa ignoruje; SK/CZ tvary: Neapol, Miláno, Mníchov, Řím, Lipsko…) ──
tim real: Real Madrid / Real Madrid CF / Real / Realu Madrid / Realom Madrid
tim barca: FC Barcelona / Barcelona / Barca / Barcelony / Barcelonou / FCB
tim atletico: Atletico Madrid / Atletico de Madrid / Atletico / Atl Madrid / Atl. Madrid
tim rsociedad: Real Sociedad
tim betis: Real Betis / Betis
tim athletic: Athletic Bilbao / Athletic Club
tim villarreal: Villarreal CF / Villarreal
tim sevilla: Sevilla FC / FC Sevilla / Sevilla
tim bayern: Bayern Mnichov / Bayern Munchen / Bayern Munich / FC Bayern / Bayern
tim dortmund: Borussia Dortmund / Dortmund / BVB
tim leverkusen: Bayer Leverkusen / Leverkusen / Bayer 04
tim leipzig: RB Leipzig / RB Lipsko / Lipsko / Leipzig
tim frankfurt: Eintracht Frankfurt / Frankfurt
tim stuttgart: VfB Stuttgart
tim juventus: Juventus / Juventus Turin / Juventus Turino / Juve
tim inter: Inter Milan / Inter Milano / Inter Milane / Internazionale / FC Internazionale / Inter
tim milan: AC Milan / AC Milano / AC Milane / Milan / Milano
tim olimpia: Olimpia Milano / Olimpia Milan / EA7 Emporio Armani Milano / Armani Milano / EA7 Milano
tim napoli: SSC Napoli / Napoli / SSC Neapol / Neapol / Neapola / Neapolom
tim roma: AS Roma / Roma / AS Rim
tim lazio: Lazio Rim / Lazio Roma / Lazio
tim atalanta: Atalanta Bergamo / Atalanta BC / Atalanta
tim mancity: Manchester City / Man City / Man. City / Manchester C
tim manutd: Manchester United / Manchester Utd / Man United / Man Utd / Man. United / Man. Utd / Manchester U
tim liverpool: Liverpool FC / Liverpool
tim everton: Everton FC / Everton
tim arsenal: Arsenal FC / Arsenal Londyn / Arsenal
tim tottenham: Tottenham Hotspur / Tottenham / Spurs
tim chelsea: Chelsea FC / Chelsea Londyn / Chelsea
tim newcastle: Newcastle United / Newcastle Utd / Newcastle
tim astonvilla: Aston Villa
tim psg: Paris Saint Germain / Paris SG / PSG / Paris St Germain / Pariz SG / Pariz Saint Germain
tim marseille: Olympique Marseille / Olympique de Marseille / Marseille / OM
tim lyon: Olympique Lyon / Olympique Lyonnais / OL Lyon / Lyon
tim monaco: AS Monaco / Monaco
tim lille: Lille OSC / LOSC Lille / Lille
tim celtic: Celtic Glasgow / Celtic FC / Celtic
tim grangers: Glasgow Rangers / Rangers FC / Rangers
tim benfica: Benfica Lisabon / SL Benfica / Benfica
tim porto: FC Porto / Porto
tim sporting: Sporting Lisabon / Sporting Lisbon / Sporting Lisboa / Sporting CP
tim braga: SC Braga / Sporting Braga / Braga
tim ajax: Ajax Amsterdam / AFC Ajax / Ajax
tim psv: PSV Eindhoven / PSV
tim feyenoord: Feyenoord Rotterdam / Feyenoord
tim az: AZ Alkmaar
tim galatasaray: Galatasaray Istanbul / Galatasaray
tim fenerbahce: Fenerbahce Istanbul / Fenerbahce
tim besiktas: Besiktas Istanbul / Besiktas / Besikstas
tim sparta: AC Sparta Praha / Sparta Praha / Sparta Prague / HC Sparta / Sparta
tim slavia: SK Slavia Praha / Slavia Praha / Slavia Prague / HC Slavia / Slavia
tim plzen: Viktoria Plzen / FC Viktoria Plzen / HC Skoda Plzen / Plzen
tim banik: FC Banik Ostrava / Banik Ostrava / Banik
tim slovan: SK Slovan Bratislava / Slovan Bratislava / HC Slovan / Slovan
tim trnava: Spartak Trnava / FC Spartak Trnava / Trnava
tim dac: DAC Dunajska Streda / Dunajska Streda / DAC
tim zilina: MSK Zilina / MSK Zilina Africa
# ── Hokej ──
tim kosice: HC Kosice / Kosice
tim kometa: Kometa Brno / HC Kometa / Kometa
tim trinec: Ocelari Trinec / HC Ocelari / Trinec
tim pardubice: Dynamo Pardubice / HC Dynamo Pardubice / Pardubice
tim liberec: Bili Tygri Liberec / Liberec
tim vitkovice: HC Vitkovice / Vitkovice Ridera / Vitkovice
tim nitra: HK Nitra / Nitra
tim zvolen: HKM Zvolen / Zvolen
tim bbystrica: HC 05 Banska Bystrica / HC Banska Bystrica / Banska Bystrica / Barani
tim trencin: HK Dukla Trencin / Dukla Trencin / Trencin
tim bos: Boston Bruins / Bruins
tim mtl: Montreal Canadiens / Canadiens
tim tor: Toronto Maple Leafs / Maple Leafs
tim det: Detroit Red Wings / Red Wings
tim chi: Chicago Blackhawks / Blackhawks
tim nyr: New York Rangers / NY Rangers / N Y Rangers
tim col: Colorado Avalanche / Avalanche
tim vgk: Vegas Golden Knights / Golden Knights
tim van: Vancouver Canucks / Canucks
tim njd: New Jersey Devils / NJ Devils
tim wsh: Washington Capitals / Capitals
tim tbl: Tampa Bay Lightning / Lightning
tim ana: Anaheim Ducks / Ducks
tim phi: Philadelphia Flyers / Flyers
tim cgy: Calgary Flames / Flames
tim min: Minnesota Wild
tim edm: Edmonton Oilers / Oilers
tim fla: Florida Panthers / Panthers
tim car: Carolina Hurricanes / Hurricanes
tim dal: Dallas Stars
tim wpg: Winnipeg Jets
tim ska: SKA Petrohrad / SKA St Petersburg / SKA
tim cska: CSKA Moskva / CSKA Moscow / CSKA
tim dynamom: Dynamo Moskva / Dinamo Moskva / Dynamo Moscow
tim akbars: Ak Bars Kazan / Ak Bars
tim magnitka: Metallurg Magnitogorsk / Metalurg Magnitogorsk
tim lokojar: Lokomotiv Jaroslavl / Lokomotiv Yaroslavl
# ── Basketbal (NBA, Euroliga) ──
tim lakers: Los Angeles Lakers / LA Lakers / Lakers
tim celtics: Boston Celtics / Celtics
tim warriors: Golden State Warriors / Warriors
tim nuggets: Denver Nuggets / Nuggets
tim thunder: Oklahoma City Thunder / OKC Thunder / Thunder
tim knicks: New York Knicks / NY Knicks / Knicks
tim cavs: Cleveland Cavaliers / Cavaliers
tim bucks: Milwaukee Bucks / Bucks
tim sixers: Philadelphia 76ers / 76ers / Sixers
tim mavs: Dallas Mavericks / Mavericks
tim spurs: San Antonio Spurs
tim olympiacos: Olympiacos Pireus / Olympiakos Pireus / Olympiacos / Olympiakos
tim panathinaikos: Panathinaikos Atheny / Panathinaikos Athens / Panathinaikos
tim efes: Anadolu Efes / Efes
tim maccabi: Maccabi Tel Aviv / Maccabi
tim zalgiris: Zalgiris Kaunas / Zalgiris
tim partizan: Partizan Belehrad / Partizan Belgrade / Partizan
tim zvezda: Crvena zvezda / Crvena Zvezda Belehrad / Cervena hviezda
# ── Národné tímy SK/CZ ──
tim sk: Slovensko / Slovakia / Slovakei / Slovaquie
tim cz: Cesko / Ceska republika / Czechia / Czech Republic / Tschechien
#
# ── Rivality (oba tímy v názve alebo názov rivality) ──
rivalita El Clásico = 50: real + barca
rivalita Madridské derby = 35: real + atletico
rivalita Der Klassiker = 40: bayern + dortmund
rivalita Derby d'Italia = 40: inter + juventus
rivalita Milánske derby (Derby della Madonnina) = 40: inter + milan
rivalita Juventus – Milan = 35: juventus + milan
rivalita Juventus – Napoli = 35: juventus + napoli
rivalita Rímske derby = 30: roma + lazio
rivalita Manchesterské derby = 40: mancity + manutd
rivalita Severolondýnske derby = 35: arsenal + tottenham
rivalita Merseyside derby = 35: liverpool + everton
rivalita Liverpool – Manchester United = 40: liverpool + manutd
rivalita Liverpool – Arsenal = 35: liverpool + arsenal
rivalita Liverpool – Manchester City = 35: liverpool + mancity
rivalita Chelsea – Manchester United = 35: chelsea + manutd
rivalita Arsenal – Manchester United = 35: arsenal + manutd
rivalita Le Classique = 35: psg + marseille
rivalita De Klassieker = 35: ajax + feyenoord
rivalita Ajax – PSV = 30: ajax + psv
rivalita O Clássico = 30: benfica + porto
rivalita Lisabonské derby = 30: benfica + sporting
rivalita Istanbulské derby = 30: galatasaray + fenerbahce
rivalita Old Firm = 35: celtic + grangers
rivalita Pražské derby (S–S) = 45: sparta + slavia
rivalita Slovan – Spartak Trnava = 40: slovan + trnava
rivalita Slovan – Košice (hokej) = 35: slovan + kosice
rivalita Kometa – Třinec = 35: kometa + trinec
rivalita Slovensko – Česko = 50: sk + cz
rivalita Lakers – Celtics = 30: lakers + celtics
rivalita Olympiacos – Panathinaikos = 30: olympiacos + panathinaikos
rivalita Belehradské derby = 30: zvezda + partizan
#
# ── Zápas dvoch tímov zo skupiny (top kluby ligy: oba tímy zo skupiny ⇒ veľký zápas) ──
skupina Premier League – top kluby = 32: mancity, manutd, liverpool, arsenal, chelsea, tottenham, newcastle, astonvilla
skupina Serie A – top kluby = 32: juventus, inter, milan, napoli, roma, lazio, atalanta
skupina LaLiga – top kluby = 32: real, barca, atletico, athletic, rsociedad, betis, villarreal, sevilla
skupina Bundesliga – top kluby = 32: bayern, dortmund, leverkusen, leipzig, frankfurt, stuttgart
skupina Ligue 1 – top kluby = 30: psg, marseille, lyon, monaco, lille
skupina Eredivisie – top kluby = 28: ajax, psv, feyenoord, az
skupina Liga Portugal – top kluby = 28: benfica, porto, sporting, braga
skupina Süper Lig – top kluby = 26: galatasaray, fenerbahce, besiktas
skupina Veľkokluby Európy = 28: real, barca, atletico, bayern, dortmund, juventus, inter, milan, napoli, mancity, manutd, liverpool, arsenal, chelsea, tottenham, psg, benfica, porto, leverkusen, sporting, ajax, psv, atalanta, newcastle, astonvilla, marseille, monaco, galatasaray, fenerbahce
skupina Chance liga – top kluby (CZ) = 28: sparta, slavia, plzen, banik
skupina Niké liga – top kluby (SK) = 26: slovan, trnava, dac, zilina
skupina Tipsport extraliga – top (CZ hokej) = 22: sparta, trinec, kometa, pardubice, liberec, vitkovice, plzen
skupina Tipsport liga – top (SK hokej) = 22: slovan, kosice, nitra, zvolen, bbystrica, trencin
skupina Original Six (NHL) = 22: bos, mtl, tor, det, chi, nyr
skupina NHL – top tímy = 18: bos, tor, nyr, col, vgk, edm, fla, tbl, car, dal, wpg, njd, wsh
skupina KHL top = 12: ska, cska, dynamom, akbars, magnitka, lokojar
skupina NBA – top tímy = 22: lakers, celtics, warriors, nuggets, thunder, knicks, cavs, bucks, sixers, mavs, spurs
skupina Euroliga – top kluby = 22: real, barca, olympiacos, panathinaikos, fenerbahce, efes, maccabi, zalgiris, partizan, zvezda, monaco, olimpia
#
# ── Tím s SK/CZ hviezdami (NHL) – stačí jeden ──
hviezdy NHL s SK/CZ hviezdou (Pastrňák, Slafkovský, Nečas, Hertl, Nemec, Černák…) = 14: bos, mtl, col, vgk, van, njd, wsh, tbl, ana, phi, cgy, min
hviezdy Reprezentácia SK/CZ = 30: sk, cz
#
# ── Športovci (meno v názve/popise) ──
mena SK/CZ športovci = 22: Vlhova / Pastrnak / Slafkovsky / Necas / Hertl / Machac / Mensik / Lehecka / Muchova / Krejcikova / Noskova / Bouzkova / Siniakova / Vondrousova / Kvitova / Schmiedlova / Sramkova / Molcan / Klizan / Davidova / Fialkova / Vitkova / Kuzmina / Sagan / Vingegaard / Vojtek / Zlocha / Kozubik / Shiffrinova / Hamilton / Hurtova / Batovsky / Vadlejch / Spotakova / Juraj Slafkovsky / Adam Lisko / Kristian Vaculik
mena Svetové hviezdy = 14: Sinner / Alcaraz / Djokovic / Zverev / Medvedev / Sabalenka / Swiatek / Swiatekova / Gauff / Rybakina / Verstappen / Norris / Leclerc / Piastri / Marquez / Bagnaia / Ovechkin / Ovecjkin / Crosby / McDavid / LeBron / Jokic / Doncic / Wembanyama / Pogacar / Duplantis / Messi / Ronaldo / Mbappe / Haaland / Kane / Odegaard / Shiffrin / Odermatt / Kristoffersen / Boe / Littler / Humphries / O Sullivan / Volkanovski / Topuria / Makhachev / Vemola
mena Tenis – top-10 ATP/WTA = 12: Sinner / Alcaraz / Djokovic / Zverev / Fritz / Draper / Musetti / de Minaur / Shelton / Auger Aliassime / Rune / Ruud / Sabalenka / Swiatek / Swiatekova / Gauff / Anisimova / Pegula / Rybakina / Paolini / Andreeva / Andrejevova / Emma Navarro / Madison Keys / Zheng Qinwen
#
# ── Pravidlá (regex na názov + podtitul + kategóriu; malé písmená bez diakritiky) ──
pravidlo Finále = 20: \b(finale|final|finala|final four|super bowl|grand final)\b
pravidlo Semifinále = 12: \b(semifinale|semifinal|semi final|semifinala|polofinale)\b
pravidlo Štvrťfinále / play-off = 7: \b(stvrtfinale|ctvrtfinale|quarter ?final|play ?off|playoff|vyrazovacia|knockout|osemfinale|osmifinale|round of 16)\b
pravidlo Liga majstrov – vyraďovacia fáza = 22: ^(?!.*\b(volejbal|volleyball|hadzana|hazena|handball|basketbal|basketball|florbal|futsal|zeny|zien|women|u19|u21|mladez|dorast|youth)\b)(?:(liga majstrov|liga mistru|champions league|uefa cl).*(osemfinale|osmifinale|stvrtfinale|ctvrtfinale|semifinale|finale|play ?off|knockout|round of 16)|(osemfinale|osmifinale|stvrtfinale|ctvrtfinale|semifinale|finale|play ?off).*(liga majstrov|liga mistru|champions league))
pravidlo Liga majstrov (futbal) = 10: ^(?!.*\b(volejbal|volleyball|hadzana|hazena|handball|basketbal|basketball|florbal|futsal|zeny|zien|women|u19|u21|mladez|dorast|youth)\b)\b(liga majstrov|liga mistru|champions league)\b
pravidlo MS / ME / olympiáda = 30: \b(ms|me|majstrovstva sveta|majstrovstva europy|mistrovstvi sveta|mistrovstvi evropy|world championships?|european championships?|olympi\w*|zoh|loh|world cup final)\b
pravidlo Hokej – MS IIHF / olympiáda = 35: (hokej|hockey|iihf).*\b(ms|majstrovstva sveta|mistrovstvi sveta|world championship|olympi\w*|zoh)\b|\b(ms|majstrovstva sveta|mistrovstvi sveta|zoh)\b.*(hokej|hockey)
pravidlo Hokej – NHL = 8: \bnhl\b
pravidlo Hokej – NHL play-off / Stanley Cup = 25: stanley cup|\bnhl\b.*(play ?off|finale|final)
pravidlo Hokej – KHL = 5: \bkhl\b
pravidlo Hokej – Liga majstrov CHL = 10: \bchl\b|champions hockey league|hokejova liga majstrov
pravidlo Hokej – Extraliga / Tipsport liga = 6: extraliga|tipsport liga|tipos extraliga|nike extraliga
pravidlo Tenis – Grand Slam = 20: australian open|roland garros|french open|wimbledon|us open|grand slam
pravidlo Tenis – Grand Slam – záver = 18: (australian open|roland garros|french open|wimbledon|us open).*(finale|final|semifinale|semifinal|stvrtfinale|quarter)|(finale|final|semifinale|semifinal|stvrtfinale).*(australian open|roland garros|wimbledon|us open)
pravidlo Tenis – ATP/WTA neskoré kolá = 14: (tenis|tennis|\batp\b|\bwta\b|masters).*(stvrtfinale|ctvrtfinale|quarter ?final|semifinale|semifinal|finale|final)|(stvrtfinale|ctvrtfinale|semifinale|semifinal|finale|final).*(tenis|tennis|\batp\b|\bwta\b)
pravidlo Tenis – ATP/WTA Finals = 22: atp finals|wta finals|turnaj majstrov|turnaj majsteriek|nitto atp
pravidlo Tenis – Davis Cup / BJK Cup = 15: davis ?cup|davisov pohar|billie jean king|bjk cup|pohar billie
pravidlo F1 – Veľká cena – preteky = 30: ^(?!.*(f1 academy|studio|magazin|highlight|zostrih|sestrih|prehlad))(?:.*)(formula 1|formule 1|formula one|\bf1\b).*(velka cena|vc |grand prix|gp |preteky|zavod|race)|^(?!.*(f1 academy|studio|magazin|highlight|zostrih|sestrih))(?:.*)(velka cena|grand prix).*(formula 1|formule 1|\bf1\b)
pravidlo F1 – kvalifikácia / šprint = 15: ^(?!.*(f1 academy|studio|magazin))(?:.*)(formula 1|formule 1|\bf1\b).*(kvalifikac|qualifying|sprint)
pravidlo MotoGP – preteky = 18: ^(?!.*(highlight|magazin|zostrih|sestrih))(?:.*)(motogp|moto gp)
pravidlo MMA – OKTAGON (číslovaný turnaj) = 30: ^(?!.*(countdown|highlight|zostrih|sestrih|best of|prehlad|embedded|vazeni|weigh))(?:.*)\boktagon \d{2,3}\b
pravidlo MMA – UFC číslovaný event (hlavná karta) = 25: ^(?!.*(countdown|highlight|zostrih|sestrih|best of|prehlad|embedded|preview|vazeni|weigh|sporty walki))(?:.*)\bufc \d{3}\b
pravidlo MMA – hlavná karta / main card = 12: main card|hlavna karta|hlavni karta|main event
pravidlo Box / MMA – titulový zápas = 20: (titul|title fight|title bout|o pas|majstra sveta|wbc|wba|ibf|wbo).*(box|boxing|mma|zapas|fight)|(box|boxing).*(titul|title|wbc|wba|ibf|wbo)
pravidlo Basketbal – NBA finále / play-off = 22: \bnba\b.*(finale|final|play ?off|playoff|conference)|nba finals
pravidlo Basketbal – Euroliga Final Four = 25: (euroliga|euroleague).*(final four|finale|final)|final four
pravidlo Basketbal – Euroliga = 6: \b(euroliga|euroleague)\b
pravidlo Basketbal – NBA = 6: \bnba\b
pravidlo Cyklistika – Grand Tour / MS = 18: tour de france|giro d ?italia|vuelta|okolo francuzska|kolo francie|(cyklistika|cycling|uci).*(ms|majstrovstva sveta|world championships)
pravidlo Atletika – MS / Diamantová liga finále = 20: (atletika|athletics).*(ms|majstrovstva sveta|mistrovstvi sveta|world championships|halove)|diamond league final|diamantova liga.*finale|zlata tretra
pravidlo Lyžovanie / biatlon – SP so SK/CZ = 14: (alpske lyzovanie|lyzovanie|slalom|obrovsky slalom|zjazd|super g|biatlon|biathlon|beh na lyziach|skoky na lyziach).*(svetovy pohar|sp |world cup|ms|majstrovstva sveta|mistrovstvi sveta)|(svetovy pohar|world cup).*(slalom|biatlon|lyzovanie)
pravidlo Hádzaná / volejbal – šampionát = 15: (hadzana|hazena|handball|volejbal|volleyball).*(ms|me|majstrovstva|mistrovstvi|championship|final|finale|final four)
pravidlo Šípky / snooker – finále = 15: (sipky|sipky pdc|darts|pdc|snooker).*(finale|final|world championship|ms )|world darts championship|world snooker championship
pravidlo Super Bowl = 25: super bowl`;

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
    'magazines, studio talk and minor matches. ALL SPORTS ARE ON EQUAL FOOTING – judge importance, not the sport: recognise iconic matches and rivalries yourself, ' +
    'also ones not flagged in big_match (El Clásico Real Madrid–Barcelona, Der Klassiker, Derby d\'Italia, Milan/Manchester/North London/Merseyside derbies, ' +
    'Liverpool–Man Utd, Le Classique, Old Firm, Sparta–Slavia, Slovan–Spartak Trnava; hockey Slovan–Košice, Kometa–Třinec, Original Six NHL games, NHL games with ' +
    'Slovak/Czech stars such as Pastrňák or Slafkovský, IIHF Worlds, Olympics), Champions League knockouts and clashes of big clubs, finals and semifinals of any ' +
    'competition, Slovak and Czech national teams in any sport, top-of-the-table clashes, Grand Slam late rounds and ATP/WTA Finals, Davis/BJK Cup with SK/CZ, ' +
    'SK/CZ athletes (Vlhová in a World Cup slalom, Czech/Slovak tennis players), F1/MotoGP races and qualifying, numbered UFC/OKTAGON cards and title fights, ' +
    'NBA Finals/playoffs, EuroLeague Final Four, Grand Tours, athletics and biathlon/ski worlds, handball/volleyball championships, darts and snooker finals. ' +
    'big_match lists what the automatic detector found – a hint, not a rule. Use ONLY ids from the list. Answer with JSON only: {"top":["id1","id2","id3"],"why":{"id1":"short reason in Slovak, max 12 words"}}',
};

module.exports = { GENRES, IMG_ORDER, DESC_ORDER, OFFICIAL, BIG_DEFAULT, CHANNELS, CHANNEL_DENY, chanSites, chanOf, BROADCASTER, BLOCKED, GUIDE, VERIFY_MIN, MIN_W, MIN_RATIO, MAX_BYTES, VARIANTS, GROUND, FALLBACK, EXTRA_KW, PROMPTS };
