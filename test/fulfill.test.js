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
