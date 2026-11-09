'use strict';
/**
 * Lazy now/next from Xtream get_short_epg (server-side only).
 * Credentials and stream URLs never leave the backend; clients send catalog channel ids.
 */
const fs = require('fs');
const path = require('path');

const TTL = 8 * 60e3;
const MAX_CACHE = 800;
const MAX_IDS = 24;
const CONCUR = 3;
function diskPath(dir) {
  return path.join(dir || process.env.SHORT_EPG_CACHE || '/tmp', 'lnkbio-shortepg.json');
}

function maybeB64(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  if (!/^[A-Za-z0-9+/]+=*$/.test(t) || t.length < 8 || t.length % 4) return t.replace(/\s+/g, ' ').trim();
  try {
    const d = Buffer.from(t, 'base64').toString('utf8');
    if (!d || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(d)) return t;
    // Prefer decoded text when it looks like a title/description (letters or punctuation, not only hex).
    if (/[A-Za-zÁ-žÀ-ÿ\u0400-\u04FF]/.test(d)) return d.replace(/\s+/g, ' ').trim().slice(0, 400);
    return t.replace(/\s+/g, ' ').trim();
  } catch { return t.replace(/\s+/g, ' ').trim(); }
}

function unixSec(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e12) return Math.round(v / 1000);
    if (v > 1e9) return Math.round(v);
    return 0;
  }
  const s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? Math.round(n / 1000) : Math.round(n);
  }
  const iso = /T/.test(s) ? s : s.replace(/^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}(:\d{2})?)$/, '$1T$2');
  const withTz = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso + 'Z' : iso);
  const d = Date.parse(withTz);
  return Number.isFinite(d) ? Math.round(d / 1000) : 0;
}

function parseListing(row) {
  if (!row || typeof row !== 'object') return null;
  const start = unixSec(row.start_timestamp != null ? row.start_timestamp : (row.start || row.time_start || row.s));
  const end = unixSec(row.stop_timestamp != null ? row.stop_timestamp : (row.end || row.stop || row.time_end || row.e));
  if (!start || !end || end <= start) return null;
  const title = maybeB64(row.title || row.name || '').slice(0, 200);
  if (!title) return null;
  const descr = maybeB64(row.description || row.descr || row.plot || '').slice(0, 400);
  return { start, end, title, descr };
}

function parseShortEpg(json) {
  const arr = Array.isArray(json) ? json
    : (json && Array.isArray(json.epg_listings) ? json.epg_listings
      : (json && Array.isArray(json.listings) ? json.listings : []));
  const out = [];
  const seen = new Set();
  for (const row of arr) {
    const p = parseListing(row);
    if (!p) continue;
    const k = p.start + ':' + p.end + ':' + p.title;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  out.sort((a, b) => a.start - b.start);
  return out.slice(0, 8);
}

/** Same tuple shape as /api/epg/now: [startSec, endSec, title, kind, flag] */
function toNowList(listings, nowSec) {
  const n = nowSec || Math.round(Date.now() / 1000);
  return (listings || []).filter((p) => p.end > n).slice(0, 4).map((p) => [p.start, p.end, p.title, '', '']);
}

function create({ getConf, fetchShort, streamIdsFor, appendLog = () => {}, now, cacheDir } = {}) {
  const mem = new Map(); // streamId -> { at, list }
  const tick = now || (() => Date.now());
  const DISK = diskPath(cacheDir);
  let diskTimer = null, diskDirty = false;
  try {
    const j = JSON.parse(fs.readFileSync(DISK, 'utf8'));
    if (j && typeof j === 'object') {
      const n0 = tick();
      for (const [k, v] of Object.entries(j)) {
        if (v && Array.isArray(v.list) && n0 - (v.at || 0) < TTL * 2) mem.set(String(k), { at: v.at, list: v.list });
      }
    }
  } catch { /* first run */ }

  function persistSoon() {
    diskDirty = true;
    if (diskTimer) return;
    diskTimer = setTimeout(() => {
      diskTimer = null;
      if (!diskDirty) return;
      diskDirty = false;
      try {
        const obj = {};
        for (const [k, v] of mem) obj[k] = v;
        fs.writeFileSync(DISK, JSON.stringify(obj));
      } catch { /* tmpfs / read-only */ }
    }, 20e3);
    if (diskTimer.unref) diskTimer.unref();
  }

  function trim() {
    if (mem.size <= MAX_CACHE) return;
    const arr = [...mem.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (let i = 0; i < arr.length - MAX_CACHE; i++) mem.delete(arr[i][0]);
  }

  async function loadOne(conf, sid) {
    const k = String(sid);
    const hit = mem.get(k);
    if (hit && tick() - hit.at < TTL) return hit.list;
    const raw = await fetchShort(conf, sid);
    const list = parseShortEpg(raw);
    mem.set(k, { at: tick(), list });
    trim();
    persistSoon();
    return list;
  }

  async function mapLimit(items, n, fn) {
    const ret = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const k = i++;
        ret[k] = await fn(items[k], k);
      }
    };
    const w = Math.max(1, Math.min(n, items.length));
    await Promise.all(Array.from({ length: w }, worker));
    return ret;
  }

  async function forCatalogIds(ids, nowSec) {
    const uniq = [...new Set((ids || []).map((x) => +x).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS);
    const nsec = nowSec || Math.round(tick() / 1000);
    const out = { t: nsec, c: {} };
    if (!uniq.length) return out;
    const conf = getConf ? await getConf() : null;
    if (!conf || !conf.base || !conf.user || !conf.pass) return out;
    const map = streamIdsFor ? await streamIdsFor(uniq) : {};
    const jobs = uniq.map((id) => ({ id, sid: map[id] })).filter((j) => j.sid);
    if (!jobs.length) return out;
    await mapLimit(jobs, CONCUR, async (j) => {
      try {
        const list = await loadOne(conf, j.sid);
        const nowL = toNowList(list, nsec);
        if (nowL.length) out.c[j.id] = nowL;
      } catch (e) { appendLog('SHORT_EPG_FAIL id=' + j.id + ' ' + String((e && e.message) || 'fail').slice(0, 80)); }
    });
    return out;
  }

  function ready(conf) { return !!(conf && conf.base && conf.user && conf.pass); }
  function clear() { mem.clear(); }

  return { forCatalogIds, ready, clear, parseShortEpg, toNowList, maybeB64, unixSec, TTL, MAX_IDS, CONCUR };
}

module.exports = { create, parseShortEpg, parseListing, toNowList, maybeB64, unixSec, TTL, MAX_IDS };
