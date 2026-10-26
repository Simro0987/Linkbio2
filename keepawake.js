'use strict';
// Render free tier: a web service sleeps after 15 min without inbound traffic, and ALL free
// services of a workspace share 750 instance-hours/month (two services 24/7 ≈ 1488 h → both get
// suspended late in the month). So only ONE free service may be kept awake around the clock.
// KEEP_AWAKE = always | day | off   (day = KEEP_AWAKE_FROM..KEEP_AWAKE_TO h, Europe/Bratislava, default 7–23)
// No dependency on any external machine: the service pings its own public URL.
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bratislava', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
function mode(def) { const v = String(process.env.KEEP_AWAKE || def).trim().toLowerCase(); return ['always', 'day', 'off'].includes(v) ? v : def; }
function wanted(def) {
  const m = mode(def); if (m === 'always') return true; if (m === 'off') return false;
  const from = Number(process.env.KEEP_AWAKE_FROM || 7), to = Number(process.env.KEEP_AWAKE_TO || 23), h = hourNow();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}
const hit = (u) => fetch(u, { signal: AbortSignal.timeout(60e3), headers: { 'user-agent': 'keepawake/1.0' } }).then((r) => r.status).catch(() => 0);
function start({ selfUrl, def = 'off', log = () => {} }) {
  if (!selfUrl) return;
  const tick = () => { if (wanted(def)) hit(selfUrl); };
  setTimeout(tick, 30e3).unref(); setInterval(tick, 10 * 60e3).unref();
  log('KEEP_AWAKE ' + mode(def));
}
// Wake a peer service on demand (fire-and-forget, at most once per 5 min) so it is warm by the time a visitor needs it.
const lastWake = new Map();
function wake(url) { const t = Date.now(); if (!url || t - (lastWake.get(url) || 0) < 5 * 60e3) return; lastWake.set(url, t); hit(url); }
module.exports = { start, wake, mode, wanted };
