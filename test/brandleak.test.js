'use strict';
// Internal brand name never in public JSON (only the Lightning address tokigo@blink.sv); chain2pay callback carries a secret token.
const assert = require('assert');
process.env.BTCPAY_STORE_SLUG = 'TokiGO'; process.env.BTCPAY_STORE_PAGE = 'https://btcpay.test.invalid/TokiGO';
const scrub = require('../pay/src/publicScrub');
const out = scrub.scrub({ ln: 'tokigo@blink.sv', note: 'send to tokigo@blink.sv', bad: 'Shop TokiGO', mail: 'tokigo-sepa@mail.test', x: { storeSlug: 'a', storePage: 'b', notifyEmail: 'c', loginPath: '/admin/login', keep: 1 }, arr: ['TOKIGO', 'ok'] });
assert.deepStrictEqual(out, { ln: 'tokigo@blink.sv', note: 'send to tokigo@blink.sv', bad: null, mail: null, x: { keep: 1 }, arr: ['ok'] });
assert.ok(!scrub.hasBrand('tokigo@blink.sv') && scrub.hasBrand('tokigo@blink.sv TokiGo'));
for (const m of ['btcpay', 'g2a', 'paysafecard']) {
  const st = JSON.stringify(require('../pay/src/' + m).status());
  assert.ok(!/tokigo/i.test(st.replace(/tokigo@blink\.sv/gi, '')), m + ' status leaks brand');
  assert.ok(!/notifyEmail|storeSlug|storePage/.test(st), m + ' status leaks internal keys');
}
const client = require('../pay/src/client');
const tok = 'a'.repeat(48);
assert.ok(client.buildCallbackUrl('ord_0123456789abcdef', tok).endsWith('orderId=ord_0123456789abcdef&t=' + tok));
assert.ok(!/&t=/.test(client.buildCallbackUrl('ord_0123456789abcdef')));
console.log('brandleak.test OK');
