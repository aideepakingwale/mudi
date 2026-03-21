/**
 * routes/r2.js — Cloudflare R2 AWS Signature V4 helpers
 * No external SDK — uses Node 18 built-in crypto only.
 * Exported and shared by routes/transfer.js and db.js independently.
 */
'use strict';

const { createHmac, createHash } = require('crypto');

function r2Configured() {
  return !!(process.env.R2_ACCOUNT_ID &&
            process.env.R2_ACCESS_KEY_ID &&
            process.env.R2_SECRET_ACCESS_KEY);
}

function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function awsSigningKey(secretKey, date, region, service) {
  return hmacSha256(
    hmacSha256(hmacSha256(hmacSha256('AWS4' + secretKey, date), region), service),
    'aws4_request'
  );
}

/**
 * Generate a presigned URL for PUT or GET against R2.
 * @param {'GET'|'PUT'|'DELETE'} method
 * @param {string} key   — object key in the bucket
 * @param {number} expiresIn — seconds until expiry (default 900)
 */
function r2PresignedUrl(method, key, expiresIn = 900) {
  const bucket    = process.env.R2_BUCKET_NAME || 'mudi-transfers';
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const host      = `${bucket}.${accountId}.r2.cloudflarestorage.com`;
  const region    = 'auto';
  const service   = 's3';

  const now       = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '');

  const scope      = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKey}/${scope}`;
  const encodedKey = encodeURIComponent(key).replace(/%2F/g, '/');

  const qs = new URLSearchParams({
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    credential,
    'X-Amz-Date':          amzDate,
    'X-Amz-Expires':       String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonical = [
    method,
    `/${encodedKey}`,
    qs.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const signingKey = awsSigningKey(secretKey, dateStamp, region, service);
  const signature  = createHmac('sha256', signingKey)
    .update(`AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonical)}`)
    .digest('hex');

  qs.set('X-Amz-Signature', signature);
  return `https://${host}/${encodedKey}?${qs.toString()}`;
}

async function deleteR2Object(key) {
  if (!r2Configured()) return;
  try {
    const res = await fetch(r2PresignedUrl('DELETE', key, 300), { method: 'DELETE' });
    if (res.ok || res.status === 204 || res.status === 404) {
      console.log('[r2] deleted:', key);
    } else {
      console.warn('[r2] delete returned', res.status, 'for', key);
    }
  } catch(e) {
    console.error('[r2] delete error:', e.message);
  }
}

module.exports = { r2Configured, r2PresignedUrl, deleteR2Object };
