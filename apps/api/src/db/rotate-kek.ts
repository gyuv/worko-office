/**
 * KEK rotation command (D199): `KMS_LOCAL_MASTER_KEY=<new> KMS_LOCAL_PREVIOUS_KEYS=<old> pnpm --filter @worko/api rotate-kek`.
 * Re-wraps every tenant's data key under the current key-encryption key (data keys and ciphertexts are untouched) and
 * audits each re-wrap. Safe to re-run. Afterwards the previous key can be removed from the environment.
 */
import { AuditService } from '../audit/audit.service.js';
import { KeyService, LocalKms, type KmsProvider } from '../crypto/key.service.js';
import { DbService } from './db.service.js';

export async function rotateKek(db: DbService, kms: KmsProvider, audit = new AuditService()) {
  const keys = new KeyService(kms);
  const tenants = (await db.systemTx((tx) => tx.query<{ id: string }>('SELECT id FROM tenant ORDER BY id'))).rows;
  const out = { rewrapped: 0, current: 0, none: 0 };
  for (const t of tenants) {
    const r = await db.tenantTx(t.id, async (tx) => {
      const res = await keys.rewrap(tx, t.id);
      if (res === 'rewrapped') await audit.record(tx, t.id, { actorId: null, deviceId: 'server', action: 'crypto.kek_rotate', entity: 'tenant_key', entityId: t.id, diff: { kekId: kms.kekId } });
      return res;
    });
    out[r]++;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = new DbService();
  rotateKek(db, new LocalKms()).then((r) => { process.stdout.write(`KEK rotation: ${JSON.stringify(r)}\n`); return db.pool.end(); })
    .catch(async (e) => { console.error(e); await db.pool.end(); process.exit(1); });
}
