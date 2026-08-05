/**
 * AWS S3 storage for original uploaded documents.
 *
 * When S3_ENABLED=false, all functions no-op or return null (RAG works without S3).
 * When S3_ENABLED=true, S3_BUCKET_NAME must be set.
 *
 * Credentials (in order):
 *   1. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — optional, for local/dev
 *   2. Default AWS SDK chain — ECS task role, instance profile, etc. (production)
 */

import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function envBool(name) {
  return process.env[name] === 'true' || process.env[name] === '1';
}

export function isEnabled() {
  return envBool('S3_ENABLED');
}

function getConfig() {
  return {
    region: process.env.AWS_REGION || 'ap-south-1',
    bucket: process.env.S3_BUCKET_NAME,
    prefix: process.env.S3_PREFIX || 'documents/',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID?.trim() || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY?.trim() || '',
  };
}

function hasStaticCredentials({ accessKeyId, secretAccessKey }) {
  return Boolean(accessKeyId && secretAccessKey);
}

export function assertConfigured() {
  if (!isEnabled()) return;
  const { bucket } = getConfig();
  if (!bucket) {
    throw new Error('S3 is enabled but missing required env var: S3_BUCKET_NAME');
  }
}

export function getBucket() {
  assertConfigured();
  return getConfig().bucket;
}

let _client = null;

function getClient() {
  assertConfigured();
  if (!_client) {
    const { region, accessKeyId, secretAccessKey } = getConfig();
    const clientConfig = { region };

    // Only pin static keys when both are set (local/dev).
    // On ECS, omit credentials so the SDK uses the task role.
    if (hasStaticCredentials({ accessKeyId, secretAccessKey })) {
      clientConfig.credentials = { accessKeyId, secretAccessKey };
    }

    _client = new S3Client(clientConfig);
  }
  return _client;
}

export function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function buildObjectKey(docId, filename) {
  const prefix = getConfig().prefix.replace(/\/?$/, '/');
  return `${prefix}${docId}/${sanitizeFilename(filename)}`;
}

/**
 * Upload a file from a buffer or filesystem path.
 * @param {{ bufferOrPath: Buffer|string, key: string, contentType?: string }} opts
 */
export async function uploadFile({ bufferOrPath, key, contentType }) {
  if (!isEnabled()) return null;
  assertConfigured();

  const body = Buffer.isBuffer(bufferOrPath)
    ? bufferOrPath
    : fs.readFileSync(bufferOrPath);

  const bucket = getConfig().bucket;
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));

  return { bucket, key };
}

/**
 * Generate a presigned GET URL for downloading an object.
 */
export async function getPresignedDownloadUrl(key, filename, expiresInSeconds = 300, bucketOverride = null) {
  if (!isEnabled()) {
    throw new Error('S3 storage is not enabled');
  }
  assertConfigured();

  const bucket = bucketOverride || getConfig().bucket;
  const safeName = sanitizeFilename(filename);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });

  const downloadUrl = await getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
  return { downloadUrl, expiresIn: expiresInSeconds };
}

/**
 * Delete an object from S3. Best-effort — logs errors but does not throw by default.
 */
export async function deleteFile(key, bucketOverride = null) {
  if (!isEnabled() || !key) return;
  try {
    assertConfigured();
    const bucket = bucketOverride || getConfig().bucket;
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.error(`S3 delete failed for key "${key}":`, err.message);
    throw err;
  }
}
