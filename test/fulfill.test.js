'use strict';
const assert = require('assert');
const f = require('../pay/src/fulfill');

const _pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      _pending.push(r.then(() => console.log('ok', name)).catch((e) => { console.error('FAIL', name, e); process.exitCode = 1; }));
      return;
    }
    console.log('ok', name);
  } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; }
}


t('username must be at least 8 chars', () => {
  const r = f.validateFulfill({ username: 'short', email: 'a@b.sk' });
  assert.ok(r.error);
  assert.ok(/8/.test(r.error));
});

t('username 8 chars + email is enough (email not mandatory vs others)', () => {
  const r = f.validateFulfill({ username: 'user1234', email: 'a@b.sk' });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.username, 'user1234');
  assert.strictEqual(r.contact.email, 'a@b.sk');
});

t('telegram only is accepted (email not required)', () => {
  const r = f.validateFulfill({ username: 'mojemeno1', telegram: '@meno_abc' });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.contact.telegram, '@meno_abc');
  assert.ok(!r.contact.email);
});

t('facebook only is accepted', () => {
  const r = f.validateFulfill({ username: 'mojemeno1', facebook: 'https://www.facebook.com/somebody' });
  assert.ok(!r.error, r.error);
});

t('rejects empty contact', () => {
  const r = f.validateFulfill({ username: 'mojemeno1' });
  assert.ok(r.error);
});

t('return path matches username + the same contact (telegram, not email)', () => {
  const v = f.validateFulfill({ username: 'mojemeno1', telegram: '@meno_abc' });
  const orders = { ord_1: { orderId: 'ord_1', fulfill: { username: v.username, telegram: v.contact.telegram, submittedAt: '2026-11-09' } } };
  const hit = f.findByReturn(orders, { username: 'mojemeno1', telegram: '@meno_abc' });
  assert.ok(hit.order && hit.order.orderId === 'ord_1');
  const miss = f.findByReturn(orders, { username: 'mojemeno1', email: 'other@x.sk' });
  assert.ok(miss.error);
});

t('isPaid recognises paid and confirmed', () => {
  assert.ok(f.isPaid({ status: 'paid' }));
  assert.ok(f.isPaid({ status: 'confirmed' }));
  assert.ok(f.isPaid({ chainStatus: 'confirmed' }));
  assert.ok(!f.isPaid({ status: 'pending' }));
});

t('ensure assigns a 32-hex token once', () => {
  const o = { orderId: 'ord_x' };
  const a = f.ensure(o);
  const b = f.ensure(o);
  assert.strictEqual(a.token, b.token);
  assert.ok(/^[a-f0-9]{32}$/.test(a.token));
});

t('credentials seal/open when DATA_ENC_KEY is set', () => {
  if (!/^[0-9a-f]{64}$/i.test(process.env.DATA_ENC_KEY || '') && !/^[0-9a-f]{64}$/i.test(process.env.BACKUP_ENC_KEY || '')) {
    process.env.DATA_ENC_KEY = 'ab'.repeat(32);
  }
  const enc = f.sealCreds('user: tajne\npass: heslo');
  assert.ok(enc && enc !== 'user: tajne\npass: heslo');
  assert.strictEqual(f.openCreds(enc), 'user: tajne\npass: heslo');
});

t('brand name never appears in public form markup', () => {
  const o = { orderId: 'ord_1', status: 'paid', fulfill: { token: 'a'.repeat(32) } };
  const html = f.pathFor(o);
  assert.ok(!/tokigo/i.test(html));
});

t('validateCheckout lowercases and limits 8–24', () => {
  const r = f.validateCheckout({ username: 'MojeMeno1', telegram: '@meno_abc' });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.username, 'mojemeno1');
  const long = f.validateCheckout({ username: 'a'.repeat(25), email: 'a@b.sk' });
  assert.ok(long.error);
  const badStart = f.validateCheckout({ username: '_abcdefgh', email: 'a@b.sk' });
  assert.ok(badStart.error);
});

t('validatePassword min 8, confirm, not equal to username', () => {
  assert.ok(f.validatePassword('short', 'short', 'mojemeno1').error);
  assert.ok(f.validatePassword('mojemeno1', 'mojemeno1', 'mojemeno1').error);
  assert.ok(f.validatePassword('tajneheslo', 'ineheslo', 'mojemeno1').error);
  assert.ok(f.validatePassword('tajneheslo', 'tajneheslo', 'mojemeno1').ok);
});

