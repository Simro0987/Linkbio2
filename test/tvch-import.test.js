'use strict';
const assert = require('assert');
const t = require('../tvch')._test;
const csv = '\uFEFFČ.;Názov kanála;Kategória;Región;Kvalita;Rok (filmy);Stream URL;tvg-id;Logo\n'
  + '1;Jednotka;Slovenské;SK;HD;;http://srv.example:8080/live/u/p/1.ts;jednotka.sk;https://cdn.example.com/logos/jednotka.png\n'
  + '2;Markíza;Slovenské;SK;HD;;http://srv.example:8080/live/u/p/2.m3u8;markiza.sk;http://srv.example:8080/logo.png\n'
  + '3;ČT1;České;CZ;FHD;;http://srv.example/x.m3u8;ct1.cz;\n'
  + '4;Jednotka;Slovenské;SK;HD;;;;\n';
const p = t.parseCsv(t.decode(Buffer.from(csv)));
assert.strictEqual(p.del, ';');
const { items, info } = t.analyze(p.rows);
assert.deepStrictEqual(info.map, { name: 'Názov kanála', category: 'Kategória', logo: 'Logo' });
assert.deepStrictEqual(items.map((x) => x.name), ['Jednotka', 'Markíza', 'ČT1']);
assert.strictEqual(items[0].logo, 'https://cdn.example.com/logos/jednotka.png');
assert.strictEqual(items[1].logo, ''); assert.strictEqual(info.badLogos, 1); assert.strictEqual(info.dupes, 1);
for (const c of ['Č.', 'Región', 'Kvalita', 'Rok (filmy)', 'Stream URL ⚠', 'tvg-id ⚠']) assert(info.ignoredCols.includes(c), c);
assert(!JSON.stringify(items).includes('srv.example'));
// logo fallback from an unrecognised column with image links; '#' never used as name
const p2 = t.parseCsv('#,Channel Name,group-title,Pic\n1,Nova,CZ,https://a.example/n.svg\n2,Prima,CZ,https://a.example/p.webp\n');
const r2 = t.analyze(p2.rows);
assert.strictEqual(r2.info.map.logo, 'Pic'); assert.strictEqual(r2.items[0].name, 'Nova'); assert.strictEqual(r2.items[1].logo, 'https://a.example/p.webp');
// name header missing but number column first -> uses text column, not numbers
const r3 = t.analyze(t.parseCsv('Číslo;Stanica;Kategoria\n1;Nova;CZ\n2;Prima;CZ\n').rows);
assert.deepStrictEqual(r3.items.map((x) => x.name), ['Nova', 'Prima']);
console.log('tvch import tests OK');
