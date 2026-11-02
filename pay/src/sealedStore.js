'use strict';
/**
 * Small encrypted-config store shared by the newer payment modules (gift cards, OxaPay, Card2Crypto / PayGate.to).
 * - Same scheme as the Blink API key (blink.js sealKey/openKey): AES-256-GCM, key = HMAC-SHA256(DATA_ENC_KEY | BACKUP_ENC_KEY, label),
 *   AAD = label, stored base64(iv|tag|ct). Secrets are never logged or returned to the browser.
 * - Persistence: Postgres table pay_config (id → jsonb), file fallback data/<id>.json (local dev / DB outage).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const orderDb = require('./db');

let tableReady = null;
async function table() {
  const p = orderDb.pool(); if (!p) return null;
  if (!tableReady) tableReady = p.query(`CREATE TABLE IF NOT EXISTS pay_config (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`).catch((x) => { tableReady = null; throw x; });
  await tableReady; return p;
}
function encKey(label) {
  const k = [process.env.DATA_ENC_KEY, process.env.BACKUP_ENC_KEY].map((v) => String(v || '').trim()).find((v) => /^[0-9a-f]{64}$/i.test(v));
  return k ? crypto.createHmac('sha256', Buffer.from(k, 'hex')).update(label).digest() : null;
}
function seal(label, plain) {
  const k = encKey(label); if (!k) throw new Error('Chýba DATA_ENC_KEY – údaj nie je možné bezpečne uložiť.');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv); c.setAAD(Buffer.from(label));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function open(label, enc) {
  if (!enc) return '';
  try {
    const k = encKey(label); if (!k) return '';
    const b = Buffer.from(String(enc), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12));
    d.setAAD(Buffer.from(label)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
/** create(id, defaults) → { get(), load(), save(patch) } ; get() is the in-memory copy (sync). */
function create(id, defaults, log = () => {}) {
  const file = path.join(__dirname, '..', 'data', id + '.json');
  let CFG = JSON.parse(JSON.stringify(defaults || {}));
  let loadFailed = false;
  return {
    get: () => CFG,
    /** true when the last load() could not read Postgres (DB configured but query failed). */
    loadFailed: () => loadFailed,
    set: (c) => { CFG = { ...CFG, ...c }; },
    async load() {
      loadFailed = false;
      try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object') CFG = { ...CFG, ...j }; } catch { /* none */ }
      try { const p = await table(); if (p) { const r = await p.query('SELECT data FROM pay_config WHERE id=$1', [id]); if (r.rows[0]) CFG = { ...CFG, ...r.rows[0].data }; } } catch (x) { loadFailed = true; log(id.toUpperCase() + '_CONFIG_DB_FAIL ' + x.message); }
      return CFG;
    },
    async save(next) {
      CFG = { ...CFG, ...next, updatedAt: new Date().toISOString() };
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(CFG)); } catch { /* read-only fs */ }
      const p = await table().catch(() => null);
      if (p) await p.query(`INSERT INTO pay_config (id, data) VALUES ($1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [id, JSON.stringify(CFG)]);
      return CFG;
    },
  };
}
module.exports = { create, seal, open };