t('applyCheckout never stores a password and stamps account id', () => {
  const v = f.validateCheckout({ username: 'mojemeno1', telegram: '@meno_abc' });
  const o = { orderId: 'ord_new', status: 'pending', amountEur: 10 };
  f.applyCheckout(o, v, { amount: 10, provider: 'revolut', acct: { id: 42, u: 'mojemeno1' }, password: 'tajneheslo' });
  assert.ok(o.fulfill && o.fulfill.submittedAt);
  assert.strictEqual(o.fulfill.username, 'mojemeno1');
  assert.strictEqual(o.acct.id, 42);
  assert.strictEqual(o.fulfill.accountId, 42);
  const blob = JSON.stringify(o);
  assert.ok(!/tajneheslo/.test(blob));
  assert.ok(!o.password && !o.fulfill.password && !o.pw_hash);
});

t('isConfirmed is paid or admin-confirmed; statusLabel three states', () => {
  assert.ok(!f.isConfirmed({ status: 'pending' }));
  assert.ok(f.isConfirmed({ status: 'paid' }));
  const o = { orderId: 'x', status: 'pending' };
  f.confirm(o, 'ryan');
  assert.ok(f.isConfirmed(o));
  assert.strictEqual(f.statusLabel({ status: 'pending' }).sk, 'čaká na platbu');
  assert.strictEqual(f.statusLabel(o).sk, 'potvrdená');
  assert.strictEqual(f.statusLabel({ status: 'paid', fulfill: { credSentAt: '2026-11-09' } }).sk, 'údaje odoslané');
});

t('deliver refuses unconfirmed orders', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  const o = { orderId: 'ord_u', status: 'pending', fulfill: { submittedAt: '2026-11-09', username: 'mojemeno1', email: 'a@b.sk' } };
  const r = f.deliver({ order: o, text: 'user: x' });
  assert.ok(r.error);
  f.confirm(o);
  const ok = f.deliver({ order: o, text: 'user: x' });
  assert.ok(ok.ok, ok.error);
});

t('listAccountOrders only returns orders for that account id', () => {
  const orders = {
    a: { orderId: 'a', acct: { id: 1, u: 'one' }, amountEur: 10, fulfill: { submittedAt: '1', username: 'one' } },
    b: { orderId: 'b', acct: { id: 2, u: 'two' }, amountEur: 12, fulfill: { submittedAt: '1', username: 'two', email: 'one@x.sk' } },
    c: { orderId: 'c', fulfill: { accountId: 1, submittedAt: '1', username: 'one' } },
  };
  const mine = f.listAccountOrders(orders, { id: 1, username: 'one', email: 'one@x.sk' });
  assert.deepStrictEqual(mine.map((x) => x.orderId).sort(), ['a', 'c']);
});

const soft = require('../pay/src/softUser');

t('generateSoftwareUser is 8 readable chars', () => {
  const u = soft.generateSoftwareUser();
  assert.strictEqual(u.length, 8);
  assert.ok(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/.test(u));
  assert.notStrictEqual(u, soft.generateSoftwareUser());
});

t('planDevices detects 2-device packages by name', () => {
  assert.strictEqual(soft.planDevices({ name: '12 mesiacov – 2 zariadenia', price: 129.99 }), 2);
  assert.strictEqual(soft.planDevices({ name: '12 mesiacov', name_en: '12 months' }), 1);
  assert.strictEqual(soft.devicesForPlans([{ name: '12 months – 2 devices' }]), 2);
});

t('validateSlots renew + new and two distinct names', () => {
  const one = soft.validateSlots([{ intent: 'new', username: 'MojeMeno1' }], 1);
  assert.ok(!one.error, one.error);
  assert.strictEqual(one.slots[0].username, 'mojemeno1');
  const two = soft.validateSlots([{ intent: 'renew', username: 'OldUser12' }, { intent: 'new', username: 'abcdefgh' }], 2);
  assert.ok(!two.error, two.error);
  const same = soft.validateSlots([{ intent: 'new', username: 'sameuser1' }, { intent: 'new', username: 'sameuser1' }], 2);
  assert.ok(same.error);
  const miss = soft.validateSlots([{ intent: 'new', username: 'onlyone1' }], 2);
  assert.ok(miss.error);
});

