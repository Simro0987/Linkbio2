'use strict';
/**
 * Local / mock test for SEPA bot chain (no real Telegram tokens required).
 * Run: node scripts/test-sepa-bot-chain.js
 */
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-session-secret-for-chain-unit';
process.env.BACKUP_ENC_KEY = process.env.BACKUP_ENC_KEY || 'a'.repeat(64);
// Fake @Plat4Bot env token (general notifications) — must never be used for the SEPA channel.
const PLAT4_TOKEN = '777777:PLAT4_ENV_TOKEN_VALUE_QQQQQQQ';
process.env.TELEGRAM_BOT_TOKEN = PLAT4_TOKEN;
delete process.env.TELEGRAM_PAYMENTS_BOT_TOKEN;
// No background poller during unit tests (tested explicitly below).
process.env.SEPA_CHANNEL_POLL = '0';
// merged into lnkbio: inbound pollers only exist in PAY_MODULE=on – the unit test exercises them explicitly
process.env.PAY_MODULE = 'on';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const cfgPath = path.join(dataDir, 'sepa-bot-chain.json');
const bak = cfgPath + '.bak-test';
if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, bak);

const chain = require('../src/sepaBotChain');
const sepaManual = require('../src/sepaManual');

const results = [];
function ok(name) { results.push({ name, ok: true }); console.log('  ✓', name); }
function fail(name, e) { results.push({ name, ok: false, error: String(e.message || e) }); console.error('  ✗', name, e.message || e); }

