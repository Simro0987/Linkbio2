'use strict';
const assert = require('assert');
const f = require('../pay/src/fulfill');

function t(name, fn) { try { fn(); console.log('ok', name); } catch (e) { console.error('FAIL', name, e); process.exitCode = 1; } }

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
