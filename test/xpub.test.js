'use strict';
// xpub watch-only derivation: BIP84/BIP44 vectors, LTC encodings, private material rejection, unique per-order allocation.
const assert = require('assert');
const X = require('../pay/src/xpub');
const { bech32, createBase58check } = require('@scure/base');
const { sha256 } = require('@noble/hashes/sha256');
const b58c = createBase58check(sha256);
let n = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);

// BIP84 official test vector (account 0 of the public "abandon … about" test mnemonic) – public data only
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
// BIP44 account xpub of the same public test mnemonic
const XPUB44 = 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
const reversion = (k, ver) => { const b = Buffer.from(b58c.decode(k)); b.writeUInt32BE(ver, 0); return b58c.encode(b); };

t('BIP84 vector', () => {
  const p = X.parse(ZPUB, 'btc'); assert.strictEqual(p.script, 'p2wpkh'); assert.strictEqual(p.depth, 3);
  assert.strictEqual(X.derive(p, 'btc', 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.strictEqual(X.derive(p, 'btc', 1), 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
  assert.deepStrictEqual(X.preview(ZPUB, 'btc').map((a) => a.path), ['…/0/0', '…/0/1', '…/0/2']);
});
t('BIP44 vector + script override', () => {
  assert.strictEqual(X.derive(XPUB44, 'btc', 0), '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  assert.ok(X.derive(XPUB44, 'btc', 0, 'p2sh-p2wpkh').startsWith('3'));
  assert.ok(X.derive(XPUB44, 'btc', 0, 'p2wpkh').startsWith('bc1q'));
});
t('LTC vector (same key → ltc1q / L… encodings of the identical hash160)', () => {
  const ltc = X.derive(ZPUB, 'ltc', 0, 'p2wpkh');
  const w = bech32.decode('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.strictEqual(ltc, bech32.encode('ltc', w.words));
  assert.ok(/^ltc1q[02-9ac-hj-np-z]{38}$/.test(ltc));
  // Ltub (BIP44 LTC) version of the BIP44 xpub must parse as LTC legacy and give the L… address of the same hash
  const ltub = reversion(XPUB44, 0x019da462); assert.ok(ltub.startsWith('Ltub'));
  const p = X.parse(ltub, 'ltc'); assert.strictEqual(p.script, 'p2pkh');
  const h = b58c.decode('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA').slice(1);
  const L = X.derive(p, 'ltc', 0); assert.strictEqual(L, b58c.encode(Uint8Array.from([0x30, ...h]))); assert.ok(L.startsWith('L'));
  const mtub = reversion(XPUB44, 0x01b26ef6); assert.ok(X.derive(mtub, 'ltc', 0).startsWith('M'));
  assert.throws(() => X.parse(ltub, 'btc'), (e) => e.code === 'coin');
});
t('rejects private keys, WIF, hex keys and seeds (message never echoes input)', () => {
  const XPRV = reversion(ZPUB, 0x0488ade4); // private-key version bytes (synthetic, no real key material in the repo)
  const bad = [
    [XPRV, 'private'], [reversion(XPRV, 0x04b2430c), 'private'], [reversion(XPRV, 0x019d9cfe), 'private'],
    ['5' + 'H'.repeat(50), 'wif'], // WIF shapes (synthetic)
    ['K' + 'x'.repeat(51), 'wif'], ['L' + 'z'.repeat(51), 'wif'],
    ['ab'.repeat(32), 'private'], ['0x' + 'cd'.repeat(32), 'private'],
    ['river apple stone cloud music paper tiger lemon orange window garden pilot', 'seed'], ['a b c d e f g h i j k l m n o p q r s t u v w x', 'seed'],
  ];
  for (const [k, code] of bad) {
    assert.throws(() => X.parse(k, 'btc'), (e) => { assert.ok(e instanceof X.XpubError); assert.strictEqual(e.code, code, k.slice(0, 6)); assert.ok(!e.message.includes(k)); return true; });
  }
  for (const k of ['', 'hello', ZPUB.slice(0, -2) + 'aa', reversion(ZPUB, 0x045f1cf6)]) assert.throws(() => X.parse(k, 'btc'));
  assert.ok(!X.mask(ZPUB).includes(ZPUB.slice(10, 60)));
});

t('counter uniqueness (Postgres, concurrent orders)', async () => {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { console.log('  (skipped: no DATABASE_URL)'); return; }
  const { Pool } = require('pg');
  const schema = 'xpubtest_' + process.pid;
  const admin = new Pool({ connectionString: url, max: 1 });
  try { await admin.query(`CREATE SCHEMA ${schema}`); } catch (e) { console.log('  (skipped: db unavailable)'); await admin.end(); return; }
  const pool = new Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
  try {
    await X.init(pool); await X.save('btc', ZPUB, 'auto', 50, true);
    const res = await Promise.all(Array.from({ length: 30 }, (_, i) => X.nextAddress('btc', 'ord' + i)));
    assert.ok(res.every(Boolean));
    assert.strictEqual(new Set(res.map((r) => r.index)).size, 30); assert.strictEqual(new Set(res.map((r) => r.address)).size, 30);
    assert.strictEqual(res.find((r) => r.index === 0).address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    const again = await X.nextAddress('btc', 'ord7'); assert.strictEqual(again.address, res.find((r, i) => i === 7).address); // same order → same address
    assert.strictEqual(await X.nextAddress('ltc', 'o'), null); // no LTC xpub → caller keeps old behaviour
    await X.save('btc', ZPUB, 'auto', 50, false); assert.strictEqual(await X.nextAddress('btc', 'z'), null);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {}); await admin.end(); X._setCfg({}); X.setPool(null); }
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } }
  console.log(`xpub: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
