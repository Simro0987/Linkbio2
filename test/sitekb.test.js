'use strict';
// AI assistant knowledge builder: live plans, affiliate tiers (inheritance), sections/videos, contacts groups, Blink, no secrets.
const assert = require('assert');
const K = require('../sitekb');
const A = require('../affiliate');
let n = 0; const t = (name, fn) => { fn(); n++; };
const mx = A.matrix(A.DEF_TIERS);
const D = (o = {}) => Object.assign({
  origin: 'https://x.test', title: 'TV Software', pages: { Domov: 'https://x.test/tv' },
  plans: [{ name: '1 mesiac', price: 10, period: 1 }, { name: '12 mesiacov', price: 85, period: 12, features: 'HD\n4K' }, { name: '12 mesiacov – 2 zariadenia', price: 150, period: 12, devices: 2 }],
  blink: true, sepaRecipient: 'Jan Novak', acc: { on: true, panel: true, mail: true },
  aff: { on: true, packages: mx.packages, rows: mx.rows },
  sections: [{ title: 'Návody', url: 'https://x.test/tv/navody', text: 'Nainštalujte aplikáciu. xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz', videos: ['Inštalácia na Android TV'] }],
  contacts: { groups: [['Telegram skupina', 'https://t.me/g']], direct: [['WhatsApp', 'https://wa.me/1']] },
  faq: [{ q: 'Funguje to?', a: 'Áno.' }],
}, o);

t('plans with live prices and 2-device flag', () => {
  const s = K.build(D());
  assert.ok(s.includes('1 mesiac: 10 €')); assert.ok(s.includes('12 mesiacov: 85 € – 12 mesiacov; obsahuje: HD, 4K'));
  assert.ok(s.includes('2 zariadenia súčasne'));
});
t('affiliate table from tiers (3m only at 20, 12m inherits +6, device at 20)', () => {
  const s = K.build(D());
  assert.ok(/5 a viac: 6 mesiacov balík \+1 mesiac, 12 mesiacov balík \+1 mesiac\n/.test(s), s);
  assert.ok(/20 a viac: 3 mesiace balík \+3 mesiace, 6 mesiacov balík \+6 mesiacov, 12 mesiacov balík \+6 mesiacov; ALEBO namiesto mesiacov 2\. zariadenie/.test(s));
  assert.ok(s.includes('3 m od 20 ľudí')); assert.ok(s.includes('od 20 aktívnych odporučených'));
  assert.ok(!/12 mesiacov balík \+12/.test(s)); assert.ok(!/5 a viac: 3 mesiace/.test(s));
});
t('sections/videos, contacts groups, account pages, Blink, SEPA recipient', () => {
  const s = K.build(D());
  assert.ok(s.includes('### Návody – https://x.test/tv/navody')); assert.ok(s.includes('Inštalácia na Android TV'));
  assert.ok(s.includes('Skupiny / kanály') && s.includes('Telegram skupina: https://t.me/g'));
  assert.ok(s.includes('Priame kontakty') && s.includes('WhatsApp: https://wa.me/1'));
  for (const u of ['/registracia', '/prihlasenie', '/zabudnute-heslo', '/ucet', '/overit-predplatne', 'Licencia platí do', 'POVINNÝ']) assert.ok(s.includes(u), u);
  assert.ok(s.includes('Blink): zapnuté')); assert.ok(s.includes('„Jan Novak“'));
  assert.ok(K.build(D({ blink: false })).includes('NIE JE zapnutý'));
});
t('no secrets / admin paths leak into the prompt', () => {
  const s = K.build(D({ about: 'Panel https://x.test/admin/ucty a IBAN SK3112000000198742637541' }));
  assert.ok(!/xpub6/.test(s)); assert.ok(!s.includes('/admin/ucty')); assert.ok(!s.includes('SK3112000000198742637541'));
  assert.ok(s.includes('NIKDY neuvádzaj ani nevymýšľaj IBAN')); assert.ok(s.includes('[[ESCALATE]]'));
});
t('contact links with internal brand handle are not written out', () => {
  const s = K.build(D({ pages: { Kontakt: 'https://x.test/tv/kontakt' }, contacts: { groups: [], direct: [['Telegram', 'https://t.me/TokiGO242']] } }));
  assert.ok(!/tokigo/i.test(s)); assert.ok(s.includes('Telegram (tlačidlo na stránke Kontakt https://x.test/tv/kontakt)'));
});
t('affiliate off → no table', () => assert.ok(!K.build(D({ aff: { on: false, packages: [], rows: [] } })).includes('## Affiliate')));
console.log(`sitekb: ${n} tests passed`);
