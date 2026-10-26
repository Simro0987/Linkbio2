'use strict';
// Postgres-backed order store (Neon). In-memory cache + write-through upserts.
// Neon serverless driver over WebSocket/443 (port 5432 is often blocked).
const { Pool, neonConfig } = require('@neondatabase/serverless');
neonConfig.webSocketConstructor = require('ws');
let pool = null;
const cache = Object.create(null);
const lastJson = Object.create(null);
let chain = Promise.resolve();
let lastError = null;
let since = new Date(0);
let syncing = null;

function enabled() { return Boolean(pool); }

async function init(log) {
  // lnkbio has its own DATABASE_URL – the payment data (Neon) lives under PAY_DATABASE_URL
  const url = String(process.env.PAY_DATABASE_URL || '').trim();
  if (!url) return false;
  pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 300000 });
  pool.on('error', (e) => { lastError = e.message; });
  try {
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY, data jsonb NOT NULL,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  const { rows } = await pool.query('SELECT id, data FROM orders');
  for (const r of rows) { cache[r.id] = r.data; lastJson[r.id] = JSON.stringify(r.data); }
  try { const m = await pool.query('SELECT max(updated_at) t FROM orders'); since = m.rows[0].t || since; } catch { /* */ }
  if (log) log(`DB_READY orders=${rows.length}`);
  return true;
  } catch (e) { const p = pool; pool = null; p.end().catch(() => {}); throw e; }
}

function load() { return JSON.parse(JSON.stringify(cache)); }

function save(orders, log) {
  const changed = [];
  for (const [id, o] of Object.entries(orders || {})) {
    const j = JSON.stringify(o);
    if (lastJson[id] !== j) { lastJson[id] = j; cache[id] = JSON.parse(j); changed.push([id, j]); }
  }
  if (!changed.length) return chain;
  chain = chain.then(async () => {
    for (const [id, j] of changed) {
      try {
        await pool.query(
          `INSERT INTO orders (id, data) VALUES ($1, $2::jsonb)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [id, j]);
      } catch (e) { lastError = e.message; if (log) log(`DB_SAVE_FAIL ${id} ${e.message}`); }
    }
  });
  return chain;
}

async function status() {
  if (!pool) return { enabled: false };
  try { const r = await pool.query('SELECT count(*)::int n FROM orders'); return { enabled: true, orders: r.rows[0].n, lastError }; }
  catch (e) { return { enabled: true, error: e.message }; }
}

async function saveSubmission(id, data) {
  if (!pool) return false;
  await pool.query(`CREATE TABLE IF NOT EXISTS proof_submissions (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz DEFAULT now())`);
  await pool.query(`INSERT INTO proof_submissions (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, JSON.stringify(data)]);
  return true;
}

/** Read-through: an order created/changed by another instance (old checkout during the move) – load it on demand. */
async function fetchOne(id) {
  if (!pool || !/^ord_[a-f0-9]{8,32}$/.test(String(id || ''))) return false;
  if (cache[id]) return true;
  try {
    const { rows } = await pool.query('SELECT id, data FROM orders WHERE id = $1', [id]);
    if (!rows.length) return false;
    if (!cache[id]) { cache[id] = rows[0].data; lastJson[id] = JSON.stringify(rows[0].data); }
    return true;
  } catch (e) { lastError = e.message; return false; }
}

/** Pull rows changed in the DB since the last sync (another instance wrote them). Local pending writes go first. */
function sync(log) {
  if (!pool) return Promise.resolve(0);
  if (syncing) return syncing;
  syncing = (async () => {
    await chain;
    const { rows } = await pool.query('SELECT id, data, updated_at FROM orders WHERE updated_at > $1 ORDER BY updated_at LIMIT 500', [since]);
    let n = 0;
    for (const r of rows) {
      const j = JSON.stringify(r.data);
      if (lastJson[r.id] !== j) { cache[r.id] = r.data; lastJson[r.id] = j; n++; }
      if (r.updated_at > since) since = r.updated_at;
    }
    if (n && log) log(`DB_SYNC pulled=${n}`);
    return n;
  })().catch((e) => { lastError = e.message; return 0; }).finally(() => { syncing = null; });
  return syncing;
}

module.exports = { fetchOne, sync, pool: () => pool, saveSubmission, init, load, save, enabled, status, flush: () => chain };