t('validateCheckout accepts slots and keeps first username for site login', () => {
  const r = f.validateCheckout({ slots: [{ intent: 'new', username: 'tvmeno01' }], telegram: '@meno_abc' });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.username, 'tvmeno01');
  assert.strictEqual(r.slots.length, 1);
  const two = f.validateCheckout({ intent: 'new', username: 'tvmeno01', username2: 'tvmeno02', telegram: '@meno_abc' }, { devices: 2 });
  assert.ok(!two.error, two.error);
  assert.strictEqual(two.slots.length, 2);
});

t('applyCheckout stores slots and does not put a password on the order', () => {
  const v = f.validateCheckout({ intent: 'renew', username: 'olduser1', telegram: '@meno_abc' });
  const o = { orderId: 'ord_slot', status: 'pending', amountEur: 10 };
  f.applyCheckout(o, v, { amount: 10, provider: 'revolut' });
  assert.strictEqual(o.fulfill.slots[0].intent, 'renew');
  assert.strictEqual(o.fulfill.username, 'olduser1');
  assert.ok(!JSON.stringify(o).includes('password'));
});

t('parseCredsFromText and parseDate (SK/ISO)', () => {
  assert.strictEqual(soft.parseDate('15.11.2026'), '2026-11-15');
  assert.strictEqual(soft.parseDate('2026-11-15'), '2026-11-15');
  assert.strictEqual(soft.parseDate('15. november 2026'), '2026-11-15');
  const c = soft.parseCredsFromText('Username: tvmeno01\nHeslo: Tajne.123\nPlatné do: 15.11.2027');
  assert.strictEqual(c.username, 'tvmeno01');
  assert.strictEqual(c.password, 'Tajne.123');
  assert.strictEqual(c.until, '2026-11-15'.replace('2026', '2027'));
});

t('attachDelivery seals text and expiry card; unconfirmed refused without autoConfirm', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  const o = { orderId: 'ord_del', status: 'pending', fulfill: { submittedAt: '2026-11-09', username: 'tvmeno01', slots: [{ intent: 'new', username: 'tvmeno01' }] } };
  const no = f.attachDelivery(o, { text: 'Username: tvmeno01\nHeslo: Abcdefgh\nPlatné do: 20.12.2027', via: 'admin' }, null);
  return Promise.resolve(no).then((r) => {
    assert.ok(r.error);
    return f.attachDelivery(o, { text: 'Username: tvmeno01\nHeslo: Abcdefgh\nPlatné do: 20.12.2027', via: 'telegram', autoConfirm: true }, null);
  }).then((r) => {
    assert.ok(r.ok, r.error);
    assert.ok(f.isConfirmed(o));
    assert.strictEqual(r.card.until, '2027-12-20');
    const blob = JSON.stringify(o);
    assert.ok(!blob.includes('Abcdefgh'));
    const msgs = f.renderMessages(o, { get: () => 'lnkbio.onrender.com' });
    assert.ok(/tvmeno01/.test(msgs));
    assert.ok(/2027-12-20/.test(msgs));
  });
});

t('telegram date-fix callback round-trip and order id from notify', () => {
  const tg = require('../pay/src/telegramBot');
  process.env.TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'test-secret-value-32chars-xxxxx';
  const kb = tg.dateFixKeyboard('ord_abc123def456');
  const data = kb.inline_keyboard[0][0].callback_data;
  const p = tg.parseDateFix(data);
  assert.ok(p && p.ref === 'ord_abc123def456');
  assert.ok(!tg.parseDateFix('f:d:ord_abc123def456:xxxxxxxxxxxxxxxx'));
  assert.strictEqual(tg.orderIdFromNotifyText('🆕 Nová objednávka\nObjednávka: ord_deadbeef00\nTyp: nový'), 'ord_deadbeef00');
});

Promise.all(_pending).then(() => { if (process.exitCode) process.exit(process.exitCode); }).catch((e) => { console.error(e); process.exit(1); });

