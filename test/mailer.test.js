'use strict';
// HTTPS e-mail API request building (Brevo/Resend/Mailjet), provider auto-detect, sender rules, key masking.
const assert = require('assert');
const M = require('../mailer');
let n = 0; const t = (name, fn) => { fn(); n++; };
const C = (o) => Object.assign({ provider: 'auto', key: '', from: 'info@example.org', fromName: '', title: 'TV Software' }, o);

t('auto provider by key format', () => {
  assert.strictEqual(M.provider(C({ key: 'xkeysib-abc' })), 'brevo');
  assert.strictEqual(M.provider(C({ key: 're_abc' })), 'resend');
  assert.strictEqual(M.provider(C({ key: 'aaa:bbb' })), 'mailjet');
  assert.strictEqual(M.provider(C({ provider: 'off', key: 'x' })), 'off');
});
t('brevo request', () => {
  const r = M.buildRequest('brevo', C({ key: 'K1' }), { to: 'a@b.sk', subject: 'S', text: 'T', attachments: [{ filename: 'p.pdf', content: Buffer.from('x') }] });
  assert.strictEqual(r.url, 'https://api.brevo.com/v3/smtp/email');
  assert.strictEqual(r.headers['api-key'], 'K1');
  assert.deepStrictEqual(r.body.sender, { email: 'info@example.org', name: 'TV Software' });
  assert.deepStrictEqual(r.body.to, [{ email: 'a@b.sk' }]);
  assert.strictEqual(r.body.textContent, 'T');
  assert.deepStrictEqual(r.body.attachment, [{ name: 'p.pdf', content: Buffer.from('x').toString('base64') }]);
});
t('resend + mailjet requests', () => {
  const r = M.buildRequest('resend', C({ key: 're_1', fromName: 'Moja TV' }), { to: 'a@b.sk', subject: 'S', text: 'T' });
  assert.strictEqual(r.headers.authorization, 'Bearer re_1'); assert.strictEqual(r.body.from, 'Moja TV <info@example.org>');
  const j = M.buildRequest('mailjet', C({ key: 'u:p' }), { to: 'a@b.sk', subject: 'S', text: 'T' });
  assert.strictEqual(j.headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));
  assert.strictEqual(j.body.Messages[0].To[0].Email, 'a@b.sk');
});
t('sender: never TokiGO, name defaults to site title', () => {
  assert.strictEqual(M.senderEmail(C({ from: 'noreply@tokigo.test' })), '');
  assert.strictEqual(M.senderName(C({ fromName: 'TokiGO' })), 'TV Software');
  assert.strictEqual(M.senderName(C({ title: 'Moja TV' })), 'Moja TV');
  assert.strictEqual(M.apiReady(C({ key: 'k', from: 'bad' })), false);
  assert.strictEqual(M.apiReady(C({ key: 'k' })), true);
});
t('mask never reveals full key', () => {
  const k = 'xkeysib-0123456789abcdef0123456789';
  assert.ok(!M.mask(k).includes('0123456789abcdef')); assert.strictEqual(M.mask(''), '');
});
console.log(`mailer: ${n} tests passed`);
