#!/usr/bin/env node
'use strict';
// Decrypts a Telegram backup file (checkout or lnkbio).
// Usage: BACKUP_ENC_KEY=<64 hex> node scripts/decrypt-backup.js <file.json.gz.enc> [out.json]
//    or: node scripts/decrypt-backup.js <file> [out.json] --key-file /workspace/.backup_enc_key
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const args = process.argv.slice(2);
const kf = args.indexOf('--key-file');
let keyHex = process.env.BACKUP_ENC_KEY || '';
if (kf >= 0) { keyHex = fs.readFileSync(args[kf + 1], 'utf8'); args.splice(kf, 2); }
keyHex = keyHex.trim();
if (!/^[0-9a-f]{64}$/i.test(keyHex) || !args[0]) { console.error('Usage: BACKUP_ENC_KEY=<64 hex> node decrypt-backup.js <file> [out.json]  (or --key-file path)'); process.exit(2); }
const buf = fs.readFileSync(args[0]);
const magic = buf.subarray(0, 6);
if (magic.toString() !== 'C2PBK1') { console.error('Not a backup file (bad magic)'); process.exit(1); }
const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(6, 18));
d.setAAD(magic); d.setAuthTag(buf.subarray(18, 34));
const json = zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(34)), d.final()]));
const out = args[1] || args[0].replace(/\.json\.gz\.enc$|\.enc$/, '') + (/\.json$/.test(args[1] || '') ? '' : '.json');
fs.writeFileSync(out, json, { mode: 0o600 });
console.log(`OK -> ${out} (${json.length} bytes)`);
