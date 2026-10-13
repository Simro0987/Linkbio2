'use strict';
// Editable UI texts: every public label is keyed by its default SK text; overrides (SK + EN) live in settings.ui_texts (JSON) and are edited in /admin/texty.
const fs = require('fs'), path = require('path');
let OV = {};
const DEF = new Map(); // sk -> en default
const S = String.raw`'((?:[^'\\]|\\.)*)'`;
const un = (x) => x.replace(/\\(.)/g, '$1');
for (const f of ['server.js', 'extras.js', 'features.js', 'tvch.js']) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  for (const m of src.matchAll(new RegExp(String.raw`tx\([^,()]+,\s*` + S + String.raw`,\s*` + S + String.raw`\)`, 'g'))) DEF.set(un(m[1]), un(m[2]));
}
function addDefaults(map) { for (const [sk, en] of Object.entries(map)) if (!DEF.has(sk) || !DEF.get(sk)) DEF.set(sk, en); }
function setOverrides(json) { try { const o = JSON.parse(json || '{}'); OV = o && typeof o === 'object' ? o : {}; } catch { OV = {}; } }
function tx(isEn, sk, en) { const o = OV[sk] || {}; return isEn ? (o.en || en || o.sk || sk) : (o.sk || sk); }
const all = () => [...DEF.entries()].sort((a, b) => a[0].localeCompare(b[0], 'sk')).map(([sk, en]) => ({ sk, en, osk: (OV[sk] || {}).sk || '', oen: (OV[sk] || {}).en || '' }));
module.exports = { tx, setOverrides, addDefaults, all, has: (k) => DEF.has(k) };
