import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Field-level encryption (AES-256-GCM). In production the key comes from KMS envelope encryption
 * (per-tenant data key wrapped by a KMS master key); locally it is derived from FIELD_ENCRYPTION_KEY.
 * Output: version(1) | iv(12) | tag(16) | ciphertext.
 */
function key(): Buffer {
  const k = process.env.FIELD_ENCRYPTION_KEY;
  if (!k && process.env.NODE_ENV === 'production') throw new Error('FIELD_ENCRYPTION_KEY is required');
  return createHash('sha256').update(k ?? 'worko-dev-only-key').digest();
}

export function encryptField(plain: Buffer | string, aad = ''): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
}

export function decryptField(blob: Buffer, aad = ''): Buffer {
  const d = createDecipheriv('aes-256-gcm', key(), blob.subarray(1, 13));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
}
