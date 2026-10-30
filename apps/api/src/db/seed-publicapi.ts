import { webhookEnvelope } from '@worko/domain';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { KeyService, LocalKms } from '../crypto/key.service.js';
import type { DbService } from './db.service.js';

/**
 * Phase 12 B demo data: one read-mostly API key (full key returned for the dev seed output only — never stored) and one
 * webhook subscription to a demo receiver with a short delivery history (success, exhausted retries, redelivery).
 */
export async function seedPublicApi(db: DbService, tenantId: string, partnerId: string): Promise<{ apiKey: string; prefix: string }> {
  const prefix = 'demo' + randomBytes(3).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  await db.systemTx((tx) => tx.query('INSERT INTO api_key_lookup (prefix, tenant_id) VALUES ($1,$2)', [prefix, tenantId]));
  await db.tenantTx(tenantId, async (tx) => {
    await tx.query(`INSERT INTO api_key (id, tenant_id, name, prefix, secret_hash, scopes, ip_allowlist, rate_per_min, created_by, device_id)
      VALUES ($1,$2,'Tally bridge (demo)',$3,$4,$5,'{}',120,$6,'seed')`,
    [randomUUID(), tenantId, prefix, createHash('sha256').update(secret).digest(), ['clients:view', 'tasks:view', 'tasks:edit', 'billing:view', 'receipts:create', 'compliance:view'], partnerId]);
    const keys = new KeyService(new LocalKms());
    const sub = randomUUID();
    await tx.query(`INSERT INTO webhook_subscription (id, tenant_id, name, url, events, secret_enc, created_by, consecutive_failures, last_delivery_at, device_id)
      VALUES ($1,$2,'Demo receiver','https://webhook.example.com/worko-demo',$3,$4,$5,0,now() - interval '1 hour','seed')`,
    [sub, tenantId, ['task.status_changed', 'receipt.recorded', 'invoice.issued'], await keys.encrypt(tx, tenantId, `whsec_${randomBytes(24).toString('base64url')}`, `webhook_subscription:${sub}:secret`), partnerId]);
    const task = (await tx.query(`SELECT id, client_id FROM task WHERE client_id IS NOT NULL ORDER BY created_at LIMIT 1`)).rows[0];
    const env = (type: string, h: number) => webhookEnvelope({ id: randomUUID(), type, occurredAt: new Date(Date.now() - h * 3600_000).toISOString(), entityType: 'task', entityId: task?.id ?? randomUUID(), clientId: task?.client_id ?? null, payload: { from: 'open', to: 'in_progress' } });
    const ok = randomUUID(), bad = randomUUID();
    const rows: Array<[string, Record<string, unknown>, string, number, number | null, string | null, number, string | null]> = [
      [ok, env('task.status_changed', 30), 'succeeded', 1, 200, null, 30, null],
      [bad, env('task.status_changed', 20), 'failed', 8, 503, 'http_503', 19, null],
      [randomUUID(), env('task.status_changed', 20), 'succeeded', 1, 200, null, 1, bad],
    ];
    for (const [id, e, status, attempts, code, err, hAgo, of] of rows) {
      await tx.query(`INSERT INTO webhook_delivery (id, tenant_id, subscription_id, event_id, event_type, envelope, redelivery_of, status, attempts, last_status_code, last_error, last_duration_ms, created_at, delivered_at, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - make_interval(hours => $13), CASE WHEN $8 = 'succeeded' THEN now() - make_interval(hours => $13) END, 'seed')`,
      [id, tenantId, sub, e.id, e.type, e, of, status, attempts, code, err, 120, hAgo]);
    }
  });
  return { apiKey: `wk_${prefix}_${secret}`, prefix };
}
