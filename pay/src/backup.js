'use strict';
// Daily encrypted DB backup -> owner Telegram chat (sendDocument).
// Format: "C2PBK1" | iv(12) | tag(16) | AES-256-GCM(gzip(JSON)), AAD = "C2PBK1". Decrypt: scripts/decrypt-backup.js
const crypto = require('crypto');
const zlib = require('zlib');
const orderDb = require('./db');

const MAGIC = Buffer.from('C2PBK1');
const HOUR = 3, MIN = 17, TZ = 'Europe/Zurich';
const APP = 'checkout';

function key() {
  const k = String(process.env.BACKUP_ENC_KEY || '').trim();
  return /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, 'hex') : null;
}
function encrypt(buf, k) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv); c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}
function zurichParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}

async function dump() {
  const pool = orderDb.pool();
  const out = { format: 'checkout-db-dump', version: 1, app: APP, exported_at: new Date().toISOString(), tables: {} };
  if (!pool) { out.note = 'DATABASE_URL not configured'; return out; }
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`);
  for (const { table_name: t } of rows) {
    if (t === 'backup_runs') continue;
    const r = await pool.query(`SELECT row_to_json(x) j FROM "${t.replace(/"/g, '')}" x`);
    out.tables[t] = r.rows.map((x) => x.j);
  }
  return out;
}

/** Claims a run slot in the DB so several instances never send twice. */
async function claim(slot) {
  const pool = orderDb.pool();
  if (!pool) return true;
  await pool.query(`CREATE TABLE IF NOT EXISTS backup_runs (slot text PRIMARY KEY, at timestamptz DEFAULT now(), result text)`);
  const r = await pool.query(`INSERT INTO backup_runs (slot) VALUES ($1) ON CONFLICT DO NOTHING RETURNING slot`, [slot]);
  return r.rowCount === 1;
}
async function mark(slot, result) {
  const pool = orderDb.pool();
  if (pool) await pool.query(`UPDATE backup_runs SET result=$2 WHERE slot=$1`, [slot, String(result).slice(0, 500)]).catch(() => {});
}

async function run({ appendLog = () => {}, slot } = {}) {
  const k = key();
  if (!k) throw new Error('BACKUP_ENC_KEY missing');
  const bot = global.__telegramBot, chat = bot && bot.loadAdminChatId();
  if (!bot || !chat || !bot.tokenConfigured()) throw new Error('telegram not configured');
  slot = slot || `${APP}:${zurichParts().day}`;
  if (!(await claim(slot))) { appendLog(`BACKUP_SKIP ${slot} already claimed`); return { ok: true, skipped: true, slot }; }
  try {
    const data = await dump();
    const counts = Object.fromEntries(Object.entries(data.tables).map(([t, r]) => [t, r.length]));
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
    const file = encrypt(gz, k);
    const name = `${APP}-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json.gz.enc`;
    const caption = `🗄 Záloha ${APP} · ${new Date().toLocaleString('sk-SK', { timeZone: TZ })}\n${Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(', ')}\n${file.length} B · AES-256-GCM (BACKUP_ENC_KEY)\nDešifrovanie: node scripts/decrypt-backup.js <súbor>`;
    const msg = await bot.sendFile(chat, 'document', file, name, caption, 'application/octet-stream');
    const res = { ok: true, slot, message_id: msg && msg.message_id, bytes: file.length, counts };
    await mark(slot, 'ok ' + (msg && msg.message_id));
    appendLog(`BACKUP_OK ${slot} msg=${res.message_id} bytes=${file.length}`);
    return res;
  } catch (e) {
    await mark(slot, 'fail ' + e.message);
    appendLog(`BACKUP_FAIL ${slot} ${e.message}`);
    throw e;
  }
}

function start({ appendLog = () => {} } = {}) {
  const tick = () => {
    const z = zurichParts();
    if (z.h * 60 + z.m < HOUR * 60 + MIN) return; // run once per day at/after 03:17 Zurich
    run({ appendLog, slot: `${APP}:${z.day}` }).catch(() => {});
  };
  // checks every minute; claim() makes it once per day across restarts/instances
  setInterval(tick, 60 * 1000).unref();
  setTimeout(tick, 90 * 1000).unref();
}

function register(app, { appendLog }) {
  // Manual trigger: Authorization: Bearer <hex HMAC-SHA256(BACKUP_ENC_KEY, "run-backup")>
  app.post('/api/backup/run', async (req, res) => {
    const k = key();
    if (!k) return res.status(503).json({ ok: false, error: 'not configured' });
    const want = Buffer.from(crypto.createHmac('sha256', k).update('run-backup').digest('hex'));
    const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return res.status(401).json({ ok: false });
    try { res.json(await run({ appendLog, slot: `${APP}:manual:${new Date().toISOString().slice(0, 16)}` })); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
}

module.exports = { start, run, register, encrypt, MAGIC };
