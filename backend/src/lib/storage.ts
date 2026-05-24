// Adaptador de almacenamiento S3-compatible.
// En desarrollo apunta a MinIO; en producción a AWS S3 (u otro compatible).
import type { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

const s3 = new S3Client({
  region: env.STORAGE_REGION,
  endpoint: env.STORAGE_ENDPOINT,
  forcePathStyle: true, // requerido por MinIO
  credentials: {
    accessKeyId: env.STORAGE_ACCESS_KEY,
    secretAccessKey: env.STORAGE_SECRET_KEY,
  },
});

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export interface UploadInput {
  body: Buffer;
  contentType: string;
}

export interface UploadResult {
  storageKey: string;
  url: string;
  contentType: string;
  sizeBytes: number;
}

function buildPublicUrl(storageKey: string): string {
  const endpoint = env.STORAGE_ENDPOINT.replace(/\/+$/, '');
  return `${endpoint}/${env.STORAGE_BUCKET}/${storageKey}`;
}

export async function uploadObject(input: UploadInput): Promise<UploadResult> {
  const ext = EXTENSION_BY_CONTENT_TYPE[input.contentType] ?? 'bin';
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const storageKey = `media/${yyyymmdd}/${randomUUID()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.STORAGE_BUCKET,
      Key: storageKey,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );

  return {
    storageKey,
    url: buildPublicUrl(storageKey),
    contentType: input.contentType,
    sizeBytes: input.body.length,
  };
}

export async function objectExists(storageKey: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.STORAGE_BUCKET, Key: storageKey }));
    return true;
  } catch {
    return false;
  }
}