t('unlabeled first line username, second password, extra notes; predlzene do is expiry-only', () => {
  const a = soft.parseCredsFromText('tvmeno01\nTajne.123\nNainštalujte TiviMate.');
  assert.strictEqual(a.username, 'tvmeno01');
  assert.strictEqual(a.password, 'Tajne.123');
  assert.ok(/TiviMate/.test(a.notes));
  assert.ok(!a.expiryOnly);
  const b = soft.parseCredsFromText('tvmeno01\nTajne.123\n1.12.2026');
  assert.strictEqual(b.username, 'tvmeno01');
  assert.strictEqual(b.password, 'Tajne.123');
  assert.strictEqual(b.until, '2026-12-01');
  assert.strictEqual(b.notes, '');
  const c = soft.parseCredsFromText('predĺžené do 12.03.2027');
  assert.strictEqual(c.until, '2027-03-12');
  assert.ok(c.expiryOnly);
  assert.ok(!c.username && !c.password);
  const d = soft.parseCredsFromText('predlzene do 12.3.2027');
  assert.strictEqual(d.until, '2027-03-12');
  assert.ok(d.expiryOnly);
  const e = soft.parseCredsFromText('olduser12\npredĺžené do 12.03.2027');
  assert.strictEqual(e.username, 'olduser12');
  assert.ok(e.expiryOnly);
  assert.strictEqual(e.until, '2027-03-12');
  assert.strictEqual(soft.maskSecret('Tajne.123'), 'Ta…(9)');
});

t('attachDelivery unlabeled lines fills card and does not store plaintext password', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  const o = { orderId: 'ord_ul', status: 'pending', fulfill: { submittedAt: '2026-11-09', username: 'tvmeno01', slots: [{ intent: 'new', username: 'tvmeno01' }] } };
  return f.attachDelivery(o, { text: 'tvmeno01\nAbcdefgh\n1.12.2026', via: 'telegram', autoConfirm: true }, null).then((r) => {
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.card.username, 'tvmeno01');
    assert.strictEqual(r.card.until, '2026-12-01');
    const blob = JSON.stringify(o);
    assert.ok(!blob.includes('Abcdefgh'));
    const msgs = o.fulfill.messages || [];
    assert.ok(msgs.some((m) => m.type === 'credsCard' && m.card && m.card.until === '2026-12-01' && m.card.passEnc));
    assert.ok(!msgs.some((m) => m.type === 'text' && f.openCreds(m.textEnc).includes('Abcdefgh')));
  });
});

t('expiry-only reply keeps previous password and updates until', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  const prev = { orderId: 'ord_old', fulfill: { username: 'olduser12', slots: [{ intent: 'renew', username: 'olduser12' }], lines: [{ username: 'olduser12', until: '2026-01-01', passEnc: f.sealCreds('OldPass99') }], messages: [{ type: 'credsCard', at: '2026-01-01', card: { username: 'olduser12', until: '2026-01-01', passEnc: f.sealCreds('OldPass99') } }] } };
  const o = { orderId: 'ord_ren', status: 'pending', fulfill: { submittedAt: '2026-11-09', username: 'olduser12', slots: [{ intent: 'renew', username: 'olduser12' }] } };
  const bag = { ord_old: prev, ord_ren: o };
  return f.attachDelivery(o, { text: 'predĺžené do 12.03.2027', via: 'telegram', autoConfirm: true, orders: bag }, null).then((r) => {
    assert.ok(r.ok, r.error);
    assert.ok(r.expiryOnly);
    assert.strictEqual(r.card.until, '2027-03-12');
    assert.strictEqual(r.card.username, 'olduser12');
    const card = (o.fulfill.messages || []).find((m) => m.type === 'credsCard').card;
    assert.strictEqual(f.openCreds(card.passEnc), 'OldPass99');
    assert.ok(!JSON.stringify(o).includes('OldPass99'));
  });
});

