'use strict';
// Pay module run mode inside lnkbio (env PAY_MODULE):
//   off    – module not loaded at all (lnkbio unchanged)
//   shadow – pages served for testing (/platby-preview); no background jobs, no inbound Telegram (old checkout still live)
//   live   – /platby served here; still no jobs / inbound bots (old checkout not yet moved)
//   on     – everything: Telegram webhook + SEPA channel polling, chain watcher, Azteco watcher, backups
const mode = () => { const m = String(process.env.PAY_MODULE || 'off').trim().toLowerCase(); return ['shadow', 'live', 'on'].includes(m) ? m : 'off'; };
module.exports = { mode, jobs: () => mode() === 'on', receive: () => mode() === 'on', servesPlatby: () => mode() === 'live' || mode() === 'on' };
