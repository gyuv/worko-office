import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Tx } from '../db/db.service.js';

/** Wraps/unwraps per-tenant data keys. Local impl for dev/tests; AWS KMS (ap-south-1) adapter slot for prod. */
export interface KmsProvider { readonly kekId: string; wrap(dek: Buffer): Promise<Buffer>; unwrap(wrapped: Buffer): Promise<Buffer> }
export const KMS_PROVIDER = 'KMS_PROVIDER';

const gcm = {
  seal(key: Buffer, plain: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  },
  open(key: Buffer, blob: Buffer, aad: string): Buffer {
    if (blob[0] !== 1) throw new Error('Unknown ciphertext version');
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13)); d.setAAD(Buffer.from(aad)); d.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
  },
};

/** Master key from env (dev/test). Production must use a managed KMS — refuse to start without a key. */
export class LocalKms implements KmsProvider {
  private readonly key: Buffer;
  readonly kekId: string;
  constructor(secret = process.env.KMS_LOCAL_MASTER_KEY ?? process.env.FIELD_ENCRYPTION_KEY) {
    if (!secret && process.env.NODE_ENV === 'production') throw new Error('KMS master key required');
    this.key = createHash('sha256').update(secret ?? 'worko-dev-only-master-key').digest();
    this.kekId = `local:${createHash('sha256').update(this.key).digest('hex').slice(0, 12)}`;
  }
  async wrap(dek: Buffer) { return gcm.seal(this.key, dek, 'dek'); }
  async unwrap(w: Buffer) { return gcm.open(this.key, w, 'dek'); }
}

/**
 * Envelope encryption for sensitive fields (portal credentials, Aadhaar, bank numbers): each tenant has a
 * random data key, stored only wrapped by the KMS key. AAD binds every ciphertext to its record and field,
 * so a value copied to another row or column fails to decrypt.
 */
@Injectable()
export class KeyService {
  private cache = new Map<string, { dek: Buffer; at: number }>();
  constructor(@Inject(KMS_PROVIDER) private kms: KmsProvider) {}

  private async dek(tx: Tx, tenantId: string): Promise<Buffer> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.dek;
    let row = (await tx.query('SELECT wrapped_dek FROM tenant_key WHERE tenant_id = $1', [tenantId])).rows[0];
    if (!row) {
      const dek = randomBytes(32);
      await tx.query('INSERT INTO tenant_key (tenant_id, kek_id, wrapped_dek) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, this.kms.kekId, await this.kms.wrap(dek)]);
      row = (await tx.query('SELECT wrapped_dek FROM tenant_key WHERE tenant_id = $1', [tenantId])).rows[0];
    }
    const dek = await this.kms.unwrap(row.wrapped_dek);
    this.cache.set(tenantId, { dek, at: Date.now() });
    return dek;
  }

  async encrypt(tx: Tx, tenantId: string, plain: string, aad: string): Promise<Buffer> {
    return gcm.seal(await this.dek(tx, tenantId), Buffer.from(plain, 'utf8'), `${tenantId}:${aad}`);
  }
  async decrypt(tx: Tx, tenantId: string, blob: Buffer, aad: string): Promise<string> {
    return gcm.open(await this.dek(tx, tenantId), blob, `${tenantId}:${aad}`).toString('utf8');
  }
}
