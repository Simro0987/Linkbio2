'use strict';
// Payment proofs -> Neon object storage (S3-compatible), bucket allet2.
const fs = require('fs');
const { S3Client, PutObjectCommand, HeadBucketCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const BUCKET = process.env.PROOF_BUCKET || 'allet2';
let client = null;
function enabled() {
  return Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}
function s3() {
  if (!client) client = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1', endpoint: process.env.AWS_ENDPOINT_URL_S3, forcePathStyle: true });
  return client;
}
async function uploadProof(orderId, filePath, filename) {
  if (!enabled()) return null;
  const key = `proofs/${orderId}/${filename}`;
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.readFileSync(filePath) }));
  return { bucket: BUCKET, key };
}
async function uploadBuffer(prefixId, filename, buffer, contentType) {
  if (!enabled()) return null;
  const key = `proofs/${prefixId}/${filename}`;
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return { bucket: BUCKET, key };
}
async function check() {
  if (!enabled()) return { enabled: false };
  try { await s3().send(new HeadBucketCommand({ Bucket: BUCKET })); return { enabled: true, bucket: BUCKET, ok: true }; }
  catch (e) { return { enabled: true, bucket: BUCKET, ok: false, error: e.name }; }
}
async function getBuffer(key) {
  if (!enabled() || !/^proofs\//.test(String(key))) return null;
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}
module.exports = { getBuffer, uploadBuffer, uploadProof, enabled, check, BUCKET };
