'use strict';
const assert = require('assert');
const A = require('../accSecure');
const F = require('../pay/src/fulfill');
let n = 0;
async function t(name, fn) { n++; await fn(); }
(async () => {
  await t('guide gate: needs paid + credSentAt', () => {
    assert.strictEqual(A.isGuideOrder({ status: 'pending', fulfill: { credSentAt: 'x' } }, F), false);
    assert.strictEqual(A.isGuideOrder({ status: 'paid', fulfill: {} }, F), false);
    assert.strictEqual(A.isGuideOrder({ status: 'paid', fulfill: { credSentAt: '2026-01-01' } }, F), true);
    assert.strictEqual(A.isGuideOrder({ status: 'confirmed', paidAt: '2026-01-01', fulfill: { credSentAt: 'x' } }, F), true);
  });
  await t('userMaySeeGuide', () => {
    const u = { id: 7 };
    const all = {
      a: { status: 'paid', acct: { id: 7 }, fulfill: { credSentAt: 'x' } },
      b: { status: 'paid', acct: { id: 8 }, fulfill: { credSentAt: 'x' } },
      c: { status: 'pending', acct: { id: 7 }, fulfill: { credSentAt: 'x' } },
    };
    assert.strictEqual(A.userMaySeeGuide(u, all, F), true);
    assert.strictEqual(A.userMaySeeGuide({ id: 9 }, all, F), false);
    assert.strictEqual(A.userMaySeeGuide(u, { c: all.c }, F), false);
  });
  await t('mdLite', () => {
    const h = A.mdLite('Ahoj **svet**\n\n[web](https://example.com)');
    assert.ok(h.includes('<b>svet</b>'), h);
    assert.ok(/href=/.test(h), h);
    assert.ok(!/<script/i.test(A.mdLite('<script>alert(1)</script>ok')));
  });
  await t('softUserOk', () => {
    assert.strictEqual(A.softUserOk('abcdefgh'), true);
    assert.strictEqual(A.softUserOk('short'), false);
  });
  await t('totp + recovery', async () => {
    const secret = A.totp.generateSecret();
    assert.ok(A.totp.verify(secret, A.totp.now(secret)) > 0);
    const codes = A.genRecoveryCodes(2);
    const hashes = await A.hashCodes(codes);
    const next = await A.consumeRecovery(hashes, A.fmtRecovery(codes[0]));
    assert.ok(next && next.length === 1);
    assert.strictEqual(await A.consumeRecovery(next, codes[0]), null);
  });
  await t('updateSoftwareCreds rename', () => {
    const orders = {
      o1: {
        fulfill: {
          credSentAt: '2026-01-01',
          username: 'olduser12',
          lines: [{ username: 'olduser12', until: '2027-01-01' }],
          slots: [{ username: 'olduser12' }],
          messages: [{ at: '1', card: { username: 'olduser12', until: '2027-01-01' } }],
        },
      },
    };
    const r = F.updateSoftwareCreds(orders, { oldUsername: 'olduser12', newUsername: 'newuser12' });
    assert.strictEqual(r.updated, 1);
    assert.strictEqual(orders.o1.fulfill.lines[0].username, 'newuser12');
    assert.strictEqual(orders.o1.fulfill.messages[0].card.username, 'newuser12');
  });
  console.log('acc-secure: ' + n + ' tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