t('new photo for a username deletes the previous screenshot blob across orders; 2nd slot is kept', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  const shot = (user, tag) => ({
    id: 's' + user + tag, type: 'shot', mime: 'image/jpeg',
    shotEnc: f.sealCreds(jpeg.toString('base64')),
    card: { username: user, until: '2027-01-01', passEnc: f.sealCreds('Secret12') },
  });
  const a = { orderId: 'ord_a', fulfill: { username: 'tvmeno01', slots: [{ intent: 'new', username: 'tvmeno01' }], messages: [shot('tvmeno01', '1')] } };
  const two = { orderId: 'ord_two', status: 'paid', fulfill: { submittedAt: '2026-11-09', username: 'tvmeno01', slots: [{ intent: 'new', username: 'tvmeno01' }, { intent: 'new', username: 'tvmeno02' }], messages: [shot('tvmeno01', 'x'), shot('tvmeno02', 'y')] } };
  const bag = { ord_a: a, ord_two: two };
  return f.attachDelivery(two, { photo: { buf: jpeg, mime: 'image/jpeg' }, extracted: { username: 'tvmeno01', password: 'Secret12', until: '2027-06-01' }, via: 'telegram', autoConfirm: true, orders: bag }, null).then((r) => {
    assert.ok(r.ok, r.error);
    assert.ok(!a.fulfill.messages[0].shotEnc, 'old order shot must be removed');
    const m1 = two.fulfill.messages.find((m) => m.card && m.card.username === 'tvmeno01' && m.shotReplacedAt);
    const m2 = two.fulfill.messages.find((m) => m.card && m.card.username === 'tvmeno02');
    const fresh = two.fulfill.messages.filter((m) => m.type === 'shot' && m.shotEnc && m.card && m.card.username === 'tvmeno01');
    assert.strictEqual(fresh.length, 1);
    assert.ok(m2 && m2.shotEnc, 'other device screenshot must stay');
    const html = f.renderMessages(two, { get: () => 'lnkbio.onrender.com' });
    const fotos = html.match(/\/foto\//g) || [];
    assert.strictEqual(fotos.length, 2); // latest for user1 + kept user2
  });
});

t('sweepExpiredShots deletes only images 90 days after latest expiry unless renewed', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  f.setRetainDays(90);
  const jpeg = Buffer.from('aaaa', 'utf8').toString('base64');
  const mk = (id, user, until, extra) => ({
    orderId: id,
    fulfill: {
      username: user,
      slots: [{ username: user, until, ...extra }],
      lines: [{ username: user, until }],
      messages: [{ type: 'shot', mime: 'image/jpeg', shotEnc: f.sealCreds(jpeg), card: { username: user, until, passEnc: f.sealCreds('Xxxxxx12') } }, { type: 'credsCard', card: { username: user, until, passEnc: f.sealCreds('Xxxxxx12') } }],
    },
  });
  const expired = mk('ord_e', 'userone1', '2025-01-01');
  const renewed = mk('ord_r', 'usertwo2', '2025-01-01');
  renewed.fulfill.lines[0].until = '2028-01-01';
  renewed.fulfill.messages[1].card.until = '2028-01-01';
  const bag = { ord_e: expired, ord_r: renewed };
  const r = f.sweepExpiredShots(bag, new Date('2026-11-09T12:00:00Z'));
  assert.ok(r.n >= 1);
  assert.ok(!expired.fulfill.messages[0].shotEnc, 'expired shot removed');
  assert.ok(expired.fulfill.messages[1].card.passEnc, 'credentials stay');
  assert.ok(renewed.fulfill.messages[0].shotEnc, 'renewed username shot stays');
  f.setRetainDays(90);
});

t('admin OCR drafts do not keep a plaintext password', () => {
  process.env.DATA_ENC_KEY = process.env.DATA_ENC_KEY || 'ab'.repeat(32);
  const o = { orderId: 'ord_d', fulfill: { drafts: { 0: { username: 'tvmeno01', password: 'PlainPass1', until: '2027-01-01' } } } };
  assert.ok(f.scrubDrafts(o));
  assert.ok(!o.fulfill.drafts[0].password);
  assert.ok(o.fulfill.drafts[0].passEnc);
  assert.strictEqual(f.openCreds(o.fulfill.drafts[0].passEnc), 'PlainPass1');
  assert.ok(!JSON.stringify(o).includes('PlainPass1'));
});

t('validateCheckout rejects missing contact or username with an error (API 400)', () => {
  const noUser = f.validateCheckout({ telegram: '@meno_abc' });
  assert.ok(noUser.error);
  const noContact = f.validateCheckout({ slots: [{ intent: 'new', username: 'tvmeno01' }] });
  assert.ok(noContact.error);
  assert.ok(/kontakt/i.test(noContact.error));
  const ok = f.validateCheckout({ slots: [{ intent: 'new', username: 'tvmeno01' }], email: 'a@b.sk' });
  assert.ok(!ok.error, ok.error);
});

t('retain days clamp 60–90 default 90', () => {
  assert.strictEqual(f.clampRetain(90), 90);
  assert.strictEqual(f.clampRetain(60), 60);
  assert.strictEqual(f.clampRetain(45), 60);
  assert.strictEqual(f.clampRetain(120), 90);
  f.setRetainDays(90);
});
