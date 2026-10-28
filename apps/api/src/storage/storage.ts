import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

/** Object storage for document bytes. Keys are always tenant-prefixed: t/{tenantId}/… */
export interface StorageAdapter {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
export const STORAGE = 'STORAGE';

/** Dev/test storage on the local disk. Keys are validated so they can never escape the root. */
export class LocalStorage implements StorageAdapter {
  private root: string;
  constructor(root = process.env.STORAGE_DIR ?? '.storage') { this.root = resolve(root); }
  private path(key: string) {
    if (!/^t\/[0-9a-f-]{36}\/[a-z0-9/._-]+$/i.test(key) || key.includes('..')) throw new Error('Bad storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('Bad storage key');
    return p;
  }
  async put(key: string, body: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body, { mode: 0o600 }); }
  async get(key: string) { return createReadStream(this.path(key)); }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
}

/** S3-compatible (AWS S3 ap-south-1 in prod, MinIO locally). Server-side encryption requested on every put. */
export class S3Storage implements StorageAdapter {
  private s3 = new S3Client({
    region: process.env.S3_REGION ?? 'ap-south-1', endpoint: process.env.S3_ENDPOINT, forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: process.env.S3_ACCESS_KEY ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY ?? '' } : undefined,
  });
  constructor(private bucket = process.env.S3_BUCKET ?? 'worko') {}
  async put(key: string, body: Buffer, mime: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime, ServerSideEncryption: process.env.S3_ENDPOINT ? undefined : 'AES256' }));
  }
  async get(key: string) { return (await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))).Body as Readable; }
  async delete(key: string) { await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
}

export const storageFactory = (): StorageAdapter => (process.env.STORAGE === 's3' ? new S3Storage() : new LocalStorage());

/** Malware scanning hook (ClamAV / cloud AV adapter slot). The mock flags the standard EICAR test file. */
export interface VirusScanner { scan(body: Buffer): Promise<'clean' | 'infected'> }
export const VIRUS_SCANNER = 'VIRUS_SCANNER';
export class MockVirusScanner implements VirusScanner {
  async scan(body: Buffer) { return body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'infected' as const : 'clean' as const; }
}