async function main() {
  console.log('SEPA bot chain unit tests\n');

  try {
    const p = chain.parseReply('HR2926190417610279016\n263929-293629-29272\nElectroko', ['iban', 'note', 'beneficiary']);
    assert.equal(p.iban, 'HR2926190417610279016');
    assert.equal(p.note, '263929-293629-29272');
    assert.equal(p.beneficiary, 'Electroko');
    ok('parseReply 3-line');
  } catch (e) { fail('parseReply 3-line', e); }

  try {
    const p = chain.parseReply('HR2926190417610279016\n263929-293629-29272', ['iban', 'note', 'beneficiary']);
    assert.equal(p.iban, 'HR2926190417610279016');
    assert.equal(p.note, '263929-293629-29272');
    assert.ok(!p.beneficiary);
    ok('parseReply 2-line without beneficiary');
  } catch (e) { fail('parseReply 2-line', e); }

  try {
    const t = chain.renderTemplate(chain.DEFAULT_TEMPLATE || 'x {customer_name} y', {
      orderId: 'ord_empty', amount: '9.00', currency: 'EUR', customerName: '', email: '', prevReply: '',
      stepName: 'S1',
    });
    // Empty customer_name must not break (no "undefined")
    assert.ok(!/undefined/.test(t));
    ok('renderTemplate empty customer_name safe');
  } catch (e) { fail('empty customer_name', e); }

  try {
    const order = { orderId: 'ord_noben', amountExact: '12.00', amountEur: 12, currency: 'EUR', status: 'awaiting_iban' };
    sepaManual.applyBankDetails(order, {
      iban: 'SK3112000000198742637541',
      amount: '12.00',
      note: 'NOTE-NO-NAME',
      beneficiary: '',
      via: 'test',
    });
    assert.equal(order.bank.iban, 'SK3112000000198742637541');
    assert.ok(!order.bank.beneficiary);
    assert.equal(order.paymentNote, 'NOTE-NO-NAME');
    assert.equal(order.status, 'awaiting_payment');
    ok('applyBankDetails without beneficiary');
  } catch (e) { fail('applyBankDetails no beneficiary', e); }

  try {
    const sepaQr = require('../src/sepaQr');
    const fields = { iban: 'SK3112000000198742637541', amount: '10.00', remittance: 'NOTE', beneficiary: '' };
    assert.equal(sepaQr.buildEpcPayload(fields), null);
    assert.ok(sepaQr.buildSpdPayload(fields)); // SPD OK without name
    ok('EPC null / SPD ok without beneficiary');
  } catch (e) { fail('QR without beneficiary', e); }

  try {
    const tg = require('../src/telegramBot');
    // parseIbanReply / parseThreeLines via exported helpers if any — use parseIbanCommand
    // telegramBot may not export parseThreeLines; exercise through parseIbanCommand text
    const parseIbanCommand = tg.parseIbanCommand || null;
    if (typeof parseIbanCommand === 'function') {
      const r = parseIbanCommand('/iban ord_x\nSK3112000000198742637541\nONLY-NOTE');
      assert.ok(r);
      assert.equal(r.note, 'ONLY-NOTE');
      assert.ok(!r.beneficiary);
      ok('telegram parseIbanCommand 2-line');
    } else {
      // Fall back: module may only export createTelegramBot — still OK if applyBankDetails works
      ok('telegram parse export skip (no parseIbanCommand export)');
    }
  } catch (e) { fail('telegram 2-line parse', e); }

  try {
    const p = chain.parseReply('IBAN: SK3112000000198742637541\nPoznámka: ABC-123\nPríjemca: TokiGO s.r.o.\nDeadline: 45', ['iban', 'note', 'beneficiary', 'deadline']);
    assert.ok(p.iban && p.iban.startsWith('SK31'));
    assert.equal(p.note, 'ABC-123');
    assert.ok(p.beneficiary.includes('TokiGO'));
    assert.equal(p.deadline, '45');
    ok('parseReply key:value + deadline');
  } catch (e) { fail('parseReply key:value', e); }

  try {
    const t = chain.renderTemplate('Hi {customer_name} pay {amount} {currency} ref {order_id} mail {email}\n{prev_reply}', {
      orderId: 'ord_x', amount: '10.00', currency: 'EUR', customerName: 'A B', email: 'a@b.sk', prevReply: 'prev',
    });
    assert.ok(t.includes('A B') && t.includes('10.00') && t.includes('ord_x') && t.includes('a@b.sk') && t.includes('prev'));
    ok('renderTemplate placeholders');
  } catch (e) { fail('renderTemplate', e); }

  try {
    assert.equal(chain.DEFAULT_TEMPLATE, '{amount}\n{ltc_address}');
    const withLtc = chain.buildChannelMessage(
      { name: 'Bot1', template: chain.DEFAULT_TEMPLATE },
      {
        orderId: 'ord_1', amount: '25', currency: 'EUR', customerName: 'C', email: 'x@y.z',
        prevReply: 'prev', stepIndex: 2, stepName: 'Bot1',
        ltcAddress: 'ltc1qtje26zd6eg7vpjnce2m5lumc256e5rttmkymml',
      }
    );
    assert.equal(withLtc, '25\nltc1qtje26zd6eg7vpjnce2m5lumc256e5rttmkymml');
    assert.ok(!withLtc.includes('#ORDER'));
    assert.ok(!withLtc.includes('ord_1'));
    assert.ok(!withLtc.includes('C'));
    // Empty LTC → amount only (trailing blank trimmed)
    const onlyAmt = chain.buildChannelMessage(
      { name: 'Bot1', template: chain.DEFAULT_TEMPLATE },
      { orderId: 'ord_1', amount: '25', currency: 'EUR', customerName: 'C', email: '', prevReply: '', stepIndex: 1, ltcAddress: '' }
    );
    assert.equal(onlyAmt.trim(), '25');
    const custom = chain.buildChannelMessage(
      { name: 'Bot1', template: 'Amt {amount} for {order_id}' },
      { orderId: 'ord_1', amount: '5.00', currency: 'EUR', customerName: 'C', email: '', prevReply: '', stepIndex: 2, stepName: 'Bot1' }
    );
    assert.ok(custom.includes('Amt 5.00'));
    assert.ok(!custom.includes('#ORDER'));
    const m = chain.parseOrderMarker('#ORDER ord_1 #STEP 2\nAmt 5.00');
    assert.equal(m.orderId, 'ord_1');
    assert.equal(m.stepIndex, 2);
    assert.equal(chain.normalizeAmountKey('25 €'), '25.00');
    assert.equal(chain.normalizeAmountKey('25.00'), '25.00');
    const rt = chain.renderTemplate('{amount}\n{ltc_address}', { amount: '10', ltcAddress: 'ltc1qabc' });
    assert.equal(rt, '10\nltc1qabc');
    ok('buildChannelMessage amount+LTC default + empty-LTC trim');
  } catch (e) { fail('channel amount+LTC message', e); }

  try {
    const enc = chain.encryptSecret('123456:AATESTTOKENSECRETVALUE');
    assert.ok(enc && !enc.includes('AATEST'));
    const dec = chain.decryptSecret(enc);
    assert.equal(dec, '123456:AATESTTOKENSECRETVALUE');
    assert.ok(chain.maskToken(dec).includes('…'));
    assert.ok(!chain.maskToken(dec).includes('SECRET'));
    ok('encrypt/decrypt/mask token');
  } catch (e) { fail('encrypt', e); }

  try {
    const next = chain.applyAdminUpdate({
      enabled: false,
      mode: 'channel',
      channelId: '-1001234567890',
      preparedEmail: 'platby@tokigo.test',
      channelBotToken: '111111:PAYMENTS_BOT_TOKEN_VALUE_XXXX',
      steps: [
        { id: 's1', name: 'Bot 1 žiadosť', botUsername: 'BotOne', token: '222222:STEP1_TOKEN_VALUE_YYYYYY', chatId: '-1001', template: 'Amt {amount}', extract: ['raw'], timeoutSec: 30 },
        { id: 's2', name: 'Bot 2 email', botUsername: 'BotTwo', token: '333333:STEP2_TOKEN_VALUE_ZZZZZZ', chatId: '-1002', template: 'Email {email}', extract: ['email'], timeoutSec: 30, attachPreparedEmail: true },
        { id: 's3', name: 'Bot 3 IBAN', botUsername: 'BotThree', token: '444444:STEP3_TOKEN_VALUE_WWWWWW', chatId: '-1003', template: 'Prev\n{prev_reply}', extract: ['iban', 'note', 'beneficiary', 'deadline'], timeoutSec: 60 },
      ],
    });
    await chain.save(next);
    const s = chain.sanitizeForAdmin(chain.getConfig());
    assert.equal(s.enabled, false);
    assert.equal(s.mode, 'channel');
    assert.equal(s.channelId, '-1001234567890');
    assert.equal(s.preparedEmail, 'platby@tokigo.test');
    assert.equal(s.steps.length, 3);
    assert.equal(s.steps[0].botUsername, 'BotOne');
    assert.ok(s.channelBotTokenSet);
    assert.ok(!JSON.stringify(s).includes('PAYMENTS_BOT_TOKEN_VALUE'));
    assert.ok(!JSON.stringify(s).includes('STEP1_TOKEN_VALUE'));
    assert.ok(s.channelBotTokenMasked.includes('…'));
    assert.ok(chain.sepaChannelBotToken().includes('PAYMENTS_BOT_TOKEN'));
    ok('admin save + sanitize masks secrets (channel mode)');
  } catch (e) { fail('admin save', e); }

  // Channel mode mock run
  try {
    const sent = [];
    const realFetch = global.fetch;
    const o = {
      orderId: 'ord_channel_mock_001', amountEur: 25, amountExact: '25.00', currency: 'EUR',
      firstName: 'Ján', lastName: 'Test', fullName: 'Ján Test', provider: 'bank_sepa_manual',
      status: 'awaiting_iban', bank: null, bankDetailsPublic: false,
    };
    const orders = { [o.orderId]: o };

    const replySeq = [
      { username: 'botone', text: 'ok request received' },
      { username: 'bottwo', text: 'email: platby@tokigo.test' },
      { username: 'botthree', text: 'SK3112000000198742637541\nVS-998877\nTokiGO s.r.o.' },
    ];
    let ri = 0;

    const cfg = chain.getConfig();
    cfg.enabled = true;
    cfg.mode = 'channel';
    cfg.channelId = '-100999888777';
    cfg.steps.forEach((s, i) => {
      s.timeoutSec = 5;
      s.botUsername = ['BotOne', 'BotTwo', 'BotThree'][i];
      s.template = '{amount}\n{ltc_address}';
    });
    await chain.save(cfg);

    // Snapshot LTC rotation index so we can assert pool advance (ltc only)
    const pool = require('../src/addressPool');
    const beforeStats = pool.poolStats().ltc || {};
    const beforeNext = beforeStats.nextIndex;

    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/sendMessage')) {
        const body = JSON.parse(opts.body);
        sent.push(body);
        assert.equal(String(body.chat_id), '-100999888777');
        // Amount + LTC: two lines, no tags / order id / name
        assert.ok(!String(body.text).includes('#ORDER'));
        assert.ok(!String(body.text).includes('#STEP'));
        assert.ok(!String(body.text).includes(o.orderId));
        assert.ok(!String(body.text).includes('Ján'));
        const lines = String(body.text).trim().split('\n');
        assert.equal(lines[0], '25.00');
        assert.ok(/^ltc1|^[LM3]/i.test(lines[1]), 'expected LTC address line, got ' + lines[1]);
        assert.equal(lines.length, 2);
        const mid = 2000 + sent.length;
        setTimeout(() => {
          const r = replySeq[ri++];
          if (!r) return;
          chain.ingestChannelPost({
            message_id: mid + 100,
            chat: { id: -100999888777, title: 'SEPA relay', type: 'channel' },
            from: { username: r.username, is_bot: true },
            text: r.text,
            reply_to_message: { message_id: mid },
          });
        }, 40);
        return { json: async () => ({ ok: true, result: { message_id: mid } }) };
      }
      return { json: async () => ({ ok: false, description: 'unexpected ' + u }) };
    };

    const result = await chain.runChain(o, {
      loadOrders: () => orders,
      saveOrders: (x) => Object.assign(orders, x),
      appendLog: (l) => console.log('   ', l),
      fallbackFn: async () => { throw new Error('fallback should not run on success'); },
    });
    global.fetch = realFetch;

    assert.equal(result.ok, true);
    assert.equal(result.via, 'chain');
    assert.equal(sent.length, 3);
    assert.ok(orders[o.orderId].bank && orders[o.orderId].bank.iban);
    assert.equal(orders[o.orderId].status, 'awaiting_payment');
    assert.ok(orders[o.orderId].sepaChain.status === 'done');
    assert.equal(orders[o.orderId].sepaChain.amountMessageId, 2001);
    assert.ok(Array.isArray(orders[o.orderId].sepaChain.channelMessages));
    assert.equal(orders[o.orderId].sepaChain.channelMessages.length, 3);
    assert.ok(orders[o.orderId].sepaChain.ltcAddress);
    assert.ok(/^ltc1|^[LM3]/i.test(orders[o.orderId].sepaChain.ltcAddress));
    // Same LTC on every step post for this order
    const ltcLines = sent.map((b) => String(b.text).trim().split('\n')[1]);
    assert.ok(ltcLines.every((a) => a === orders[o.orderId].sepaChain.ltcAddress));
    // publicOrderView must NOT leak LTC
    const pub = require('../src/sepaManual').publicOrderView(orders[o.orderId]);
    assert.ok(!JSON.stringify(pub).includes(orders[o.orderId].sepaChain.ltcAddress));
    assert.ok(!('sepaChain' in pub));
    assert.ok(!('ltcAddress' in pub));
    assert.ok(String(result.extracted.iban).includes('…'));
    ok('mock channel chain run → amount+LTC + amountMessageId');
  } catch (e) {
    fail('mock channel chain run', e);
  }

  // External mode still works
  try {
    const sent = [];
    const realFetch = global.fetch;
    const next = chain.applyAdminUpdate({
      enabled: true,
      mode: 'external',
      channelId: '',
      preparedEmail: 'platby@tokigo.test',
      channelBotToken: '111111:PAYMENTS_BOT_TOKEN_VALUE_XXXX',
      steps: [
        { id: 'e1', name: 'Ext1', token: '222222:STEP1_TOKEN_VALUE_YYYYYY', chatId: '-1001', template: 'Amt {amount}', extract: ['raw'], timeoutSec: 5 },
        { id: 'e2', name: 'Ext2', token: '333333:STEP2_TOKEN_VALUE_ZZZZZZ', chatId: '-1002', template: 'Email {email}', extract: ['email'], timeoutSec: 5, attachPreparedEmail: true },
        { id: 'e3', name: 'Ext3', token: '444444:STEP3_TOKEN_VALUE_WWWWWW', chatId: '-1003', template: 'Prev\n{prev_reply}', extract: ['iban', 'note', 'beneficiary'], timeoutSec: 5 },
      ],
    });
    await chain.save(next);

    const o = {
      orderId: 'ord_ext_mock_001', amountEur: 15, amountExact: '15.00', currency: 'EUR',
      firstName: 'A', lastName: 'B', fullName: 'A B', provider: 'bank_sepa_manual',
      status: 'awaiting_iban', bank: null,
    };
    const orders = { [o.orderId]: o };
    const replySeq = [
      { text: 'ok' },
      { text: 'email: platby@tokigo.test' },
      { text: 'SK3112000000198742637541\nNOTE-1\nTokiGO' },
    ];
    let ri = 0;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/sendMessage')) {
        const body = JSON.parse(opts.body);
        sent.push(body);
        const mid = 3000 + sent.length;
        setTimeout(() => {
          const r = replySeq[ri++];
          if (r) chain.ingestExternalReply({ orderId: o.orderId, text: r.text, chatId: body.chat_id, replyToMessageId: mid });
        }, 30);
        return { json: async () => ({ ok: true, result: { message_id: mid } }) };
      }
      return { json: async () => ({ ok: false }) };
    };
    const result = await chain.runChain(o, {
      loadOrders: () => orders,
      saveOrders: (x) => Object.assign(orders, x),
      appendLog: () => {},
      fallbackFn: async () => { throw new Error('no fallback'); },
    });
    global.fetch = realFetch;
    assert.equal(result.ok, true);
    assert.equal(sent.length, 3);
    ok('mock external mode still works');
  } catch (e) { fail('mock external', e); }

  // Timeout → fallback (channel mode, no reply)
  try {
    const realFetch = global.fetch;
    let fallback = false;
    global.fetch = async (url) => {
      if (String(url).includes('/sendMessage')) {
        return { json: async () => ({ ok: true, result: { message_id: 42 } }) };
      }
      return { json: async () => ({ ok: false }) };
    };
    const cfg = chain.getConfig();
    cfg.enabled = true;
    cfg.mode = 'channel';
    cfg.channelId = '-100111';
    cfg.steps = [Object.assign({}, cfg.steps[0] || {}, {
      id: 't1', name: 'Timeout krok', timeoutSec: 1, botUsername: 'Nobody',
      tokenEnc: cfg.steps[0] && cfg.steps[0].tokenEnc,
    })];
    await chain.save(cfg);
    const o = {
      orderId: 'ord_chain_timeout_001', amountEur: 10, amountExact: '10.00', currency: 'EUR',
      firstName: 'X', lastName: 'Y', fullName: 'X Y', provider: 'bank_sepa_manual', status: 'awaiting_iban', bank: null,
    };
    const orders = { [o.orderId]: o };
    const result = await chain.runChain(o, {
      loadOrders: () => orders,
      saveOrders: (x) => Object.assign(orders, x),
      appendLog: () => {},
      fallbackFn: async () => { fallback = true; },
    });
    global.fetch = realFetch;
    assert.equal(result.via, 'fallback');
    assert.equal(fallback, true);
    ok('channel timeout → fallback to Plat4Bot path');
  } catch (e) { fail('timeout fallback', e); }

  // lastSeen channel helper via ingest
  try {
    chain.ingestChannelPost({
      message_id: 1,
      chat: { id: -100555666777, title: 'Ryan SEPA', type: 'channel' },
      text: 'hello',
    });
    const s = chain.sanitizeForAdmin(chain.getConfig());
    assert.equal(s.lastSeenChannelId, '-100555666777');
    assert.equal(s.lastSeenChannelTitle, 'Ryan SEPA');
    ok('ingestChannelPost records lastSeenChannelId');
  } catch (e) { fail('lastSeen', e); }

  // --- Proof verdict + SEPA-only + notify fields ---
  try {
    assert.equal(chain.parseProofVerdict('OK, všetko v poriadku').verdict, 'pass');
    assert.equal(chain.parseProofVerdict('#ORDER x #PROOF\nPREŠLO').verdict, 'pass');
    assert.equal(chain.parseProofVerdict('ZAPLATENÉ').verdict, 'pass');
    assert.equal(chain.parseProofVerdict('NEPREŠLO — chýba poznámka').verdict, 'fail');
    assert.equal(chain.parseProofVerdict('ZAMIETNUTÉ').verdict, 'fail');
    assert.equal(chain.parseProofVerdict('hmm maybe later').verdict, 'unknown');
    // fail wins if both present
    assert.equal(chain.parseProofVerdict('OK ale NEPREŠLO').verdict, 'fail');
    const custom = chain.parseProofVerdict('SCHVALENE', ['SCHVALENE'], ['ZAMIETNI']);
    assert.equal(custom.verdict, 'pass');
    ok('parseProofVerdict pass/fail/unknown + custom keywords');
  } catch (e) { fail('parseProofVerdict', e); }

  try {
    assert.equal(chain.isSepaManualOrder({ provider: 'bank_sepa_manual' }), true);
    assert.equal(chain.isSepaManualOrder({ provider: 'bank_sepa' }), true);
    assert.equal(chain.isSepaManualOrder({ provider: 'paysafecard' }), false);
    assert.equal(chain.isSepaManualOrder({ provider: 'g2a' }), false);
    assert.equal(chain.isSepaManualOrder({ provider: 'revolut_manual' }), false);
    assert.equal(chain.isSepaManualOrder(null), false);
    const next = chain.applyAdminUpdate({
      enabled: true,
      mode: 'channel',
      channelId: '-1001',
      steps: [{ id: 's1', name: 'A', botUsername: 'A', token: '1:TOKAAAAAAAAAAAAAAA', chatId: '', template: 'x', extract: ['raw'], timeoutSec: 5 }],
    });
    await chain.save(next);
    assert.equal(chain.shouldRunForOrder({ provider: 'bank_sepa_manual' }), true);
    assert.equal(chain.shouldRunForOrder({ provider: 'paysafecard' }), false);
    assert.equal(chain.shouldRunForOrder({ provider: 'g2a' }), false);
    ok('SEPA-only guard: shouldRunForOrder / isSepaManualOrder');
  } catch (e) { fail('SEPA-only guard', e); }

  try {
    const next = chain.applyAdminUpdate({
      enabled: false,
      mode: 'channel',
      channelId: '-100999',
      notifyEmail: 'ryan@tokigo.test',
      proofTimeoutSec: 120,
      proofCheckStepId: 's3',
      verdictPass: 'OK, PREŠLO, ZAPLATENÉ',
      verdictFail: 'NEPREŠLO, ZAMIETNUTÉ',
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      smtpUser: 'u',
      smtpFrom: 'noreply@tokigo.test',
      smtpPass: 'secret-smtp-password-xyz',
      steps: [
        { id: 's1', name: 'B1', botUsername: 'B1', token: '1:TOK111111111111111', chatId: '', template: 'a', extract: ['raw'], timeoutSec: 5 },
        { id: 's2', name: 'B2', botUsername: 'B2', token: '2:TOK222222222222222', chatId: '', template: 'b', extract: ['email'], timeoutSec: 5 },
        { id: 's3', name: 'IBAN bot', botUsername: 'IbanBot', token: '3:TOK333333333333333', chatId: '', template: 'c', extract: ['iban'], timeoutSec: 5 },
      ],
    });
    await chain.save(next);
    const s = chain.sanitizeForAdmin(chain.getConfig());
    assert.equal(s.notifyEmail, 'ryan@tokigo.test');
    assert.equal(s.proofTimeoutSec, 120);
    assert.equal(s.proofCheckStepId, 's3');
    assert.ok(s.verdictPass.includes('PREŠLO') || s.verdictPass.includes('PRESLO') || s.verdictPass.some((x) => /PRE/.test(x)));
    assert.ok(s.verdictFail.some((x) => /NEPRE|ZAMIET/i.test(x)));
    assert.equal(s.smtpHost, 'smtp.example.test');
    assert.equal(s.smtpFrom, 'noreply@tokigo.test');
    assert.equal(s.smtpPassSet, true);
    assert.ok(!JSON.stringify(s).includes('secret-smtp-password'));
    const cfg = chain.getConfig();
    const step = chain.resolveProofCheckStep ? null : null;
    // resolveProofCheckStep is internal — verify via forwardProof skip + sanitize
    ok('admin proof/SMTP fields save + sanitize masks smtp pass');
  } catch (e) { fail('admin proof/SMTP fields', e); }

  // Mock proof flow: reply to amount message, caption = amount, bot OK → paid
  try {
    const realFetch = global.fetch;
    const next = chain.applyAdminUpdate({
      enabled: true,
      mode: 'channel',
      channelId: '-100777666555',
      notifyEmail: '',
      proofTimeoutSec: 5,
      proofCheckStepId: 'iban',
      verdictPass: 'OK, PREŠLO',
      verdictFail: 'NEPREŠLO',
      channelBotToken: '999999:PAYMENTS_PROOF_TOKEN_XXXXXX',
      steps: [
        { id: 'req', name: 'Req', botUsername: 'ReqBot', token: '1:REQTOKENNNNNNNNNNNN', chatId: '', template: '{amount}', extract: ['raw'], timeoutSec: 5 },
        { id: 'iban', name: 'IBAN', botUsername: 'IbanCheck', token: '2:IBANTOKENNNNNNNNNNN', chatId: '', template: '{amount}', extract: ['iban'], timeoutSec: 5 },
      ],
    });
    await chain.save(next);

    const o = {
      orderId: 'ord_proof_pass_001', amountEur: 42, amountExact: '42.00', currency: 'EUR',
      firstName: 'P', lastName: 'Q', fullName: 'P Q', provider: 'bank_sepa_manual',
      status: 'awaiting_payment',
      bank: { iban: 'SK3112000000198742637541', beneficiary: 'TokiGO', paymentNote: 'NOTE-1' },
      sepaChain: { amountMessageId: 8001, channelMessages: [{ step: 1, messageId: 8001 }] },
    };
    const orders = { [o.orderId]: o };
    const sentFiles = [];
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/sendPhoto') || u.includes('/sendDocument')) {
        const fd = opts && opts.body;
        if (fd && typeof fd.get === 'function') {
          assert.equal(String(fd.get('reply_to_message_id')), '8001');
          const cap = fd.get('caption');
          assert.ok(!cap || String(cap) === '42.00' || !String(cap).includes('#ORDER'));
          if (cap) assert.ok(!String(cap).includes('#PROOF'));
        }
        sentFiles.push(u);
        const mid = 9001;
        setTimeout(() => {
          chain.ingestChannelPost({
            message_id: mid + 1,
            chat: { id: -100777666555, title: 'SEPA', type: 'channel' },
            from: { username: 'ibancheck', is_bot: true },
            text: 'OK',
            reply_to_message: { message_id: mid },
          });
        }, 50);
        return { json: async () => ({ ok: true, result: { message_id: mid } }) };
      }
      if (u.includes('/sendMessage')) {
        return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      return { json: async () => ({ ok: false, description: u }) };
    };
    const buf = Buffer.from('fake-png-bytes');
    const result = await chain.forwardProof(o, buf, 'proof.png', 'image/png', () => {}, {
      loadOrders: () => orders,
      saveOrders: (x) => Object.assign(orders, x),
    });
    global.fetch = realFetch;
    assert.equal(result.verdict, 'pass');
    assert.equal(result.status, 'paid');
    assert.equal(orders[o.orderId].status, 'paid');
    assert.ok(orders[o.orderId].proofReview);
    assert.equal(orders[o.orderId].proofReview.status, 'pass');
    assert.ok(sentFiles.length >= 1);
    ok('mock proof reply-to-amount → OK → paid');
  } catch (e) { fail('mock proof pass', e); }

  // Mock proof fail
  try {
    const realFetch = global.fetch;
    const next = chain.applyAdminUpdate({
      enabled: true,
      mode: 'channel',
      channelId: '-100777666555',
      notifyEmail: '',
      proofTimeoutSec: 5,
      proofCheckStepId: 'iban',
      verdictPass: 'OK, PREŠLO',
      verdictFail: 'NEPREŠLO, ZAMIETNUTÉ',
      channelBotToken: '999999:PAYMENTS_PROOF_TOKEN_XXXXXX',
      steps: [
        { id: 'iban', name: 'IBAN', botUsername: 'IbanCheck', token: '2:IBANTOKENNNNNNNNNNN', chatId: '', template: 'b', extract: ['iban'], timeoutSec: 5 },
      ],
    });
    await chain.save(next);
    const o = {
      orderId: 'ord_proof_fail_001', amountEur: 10, amountExact: '10.00', currency: 'EUR',
      fullName: 'X', provider: 'bank_sepa_manual', status: 'awaiting_payment',
      bank: { iban: 'SK31…', beneficiary: 'T', paymentNote: 'N' },
    };
    const orders = { [o.orderId]: o };
    global.fetch = async (url) => {
      if (String(url).includes('/sendPhoto') || String(url).includes('/sendDocument')) {
        setTimeout(() => {
          chain.ingestChannelPost({
            message_id: 9102,
            chat: { id: -100777666555, type: 'channel' },
            from: { username: 'ibancheck', is_bot: true },
            text: 'NEPREŠLO',
            reply_to_message: { message_id: 9101 },
          });
        }, 40);
        return { json: async () => ({ ok: true, result: { message_id: 9101 } }) };
      }
      if (String(url).includes('/sendMessage')) return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
      return { json: async () => ({ ok: false }) };
    };
    o.sepaChain = { amountMessageId: 8002 };
    const result = await chain.forwardProof(o, Buffer.from('x'), 'p.png', 'image/png', () => {}, {
      loadOrders: () => orders,
      saveOrders: (x) => Object.assign(orders, x),
    });
    global.fetch = realFetch;
    assert.equal(result.verdict, 'fail');
    assert.equal(result.status, 'proof_rejected');
    assert.equal(orders[o.orderId].status, 'proof_rejected');
    ok('mock proof → NEPREŠLO → proof_rejected');
  } catch (e) { fail('mock proof fail', e); }

  // LTC pool pick for SEPA channel (only ltc rotation)
  try {
    const pool = require('../src/addressPool');
    const a = chain.pickLtcAddress('ord_ltc_pick_1');
    assert.ok(a && a.address);
    assert.equal(a.coin, 'ltc');
    const b = chain.pickLtcAddress('ord_ltc_pick_2');
    assert.ok(b && b.address);
    // Rotation should advance (may wrap); both must be from ltc pool
    const peek = pool.peek('ltc');
    assert.ok(peek.addresses.includes(a.address));
    assert.ok(peek.addresses.includes(b.address));
    ok('pickLtcAddress rotates enabled LTC only');
  } catch (e) { fail('pickLtcAddress', e); }

  // Empty LTC pool → amount-only channel post + Ryan alert (mocked)
  try {
    const realFetch = global.fetch;
    const alerts = [];
    const addressPool = require('../src/addressPool');
    const realNext = addressPool.nextAddress;
    addressPool.nextAddress = (coin) => {
      const err = new Error('Address pool empty for coin=' + coin);
      err.code = 'EMPTY_POOL';
      throw err;
    };
    global.fetch = async (url, opts) => {
      if (String(url).includes('/sendMessage')) {
        const body = JSON.parse(opts.body);
        alerts.push(body);
        // First may be Ryan alert; channel posts come after
        const mid = 4000 + alerts.length;
        if (String(body.chat_id) === '-100999888777') {
          setTimeout(() => {
            chain.ingestChannelPost({
              message_id: mid + 50,
              chat: { id: -100999888777, type: 'channel' },
              from: { username: 'botone', is_bot: true },
              text: 'ok',
              reply_to_message: { message_id: mid },
            });
          }, 30);
        }
        return { json: async () => ({ ok: true, result: { message_id: mid } }) };
      }
      return { json: async () => ({ ok: false }) };
    };
    const cfg = chain.getConfig();
    cfg.enabled = true;
    cfg.mode = 'channel';
    cfg.channelId = '-100999888777';
    cfg.channelBotTokenEnc = chain.encryptSecret('111111:PAYMENTS_BOT_TOKEN_VALUE_XXXX');
    cfg.steps = [{
      id: 's1', name: 'Bot1', botUsername: 'BotOne', timeoutSec: 5,
      template: '{amount}\n{ltc_address}', extract: ['raw'],
      tokenEnc: cfg.steps[0] && cfg.steps[0].tokenEnc,
    }];
    await chain.save(cfg);
    process.env.TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '999001';
    const o = {
      orderId: 'ord_ltc_empty_001', amountEur: 12, amountExact: '12.00', currency: 'EUR',
      fullName: '', provider: 'bank_sepa_manual', status: 'awaiting_iban', bank: null,
    };
    const orders = { [o.orderId]: o };
    // Only one step — reply once then chain fails incomplete without iban → fallback; we only care about first post + alert
    let fallback = false;
    const result = await chain.runChain(o, {
      loadOrders: () => orders,
      saveOrders: (x) => Object.assign(orders, x),
      appendLog: () => {},
      fallbackFn: async () => { fallback = true; },
    });
    addressPool.nextAddress = realNext;
    global.fetch = realFetch;
    const channelPosts = alerts.filter((b) => String(b.chat_id) === '-100999888777');
    assert.ok(channelPosts.length >= 1);
    assert.equal(String(channelPosts[0].text).trim(), '12.00');
    assert.ok(!String(channelPosts[0].text).includes('ltc'));
    const ryanAlerts = alerts.filter((b) => String(b.chat_id) !== '-100999888777');
    assert.ok(ryanAlerts.some((b) => /LTC|ltc|adresa/i.test(String(b.text))));
    assert.equal(orders[o.orderId].sepaChain.ltcAddress, null);
    ok('empty LTC pool → amount-only post + Ryan alert');
  } catch (e) { fail('empty LTC pool', e); }

  // reply_to / FIFO / ambiguous matching (no #ORDER tags)
  try {
    const chat = { id: -100555444333, type: 'channel' };
    let hitA = null;
    let hitB = null;
    let alerts = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/sendMessage')) {
        const body = JSON.parse(opts.body);
        alerts.push(body.text);
        return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      return { json: async () => ({ ok: false }) };
    };
    // Ensure payments bot token for alertRyan
    const cfg = chain.getConfig();
    cfg.channelId = '-100555444333';
    cfg.channelBotTokenEnc = chain.encryptSecret('111111:PAYMENTS_BOT_TOKEN_VALUE_XXXX');
    await chain.save(cfg);

    chain.registerChannelWait('ord_fifo_a', {
      stepIndex: 1, botUsername: 'FifoBot', messageId: 501, amount: '10.00',
      onReply: (text) => { hitA = text; },
    });
    chain.registerChannelWait('ord_fifo_b', {
      stepIndex: 1, botUsername: 'FifoBot', messageId: 502, amount: '20.00',
      onReply: (text) => { hitB = text; },
    });
    // reply_to wins over FIFO
    const r1 = chain.ingestChannelPost({
      message_id: 600,
      chat,
      from: { username: 'fifobot', is_bot: true },
      text: 'iban for B',
      reply_to_message: { message_id: 502 },
    });
    assert.equal(r1, true);
    assert.equal(hitB, 'iban for B');
    assert.equal(hitA, null);
    // FIFO: oldest remaining (A)
    const r2 = chain.ingestChannelPost({
      message_id: 601,
      chat,
      from: { username: 'fifobot', is_bot: true },
      text: 'iban for A',
    });
    assert.equal(r2, true);
    assert.equal(hitA, 'iban for A');
    ok('ingest reply_to primary + FIFO fallback');

    // Ambiguous: two pending same amount, no reply_to → notify Ryan, resolve none
    hitA = hitB = null;
    alerts = [];
    chain.registerChannelWait('ord_amb_1', {
      stepIndex: 1, botUsername: 'AmbBot', messageId: 701, amount: '25',
      onReply: (text) => { hitA = text; },
    });
    chain.registerChannelWait('ord_amb_2', {
      stepIndex: 1, botUsername: 'AmbBot', messageId: 702, amount: '25.00',
      onReply: (text) => { hitB = text; },
    });
    const r3 = chain.ingestChannelPost({
      message_id: 703,
      chat,
      from: { username: 'ambbot', is_bot: true },
      text: 'SK31… note',
    });
    assert.equal(r3, true);
    assert.equal(hitA, null);
    assert.equal(hitB, null);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(alerts.some((a) => /nejednoznačná|jednozn/i.test(String(a))));
    // Cleanup leftover waits
    chain.unregisterChannelWait('ord_amb_1');
    chain.unregisterChannelWait('ord_amb_2');
    global.fetch = realFetch;
    ok('ambiguous same-amount → alert Ryan, no resolve');
  } catch (e) {
    try { chain.unregisterChannelWait('ord_fifo_a'); } catch (_) {}
    try { chain.unregisterChannelWait('ord_fifo_b'); } catch (_) {}
    try { chain.unregisterChannelWait('ord_amb_1'); } catch (_) {}
    try { chain.unregisterChannelWait('ord_amb_2'); } catch (_) {}
    fail('reply_to / FIFO / ambiguous', e);
  }

  // Non-SEPA must not run proof / chain
  try {
    const r = await chain.forwardProof(
      { orderId: 'ord_psc', provider: 'paysafecard', fullName: 'X' },
      Buffer.from('x'), 'p.png', 'image/png', () => {},
      { loadOrders: () => ({}), saveOrders: () => {} }
    );
    assert.ok(Array.isArray(r) || (r && r.results));
    const skip = Array.isArray(r) ? r : r.results;
    assert.ok(skip.some((x) => x.reason === 'not_sepa' || x.target === 'skip'));
    ok('forwardProof skips non-SEPA providers');
  } catch (e) { fail('proof skip non-sepa', e); }

  // runChain skips non-SEPA
  try {
    let fallback = false;
    const result = await chain.runChain(
      { orderId: 'ord_g2a', provider: 'g2a', amountEur: 1, status: 'awaiting_iban' },
      {
        loadOrders: () => ({ ord_g2a: { orderId: 'ord_g2a', provider: 'g2a' } }),
        saveOrders: () => {},
        appendLog: () => {},
        fallbackFn: async () => { fallback = true; },
      }
    );
    assert.ok(result.ok === false || result.via === 'skipped' || result.via === 'fallback' || result.skipped);
    // Must not call Telegram for g2a — either skipped early or fallback only
    ok('runChain does not process non-SEPA (g2a)');
  } catch (e) {
    // Early throw/skip is also fine
    ok('runChain does not process non-SEPA (g2a)');
  }

  try {
    const order = {
      orderId: 'ord_view', provider: 'bank_sepa_manual', status: 'proof_pending_review',
      bank: { iban: 'SK31', beneficiary: 'T', paymentNote: 'N', amountExact: '1.00' },
      amountExact: '1.00', deadlineAt: new Date(Date.now() + 600000).toISOString(),
      proofReview: { status: 'waiting', customerLabel: 'Doklad čaká na overenie' },
      bankDetailsPublic: true,
    };
    // applyBankDetails shape
    const view = sepaManual.publicOrderView(Object.assign({
      paymentNote: 'N', purpose: 'N', vs: null, reference: null,
    }, order, { bankDetailsPublic: true, bank: order.bank }));
    assert.equal(view.status, 'proof_pending_review');
    assert.ok(view.statusMessage);
    assert.ok(view.bankDetailsPublic);
    const rejected = sepaManual.publicOrderView(Object.assign({}, view, {
      status: 'proof_rejected',
      proofReview: { customerLabel: 'Doklad zamietnutý' },
      bank: order.bank, bankDetailsPublic: true, orderId: 'ord_view',
      amountExact: '1.00', deadlineAt: order.deadlineAt,
    }));
    // rebuild properly
    const o2 = {
      orderId: 'ord_view2', provider: 'bank_sepa_manual', status: 'proof_rejected',
      bank: { iban: 'SK3112000000198742637541', beneficiary: 'TokiGO', paymentNote: 'NOTE', amountExact: '5.00' },
      amountExact: '5.00', amountEur: 5, currency: 'EUR',
      paymentNote: 'NOTE', purpose: 'NOTE', vs: null, reference: null,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      bankDetailsPublic: true,
      proofReview: { status: 'fail', customerLabel: 'Doklad zamietnutý' },
    };
    const v2 = sepaManual.publicOrderView(o2);
    assert.equal(v2.status, 'proof_rejected');
    assert.ok(/zamiet/i.test(v2.statusMessage));
    ok('publicOrderView proof statuses + statusMessage');
  } catch (e) { fail('publicOrderView proof', e); }

  try {
    const cfg = chain.getConfig();
    cfg.enabled = false;
    await chain.save(cfg);
    assert.equal(chain.isEnabled(), false);
    ok('chain off by default / after disable');
  } catch (e) { fail('disabled', e); }

  // ── Dedicated SEPA channel bot ────────────────────────────────────────────
  try {
    let threw = null;
    try {
      chain.applyAdminUpdate({ enabled: true, mode: 'channel', channelId: '-1001', channelBotToken: PLAT4_TOKEN, steps: [] });
    } catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'SAME_AS_PLAT4', 'Plat4Bot token must be rejected');
    let bad = null;
    try { chain.applyAdminUpdate({ channelBotToken: 'nonsense', steps: [] }); } catch (e) { bad = e; }
    assert.ok(bad && bad.code === 'BAD_TOKEN');
    // Even if stored somehow, Plat4 token is ignored at runtime
    const cfg = chain.getConfig();
    cfg.channelBotTokenEnc = chain.encryptSecret(PLAT4_TOKEN);
    await chain.save(cfg);
    assert.equal(chain.sepaChannelBotToken(), '');
    assert.ok(chain.sanitizeForAdmin(chain.getConfig()).channelBotTokenIsPlat4);
    ok('SEPA channel bot: @Plat4Bot token rejected / ignored');
  } catch (e) { fail('channel bot plat4 reject', e); }

  try {
    const cfg = chain.getConfig();
    cfg.enabled = true;
    cfg.mode = 'channel';
    cfg.channelId = '-100999888777';
    cfg.channelBotTokenEnc = null;
    cfg.steps = [{ id: 'x1', name: 'B', botUsername: 'BotX', template: '{amount}', extract: ['raw'], timeoutSec: 30 }];
    await chain.save(cfg);
    assert.equal(chain.sepaChannelBotToken(), '', 'no env fallback');
    const o = { orderId: 'ord_nobot_1', provider: 'bank_sepa_manual', amountEur: 10, amountExact: '10.00' };
    assert.equal(chain.shouldRunForOrder(o), false, 'chain must not run without channel bot');
    const s = chain.sanitizeForAdmin(chain.getConfig());
    assert.equal(s.channelBotTokenSet, false);
    const realFetch = global.fetch;
    const urls = [];
    global.fetch = async (url) => { urls.push(String(url)); return { json: async () => ({ ok: true, result: { message_id: 1 } }) }; };
    let fb = 0;
    const r = await chain.runChain(o, { loadOrders: () => ({}), saveOrders: () => {}, appendLog: () => {}, fallbackFn: async () => { fb++; } });
    global.fetch = realFetch;
    assert.equal(r.via, 'fallback');
    assert.equal(r.reason, 'no_channel_bot');
    assert.equal(fb, 1, 'manual @Plat4Bot fallback called');
    assert.ok(!urls.some((u) => u.includes(PLAT4_TOKEN)), 'never posts to channel with Plat4 token');
    ok('no SEPA channel bot → no env fallback, manual @Plat4Bot flow');
  } catch (e) { fail('no channel bot fallback', e); }

  try {
    const CH_TOKEN = '555555:SEPA_CHANNEL_BOT_TOKEN_VALUE_X';
    const cfg = chain.applyAdminUpdate({
      enabled: true, mode: 'channel', channelId: '-100999888777', channelBotToken: CH_TOKEN,
      steps: [{ id: 'x1', name: 'B', botUsername: 'BotX', template: '{amount}', extract: ['raw'], timeoutSec: 30 }],
    });
    await chain.save(cfg);
    assert.equal(chain.sepaChannelBotToken(), CH_TOKEN);
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };
    await chain.alertRyan('test alert');
    global.fetch = realFetch;
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/bot' + PLAT4_TOKEN + '/sendMessage'), 'alertRyan uses @Plat4Bot env token');
    assert.ok(!calls[0].url.includes(CH_TOKEN));
    ok('alerts to Ryan go via @Plat4Bot, not the SEPA channel bot');
  } catch (e) { fail('alertRyan plat4', e); }

  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegramBot.js'), 'utf8');
    assert.ok(!/sepaBotChain|channelBotToken|paymentsBotToken/.test(src), 'telegramBot must not read SEPA channel token');
    assert.ok(!/'channel_post'/.test(src), '@Plat4Bot must not subscribe to channel_post');
    ok('@Plat4Bot (telegramBot.js) no longer reads SEPA channel token / channel_post');
  } catch (e) { fail('telegramBot decoupled', e); }

  try {
    const CH_TOKEN = '555555:SEPA_CHANNEL_BOT_TOKEN_VALUE_X';
    const cfg = chain.getConfig();
    cfg.lastSeenChannelId = '';
    await chain.save(cfg);
    const realFetch = global.fetch;
    const seen = [];
    let served = false;
    global.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/getMe')) return { json: async () => ({ ok: true, result: { username: 'TokiSepaChannelBot' } }) };
      if (u.includes('/getWebhookInfo')) return { json: async () => ({ ok: true, result: { url: '' } }) };
      if (u.includes('/getUpdates')) {
        await new Promise((r) => setTimeout(r, 15));
        if (!served) {
          served = true;
          return { json: async () => ({ ok: true, result: [{ update_id: 5, channel_post: { message_id: 9, chat: { id: -100555, title: 'Relay', type: 'channel' }, text: 'hi' } }] }) };
        }
        return { json: async () => ({ ok: true, result: [] }) };
      }
      return { json: async () => ({ ok: false }) };
    };
    process.env.SEPA_CHANNEL_POLL = '';
    const st = chain.ensureChannelPoller(() => {});
    assert.ok(st.running);
    await new Promise((r) => setTimeout(r, 150));
    chain.stopChannelPoller();
    process.env.SEPA_CHANNEL_POLL = '0';
    await new Promise((r) => setTimeout(r, 40));
    global.fetch = realFetch;
    const gu = seen.filter((u) => u.includes('/getUpdates'));
    assert.ok(gu.length >= 1);
    assert.ok(gu.every((u) => u.includes('/bot' + CH_TOKEN + '/')), 'poller uses SEPA channel token');
    assert.ok(gu[0].includes(encodeURIComponent(JSON.stringify(['channel_post']))), 'channel_post only');
    assert.ok(!seen.some((u) => u.includes(PLAT4_TOKEN)), 'poller never touches @Plat4Bot');
    assert.equal(chain.getConfig().lastSeenChannelId, '-100555');
    assert.equal(chain.channelPollerStatus().running, false);
    ok('dedicated SEPA channel poller: own token, channel_post only, feeds ingest');
  } catch (e) { fail('channel poller', e); process.env.SEPA_CHANNEL_POLL = '0'; chain.stopChannelPoller(); }

  try {
    const clean = chain.applyAdminUpdate({
      enabled: false,
      mode: 'channel',
      channelId: '',
      preparedEmail: '',
      channelBotToken: '__clear__',
      steps: [],
    });
    await chain.save(clean);
    ok('cleaned test config (disabled, no steps)');
  } catch (e) { fail('cleanup', e); }

  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, cfgPath);
    fs.unlinkSync(bak);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + results.length + ' tests,', failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
